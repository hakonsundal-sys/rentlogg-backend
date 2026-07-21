import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const deviationsRouter = Router();

deviationsRouter.get("/", requireAuth, (req, res) => {
  if (req.user.role === "customer") {
    const rows = db
      .prepare(
        `SELECT d.* FROM deviations d
         JOIN sites s ON s.id = d.site_id
         WHERE s.client_id = ?
         ORDER BY d.created_at DESC`
      )
      .all(req.user.client_id);
    return res.json(rows);
  }
  res.json(db.prepare("SELECT * FROM deviations ORDER BY created_at DESC").all());
});

deviationsRouter.post("/", requireAuth, requireRole("cleaner", "manager"), (req, res) => {
  const { site_id, run_id, description, priority } = req.body;
  if (!site_id || !description) return res.status(400).json({ error: "site_id and description are required" });

  const info = db
    .prepare("INSERT INTO deviations (site_id, run_id, reported_by, description, priority) VALUES (?, ?, ?, ?, ?)")
    .run(site_id, run_id || null, req.user.id, description, priority || "medium");

  db.prepare("UPDATE sites SET status = 'deviation' WHERE id = ?").run(site_id);

  res.status(201).json({ id: info.lastInsertRowid });
});

deviationsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status } = req.body;
  if (!["open", "in_progress", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  db.prepare(
    "UPDATE deviations SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END WHERE id = ?"
  ).run(status, status, req.params.id);

  const deviation = db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id);
  const stillOpen = db
    .prepare("SELECT id FROM deviations WHERE site_id = ? AND status != 'resolved'")
    .get(deviation.site_id);

  if (!stillOpen) {
    db.prepare("UPDATE sites SET status = 'ok' WHERE id = ?").run(deviation.site_id);
  }

  res.json({ ok: true });
});
