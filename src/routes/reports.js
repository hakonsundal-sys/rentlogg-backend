import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { computeMonthlyReport } from "../services/schedule.js";

const PHOTO_KIND_LABELS = { before: "Før", after: "Etter", general: "Generelt" };

export const reportsRouter = Router();

reportsRouter.get("/sites/:id/pdf", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Not found" });

  if (req.user.role === "customer" && site.client_id !== req.user.client_id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(site.client_id);
  const runs = db
    .prepare("SELECT * FROM checklist_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 20")
    .all(site.id);
  const deviations = db
    .prepare("SELECT * FROM deviations WHERE site_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(site.id);

  const runIds = runs.map((r) => r.id);
  const photos = runIds.length
    ? db
        .prepare(`SELECT * FROM photos WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY created_at DESC`)
        .all(...runIds)
    : [];

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
    doc.fontSize(10).text(`${run.started_at} — ${status}${run.gps_verified ? " — posisjon bekreftet" : ""}`);
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
    doc.image(absolutePath, { fit: [220, 220] });
    doc.moveDown();
  });
  if (!embeddedAny) doc.fontSize(10).fillColor("gray").text("Ingen bilder tilgjengelig.");

  doc.end();
});

function parseSummaryQuery(req) {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const siteId = req.query.site_id ? Number(req.query.site_id) : undefined;
  return { month, siteId };
}

reportsRouter.get("/summary", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(computeMonthlyReport(parseSummaryQuery(req)));
});

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const STATUS_LABELS = { completed: "Fullført", in_progress: "Pågår", missing: "Manglende" };

reportsRouter.get("/summary.csv", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { month, siteId } = parseSummaryQuery(req);
  const { rows } = computeMonthlyReport({ month, siteId });

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
