import { Router } from "express";
import multer from "multer";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import { getRoomsForSite, findOrCreateTodayRoomRun } from "../services/rooms.js";

export const siteRoomsRouter = Router({ mergeParams: true });
export const roomsRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MAX_EXTRACTED_TEXT_CHARS = 15000;

const SUBMIT_ROOMS_TOOL = {
  name: "submit_rooms",
  description: "Submit the rooms and cleaning tasks extracted from a cleaning plan document.",
  input_schema: {
    type: "object",
    properties: {
      rooms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Room or area name, e.g. 'Kjøkken' or 'Gulv ekspedisjon'" },
            tasks: { type: "array", items: { type: "string" }, description: "Cleaning tasks for this room" },
          },
          required: ["name", "tasks"],
        },
      },
    },
    required: ["rooms"],
  },
};

function isValidRoomsShape(rooms) {
  return (
    Array.isArray(rooms) &&
    rooms.every(
      (r) => r && typeof r.name === "string" && Array.isArray(r.tasks) && r.tasks.every((t) => typeof t === "string")
    )
  );
}

// --- Site-scoped: /sites/:siteId/rooms ---

siteRoomsRouter.get("/", requireAuth, (req, res) => {
  res.json(getRoomsForSite(req.params.siteId, todayInOslo()));
});

siteRoomsRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, interval_days } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM rooms WHERE site_id = ?").get(req.params.siteId).n;
  const info = db
    .prepare("INSERT INTO rooms (site_id, name, sort_order, interval_days) VALUES (?, ?, ?, ?)")
    .run(req.params.siteId, name, nextSort, interval_days ?? null);

  res.status(201).json(db.prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid));
});

siteRoomsRouter.post("/complete-all-due", requireAuth, requireRole("cleaner"), (req, res) => {
  const today = todayInOslo();
  const dueIncomplete = getRoomsForSite(req.params.siteId, today).filter((r) => r.dueToday && r.status !== "completed");

  const completeAll = db.transaction((rooms) => {
    let completedCount = 0;
    for (const room of rooms) {
      const run = findOrCreateTodayRoomRun(room.id, req.user.id);
      db.prepare("UPDATE room_run_items SET done = 1 WHERE room_run_id = ?").run(run.id);
      db.prepare("UPDATE room_runs SET completed_at = datetime('now') WHERE id = ?").run(run.id);
      completedCount++;
    }
    return completedCount;
  });

  res.json({ completedCount: completeAll(dueIncomplete) });
});

// --- AI PDF import: proposes rooms/tasks without persisting them ---

siteRoomsRouter.post("/import-pdf", requireAuth, requireRole("admin", "manager"), pdfUpload.single("pdf"), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI-import er ikke konfigurert ennå." });
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'pdf')" });

  let text;
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    await parser.destroy();
    text = (result.text || "").trim();
  } catch {
    return res.status(422).json({ error: "Kunne ikke lese PDF-en. Sjekk at filen ikke er skadet." });
  }

  if (text.length < 20) {
    return res.status(422).json({
      error: "Fant ingen lesbar tekst i PDF-en. Prøv en tekstbasert PDF, eller legg til rom manuelt.",
    });
  }
  text = text.slice(0, MAX_EXTRACTED_TEXT_CHARS);

  let message;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      tools: [SUBMIT_ROOMS_TOOL],
      tool_choice: { type: "tool", name: "submit_rooms" },
      messages: [
        {
          role: "user",
          content:
            "This is the text of a cleaning plan document for a commercial site (may be in Norwegian). " +
            "Extract every room or area mentioned and the cleaning tasks for each. If a room has no " +
            "explicit task list, use a single sensible general task. Call submit_rooms with the result.\n\n" +
            text,
        },
      ],
    });
  } catch (err) {
    console.error("Anthropic API error:", err);
    return res.status(502).json({ error: "Kunne ikke kontakte AI-tjenesten. Prøv igjen senere." });
  }

  const toolUse = message.content.find((block) => block.type === "tool_use" && block.name === "submit_rooms");
  const rooms = toolUse?.input?.rooms;
  if (!isValidRoomsShape(rooms)) {
    return res.status(502).json({ error: "Kunne ikke tolke resultatet fra AI-analysen." });
  }

  res.json({ rooms });
});

siteRoomsRouter.post("/import-confirm", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { rooms } = req.body;
  if (!isValidRoomsShape(rooms)) return res.status(400).json({ error: "rooms[] with name/tasks[] is required" });

  const siteId = req.params.siteId;
  const insertRoom = db.prepare("INSERT INTO rooms (site_id, name, sort_order) VALUES (?, ?, ?)");
  const insertItem = db.prepare("INSERT INTO room_checklist_items (room_id, label, sort_order) VALUES (?, ?, ?)");

  const importAll = db.transaction((roomsToImport) => {
    let nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM rooms WHERE site_id = ?").get(siteId).n;
    const created = [];
    for (const room of roomsToImport) {
      if (!room.name.trim()) continue;
      const info = insertRoom.run(siteId, room.name, nextSort++);
      room.tasks.forEach((label, i) => {
        if (label.trim()) insertItem.run(info.lastInsertRowid, label, i);
      });
      created.push(db.prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid));
    }
    return created;
  });

  res.status(201).json({ rooms: importAll(rooms) });
});

// --- Room-scoped: /rooms/:id ---

const ROOM_PATCH_FIELDS = ["name", "interval_days"];

roomsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const fields = ROOM_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  const updateRoom = db.transaction(() => {
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => req.body[f]);
    db.prepare(`UPDATE rooms SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    if ("interval_days" in req.body && req.body.interval_days != null) {
      db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(req.params.id);
    }
  });
  updateRoom();

  res.json(db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id));
});

roomsRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Not found" });

  const deleteCascade = db.transaction((roomId) => {
    const runIds = db.prepare("SELECT id FROM room_runs WHERE room_id = ?").all(roomId).map((r) => r.id);
    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM photos WHERE room_run_id IN (${placeholders})`).run(...runIds);
      db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${placeholders})`).run(...runIds);
    }
    db.prepare("DELETE FROM room_runs WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM room_checklist_items WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  });

  deleteCascade(req.params.id);
  res.json({ ok: true });
});

// --- Room task template ---

roomsRouter.get("/:id/items", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM room_checklist_items WHERE room_id = ? ORDER BY sort_order").all(req.params.id));
});

roomsRouter.post("/:id/items", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: "label is required" });

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM room_checklist_items WHERE room_id = ?").get(req.params.id).n;
  const info = db
    .prepare("INSERT INTO room_checklist_items (room_id, label, sort_order) VALUES (?, ?, ?)")
    .run(req.params.id, label, nextSort);

  res.status(201).json(db.prepare("SELECT * FROM room_checklist_items WHERE id = ?").get(info.lastInsertRowid));
});

roomsRouter.delete("/:id/items/:itemId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  db.prepare("DELETE FROM room_checklist_items WHERE id = ? AND room_id = ?").run(req.params.itemId, req.params.id);
  res.json({ ok: true });
});

// --- Room schedule (weekday mode) ---

roomsRouter.get("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT sch.id, sch.weekday, sch.assigned_cleaner_id, u.name AS assigned_cleaner_name
       FROM room_schedules sch
       LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
       WHERE sch.room_id = ?
       ORDER BY sch.weekday`
    )
    .all(req.params.id);
  res.json(rows);
});

roomsRouter.post("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { weekday, assigned_cleaner_id } = req.body;
  if (weekday === undefined || weekday === null || weekday < 0 || weekday > 6) {
    return res.status(400).json({ error: "weekday (0-6) is required" });
  }

  const upsert = db.transaction(() => {
    db.prepare("UPDATE rooms SET interval_days = NULL WHERE id = ?").run(req.params.id);
    db.prepare(
      `INSERT INTO room_schedules (room_id, weekday, assigned_cleaner_id) VALUES (?, ?, ?)
       ON CONFLICT(room_id, weekday) DO UPDATE SET assigned_cleaner_id = excluded.assigned_cleaner_id`
    ).run(req.params.id, weekday, assigned_cleaner_id || null);
  });
  upsert();

  const row = db
    .prepare(
      `SELECT sch.id, sch.weekday, sch.assigned_cleaner_id, u.name AS assigned_cleaner_name
       FROM room_schedules sch LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
       WHERE sch.room_id = ? AND sch.weekday = ?`
    )
    .get(req.params.id, weekday);
  res.status(201).json(row);
});

roomsRouter.delete("/:id/schedule/:weekday", requireAuth, requireRole("admin", "manager"), (req, res) => {
  db.prepare("DELETE FROM room_schedules WHERE room_id = ? AND weekday = ?").run(req.params.id, req.params.weekday);
  res.json({ ok: true });
});

// --- Room runs (a cleaner's cleaning instance for a room on a given day) ---

roomsRouter.post("/:id/checkin", requireAuth, requireRole("cleaner"), (req, res) => {
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Not found" });

  const run = findOrCreateTodayRoomRun(req.params.id, req.user.id);
  const items = db.prepare("SELECT * FROM room_run_items WHERE room_run_id = ? ORDER BY sort_order").all(run.id);
  const photos = db.prepare("SELECT * FROM photos WHERE room_run_id = ?").all(run.id);
  res.json({ ...run, items, photos });
});

roomsRouter.patch("/runs/:runId/items/:itemId", requireAuth, requireRole("cleaner"), (req, res) => {
  const { done } = req.body;
  db.prepare("UPDATE room_run_items SET done = ? WHERE id = ? AND room_run_id = ?").run(done ? 1 : 0, req.params.itemId, req.params.runId);
  res.json({ ok: true });
});

roomsRouter.post("/runs/:runId/complete", requireAuth, requireRole("cleaner"), (req, res) => {
  const run = db.prepare("SELECT * FROM room_runs WHERE id = ?").get(req.params.runId);
  if (!run) return res.status(404).json({ error: "Not found" });

  db.prepare("UPDATE room_runs SET completed_at = datetime('now') WHERE id = ?").run(run.id);
  res.json({ ok: true });
});

roomsRouter.post("/runs/:runId/photos", requireAuth, requireRole("cleaner"), upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'photo')" });
  const kind = req.body.kind || "general";
  const info = db
    .prepare("INSERT INTO photos (room_run_id, file_path, kind) VALUES (?, ?, ?)")
    .run(req.params.runId, path.join("uploads", req.file.filename), kind);
  res.status(201).json({ id: info.lastInsertRowid, file_path: req.file.filename });
});
