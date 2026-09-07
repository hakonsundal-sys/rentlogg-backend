import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { gatherReportPhotos, streamPhotosZip } from "../services/photos.js";
import { getRunDetail, canAccessRun } from "../services/runDetail.js";
import { safeOriginalName } from "../utils/uploads.js";

export const checklistsRouter = Router();

// Shared ownership check for the many :id-scoped run routes below (none of which had any
// cross-tenant check at all before company_id existed — any admin/manager/cleaner could touch
// any run in the whole database by guessing an id).
function getRunScoped(runId, user) {
  const run = db
    .prepare(
      `SELECT r.*, s.company_id AS site_company_id, s.client_id AS site_client_id, s.department_id AS site_department_id
       FROM checklist_runs r JOIN sites s ON s.id = r.site_id WHERE r.id = ?`
    )
    .get(runId);
  if (!run) return { status: 404, error: "Not found" };
  if (user.role === "customer") {
    const mismatch = user.department_id ? run.site_department_id !== user.department_id : run.site_client_id !== user.client_id;
    if (mismatch) return { status: 403, error: "Not allowed" };
  }
  if (user.role !== "customer" && run.site_company_id !== user.company_id) return { status: 403, error: "Not allowed" };
  return { run };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  // Phone camera photos (HDR/high-res shots especially) routinely land well past 10MB —
  // 20MB gives real-world headroom without allowing e.g. a video by mistake.
  limits: { fileSize: 20 * 1024 * 1024 },
});

// --- Templates ---

checklistsRouter.get("/templates", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const templates = db.prepare("SELECT * FROM checklist_templates WHERE company_id = ? ORDER BY name").all(req.user.company_id);
  const items = db.prepare("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort_order");
  res.json(templates.map((t) => ({ ...t, items: items.all(t.id) })));
});

checklistsRouter.post("/templates", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, items } = req.body; // items: string[]
  if (!name || !Array.isArray(items)) return res.status(400).json({ error: "name and items[] are required" });

  const info = db.prepare("INSERT INTO checklist_templates (name, company_id) VALUES (?, ?)").run(name, req.user.company_id);
  const insertItem = db.prepare("INSERT INTO checklist_template_items (template_id, label, sort_order) VALUES (?, ?, ?)");
  items.forEach((label, i) => insertItem.run(info.lastInsertRowid, label, i));

  res.status(201).json({ id: info.lastInsertRowid, name, items });
});

// --- Runs (an in-progress or completed cleaning visit) ---

// The cleaner's own past visits, enriched with avvik counts so the "Tidligere" list can show
// a "2 avvik" badge per row without a second fetch — needsResponseCount is what tells a
// cleaner they still have something to reply to from a given day.
checklistsRouter.get("/my-runs", requireAuth, requireRole("cleaner"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS site_name,
         (SELECT COUNT(*) FROM deviations d WHERE d.run_id = r.id) AS deviation_count,
         (SELECT COUNT(*) FROM deviations d WHERE d.run_id = r.id
            AND d.reply_text IS NULL AND d.status != 'resolved') AS needs_response_count
       FROM checklist_runs r
       JOIN sites s ON s.id = r.site_id
       WHERE r.cleaner_id = ?
       ORDER BY r.started_at DESC
       LIMIT 60`
    )
    .all(req.user.id);
  res.json(rows);
});

// Paginated visit history for one site — powers the customer's "Se historikk" timeline (and
// works for admin/manager too), so browsing isn't capped at the PDF report's last-20 window.
// Cursor-paginated by id (not date) since inserts happen in chronological order, so an id
// cursor is simpler and immune to same-timestamp ties that a date cursor could skip or repeat.
checklistsRouter.get("/site-runs/:siteId", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.siteId);
  if (!site) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "customer") {
    const mismatch = req.user.department_id ? site.department_id !== req.user.department_id : site.client_id !== req.user.client_id;
    if (mismatch) return res.status(403).json({ error: "Not allowed" });
  }
  if (req.user.role !== "customer" && site.company_id !== req.user.company_id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const before = req.query.before ? Number(req.query.before) : null;

  const rows = before
    ? db
        .prepare(
          `SELECT r.*, u.name AS cleaner_name,
             (SELECT COUNT(*) FROM deviations d WHERE d.run_id = r.id) AS deviation_count
           FROM checklist_runs r JOIN users u ON u.id = r.cleaner_id
           WHERE r.site_id = ? AND r.id < ?
           ORDER BY r.id DESC LIMIT ?`
        )
        .all(req.params.siteId, before, limit)
    : db
        .prepare(
          `SELECT r.*, u.name AS cleaner_name,
             (SELECT COUNT(*) FROM deviations d WHERE d.run_id = r.id) AS deviation_count
           FROM checklist_runs r JOIN users u ON u.id = r.cleaner_id
           WHERE r.site_id = ?
           ORDER BY r.id DESC LIMIT ?`
        )
        .all(req.params.siteId, limit);

  res.json({ runs: rows, hasMore: rows.length === limit });
});

checklistsRouter.get("/runs", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site_id, from, to } = req.query;
  const conditions = ["s.company_id = ?"];
  const params = [req.user.company_id];
  if (site_id) {
    conditions.push("r.site_id = ?");
    params.push(site_id);
  }
  if (from) {
    conditions.push("date(r.started_at) >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("date(r.started_at) <= ?");
    params.push(to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT r.*, s.name AS site_name, u.name AS cleaner_name FROM checklist_runs r
       JOIN sites s ON s.id = r.site_id
       JOIN users u ON u.id = r.cleaner_id
       ${where}
       ORDER BY r.started_at DESC`
    )
    .all(...params);
  res.json(rows);
});

checklistsRouter.get("/runs/:id", requireAuth, (req, res) => {
  const detail = getRunDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Not found" });
  if (!canAccessRun(detail, req.user)) return res.status(403).json({ error: "Not allowed" });
  res.json(detail);
});

checklistsRouter.get("/runs/:id/photos.zip", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { run, status, error } = getRunScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const photos = gatherReportPhotos([run]);
  if (photos.length === 0) return res.status(404).json({ error: "Ingen bilder funnet for dette besøket." });

  streamPhotosZip(res, photos, `bilder-besok-${run.id}.zip`);
});

// Same reasoning as rooms.js's stampRoomRunEdit — only marks a run as edited when it was
// already completed (a genuine retroactive change), and never touches completed_at/
// signed_initials, so the original signed record of the day stays intact.
function stampChecklistRunEdit(runId, initials) {
  if (!initials || !initials.trim()) return;
  const run = db.prepare("SELECT completed_at FROM checklist_runs WHERE id = ?").get(runId);
  if (run?.completed_at) {
    db.prepare("UPDATE checklist_runs SET edited_at = datetime('now'), edited_by_initials = ? WHERE id = ?").run(initials.trim(), runId);
  }
}

checklistsRouter.patch("/runs/:id/items/:itemId", requireAuth, requireRole("cleaner", "admin", "manager"), (req, res) => {
  const { status, error } = getRunScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const { done, initials } = req.body;
  db.prepare("UPDATE checklist_run_items SET done = ? WHERE id = ? AND run_id = ?").run(done ? 1 : 0, req.params.itemId, req.params.id);
  stampChecklistRunEdit(req.params.id, initials);
  res.json({ ok: true });
});

checklistsRouter.post("/runs/:id/complete", requireAuth, requireRole("cleaner", "admin", "manager"), (req, res) => {
  const { run, status, error } = getRunScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const initials = (req.body?.initials || "").trim();
  if (!initials) return res.status(400).json({ error: "Navn er påkrevd for å fullføre besøket." });

  db.prepare("UPDATE checklist_runs SET completed_at = datetime('now'), signed_initials = ? WHERE id = ?").run(initials, run.id);

  const hasOpenDeviation = db
    .prepare("SELECT id FROM deviations WHERE site_id = ? AND status != 'resolved'")
    .get(run.site_id);

  db.prepare("UPDATE sites SET last_cleaned_at = datetime('now'), status = ? WHERE id = ?").run(
    hasOpenDeviation ? "deviation" : "ok",
    run.site_id
  );

  res.json({ ok: true });
});

checklistsRouter.post("/runs/:id/photos", requireAuth, requireRole("cleaner", "admin", "manager"), upload.single("photo"), (req, res) => {
  const { status, error } = getRunScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'photo')" });
  const kind = req.body.kind || "general";
  const info = db
    .prepare("INSERT INTO photos (run_id, file_path, kind) VALUES (?, ?, ?)")
    .run(req.params.id, path.join("uploads", req.file.filename), kind);
  stampChecklistRunEdit(req.params.id, req.body.initials);
  res.status(201).json({ id: info.lastInsertRowid, file_path: req.file.filename });
});

checklistsRouter.delete("/runs/:id/photos/:photoId", requireAuth, requireRole("cleaner", "admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getRunScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND run_id = ?").get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: "Not found" });

  const uploadsDir = process.env.UPLOADS_DIR || "uploads";
  const absolutePath = path.join(uploadsDir, path.basename(photo.file_path));
  fs.rmSync(absolutePath, { force: true });
  db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  stampChecklistRunEdit(req.params.id, req.body?.initials);

  res.json({ ok: true });
});

// For cleaning up genuine duplicates (e.g. from the repeated-checkin bug fixed alongside this
// endpoint) — refuses to delete a run that has deviations attached rather than silently
// orphaning them, since those represent real reports that shouldn't quietly disappear.
checklistsRouter.delete("/runs/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, error } = getRunScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ error });

  const deviationCount = db.prepare("SELECT COUNT(*) AS n FROM deviations WHERE run_id = ?").get(req.params.id).n;
  if (deviationCount > 0) {
    return res.status(409).json({
      error: `${deviationCount} avvik er knyttet til dette besøket. Fjern eller flytt dem først.`,
    });
  }

  db.prepare("DELETE FROM photos WHERE run_id = ?").run(req.params.id);
  db.prepare("DELETE FROM checklist_run_items WHERE run_id = ?").run(req.params.id);
  db.prepare("DELETE FROM checklist_runs WHERE id = ?").run(req.params.id);

  res.json({ ok: true });
});
