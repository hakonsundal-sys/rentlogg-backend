import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const checklistsRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Templates ---

checklistsRouter.get("/templates", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const templates = db.prepare("SELECT * FROM checklist_templates ORDER BY name").all();
  const items = db.prepare("SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY sort_order");
  res.json(templates.map((t) => ({ ...t, items: items.all(t.id) })));
});

checklistsRouter.post("/templates", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, items } = req.body; // items: string[]
  if (!name || !Array.isArray(items)) return res.status(400).json({ error: "name and items[] are required" });

  const info = db.prepare("INSERT INTO checklist_templates (name) VALUES (?)").run(name);
  const insertItem = db.prepare("INSERT INTO checklist_template_items (template_id, label, sort_order) VALUES (?, ?, ?)");
  items.forEach((label, i) => insertItem.run(info.lastInsertRowid, label, i));

  res.status(201).json({ id: info.lastInsertRowid, name, items });
});

// --- Runs (an in-progress or completed cleaning visit) ---

checklistsRouter.get("/runs/:id", requireAuth, (req, res) => {
  const run = db.prepare("SELECT * FROM checklist_runs WHERE id = ?").get(req.params.id);
  if (!run) return res.status(404).json({ error: "Not found" });
  const items = db.prepare("SELECT * FROM checklist_run_items WHERE run_id = ? ORDER BY sort_order").all(run.id);
  const photos = db.prepare("SELECT * FROM photos WHERE run_id = ?").all(run.id);
  res.json({ ...run, items, photos });
});

checklistsRouter.patch("/runs/:id/items/:itemId", requireAuth, requireRole("cleaner"), (req, res) => {
  const { done } = req.body;
  db.prepare("UPDATE checklist_run_items SET done = ? WHERE id = ? AND run_id = ?").run(done ? 1 : 0, req.params.itemId, req.params.id);
  res.json({ ok: true });
});

checklistsRouter.post("/runs/:id/complete", requireAuth, requireRole("cleaner"), (req, res) => {
  const run = db.prepare("SELECT * FROM checklist_runs WHERE id = ?").get(req.params.id);
  if (!run) return res.status(404).json({ error: "Not found" });

  db.prepare("UPDATE checklist_runs SET completed_at = datetime('now') WHERE id = ?").run(run.id);

  const hasOpenDeviation = db
    .prepare("SELECT id FROM deviations WHERE site_id = ? AND status != 'resolved'")
    .get(run.site_id);

  db.prepare("UPDATE sites SET last_cleaned_at = datetime('now'), status = ? WHERE id = ?").run(
    hasOpenDeviation ? "deviation" : "ok",
    run.site_id
  );

  res.json({ ok: true });
});

checklistsRouter.post("/runs/:id/photos", requireAuth, requireRole("cleaner"), upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'photo')" });
  const kind = req.body.kind || "general";
  const info = db
    .prepare("INSERT INTO photos (run_id, file_path, kind) VALUES (?, ?, ?)")
    .run(req.params.id, path.join("uploads", req.file.filename), kind);
  res.status(201).json({ id: info.lastInsertRowid, file_path: req.file.filename });
});
