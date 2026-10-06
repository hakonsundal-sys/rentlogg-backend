import { db } from "../db.js";
import { isModuleEnabled } from "../modules.js";
import { yesterdayInOslo } from "./schedule.js";
import { sendEmail } from "./mailer.js";
import { isDueOn, scheduleMode, isLastDayOfMonth, monthStart } from "./checklistSchedule.js";

// Sjekk det: daglig oppsummering på e-post til lederen. Svarer på de to spørsmålene en leder har
// om morgenen — ble rutinene gjort i går, og er det noe som ikke er fulgt opp — uten at hun må
// logge inn for å finne ut at svaret er «ja, alt i orden».
//
// Mottakere og klokkeslett settes per firma (simple_checklist_settings). Planleggeren i
// scheduler.js kaller sendChecklistDigestsForHour hver hele time.

// Bevisst enkel: én @, noe på hver side, et punktum i domenet, ingen mellomrom. Resend avviser
// resten selv, og en strengere regel her ville bare avvist gyldige adresser.
export function isValidEmail(value) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function fmtNumber(n) {
  return String(n).replace(".", ",");
}

// Alt innholdet for ett firma og én dag, som data. Skilt fra HTML-en så det kan testes uten e-post.
export function buildChecklistDigest(companyId, dateStr) {
  const lists = db
    .prepare(
      `SELECT id, name, weekdays, created_at, times_per_day, schedule_mode, month_day FROM simple_checklists
       WHERE company_id = ? AND active = 1 ORDER BY sort_order, name COLLATE NOCASE`
    )
    .all(companyId);
  const submissions = db
    .prepare(
      `SELECT id, checklist_id, checklist_name, user_name, submitted_at, deviation_count
       FROM simple_checklist_submissions
       WHERE company_id = ? AND submitted_at IS NOT NULL AND work_date = ?
       ORDER BY submitted_at`
    )
    .all(companyId, dateStr);

  // Samme regel som I dag og ukeoversikten (services/checklistSchedule.js). «Én gang i måneden»
  // nevnes bare på månedens siste dag — før det har den ikke manglet ennå.
  const monthCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM simple_checklist_submissions
     WHERE checklist_id = ? AND submitted_at IS NOT NULL AND work_date BETWEEN ? AND ?`
  );
  const planned = lists
    .filter((l) => (scheduleMode(l) === "monthly_any"
      ? isLastDayOfMonth(dateStr) && String(l.created_at).slice(0, 10) <= dateStr
      : isDueOn(l, dateStr)))
    .map((l) => {
      if (scheduleMode(l) === "monthly_any") {
        const n = monthCountStmt.get(l.id, monthStart(dateStr), dateStr).n;
        return { name: `${l.name} (denne måneden)`, done: n > 0 };
      }
      const times = scheduleMode(l) === "weekly" ? Math.max(1, Number(l.times_per_day) || 1) : 1;
      const count = submissions.filter((s) => s.checklist_id === l.id).length;
      return { name: times > 1 ? `${l.name} (${count} av ${times})` : l.name, done: count >= times };
    });

  const deviations = db
    .prepare(
      `SELECT a.label, a.comment, a.measured_value, a.measure_unit, a.followup_at, a.followup_by_name, s.checklist_name, s.user_name
       FROM simple_checklist_answers a JOIN simple_checklist_submissions s ON s.id = a.submission_id
       WHERE s.company_id = ? AND s.submitted_at IS NOT NULL AND s.work_date = ? AND a.status = 'deviation'
       ORDER BY s.submitted_at, a.sort_order`
    )
    .all(companyId, dateStr);

  const openTotal = db
    .prepare(
      `SELECT COUNT(*) AS n FROM simple_checklist_answers a JOIN simple_checklist_submissions s ON s.id = a.submission_id
       WHERE s.company_id = ? AND s.submitted_at IS NOT NULL AND a.status = 'deviation' AND a.followup_at IS NULL`
    )
    .get(companyId).n;

  return { date: dateStr, planned, submissions, deviations, openTotal };
}

export function digestHtml(companyName, d) {
  const missing = d.planned.filter((p) => !p.done);
  const doneCount = d.planned.length - missing.length;
  const row = (left, right, color) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;">${left}</td>` +
    `<td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:bold;">${right}</td></tr>`;

  const plannedRows = d.planned.length
    ? d.planned.map((p) => row(escapeHtml(p.name), p.done ? "Utført" : "Mangler", p.done ? "#16a34a" : "#d97706")).join("")
    : `<tr><td style="padding:6px 0;color:#71717a;">Ingen lister var planlagt denne dagen.</td></tr>`;

  const deviationItems = d.deviations
    .map((x) => {
      const value = x.measure_unit && x.measured_value !== null ? ` — målt ${fmtNumber(x.measured_value)} ${escapeHtml(x.measure_unit)}` : "";
      return (
        `<li style="margin-bottom:8px;"><strong>${escapeHtml(x.checklist_name)}: ${escapeHtml(x.label)}</strong>${value}` +
        (x.comment ? `<br><span style="color:#b91c1c;">${escapeHtml(x.comment)}</span>` : "") +
        `<br><span style="color:#71717a;font-size:13px;">Meldt av ${escapeHtml(x.user_name)}</span>` +
        (x.followup_at
          ? ` <span style="color:#16a34a;font-size:13px;">· fulgt opp av ${escapeHtml(x.followup_by_name)}</span>`
          : ` <span style="color:#d97706;font-size:13px;">· ikke fulgt opp</span>`) +
        `</li>`
      );
    })
    .join("");

  const app = (process.env.PUBLIC_FRONTEND_URL || "https://www.rentlogg.no").replace(/\/$/, "");

  return `<!doctype html><html lang="no"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
<div style="max-width:560px;">
  <div style="font-size:12px;color:#71717a;letter-spacing:0.05em;text-transform:uppercase;">${escapeHtml(companyName)}</div>
  <h1 style="font-size:22px;margin:4px 0 2px;">Sjekk det — ${fmtDate(d.date)}</h1>
  <div style="color:#71717a;margin-bottom:18px;">
    ${d.planned.length ? `${doneCount} av ${d.planned.length} planlagte lister utført` : "Ingen planlagte lister"} ·
    ${d.submissions.length} innsendt · ${d.deviations.length} avvik
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">${plannedRows}</table>
  ${d.deviations.length ? `<h2 style="font-size:16px;margin:22px 0 8px;">Avvik</h2><ul style="padding-left:18px;margin:0;font-size:14px;">${deviationItems}</ul>` : ""}
  ${
    d.openTotal
      ? `<p style="margin-top:22px;padding:10px 12px;background:#fff7ed;border-radius:8px;font-size:14px;">
           <strong>${d.openTotal} avvik er ikke fulgt opp.</strong> Registrer hva som ble gjort under Sjekk det → Avvik.</p>`
      : ""
  }
  <p style="margin-top:22px;font-size:14px;"><a href="${app}/app/" style="color:#6d28d9;">Åpne Sjekk det</a></p>
  <p style="margin-top:24px;font-size:12px;color:#a1a1aa;">Mottakere endres av en administrator under Sjekk det → Rapport.</p>
</div></body></html>`;
}

// Én oppsummering for ett firma. `force` = manuell «Send nå»: sendes selv om dagen var tom, så
// admin ser hvordan e-posten ser ut. Den planlagte utsendingen hopper over en dag uten noe å si.
export async function sendChecklistDigest(companyId, { dateStr = yesterdayInOslo(), force = false } = {}) {
  const settings = db.prepare("SELECT report_recipients FROM simple_checklist_settings WHERE company_id = ?").get(companyId);
  const recipients = (settings?.report_recipients || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { status: "no_recipients" };

  const digest = buildChecklistDigest(companyId, dateStr);
  const empty = !digest.planned.length && !digest.submissions.length && !digest.openTotal;
  if (empty && !force) return { status: "skipped" };

  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(companyId);
  const missing = digest.planned.filter((p) => !p.done).length;
  const flags = [digest.deviations.length && `${digest.deviations.length} avvik`, missing && `${missing} mangler`].filter(Boolean);
  try {
    await sendEmail({
      to: recipients,
      subject: `Sjekk det ${fmtDate(dateStr)}${flags.length ? ` — ${flags.join(", ")}` : " — alt i orden"}`,
      html: digestHtml(company?.name || "", digest),
    });
    return { status: "sent", recipients: recipients.length };
  } catch (err) {
    console.error(`Sjekk det-oppsummering feilet for firma ${companyId}:`, err.message);
    return { status: "failed" };
  }
}

// Planleggerens inngang: alle firmaer som har valgt denne timen og fortsatt har modulen.
export async function sendChecklistDigestsForHour(hour) {
  const rows = db
    .prepare(
      `SELECT company_id FROM simple_checklist_settings
       WHERE report_recipients IS NOT NULL AND TRIM(report_recipients) != '' AND COALESCE(report_hour, 7) = ?`
    )
    .all(hour);
  const results = { sent: 0, skipped: 0, failed: 0 };
  for (const { company_id: companyId } of rows) {
    if (!isModuleEnabled(companyId, "checklist")) {
      results.skipped++;
      continue;
    }
    const r = await sendChecklistDigest(companyId);
    if (r.status === "sent") results.sent++;
    else if (r.status === "failed") results.failed++;
    else results.skipped++;
  }
  return results;
}
