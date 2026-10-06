import { Router } from "express";
import PDFDocument from "pdfkit";
import { ZipArchive } from "archiver";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { digestRunLimiter } from "../middleware/rateLimits.js";
import { computeMonthlyReport } from "../services/schedule.js";
import { csvEscape } from "../utils/csv.js";
import { gatherReportPhotos, streamPhotosZip } from "../services/photos.js";
import { getRunDetail, canAccessRun } from "../services/runDetail.js";
import { buildReportHtml, buildReportPdf } from "../services/runReport.js";
import { sendDailyReports } from "../services/dailyReportJob.js";
import { yesterdayInOslo } from "../services/schedule.js";

const PHOTO_KIND_LABELS = { before: "Før", after: "Etter", general: "Generelt" };

export const reportsRouter = Router();

reportsRouter.get("/sites/:id/pdf", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });

  if (req.user.role === "customer" && site.client_id !== req.user.client_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }
  if (req.user.role !== "customer" && site.company_id !== req.user.company_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }

  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(site.client_id);
  const runs = db
    .prepare("SELECT * FROM checklist_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 20")
    .all(site.id);
  const deviations = db
    .prepare("SELECT * FROM deviations WHERE site_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(site.id);

  const photos = gatherReportPhotos(runs).sort((a, b) => b.created_at.localeCompare(a.created_at));

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=rapport-${site.id}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(18).text(site.name, { continued: false });
  doc.fontSize(11).fillColor("gray").text(client ? client.name : "");
  doc.moveDown();

  doc.fillColor("black").fontSize(13).text("Utførte oppdrag");
  doc.moveDown(0.5);
  runs.forEach((run) => {
    const status = run.completed_at ? "Fullført" : "Pågår";
    const signed = run.signed_initials ? ` — signert ${run.signed_initials}` : "";
    doc.fontSize(10).text(`${run.started_at} — ${status}${run.gps_verified ? " — posisjon bekreftet" : ""}${signed}`);
  });
  if (runs.length === 0) doc.fontSize(10).fillColor("gray").text("Ingen registrerte oppdrag ennå.");

  doc.moveDown();
  doc.fillColor("black").fontSize(13).text("Avvik");
  doc.moveDown(0.5);
  deviations.forEach((d) => {
    doc.fontSize(10).text(`${d.created_at} — [${d.priority}] ${d.description} (${d.status})`);
  });
  if (deviations.length === 0) doc.fontSize(10).fillColor("gray").text("Ingen registrerte avvik.");

  doc.moveDown();
  doc.fillColor("black").fontSize(13).text("Bilder");
  doc.moveDown(0.5);
  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  let embeddedAny = false;
  photos.forEach((photo) => {
    const absolutePath = path.join(uploadsDir, path.basename(photo.file_path));
    if (!fs.existsSync(absolutePath)) return;
    embeddedAny = true;
    if (doc.y > doc.page.height - 250) doc.addPage();
    doc.fontSize(9).fillColor("gray").text(`${photo.created_at} — ${PHOTO_KIND_LABELS[photo.kind] || photo.kind}`);
    // pdfkit reads only JPEG and PNG. A photo in any other format (a HEIC the server could not
    // convert, a corrupt file) makes image() throw — and by now the response is already streaming,
    // so that throw left the PDF half-written and, unhandled, ended the whole process.
    try {
      doc.image(absolutePath, { fit: [220, 220] });
    } catch {
      doc.fontSize(9).fillColor("gray").text("(bildet kan ikke vises i PDF-en)");
    }
    doc.moveDown();
  });
  if (!embeddedAny) doc.fontSize(10).fillColor("gray").text("Ingen bilder tilgjengelig.");

  doc.end();
});

reportsRouter.get("/sites/:id/photos.zip", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });

  if (req.user.role === "customer" && site.client_id !== req.user.client_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }
  if (req.user.role !== "customer" && site.company_id !== req.user.company_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }

  const runs = db
    .prepare("SELECT * FROM checklist_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 20")
    .all(site.id);
  const photos = gatherReportPhotos(runs);
  if (photos.length === 0) return res.status(404).json({ code: "no_photos", error: "Ingen bilder tilgjengelig." });

  streamPhotosZip(res, photos, `bilder-${site.id}.zip`);
});

// Landax-style single-visit inspection report — numbered room sections with checked-off tasks
// and photos, distinct from the rolling multi-visit summary above. Ready to view/copy as an
// email body (buildReportHtml) or download as a PDF; both share the same detail-gathering and
// access-scoping as GET /checklists/runs/:id via runDetail.js.
reportsRouter.get("/runs/:id/html", requireAuth, async (req, res) => {
  const detail = getRunDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (!canAccessRun(detail, req.user)) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(await buildReportHtml(detail));
});

reportsRouter.get("/runs/:id/pdf", requireAuth, (req, res) => {
  const detail = getRunDetail(req.params.id);
  if (!detail) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (!canAccessRun(detail, req.user)) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=rapport-besok-${detail.id}.pdf`);
  buildReportPdf(detail, res);
});

// Manual trigger for the daily digest — lets an admin verify/re-send for a specific date
// (optionally scoped to one site) without waiting for the 07:00 scheduler.
reportsRouter.post("/daily-digest/run", requireAuth, requireRole("admin"), digestRunLimiter, async (req, res) => {
  const dateStr = req.body?.date || yesterdayInOslo();
  const results = await sendDailyReports(dateStr, req.body?.site_id || undefined, req.user.company_id, req.body?.recipients || undefined);
  res.json({ date: dateStr, ...results });
});

function parseSummaryQuery(req) {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const siteId = req.query.site_id ? Number(req.query.site_id) : undefined;
  const departmentId = req.query.department_id ? Number(req.query.department_id) : undefined;
  return { month, siteId, departmentId };
}

reportsRouter.get("/summary", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(computeMonthlyReport({ ...parseSummaryQuery(req), companyId: req.user.company_id }));
});

const STATUS_LABELS = { completed: "Fullført", in_progress: "Pågår", missing: "Manglende" };

reportsRouter.get("/summary.csv", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { month, siteId, departmentId } = parseSummaryQuery(req);
  const { rows } = computeMonthlyReport({ month, siteId, departmentId, companyId: req.user.company_id });

  const header = ["Dato", "Lokasjon", "Planlagt", "Rom", "Oppgaver"];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.site_name,
        STATUS_LABELS[row.status] || row.status,
        row.room_count,
        `${row.tasksCompleted}/${row.tasksTotal}`,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const csv = `﻿${lines.join("\r\n")}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=rapport-${month}.csv`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Revisjonssporet
// ---------------------------------------------------------------------------

// quality_log var fram til nå skrive-bare: hendelsene ble samvittighetsfullt lagret, og ingen
// kunne lese dem uten å åpne databasen. Et revisjonsspor ingen kan slå opp i er ikke et
// revisjonsspor — det er en logg man håper man aldri trenger.
//
// Låst til admin/manager: raden inneholder hvem som gjorde hva, altså personopplysninger om
// ansatte. En kunde skal se sin egen dokumentasjon, ikke hvem hos leverandøren som rettet den.
const QUALITY_ACTION_LABELS = {
  deviation_reported: "Avvik meldt",
  deviation_immediate: "Strakstiltak registrert",
  deviation_cause: "Årsak registrert",
  deviation_corrective: "Korrigerende tiltak registrert",
  deviation_closed: "Avvik lukket med signatur",
  deviation_categorised: "Avvikskategori satt",
  deviation_due_date: "Frist satt",
  room_controlled: "Rom etterkontrollert",
  deviation_deleted: "Avvik slettet",
  released_out_of_limits: "Frigitt tross måling utenfor grensen",
  approval_override: "Godkjent på kundens vegne",
  photo_deleted: "Bilde slettet",
  room_deleted: "Rom slettet",
  site_deleted: "Lokasjon slettet",
  time_entry_deleted: "Timeføring slettet",
};

function parseAuditQuery(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : null;
  const siteId = req.query.site_id ? Number(req.query.site_id) : null;
  const action = typeof req.query.action === "string" && req.query.action ? req.query.action : null;
  return { from, to, siteId: Number.isFinite(siteId) ? siteId : null, action };
}

function queryQualityLog({ companyId, from, to, siteId, action, limit = 500 }) {
  const where = ["q.company_id = ?"];
  const params = [companyId];
  // date(occurred_at) så en fra/til-dato tar hele dagen, ikke bare midnatt.
  if (from) { where.push("date(q.occurred_at) >= ?"); params.push(from); }
  if (to) { where.push("date(q.occurred_at) <= ?"); params.push(to); }
  if (siteId) { where.push("q.site_id = ?"); params.push(siteId); }
  if (action) { where.push("q.action = ?"); params.push(action); }

  return db
    .prepare(
      `SELECT q.*, s.name AS site_name, r.name AS room_name
       FROM quality_log q
       LEFT JOIN sites s ON s.id = q.site_id
       LEFT JOIN rooms r ON r.id = q.room_id
       WHERE ${where.join(" AND ")}
       ORDER BY q.occurred_at DESC, q.id DESC
       LIMIT ?`
    )
    .all(...params, limit)
    .map((row) => ({ ...row, action_label: QUALITY_ACTION_LABELS[row.action] || row.action }));
}

reportsRouter.get("/quality-log", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(queryQualityLog({ companyId: req.user.company_id, ...parseAuditQuery(req) }));
});

reportsRouter.get("/quality-log.csv", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const rows = queryQualityLog({ companyId: req.user.company_id, ...parseAuditQuery(req), limit: 10000 });
  const header = ["Tidspunkt", "Hendelse", "Lokasjon", "Rom", "Utført av", "Før", "Etter", "Kommentar"];
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [r.occurred_at, r.action_label, r.site_name || "", r.room_name || "", r.user_name || "",
       r.before_value || "", r.after_value || "", r.comment || ""]
        .map(csvEscape)
        .join(",")
    );
  }
  // BOM, som summary.csv: uten den viser Excel på norsk Windows æøå som kråketær.
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="revisjonsspor.csv"');
  res.send(`\ufeff${lines.join("\r\n")}`);
});

export { queryQualityLog, QUALITY_ACTION_LABELS };

// ---------------------------------------------------------------------------
// Revisjonsklar eksport
// ---------------------------------------------------------------------------

// «Alt for denne lokasjonen i denne perioden, i én fil.»
//
// Finnes fordi delene allerede lå her hver for seg — besøksrapporter, bilde-zip, sammendrag,
// revisjonsspor — og det å samle dem var en halvtimes klikking noen måtte gjøre mens en
// inspektør ventet i resepsjonen. Dette er den halvtimen.
//
// Innholdet er bevisst flatt og lesbart uten Rentlogg: en PDF noen kan bla i, og CSV-er som
// åpner i Excel. En revisjonseksport som krever vårt eget system for å leses er ikke
// revisjonsklar.
function isOutsideLimit(m) {
  if (m.measured_value === null || m.measured_value === undefined) return false;
  const under = m.measure_min !== null && m.measure_min !== undefined && m.measured_value < m.measure_min;
  const over = m.measure_max !== null && m.measure_max !== undefined && m.measured_value > m.measure_max;
  return under || over;
}

// hideStaffNames: the caller is a customer. The audit trail is locked to admin/manager everywhere
// else because each row says WHICH employee did a thing (see the comment above QUALITY_ACTION_LABELS),
// and this ZIP used to hand customers the same file with the "Utført av" column intact. The events
// themselves stay — they are the point of an audit export — only the person behind each one goes.
function sendAuditZip(res, { site, from, to, companyName, hideStaffNames = false }) {
  const runs = db
    .prepare(
      `SELECT * FROM checklist_runs
       WHERE site_id = ? AND date(started_at) BETWEEN ? AND ?
       ORDER BY started_at`
    )
    .all(site.id, from, to);

  const deviations = db
    .prepare(
      `SELECT * FROM deviations
       WHERE site_id = ? AND date(created_at) BETWEEN ? AND ?
       ORDER BY created_at`
    )
    .all(site.id, from, to);

  // Målingene i perioden, med grensene som gjaldt DA de ble tatt — de ligger på besøket, ikke
  // på dagens oppgavemal. Se room_run_items.measure_* i db.js.
  const measurements = db
    .prepare(
      `SELECT rr.started_at, r.name AS room_name, i.label, i.measured_value, i.measure_unit,
              i.measure_min, i.measure_max, i.measured_at
       FROM room_run_items i
       JOIN room_runs rr ON rr.id = i.room_run_id
       JOIN rooms r ON r.id = rr.room_id
       WHERE r.site_id = ? AND i.measure_unit IS NOT NULL
         AND date(rr.started_at) BETWEEN ? AND ?
       ORDER BY rr.started_at, r.name`
    )
    .all(site.id, from, to);

  const auditRows = queryQualityLog({
    companyId: site.company_id, from, to, siteId: site.id, action: null, limit: 10000,
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=revisjon-${site.id}-${from}_${to}.zip`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Audit zip error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  // --- forsiden, som PDF ---
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  archive.append(doc, { name: "revisjonsrapport.pdf" });

  const outside = measurements.filter(isOutsideLimit);
  const within = measurements.filter((m) => m.measured_value !== null && !isOutsideLimit(m)).length;

  doc.fontSize(20).fillColor("#6d28d9").text("Revisjonsdokumentasjon");
  doc.moveDown(0.3);
  doc.fontSize(13).fillColor("#71717a").text(`${site.name} · ${from} til ${to}`);
  if (companyName) doc.fontSize(10).text(companyName);
  doc.moveDown(1);

  doc.fontSize(11).fillColor("#18181b");
  doc.text(`Besøk i perioden: ${runs.length}`);
  doc.text(`Avvik meldt: ${deviations.length} (lukket med signatur: ${deviations.filter((d) => d.closed_at).length})`);
  doc.text(`Måleresultater: ${measurements.length} (innenfor: ${within}, utenfor: ${outside.length})`);
  doc.text(`Hendelser i revisjonssporet: ${auditRows.length}`);
  doc.moveDown(1);

  if (outside.length > 0) {
    doc.fontSize(13).fillColor("#dc2626").text("Målinger utenfor grensen");
    doc.moveDown(0.3);
    outside.forEach((m) => {
      if (doc.y > doc.page.height - 80) doc.addPage();
      const grense = m.measure_max !== null && m.measure_max !== undefined ? `maks ${m.measure_max}` : `minst ${m.measure_min}`;
      doc.fontSize(10).fillColor("#18181b").text(
        `${String(m.started_at).slice(0, 10)} · ${m.room_name} · ${m.label}: ${m.measured_value} ${m.measure_unit} (${grense})`
      );
    });
    doc.moveDown(1);
  }

  if (deviations.length > 0) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.fontSize(13).fillColor("#18181b").text("Avvik");
    doc.moveDown(0.4);
    deviations.forEach((d) => {
      if (doc.y > doc.page.height - 150) doc.addPage();
      doc.fontSize(11).fillColor("#18181b").text(`${String(d.created_at).slice(0, 10)} · ${d.title || "Avvik"} (${d.priority})`);
      doc.fontSize(9.5).fillColor("#71717a").text(d.description || "", { indent: 12 });
      const steg = [
        ["Strakstiltak", d.immediate_action, d.immediate_action_by, d.immediate_action_at],
        ["Årsak", d.root_cause, d.root_cause_by, d.root_cause_at],
        ["Korrigerende tiltak", d.corrective_action, d.corrective_action_by, d.corrective_action_at],
      ];
      steg.forEach((rad) => {
        const [navn, tekst, av, nar] = rad;
        if (!tekst) return;
        doc.fontSize(9.5).fillColor("#18181b").text(
          `${navn}: ${tekst} — ${av || "?"}, ${String(nar || "").slice(0, 16)}`,
          { indent: 12 }
        );
      });
      doc.fontSize(9.5).fillColor(d.closed_at ? "#16a34a" : "#d97706").text(
        d.closed_at ? `Lukket og signert av ${d.closed_signature}, ${String(d.closed_at).slice(0, 16)}` : "Ikke lukket",
        { indent: 12 }
      );
      doc.moveDown(0.5);
    });
  }
  doc.end();

  // --- CSV-ene ---
  const measHeader = ["Dato", "Rom", "Måling", "Verdi", "Enhet", "Nedre grense", "Øvre grense", "Vurdering", "Registrert"];
  const measLines = [measHeader.map(csvEscape).join(",")];
  measurements.forEach((m) => {
    measLines.push(
      [
        String(m.started_at).slice(0, 10), m.room_name, m.label,
        m.measured_value === null || m.measured_value === undefined ? "" : m.measured_value,
        m.measure_unit,
        m.measure_min === null || m.measure_min === undefined ? "" : m.measure_min,
        m.measure_max === null || m.measure_max === undefined ? "" : m.measure_max,
        m.measured_value === null || m.measured_value === undefined
          ? "Ikke registrert"
          : isOutsideLimit(m) ? "Utenfor" : "Innenfor",
        m.measured_at || "",
      ].map(csvEscape).join(",")
    );
  });
  archive.append(`﻿${measLines.join("\r\n")}`, { name: "malinger.csv" });

  const auditHeader = hideStaffNames
    ? ["Tidspunkt", "Hendelse", "Rom", "Før", "Etter", "Kommentar"]
    : ["Tidspunkt", "Hendelse", "Rom", "Utført av", "Før", "Etter", "Kommentar"];
  const auditLines = [auditHeader.map(csvEscape).join(",")];
  auditRows.forEach((r) => {
    auditLines.push(
      [
        r.occurred_at, r.action_label, r.room_name || "", ...(hideStaffNames ? [] : [r.user_name || ""]),
        r.before_value || "", r.after_value || "", r.comment || "",
      ].map(csvEscape).join(",")
    );
  });
  archive.append(`﻿${auditLines.join("\r\n")}`, { name: "revisjonsspor.csv" });

  // --- bildene ---
  const photos = gatherReportPhotos(runs);
  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  const used = new Set();
  photos.forEach((photo) => {
    const abs = path.join(uploadsDir, path.basename(photo.file_path));
    if (!fs.existsSync(abs)) return;
    let name = path.basename(photo.file_path);
    while (used.has(name)) name = `${Date.now()}-${name}`;
    used.add(name);
    archive.file(abs, { name: `bilder/${name}` });
  });

  archive.finalize();
}

reportsRouter.get("/sites/:id/revisjon.zip", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (req.user.role === "customer" && site.client_id !== req.user.client_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }
  if (req.user.role !== "customer" && site.company_id !== req.user.company_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }

  const { from, to } = parseAuditQuery(req);
  if (!from || !to) {
    return res.status(400).json({ code: "period_required", error: "Oppgi fra- og til-dato (YYYY-MM-DD)." });
  }
  if (from > to) return res.status(400).json({ code: "period_reversed", error: "Fra-dato må være før til-dato." });

  const company = db.prepare("SELECT name FROM companies WHERE id = ?").get(site.company_id);
  sendAuditZip(res, { site, from, to, companyName: company?.name, hideStaffNames: req.user.role === "customer" });
});
