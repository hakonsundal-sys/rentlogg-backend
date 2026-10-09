import { db } from "../db.js";
import { isModuleEnabled } from "../modules.js";
import { yesterdayInOslo } from "./schedule.js";
import { sendEmail } from "./mailer.js";
import { isDueOn, scheduleMode, isLastDayOfMonth, monthStart } from "./checklistSchedule.js";
import { BRAND as B, MAIL_FONT, mailShell } from "../brand.js";

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

  // Hver rad er en tabell i tabellen: navnet flyter, statusen står fast til høyre. Statusen
  // bruker *Text-variantene — #16a34a og #d97706 målte 3,30:1 og 3,19:1 som fet tekst her,
  // altså under WCAG AA, i en e-post en leder leser på telefon. Se src/brand.js.
  const plannedRows = d.planned.length
    ? d.planned
        .map(
          (p) => `
      <tr><td style="padding:10px 16px;border-top:1px solid ${B.lineSoft};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr>
          <td style="font:400 14px/1.4 ${MAIL_FONT};color:${B.ink};">${escapeHtml(p.name)}</td>
          <td align="right" style="white-space:nowrap;font:700 12px/1.4 ${MAIL_FONT};color:${p.done ? B.okText : B.warnText};">${p.done ? "Utført" : "Mangler"}</td>
        </tr></table>
      </td></tr>`
        )
        .join("")
    : `<tr><td style="padding:14px 16px;font:400 14px/1.4 ${MAIL_FONT};color:${B.muted};">Ingen lister var planlagt denne dagen.</td></tr>`;

  const deviationItems = d.deviations
    .map((x) => {
      const value = x.measure_unit && x.measured_value !== null ? ` &mdash; målt ${fmtNumber(x.measured_value)} ${escapeHtml(x.measure_unit)}` : "";
      return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${B.line};border-left:3px solid ${B.danger};margin-top:10px;">
        <tr><td style="padding:12px 16px;font:400 13px/1.5 ${MAIL_FONT};color:${B.ink};">
          <div style="font-weight:700;">${escapeHtml(x.checklist_name)}: ${escapeHtml(x.label)}${value}</div>
          ${x.comment ? `<div style="padding-top:4px;color:${B.ink2};">${escapeHtml(x.comment)}</div>` : ""}
          <div style="padding-top:6px;font-size:12px;color:${B.muted};">
            Meldt av ${escapeHtml(x.user_name)} &middot;
            <span style="color:${x.followup_at ? B.okText : B.warnText};font-weight:700;">${
              x.followup_at ? `fulgt opp av ${escapeHtml(x.followup_by_name)}` : "ikke fulgt opp"
            }</span>
          </div>
        </td></tr>
      </table>`;
    })
    .join("");

  const app = (process.env.PUBLIC_FRONTEND_URL || "https://www.rentlogg.no").replace(/\/$/, "");

  return mailShell(`<div style="max-width:560px;margin:0 auto;font:400 15px/1.6 ${MAIL_FONT};color:${B.ink};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:22px;">
    <tr><td style="width:34px;height:4px;background:${B.brand};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding-top:9px;font:700 12px/1 ${MAIL_FONT};letter-spacing:0.14em;color:${B.brand};">SJEKK DET</td></tr>
  </table>

  <div style="font:700 25px/1.2 ${MAIL_FONT};letter-spacing:-0.02em;">${escapeHtml(companyName)}</div>
  <div style="font:400 14px/1.5 ${MAIL_FONT};color:${B.muted};padding-top:5px;">${fmtDate(d.date)}</div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:18px 0 26px;"><tr>
    <td style="padding:0 34px 0 0;vertical-align:top;">
      <div style="font:400 11px/1.4 ${MAIL_FONT};color:${B.muted};">Lister</div>
      <div style="font:700 26px/1.2 ${MAIL_FONT};padding-top:2px;color:${d.planned.length && doneCount === d.planned.length ? B.okText : d.planned.length ? B.warnText : B.ink};">${doneCount} / ${d.planned.length}</div>
    </td>
    <td style="padding:0 34px 0 0;vertical-align:top;">
      <div style="font:400 11px/1.4 ${MAIL_FONT};color:${B.muted};">Innsendt</div>
      <div style="font:700 26px/1.2 ${MAIL_FONT};padding-top:2px;color:${B.ink};">${d.submissions.length}</div>
    </td>
    <td style="padding:0 34px 0 0;vertical-align:top;">
      <div style="font:400 11px/1.4 ${MAIL_FONT};color:${B.muted};">Avvik</div>
      <div style="font:700 26px/1.2 ${MAIL_FONT};padding-top:2px;color:${d.deviations.length ? B.dangerText : B.ink};">${d.deviations.length}</div>
    </td>
  </tr></table>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${B.line};border-radius:10px;">
    <tr><td style="padding:11px 16px;background:${B.ground};font:700 13px/1.3 ${MAIL_FONT};border-bottom:1px solid ${B.line};">Planlagte lister</td></tr>
    ${plannedRows}
  </table>

  ${d.deviations.length ? `<div style="font:700 16px/1.3 ${MAIL_FONT};margin:28px 0 0;">Avvik</div>${deviationItems}` : ""}

  ${
    d.openTotal
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:22px;background:${B.warnBg};border:1px solid ${B.warnLine};">
           <tr><td style="padding:13px 16px;font:400 13.5px/1.5 ${MAIL_FONT};color:${B.ink};">
             <strong style="color:${B.warnText};">${d.openTotal} avvik er ikke fulgt opp.</strong>
             Registrer hva som ble gjort under Sjekk det &rarr; Avvik.
           </td></tr></table>`
      : ""
  }

  <div style="margin-top:26px;"><a href="${app}/app/" style="display:inline-block;padding:11px 22px;background:${B.brand};color:#ffffff;font:700 14px/1 ${MAIL_FONT};text-decoration:none;border-radius:8px;">Åpne Sjekk det</a></div>

  <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${B.line};font:400 12px/1.6 ${MAIL_FONT};color:${B.muted};">
    Rapport fra Rentlogg. Mottakere endres av en administrator under Sjekk det &rarr; Rapport.
  </div>
</div>`);
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
