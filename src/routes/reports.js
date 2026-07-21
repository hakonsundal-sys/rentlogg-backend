import { Router } from "express";
import PDFDocument from "pdfkit";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

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

  doc.end();
});
