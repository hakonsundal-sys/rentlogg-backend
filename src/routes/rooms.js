import { Router } from "express";
import multer from "multer";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import { getRoomsForSite, findOrCreateTodayRoomRun, findRoomRunForDate } from "../services/rooms.js";

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
  description: "Submit the rooms, cleaning tasks, and cleaning frequency extracted from a cleaning plan document.",
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
            schedule: {
              type: "object",
              description:
                "Best-guess cleaning frequency for this room, inferred from its task text (e.g. '5 ganger per uke " +
                "(mandag-fredag)', 'første mandag i måneden', '1 gang per måned'). Set exactly one of weekdays, " +
                "monthly, or interval_days — never more than one. Omit this whole object if no frequency is " +
                "mentioned anywhere for the room.",
              properties: {
                weekdays: {
                  type: "array",
                  items: { type: "integer", minimum: 0, maximum: 6 },
                  description:
                    "0=søndag..6=lørdag. Only set when the task repeats weekly on specific named weekdays, e.g. " +
                    "'mandag-fredag' -> [1,2,3,4,5], 'mandag og fredag' -> [1,5]. Leave unset otherwise.",
                },
                monthly: {
                  type: "object",
                  description:
                    "Use when the task happens once a month on a specific weekday occurrence, e.g. 'første mandag " +
                    "i måneden' -> {weekday: 1, occurrence: 1}, 'siste fredag i måneden' -> {weekday: 5, " +
                    "occurrence: -1}, 'andre tirsdag hver måned' -> {weekday: 2, occurrence: 2}.",
                  properties: {
                    weekday: { type: "integer", minimum: 0, maximum: 6, description: "0=søndag..6=lørdag" },
                    occurrence: {
                      type: "integer",
                      description: "1=første, 2=andre, 3=tredje, 4=fjerde, -1=siste",
                    },
                  },
                },
                interval_days: {
                  type: "integer",
                  description:
                    "Use when a frequency is given without naming specific weekdays or a monthly weekday " +
                    "occurrence. Convert to an approximate day count: '1 gang per uke' -> 7, '2 ganger per uke' " +
                    "-> 4, '3 ganger per uke' -> 2, '1 gang per måned' -> 30, '2 ganger per måned' -> 15, " +
                    "'1 gang per år' -> 365, '2 ganger per år' -> 180, 'ved behov' -> omit entirely (no reliable " +
                    "frequency).",
                },
              },
            },
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

// Normalizes an AI- or admin-supplied `schedule` into exactly one of weekday-mode, monthly-
// mode, or interval-mode (checked in that priority order if more than one is somehow
// present), or null if none is usable — mirrors the three-way mutual exclusivity enforced
// on rooms.interval_days / monthly_weekday+monthly_occurrence / room_schedules rows.
function sanitizeSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  if (Array.isArray(schedule.weekdays)) {
    const weekdays = [...new Set(schedule.weekdays.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))];
    if (weekdays.length > 0) return { weekdays, monthly: null, interval_days: null };
  }
  if (schedule.monthly && typeof schedule.monthly === "object") {
    const { weekday, occurrence } = schedule.monthly;
    const validOccurrence = Number.isInteger(occurrence) && (occurrence === -1 || (occurrence >= 1 && occurrence <= 4));
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 && validOccurrence) {
      return { weekdays: null, monthly: { weekday, occurrence }, interval_days: null };
    }
  }
  if (Number.isInteger(schedule.interval_days) && schedule.interval_days > 0) {
    return { weekdays: null, monthly: null, interval_days: schedule.interval_days };
  }
  return null;
}

// For large documents Claude sometimes stringifies its whole answer into the
// `rooms` field instead of returning a native array — unwrap that case too.
function coerceRoomsShape(raw) {
  if (isValidRoomsShape(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      const candidate = Array.isArray(parsed) ? parsed : parsed?.rooms;
      if (isValidRoomsShape(candidate)) return candidate;
    } catch {
      // fall through
    }
  }
  return null;
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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let rooms;
  for (let attempt = 1; attempt <= 2 && !rooms; attempt++) {
    let message;
    try {
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
              "explicit task list, use a single sensible general task. For each room, also infer its cleaning " +
              "schedule from the frequency wording in its task text (e.g. '5 ganger per uke (mandag-fredag)', " +
              "'første mandag i måneden', '1 gang per måned') per the schedule field's rules. Call submit_rooms " +
              "with the result.\n\n" +
              text,
          },
        ],
      });
    } catch (err) {
      console.error("Anthropic API error:", err);
      return res.status(502).json({ error: "Kunne ikke kontakte AI-tjenesten. Prøv igjen senere." });
    }

    const toolUse = message.content.find((block) => block.type === "tool_use" && block.name === "submit_rooms");
    const coerced = coerceRoomsShape(toolUse?.input?.rooms);
    if (coerced) {
      rooms = coerced;
    } else {
      console.error(
        `Bad AI shape (attempt ${attempt}). stop_reason:`,
        message.stop_reason,
        "content:",
        JSON.stringify(message.content).slice(0, 2000)
      );
    }
  }

  if (!rooms) {
    return res.status(502).json({ error: "Kunne ikke tolke resultatet fra AI-analysen. Prøv å laste opp PDF-en på nytt." });
  }

  res.json({ rooms: rooms.map((r) => ({ ...r, schedule: sanitizeSchedule(r.schedule) })) });
});

siteRoomsRouter.post("/import-confirm", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { rooms } = req.body;
  if (!isValidRoomsShape(rooms)) return res.status(400).json({ error: "rooms[] with name/tasks[] is required" });

  const siteId = req.params.siteId;
  const insertRoom = db.prepare(
    "INSERT INTO rooms (site_id, name, sort_order, interval_days, monthly_weekday, monthly_occurrence) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertItem = db.prepare("INSERT INTO room_checklist_items (room_id, label, sort_order) VALUES (?, ?, ?)");
  const insertWeekday = db.prepare("INSERT INTO room_schedules (room_id, weekday) VALUES (?, ?)");

  const importAll = db.transaction((roomsToImport) => {
    let nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM rooms WHERE site_id = ?").get(siteId).n;
    const created = [];
    for (const room of roomsToImport) {
      if (!room.name.trim()) continue;
      const schedule = sanitizeSchedule(room.schedule);
      const info = insertRoom.run(
        siteId, room.name, nextSort++,
        schedule?.interval_days ?? null,
        schedule?.monthly?.weekday ?? null,
        schedule?.monthly?.occurrence ?? null
      );
      room.tasks.forEach((label, i) => {
        if (label.trim()) insertItem.run(info.lastInsertRowid, label, i);
      });
      if (schedule?.weekdays) {
        schedule.weekdays.forEach((weekday) => insertWeekday.run(info.lastInsertRowid, weekday));
      }
      created.push(db.prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid));
    }
    return created;
  });

  res.status(201).json({ rooms: importAll(rooms) });
});

// --- Room-scoped: /rooms/:id ---

const ROOM_PATCH_FIELDS = ["name", "interval_days", "monthly_weekday", "monthly_occurrence"];

roomsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const fields = ROOM_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  const updateRoom = db.transaction(() => {
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => req.body[f]);
    db.prepare(`UPDATE rooms SET ${setClause} WHERE id = ?`).run(...values, req.params.id);

    // Three schedule modes (room_schedules rows / interval_days / monthly_*) are mutually
    // exclusive — switching into one clears the other two in the same transaction.
    if ("interval_days" in req.body && req.body.interval_days != null) {
      db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(req.params.id);
      db.prepare("UPDATE rooms SET monthly_weekday = NULL, monthly_occurrence = NULL WHERE id = ?").run(req.params.id);
    } else if ("monthly_weekday" in req.body && req.body.monthly_weekday != null) {
      db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(req.params.id);
      db.prepare("UPDATE rooms SET interval_days = NULL WHERE id = ?").run(req.params.id);
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
    db.prepare("UPDATE rooms SET interval_days = NULL, monthly_weekday = NULL, monthly_occurrence = NULL WHERE id = ?").run(req.params.id);
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

// Undo for a just-completed room — powers the cleaner-facing "Angre" affordance for both a
// single room's "Fullfør rom" and the bulk "Huk av alle dagens oppgaver" action. `resetItems`
// additionally un-checks every item, since only the bulk action force-checks them all; a
// single "Fullfør rom" click never touches item state, so undoing it must leave the
// cleaner's own checkmarks alone.
roomsRouter.post("/:id/reopen", requireAuth, requireRole("cleaner"), (req, res) => {
  const run = findRoomRunForDate(req.params.id, todayInOslo());
  if (!run) return res.status(404).json({ error: "Ingen fullført besøk å angre i dag" });

  db.prepare("UPDATE room_runs SET completed_at = NULL WHERE id = ?").run(run.id);
  if (req.body?.resetItems) {
    db.prepare("UPDATE room_run_items SET done = 0 WHERE room_run_id = ?").run(run.id);
  }
  res.json({ ok: true });
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
