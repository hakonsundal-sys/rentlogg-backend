import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const deviationsRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  // Phone camera photos (HDR/high-res shots especially) routinely land well past 10MB —
  // 20MB gives real-world headroom without allowing e.g. a video by mistake.
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Attaches each deviation's photos and the checklist run it was reported during (same
// site name + date a cleaner or admin would see for that visit elsewhere in the app).
function withPhotosAndRun(rows) {
  const ids = rows.map((d) => d.id);
  const photosByDeviation = {};
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`SELECT * FROM photos WHERE deviation_id IN (${placeholders})`)
      .all(...ids)
      .forEach((p) => {
        (photosByDeviation[p.deviation_id] ??= []).push(p);
      });
  }
  return rows.map((d) => ({ ...d, photos: photosByDeviation[d.id] || [] }));
}

deviationsRouter.get("/", requireAuth, (req, res) => {
  if (req.user.role === "customer") {
    const rows = db
      .prepare(
        `SELECT d.*, r.started_at AS run_started_at, rm.name AS room_name FROM deviations d
         JOIN sites s ON s.id = d.site_id
         LEFT JOIN checklist_runs r ON r.id = d.run_id
         LEFT JOIN rooms rm ON rm.id = d.room_id
         WHERE s.client_id = ?
         ORDER BY d.created_at DESC`
      )
      .all(req.user.client_id);
    return res.json(withPhotosAndRun(rows));
  }
  if (req.user.role === "cleaner") {
    const rows = db
      .prepare(
        `SELECT d.*, r.started_at AS run_started_at, rm.name AS room_name FROM deviations d
         JOIN checklist_runs r ON r.id = d.run_id
         LEFT JOIN rooms rm ON rm.id = d.room_id
         WHERE r.cleaner_id = ?
         ORDER BY d.created_at DESC`
      )
      .all(req.user.id);
    return res.json(withPhotosAndRun(rows));
  }
  const rows = db
    .prepare(
      `SELECT d.*, r.started_at AS run_started_at, rm.name AS room_name FROM deviations d
       LEFT JOIN checklist_runs r ON r.id = d.run_id
       LEFT JOIN rooms rm ON rm.id = d.room_id
       ORDER BY d.created_at DESC`
    )
    .all();
  res.json(withPhotosAndRun(rows));
});

deviationsRouter.post("/", requireAuth, requireRole("cleaner", "manager", "customer"), (req, res) => {
  const { site_id, run_id, room_id, room_task_label, title, description, priority, initials } = req.body;
  if (!site_id || !description) return res.status(400).json({ error: "site_id and description are required" });
  if (!initials || !initials.trim()) return res.status(400).json({ error: "Initialer/navn er påkrevd" });

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(site_id);
  if (!site) return res.status(404).json({ error: "Not found" });
  if (req.user.role === "customer" && site.client_id !== req.user.client_id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  // Cleaners report during their active visit and already know its run_id; customers report
  // against a room/task at any time with no notion of "the current visit," so when run_id isn't
  // given we attach the deviation to the site's most recent visit — this is what lets the
  // cleaner's past-checklists view group it under the right day without the customer needing to
  // know what a "run" is.
  let resolvedRunId = run_id || null;
  if (!resolvedRunId) {
    const latestRun = db
      .prepare("SELECT id FROM checklist_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(site_id);
    resolvedRunId = latestRun?.id || null;
  }

  const info = db
    .prepare(
      `INSERT INTO deviations (site_id, run_id, room_id, room_task_label, reported_by, reported_by_initials, title, description, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(site_id, resolvedRunId, room_id || null, room_task_label || null, req.user.id, initials.trim(), title || null, description, priority || "medium");

  db.prepare("UPDATE sites SET status = 'deviation' WHERE id = ?").run(site_id);

  res.status(201).json({ id: info.lastInsertRowid });
});

deviationsRouter.post("/:id/photos", requireAuth, requireRole("cleaner", "manager"), upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'photo')" });
  const info = db
    .prepare("INSERT INTO photos (deviation_id, file_path, kind) VALUES (?, ?, 'general')")
    .run(req.params.id, path.join("uploads", req.file.filename));
  res.status(201).json({ id: info.lastInsertRowid, file_path: req.file.filename });
});

// Sets a site back to 'ok' once it has no more open/in_progress deviations (matches existing behavior).
function recomputeSiteStatus(siteId) {
  const stillOpen = db.prepare("SELECT id FROM deviations WHERE site_id = ? AND status != 'resolved'").get(siteId);
  if (!stillOpen) db.prepare("UPDATE sites SET status = 'ok' WHERE id = ?").run(siteId);
}

const DEVIATION_PATCH_FIELDS = ["title", "description", "priority"];

deviationsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const deviation = db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id);
  if (!deviation) return res.status(404).json({ error: "Not found" });

  const fields = DEVIATION_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length) {
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => req.body[f]);
    db.prepare(`UPDATE deviations SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
  }

  if ("status" in req.body) {
    const { status } = req.body;
    if (!["open", "in_progress", "resolved"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    db.prepare(
      "UPDATE deviations SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END WHERE id = ?"
    ).run(status, status, req.params.id);
    recomputeSiteStatus(deviation.site_id);
  }

  res.json(db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id));
});

const REPLY_ACTIONS = ["resolve", "assign_manager", "assign_customer"];

// Lets a cleaner (or manager) respond to an avvik: always a written reply + a typed signature,
// then a routing decision — close it themselves, or hand it off to a manager or back to the
// customer. Not restricted to the run's original cleaner_id — a day's run is shared per site
// (see canAccessRun in runDetail.js), so whichever cleaner is actually on site today needs to be
// able to reply, not just whoever happened to check in first.
deviationsRouter.patch("/:id/reply", requireAuth, requireRole("cleaner", "manager"), (req, res) => {
  const deviation = db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id);
  if (!deviation) return res.status(404).json({ error: "Not found" });

  const { reply_text, initials, action } = req.body;
  if (!reply_text || !reply_text.trim()) return res.status(400).json({ error: "Svar er påkrevd" });
  if (!initials || !initials.trim()) return res.status(400).json({ error: "Initialer/navn er påkrevd" });
  if (!REPLY_ACTIONS.includes(action)) return res.status(400).json({ error: "Invalid action" });

  db.prepare(
    "UPDATE deviations SET reply_text = ?, replied_by_initials = ?, replied_at = datetime('now') WHERE id = ?"
  ).run(reply_text.trim(), initials.trim(), req.params.id);

  if (action === "resolve") {
    db.prepare(
      "UPDATE deviations SET status = 'resolved', resolved_at = datetime('now'), assigned_to = NULL WHERE id = ?"
    ).run(req.params.id);
    recomputeSiteStatus(deviation.site_id);
  } else {
    const assignedTo = action === "assign_manager" ? "manager" : "customer";
    db.prepare(
      "UPDATE deviations SET assigned_to = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?"
    ).run(assignedTo, req.params.id);
  }

  res.json(db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id));
});

// Lets the customer put an active, signed confirmation on a resolved avvik ("yes, this is
// fixed") instead of just passively seeing it disappear — stronger documentation for both
// sides than a status flip nobody outside the cleaner/admin ever explicitly agreed to.
deviationsRouter.patch("/:id/approve", requireAuth, requireRole("customer"), (req, res) => {
  const deviation = db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id);
  if (!deviation) return res.status(404).json({ error: "Not found" });

  const site = db.prepare("SELECT client_id FROM sites WHERE id = ?").get(deviation.site_id);
  if (!site || site.client_id !== req.user.client_id) return res.status(403).json({ error: "Not allowed" });

  if (deviation.status !== "resolved") {
    return res.status(400).json({ error: "Avviket er ikke løst ennå." });
  }

  const { initials } = req.body;
  if (!initials || !initials.trim()) return res.status(400).json({ error: "Initialer/navn er påkrevd" });

  db.prepare(
    "UPDATE deviations SET customer_approved_at = datetime('now'), customer_approved_by_initials = ? WHERE id = ?"
  ).run(initials.trim(), req.params.id);

  res.json(db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id));
});

deviationsRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const deviation = db.prepare("SELECT * FROM deviations WHERE id = ?").get(req.params.id);
  if (!deviation) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM photos WHERE deviation_id = ?").run(req.params.id);
  db.prepare("DELETE FROM deviations WHERE id = ?").run(req.params.id);
  recomputeSiteStatus(deviation.site_id);

  res.json({ ok: true });
});
