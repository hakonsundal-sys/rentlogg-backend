import { Router } from "express";
import multer from "multer";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import { getRoomsForSite, findOrCreateTodayRoomRun, findOrCreateRoomRunForDate, findRoomRunForDate, getMonthlyItemsForSite, getRoomGridForSiteMonth, getRoomRunItems, ensureRunItemOptions } from "../services/rooms.js";
import { safeOriginalName, normalizeImageOrientation, imageFileFilter, removeUploadedFile, UploadRejectedError } from "../utils/uploads.js";

export const siteRoomsRouter = Router({ mergeParams: true });
export const roomsRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  // Phone camera photos (HDR/high-res shots especially) routinely land well past 10MB —
  // 20MB gives real-world headroom without allowing e.g. a video by mistake.
  limits: { fileSize: 20 * 1024 * 1024 },
});

function pdfFileFilter(req, file, cb) {
  if (file.mimetype !== "application/pdf") return cb(new UploadRejectedError("Bare PDF er tillatt."));
  cb(null, true);
}

const pdfUpload = multer({ storage: multer.memoryStorage(), fileFilter: pdfFileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// Same shared-ownership-check pattern as sites.js/checklists.js/deviations.js, one per level
// this file operates at (site, room, room_run) since a room-run's site is two joins away.
function getSiteScopedForRooms(siteId, user) {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return { status: 404, code: "not_found", error: "Not found" };
  if (user.role === "customer" && site.client_id !== user.client_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (user.role !== "customer" && site.company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { site };
}

function getRoomScoped(roomId, user) {
  const room = db
    .prepare(
      `SELECT r.*, s.company_id AS site_company_id, s.client_id AS site_client_id
       FROM rooms r JOIN sites s ON s.id = r.site_id WHERE r.id = ?`
    )
    .get(roomId);
  if (!room) return { status: 404, code: "not_found", error: "Not found" };
  if (user.role === "customer" && room.site_client_id !== user.client_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (user.role !== "customer" && room.site_company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { room };
}

function getRoomRunScoped(roomRunId, user) {
  const roomRun = db
    .prepare(
      `SELECT rr.*, r.responsible AS room_responsible, r.requires_approval AS room_requires_approval,
              s.company_id AS site_company_id, s.client_id AS site_client_id
       FROM room_runs rr JOIN rooms r ON r.id = rr.room_id JOIN sites s ON s.id = r.site_id WHERE rr.id = ?`
    )
    .get(roomRunId);
  if (!roomRun) return { status: 404, code: "not_found", error: "Not found" };
  if (user.role === "customer" && roomRun.site_client_id !== user.client_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (user.role !== "customer" && roomRun.site_company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { roomRun };
}

// A customer can only mutate (not just view) a room explicitly marked as their own
// responsibility. Deliberately not baked into getRoomScoped/getRoomRunScoped themselves — some
// of their other callers (e.g. GET /:id/items, used for the avvik room-picker) need a customer
// to reach ANY room at their site regardless of who's responsible for cleaning it, only the
// mutation routes below need this extra check.
function requireCustomerOwnsRoom(user, responsible) {
  if (user.role === "customer" && responsible !== "customer") return { status: 403, code: "not_allowed", error: "Not allowed" };
  return null;
}

// Guards the new approval endpoints below: a customer may only approve a room explicitly flagged
// requires_approval (never an ordinary room, even one at their own site) — admin/manager pass
// through unconditionally, since they're allowed to approve on a customer's behalf (see
// POST /runs/:runId/approve's own comment for why that escape hatch exists).
function requireCustomerApprovalRoom(user, requiresApproval) {
  if (user.role === "customer" && !requiresApproval) return { status: 403, code: "room_needs_no_approval", error: "Dette rommet krever ikke kundegodkjenning." };
  return null;
}

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
                    "0=søndag..6=lørdag. PREFER THIS over interval_days whenever the document gives any day " +
                    "information at all — named weekdays ('mandag-fredag' -> [1,2,3,4,5], 'mandag og fredag' " +
                    "-> [1,5]), or a weekday-grid table's marked columns for that row (map each mark to its " +
                    "actual column header). Leave unset only when the document truly gives no day information.",
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
                    "LAST RESORT — only when the document gives a bare frequency with no day information " +
                    "anywhere for that room (no named weekdays, no grid column marks). A rolling interval " +
                    "drifts onto a different weekday each cycle — including weekends with no production at " +
                    "many sites — so weekdays (or monthly) is correct whenever any day information exists at " +
                    "all, even a single marked column in an otherwise-empty grid row. When this does apply, " +
                    "convert to an approximate day count: '1 gang per uke' -> 7, '2 ganger per uke' -> 4, " +
                    "'3 ganger per uke' -> 2, '1 gang per måned' -> 30, '2 ganger per måned' -> 15, '1 gang " +
                    "per år' -> 365, '2 ganger per år' -> 180, 'ved behov' -> omit entirely (no reliable " +
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
  const { status, code, error } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (error) return res.status(status).json({ code, error });

  const rooms = getRoomsForSite(req.params.siteId, todayInOslo());
  // A cleaner's live checklist only ever shows the cleaning company's own rooms — a
  // customer-responsibility room (see rooms.responsible) is that client's own job, never
  // something a cleaner should be prompted to do. Admin/manager (oversight) and customer
  // (their own avvik room-picker, which reasonably covers any room at the site) still see
  // everything, unfiltered.
  const visible = req.user.role === "cleaner" ? rooms.filter((r) => r.responsible !== "customer") : rooms;
  res.json(visible);
});

// "Tick every task in this run that CAN be ticked" — everything except a flervalg task with no
// alternative chosen yet, which needs a real answer rather than a bulk sweep (see
// itemSelectionSatisfied). Shared by the per-room "Merk alle" and the site-wide bulk complete.
const markAnswerableItemsDoneStmt = db.prepare(
  `UPDATE room_run_items SET done = 1
   WHERE room_run_id = ?
     AND id NOT IN (
       SELECT run_item_id FROM room_run_item_options GROUP BY run_item_id HAVING SUM(selected) = 0
     )`
);

function isValidResponsible(value) {
  return value == null || value === "company" || value === "customer";
}

siteRoomsRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const { name, interval_days, responsible } = req.body;
  if (!name) return res.status(400).json({ code: "name_required", error: "name is required" });
  if (!isValidResponsible(responsible)) return res.status(400).json({ code: "invalid_responsible", error: "responsible must be 'company' or 'customer'" });

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM rooms WHERE site_id = ?").get(req.params.siteId).n;
  const info = db
    .prepare("INSERT INTO rooms (site_id, name, sort_order, interval_days, responsible) VALUES (?, ?, ?, ?, ?)")
    .run(req.params.siteId, name, nextSort, interval_days ?? null, responsible || "company");

  res.status(201).json(db.prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid));
});

// Bulk version of the single-room delete below — same cascade, wrapped in one transaction
// so a crash partway through can't leave some rooms deleted and others half-cleaned-up.
siteRoomsRouter.delete("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const roomIds = db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(req.params.siteId).map((r) => r.id);
  const filesToRemove = [];

  const deleteAll = db.transaction((ids) => {
    if (ids.length) {
      // Deviations outlive the room they were filed against — unlink rather than delete, so
      // the avvik and its reply history stay intact even after the room definition is gone.
      const roomPlaceholders = ids.map(() => "?").join(",");
      db.prepare(`UPDATE deviations SET room_id = NULL WHERE room_id IN (${roomPlaceholders})`).run(...ids);
    }
    for (const roomId of ids) {
      const runIds = db.prepare("SELECT id FROM room_runs WHERE room_id = ?").all(roomId).map((r) => r.id);
      if (runIds.length) {
        const placeholders = runIds.map(() => "?").join(",");
        filesToRemove.push(
          ...db.prepare(`SELECT file_path FROM photos WHERE room_run_id IN (${placeholders})`).all(...runIds).map((p) => p.file_path)
        );
        db.prepare(`DELETE FROM photos WHERE room_run_id IN (${placeholders})`).run(...runIds);
        db.prepare(
          `DELETE FROM room_run_item_options WHERE run_item_id IN
             (SELECT id FROM room_run_items WHERE room_run_id IN (${placeholders}))`
        ).run(...runIds);
        db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${placeholders})`).run(...runIds);
      }
      db.prepare("DELETE FROM room_runs WHERE room_id = ?").run(roomId);
      db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(roomId);
      db.prepare(
        "DELETE FROM room_checklist_item_options WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?)"
      ).run(roomId);
      db.prepare(
        "DELETE FROM room_checklist_item_weekdays WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?)"
      ).run(roomId);
      db.prepare("DELETE FROM room_checklist_items WHERE room_id = ?").run(roomId);
      db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    }
  });

  deleteAll(roomIds);
  filesToRemove.forEach(removeUploadedFile);
  res.json({ ok: true, deletedCount: roomIds.length });
});

// Month defaults to the current Oslo month when omitted; otherwise must be "YYYY-MM".
siteRoomsRouter.get("/monthly-items", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const month = req.query.month || todayInOslo().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ code: "invalid_month", error: "month must be YYYY-MM" });

  res.json(getMonthlyItemsForSite(req.params.siteId, month));
});

// Room x day grid for Rapporter's "vaskeplan" view, the customer portal's read-only
// counterpart, and a cleaner's own editable one — which rooms were actually done on which
// days over a month, at a glance. getSiteScopedForRooms below already restricts a customer
// caller to their own client's sites (and a cleaner/admin/manager caller to their own company's).
siteRoomsRouter.get("/monthly-grid", requireAuth, requireRole("admin", "manager", "customer", "cleaner"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const month = req.query.month || todayInOslo().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ code: "invalid_month", error: "month must be YYYY-MM" });
  const [year, mon] = month.split("-").map(Number);

  res.json(getRoomGridForSiteMonth(req.params.siteId, year, mon));
});

siteRoomsRouter.post("/complete-all-due", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const initials = (req.body?.initials || "").trim();
  if (!initials) return res.status(400).json({ code: "initials_required_tasks", error: "Navn er påkrevd for å fullføre oppgavene." });

  const today = todayInOslo();
  // A customer's bulk-complete is scoped to only their own (responsible='customer') rooms;
  // staff's is scoped to only the cleaning company's rooms — same split as GET "/" above.
  // Without this, a cleaner's bulk-complete silently completed the customer's own rooms too
  // (using the cleaner's initials), whenever one of those happened to be due the same day —
  // caught 2026-09-15 after it had already happened once in production.
  // Optional: complete only these rooms rather than every due one. This is how the day view's
  // per-chapter "Huk av alle" works — it passes that chapter's rooms. The role scoping below
  // still applies on top, so a narrowed list can never reach a room the caller could not have
  // completed with the unscoped call.
  const only = Array.isArray(req.body?.room_ids)
    ? new Set(req.body.room_ids.filter((id) => Number.isInteger(id)))
    : null;
  if (only && only.size === 0) return res.status(400).json({ code: "room_ids_required", error: "room_ids må ha minst ett rom" });

  const isCustomer = req.user.role === "customer";
  const dueIncomplete = getRoomsForSite(req.params.siteId, today)
    .filter((r) => r.dueToday && r.status !== "completed" && (isCustomer ? r.responsible === "customer" : r.responsible !== "customer"))
    .filter((r) => !only || only.has(r.id));

  // A room holding a flervalg task nobody has answered is deliberately left open rather than
  // signed off — the whole point of such a task (which soap was used today) is that only the
  // person who did the work can answer it, so a bulk sweep signing it off unanswered would make
  // the requirement optional in practice. Those rooms are named back to the caller so the app can
  // say which ones still need opening, instead of silently leaving them behind.
  const completeAll = db.transaction((rooms) => {
    const completed = [];
    const skipped = [];
    for (const room of rooms) {
      const run = findOrCreateTodayRoomRun(room.id, req.user.id);
      markAnswerableItemsDoneStmt.run(run.id);
      const unanswered = db
        .prepare("SELECT COUNT(*) AS n FROM room_run_items WHERE room_run_id = ? AND done = 0")
        .get(run.id).n;
      if (unanswered > 0) {
        skipped.push(room.name);
        continue;
      }
      db.prepare("UPDATE room_runs SET completed_at = datetime('now'), signed_initials = ? WHERE id = ?").run(initials, run.id);
      completed.push(room.id);
    }
    return { completedCount: completed.length, skippedRooms: skipped };
  });

  res.json(completeAll(dueIncomplete));
});

// --- AI PDF import: proposes rooms/tasks without persisting them ---

siteRoomsRouter.post("/import-pdf", requireAuth, requireRole("admin", "manager"), pdfUpload.single("pdf"), async (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ code: "ai_import_not_configured", error: "AI-import er ikke konfigurert ennå." });
  }
  if (!req.file) return res.status(400).json({ code: "no_file_uploaded", error: "No file uploaded (field name must be 'pdf')" });

  let text;
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    await parser.destroy();
    text = (result.text || "").trim();
  } catch {
    return res.status(422).json({ code: "pdf_unreadable", error: "Kunne ikke lese PDF-en. Sjekk at filen ikke er skadet." });
  }

  if (text.length < 20) {
    return res.status(422).json({
      code: "pdf_no_text", error: "Fant ingen lesbar tekst i PDF-en. Prøv en tekstbasert PDF, eller legg til rom manuelt.",
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
            content: [
              // The raw PDF, not the pdf-parse'd text above (that's only used for the cheap
              // pre-check that something readable exists) — a lot of real cleaning plans are a
              // spreadsheet-style table with weekday columns and an X/checkmark per row, and
              // pdf-parse's plain-text extraction flattens that grid, losing exactly which
              // column (weekday) a mark belongs to. Sending the actual PDF lets the model read
              // the table natively — column headers, row alignment, checkboxes — instead of
              // guessing from a frequency number once that structure is already gone.
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: req.file.buffer.toString("base64") },
              },
              {
                type: "text",
                text:
                  "This is a cleaning plan document for a commercial site (may be in Norwegian) — it may be a " +
                  "plain list, or a spreadsheet-style table with a weekday grid (day-of-week column headers, " +
                  "with an X or checkmark in some rows/columns showing which days that room or task applies). " +
                  "Extract every room or area mentioned and the cleaning tasks for each. If a room has no " +
                  "explicit task list, use a single sensible general task.\n\n" +
                  "Some documents — this is OKV's own standard 'Renholdsplan' template, so expect it again — " +
                  "use a table with a COARSER area column (often headed 'Lokale') whose value repeats down " +
                  "several rows before changing, alongside a FINER per-item column (often 'Inv/Objekt' or " +
                  "'Utstyr') naming one specific object or spot within that area. When this pattern is present, " +
                  "each distinct Lokale value is ONE room — never create a separate room per Inv/Objekt row — " +
                  "and every Inv/Objekt entry under that Lokale becomes one task inside that room's task list. " +
                  "For example, a 'Produksjon' Lokale listing a dozen individual machines is ONE room named " +
                  "'Produksjon' with a dozen tasks, not a dozen separate rooms; a real cleaner walks into one " +
                  "physical space (the Lokale) and works through everything in it, they don't treat each piece " +
                  "of equipment as its own room. Likewise a Lokale value like '1. Etg' grouping several rows " +
                  "(e.g. Inngangsparti, Gang, Toalett, Tørrgarderobe) is ONE room named for that Lokale (e.g. " +
                  "'1. Etasje'), not four separate rooms. Apply this the same way on every page of a multi-page " +
                  "document, even where a later page's table looks visually simpler than an earlier one — the " +
                  "same Lokale/Inv-Objekt structure still means the same grouping rule. Getting this wrong " +
                  "produces far more rooms than the site actually has.\n\n" +
                  "For each room, set the schedule's weekdays field whenever the document shows or names " +
                  "specific days — a weekday grid's marked columns, text naming weekdays ('mandag-fredag', " +
                  "'tirsdager og fredager'), or a day abbreviation next to a task. If it's a grid, read it " +
                  "carefully: match each mark to its actual column header for that row, don't infer weekdays " +
                  "from the mark count alone.\n\n" +
                  "A very common header for the weekday columns is the single-letter row 'M T O T F L S' " +
                  "(Mandag, Tirsdag, Onsdag, Torsdag, Fredag, Lørdag, Søndag) — note the letter T appears " +
                  "TWICE, for both Tirsdag and Torsdag, so the letter alone can't tell those two apart. Never " +
                  "match by letter for this or any similar abbreviated header; instead count column POSITION " +
                  "from the leftmost day-column in this fixed order: 1st=mandag, 2nd=tirsdag, 3rd=onsdag, " +
                  "4th=torsdag, 5th=fredag, 6th=lørdag, 7th=søndag (fewer than 7 columns usually means " +
                  "weekends are simply omitted, so still count from the left in that same order). Count " +
                  "carefully and re-check each mark's column before answering, especially in a dense table " +
                  "with many rows and narrow columns — a mark read one column off from its true position is " +
                  "a wrong weekday (e.g. Fredag misread as Onsdag, Torsdag, or Lørdag), and that's a real " +
                  "operational error since it can land a task on a day the site isn't even staffed.\n\n" +
                  "A row with a mark in only one or two columns is the easiest to misread by one column, " +
                  "because there's no redundant pattern to sanity-check it against. Calibrate first: find a " +
                  "nearby row in the same table with an unambiguous, easy-to-read pattern — e.g. a '5 / u' " +
                  "row, which should have exactly 5 marks in the first 5 day-columns (mandag-fredag) — and " +
                  "use its mark positions as your reference for exactly where each column sits before you " +
                  "read a sparser row's single mark against that same alignment. Every row in one table shares " +
                  "the same column positions, so this cross-check is reliable and worth doing explicitly.\n\n" +
                  "Only use interval_days when the document gives nothing but a " +
                  "bare frequency with no day information anywhere (e.g. '1 gang per uke' with no grid and no " +
                  "named days) — never default to interval_days just because it's simpler to compute. A " +
                  "rolling interval drifts onto a different weekday every cycle, including weekends with no " +
                  "production at many sites; naming the actual weekdays keeps the task on a real working day " +
                  "permanently. Call submit_rooms with the result.",
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error("Anthropic API error:", err);
      return res.status(502).json({ code: "ai_service_unavailable", error: "Kunne ikke kontakte AI-tjenesten. Prøv igjen senere." });
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
    return res.status(502).json({ code: "ai_response_unparseable", error: "Kunne ikke tolke resultatet fra AI-analysen. Prøv å laste opp PDF-en på nytt." });
  }

  res.json({ rooms: rooms.map((r) => ({ ...r, schedule: sanitizeSchedule(r.schedule) })) });
});

siteRoomsRouter.post("/import-confirm", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getSiteScopedForRooms(req.params.siteId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const { rooms } = req.body;
  if (!isValidRoomsShape(rooms)) return res.status(400).json({ code: "rooms_required", error: "rooms[] with name/tasks[] is required" });

  const siteId = req.params.siteId;
  const insertRoom = db.prepare(
    "INSERT INTO rooms (site_id, name, area, sort_order, interval_days, monthly_weekday, monthly_occurrence) VALUES (?, ?, ?, ?, ?, ?, ?)"
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
        siteId, room.name, typeof room.area === "string" && room.area.trim() ? room.area.trim() : null, nextSort++,
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

const ROOM_PATCH_FIELDS = ["name", "area", "interval_days", "monthly_weekday", "monthly_occurrence", "responsible", "requires_approval"];

roomsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getRoomScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  if ("responsible" in req.body && !isValidResponsible(req.body.responsible)) {
    return res.status(400).json({ code: "invalid_responsible", error: "responsible must be 'company' or 'customer'" });
  }
  if ("requires_approval" in req.body && typeof req.body.requires_approval !== "boolean") {
    return res.status(400).json({ code: "invalid_requires_approval", error: "requires_approval must be true or false" });
  }

  const fields = ROOM_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });

  const updateRoom = db.transaction(() => {
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    // better-sqlite3 can't bind a raw JS boolean — requires_approval is the one boolean field in
    // this allowlist, every other field here is already a string/number/null.
    const values = fields.map((f) => (f === "requires_approval" ? (req.body[f] ? 1 : 0) : req.body[f]));
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
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const filesToRemove = [];
  const deleteCascade = db.transaction((roomId) => {
    db.prepare("UPDATE deviations SET room_id = NULL WHERE room_id = ?").run(roomId);
    const runIds = db.prepare("SELECT id FROM room_runs WHERE room_id = ?").all(roomId).map((r) => r.id);
    if (runIds.length) {
      const placeholders = runIds.map(() => "?").join(",");
      filesToRemove.push(
        ...db.prepare(`SELECT file_path FROM photos WHERE room_run_id IN (${placeholders})`).all(...runIds).map((p) => p.file_path)
      );
      db.prepare(`DELETE FROM photos WHERE room_run_id IN (${placeholders})`).run(...runIds);
      db.prepare(
        `DELETE FROM room_run_item_options WHERE run_item_id IN
           (SELECT id FROM room_run_items WHERE room_run_id IN (${placeholders}))`
      ).run(...runIds);
      db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${placeholders})`).run(...runIds);
    }
    db.prepare("DELETE FROM room_runs WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM room_schedules WHERE room_id = ?").run(roomId);
    db.prepare(
      "DELETE FROM room_checklist_item_options WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?)"
    ).run(roomId);
    db.prepare(
      "DELETE FROM room_checklist_item_weekdays WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?)"
    ).run(roomId);
    db.prepare("DELETE FROM room_checklist_items WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  });

  deleteCascade(req.params.id);
  filesToRemove.forEach(removeUploadedFile);
  res.json({ ok: true });
});

// --- Room task template ---

roomsRouter.get("/:id/items", requireAuth, (req, res) => {
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const items = db.prepare("SELECT * FROM room_checklist_items WHERE room_id = ? ORDER BY sort_order").all(req.params.id);
  const weekdayRows = db
    .prepare(
      `SELECT item_id, weekday FROM room_checklist_item_weekdays
       WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?) ORDER BY weekday`
    )
    .all(req.params.id);
  const weekdaysByItem = {};
  weekdayRows.forEach((r) => { (weekdaysByItem[r.item_id] ||= []).push(r.weekday); });
  // A task with options is a multi-choice ("flervalg") task — see room_checklist_item_options.
  const optionRows = db
    .prepare(
      `SELECT * FROM room_checklist_item_options
       WHERE item_id IN (SELECT id FROM room_checklist_items WHERE room_id = ?) ORDER BY sort_order, id`
    )
    .all(req.params.id);
  const optionsByItem = {};
  optionRows.forEach((o) => { (optionsByItem[o.item_id] ||= []).push(o); });
  res.json(items.map((item) => ({
    ...item,
    weekly_days: weekdaysByItem[item.id] || [],
    options: optionsByItem[item.id] || [],
  })));
});

roomsRouter.post("/:id/items", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getRoomScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const { label } = req.body;
  if (!label) return res.status(400).json({ code: "label_required", error: "label is required" });

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM room_checklist_items WHERE room_id = ?").get(req.params.id).n;
  const info = db
    .prepare("INSERT INTO room_checklist_items (room_id, label, sort_order) VALUES (?, ?, ?)")
    .run(req.params.id, label, nextSort);

  res.status(201).json(db.prepare("SELECT * FROM room_checklist_items WHERE id = ?").get(info.lastInsertRowid));
});

// Renaming a task (label) and its schedule override are independent, optional edits — the
// frontend sends whichever one changed, never both at once, so each is only touched when present
// in the body (an earlier version always wrote both monthly fields unconditionally, defaulting
// absent ones to null — a label-only edit would have silently wiped any existing weekly/monthly
// override). The frontend still always sends the full set of fields for whichever schedule mode
// it does send, so no partial-pair validation is needed there.
roomsRouter.patch("/:id/items/:itemId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const existing = db.prepare("SELECT id FROM room_checklist_items WHERE id = ? AND room_id = ?").get(req.params.itemId, req.params.id);
  if (!existing) return res.status(404).json({ code: "not_found", error: "Not found" });

  const updates = {};
  // null = leave room_checklist_item_weekdays untouched; [] or a day list = replace its rows.
  let weeklyDays = null;
  if ("label" in req.body) {
    const label = typeof req.body.label === "string" ? req.body.label.trim() : "";
    if (!label) return res.status(400).json({ code: "task_label_required", error: "Oppgavenavn kan ikke være tomt." });
    updates.label = label;
  }
  // interval_days ("annenhver uke" etc), monthly_weekday/monthly_occurrence ("Månedlig"), and
  // weekly_days ("Ukentlig", one or more specific weekdays — see room_checklist_item_weekdays) are
  // three mutually exclusive schedule modes, plus a fourth implicit "every time" (none of them
  // set) — setting one explicitly clears the other two, same pairing rooms already enforce for
  // their own interval_days vs monthly_* fields.
  if ("interval_days" in req.body && req.body.interval_days != null) {
    updates.interval_days = req.body.interval_days;
    updates.monthly_weekday = null;
    updates.monthly_occurrence = null;
    weeklyDays = [];
  } else if ("weekly_days" in req.body) {
    const days = Array.isArray(req.body.weekly_days)
      ? [...new Set(req.body.weekly_days.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))]
      : [];
    if (days.length === 0) return res.status(400).json({ code: "weekly_days_required", error: "weekly_days må ha minst én dag" });
    weeklyDays = days;
    updates.monthly_weekday = null;
    updates.monthly_occurrence = null;
    updates.interval_days = null;
  } else if ("monthly_weekday" in req.body || "monthly_occurrence" in req.body) {
    updates.monthly_weekday = req.body.monthly_weekday ?? null;
    updates.monthly_occurrence = req.body.monthly_occurrence ?? null;
    updates.interval_days = null;
    weeklyDays = [];
  }
  const fields = Object.keys(updates);
  if (fields.length === 0 && weeklyDays === null) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });

  db.transaction(() => {
    if (fields.length > 0) {
      db.prepare(`UPDATE room_checklist_items SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`)
        .run(...fields.map((f) => updates[f]), req.params.itemId);
    }
    if (weeklyDays !== null) {
      db.prepare("DELETE FROM room_checklist_item_weekdays WHERE item_id = ?").run(req.params.itemId);
      const insertItemWeekday = db.prepare("INSERT INTO room_checklist_item_weekdays (item_id, weekday) VALUES (?, ?)");
      weeklyDays.forEach((weekday) => insertItemWeekday.run(req.params.itemId, weekday));
    }
  })();

  res.json({
    ...db.prepare("SELECT * FROM room_checklist_items WHERE id = ?").get(req.params.itemId),
    weekly_days: db
      .prepare("SELECT weekday FROM room_checklist_item_weekdays WHERE item_id = ? ORDER BY weekday")
      .all(req.params.itemId)
      .map((r) => r.weekday),
  });
});

roomsRouter.delete("/:id/items/:itemId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  // room_run_items.room_checklist_item_id (added for the monthly-tasks overview, see services/
  // rooms.js) points back at this row with no ON DELETE clause, so a checklist item that's ever
  // been included in a run failed this delete outright with a raw FK constraint error. Each past
  // run_item keeps its own label as a plain text snapshot regardless, so clearing the link (not
  // deleting the historical row itself) is enough to unblock the delete without touching history.
  const deleteItem = db.transaction((itemId, roomId) => {
    db.prepare("UPDATE room_run_items SET room_checklist_item_id = NULL WHERE room_checklist_item_id = ?").run(itemId);
    // Same treatment for the multi-choice options this task may have had: past runs keep their
    // own snapshotted option rows (with their own labels), they just lose the template link.
    db.prepare(
      `UPDATE room_run_item_options SET option_id = NULL
       WHERE option_id IN (SELECT id FROM room_checklist_item_options WHERE item_id = ?)`
    ).run(itemId);
    db.prepare("DELETE FROM room_checklist_item_options WHERE item_id = ?").run(itemId);
    db.prepare("DELETE FROM room_checklist_item_weekdays WHERE item_id = ?").run(itemId);
    db.prepare("DELETE FROM room_checklist_items WHERE id = ? AND room_id = ?").run(itemId, roomId);
  });
  deleteItem(req.params.itemId, req.params.id);
  res.json({ ok: true });
});

// --- Multi-choice ("flervalg") options on a task ---
//
// A task with at least one option stops being a plain done/not-done line and becomes "tick which
// of these applied today" — Sinkaberg's cleaners have to record which soap they used, one task per
// room with the site's chemical list as its options. Options live only on the template here; each
// day's run snapshots its own copy (see room_run_item_options), so editing this list never
// rewrites what an earlier visit recorded.

function getItemScoped(roomId, itemId, user) {
  const { status, code, error } = getRoomScoped(roomId, user);
  if (error) return { status, code, error };
  const item = db.prepare("SELECT * FROM room_checklist_items WHERE id = ? AND room_id = ?").get(itemId, roomId);
  if (!item) return { status: 404, code: "not_found", error: "Not found" };
  return { item };
}

roomsRouter.post("/:id/items/:itemId/options", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getItemScoped(req.params.id, req.params.itemId, req.user);
  if (error) return res.status(status).json({ code, error });

  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!label) return res.status(400).json({ code: "option_label_required", error: "Valgnavn kan ikke være tomt." });

  const nextSort = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM room_checklist_item_options WHERE item_id = ?")
    .get(req.params.itemId).n;
  const info = db
    .prepare("INSERT INTO room_checklist_item_options (item_id, label, sort_order) VALUES (?, ?, ?)")
    .run(req.params.itemId, label, nextSort);

  res.status(201).json(db.prepare("SELECT * FROM room_checklist_item_options WHERE id = ?").get(info.lastInsertRowid));
});

roomsRouter.patch("/:id/items/:itemId/options/:optionId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getItemScoped(req.params.id, req.params.itemId, req.user);
  if (error) return res.status(status).json({ code, error });

  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!label) return res.status(400).json({ code: "option_label_required", error: "Valgnavn kan ikke være tomt." });

  const result = db
    .prepare("UPDATE room_checklist_item_options SET label = ? WHERE id = ? AND item_id = ?")
    .run(label, req.params.optionId, req.params.itemId);
  if (result.changes === 0) return res.status(404).json({ code: "not_found", error: "Not found" });

  res.json(db.prepare("SELECT * FROM room_checklist_item_options WHERE id = ?").get(req.params.optionId));
});

roomsRouter.delete("/:id/items/:itemId/options/:optionId", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status, code, error } = getItemScoped(req.params.id, req.params.itemId, req.user);
  if (error) return res.status(status).json({ code, error });

  // Past runs keep their own snapshot of this option (label and all) — only the link back to the
  // template row is cleared, same as a deleted task does for room_run_items.
  const deleteOption = db.transaction((optionId, itemId) => {
    db.prepare("UPDATE room_run_item_options SET option_id = NULL WHERE option_id = ?").run(optionId);
    return db.prepare("DELETE FROM room_checklist_item_options WHERE id = ? AND item_id = ?").run(optionId, itemId);
  });
  const result = deleteOption(req.params.optionId, req.params.itemId);
  if (result.changes === 0) return res.status(404).json({ code: "not_found", error: "Not found" });

  res.json({ ok: true });
});

// --- Room schedule (weekday mode) ---

roomsRouter.get("/:id/schedule", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getRoomScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

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
  const { status: scopeStatus, error: scopeError } = getRoomScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const { weekday, assigned_cleaner_id } = req.body;
  if (weekday === undefined || weekday === null || weekday < 0 || weekday > 6) {
    return res.status(400).json({ code: "weekday_required", error: "weekday (0-6) is required" });
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
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  db.prepare("DELETE FROM room_schedules WHERE room_id = ? AND weekday = ?").run(req.params.id, req.params.weekday);
  res.json({ ok: true });
});

// --- Room runs (a cleaner's cleaning instance for a room on a given day) ---

roomsRouter.post("/:id/checkin", requireAuth, requireRole("cleaner"), (req, res) => {
  const { status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });

  const run = findOrCreateTodayRoomRun(req.params.id, req.user.id);
  // Picks up any flervalg-option added to a task after this room was already opened today.
  ensureRunItemOptions(run.id);
  const items = getRoomRunItems(run.id);
  const photos = db.prepare("SELECT * FROM photos WHERE room_run_id = ?").all(run.id);
  res.json({ ...run, items, photos });
});

// Opens a room that shows "IKKE STARTET" on a day being edited retroactively (via the vaskeplan
// grid's day-open button, see GET /checklists/site/:siteId/date/:date) — without this there was
// no way to start a room on any day but today, so a genuinely missed room on an older day was a
// permanent dead end with nothing to click. Not role-restricted to cleaner like the live /checkin
// above: admin/manager can retroactively open a room here too, same as they can already edit one
// that does have data — and so can a customer, but only for a room marked as their own
// responsibility (see requireCustomerOwnsRoom).
roomsRouter.post("/:id/checkin-date", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { room, status, code, error } = getRoomScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, room.responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  const { date } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ code: "invalid_date", error: "date must be YYYY-MM-DD" });
  if (date > todayInOslo()) return res.status(400).json({ code: "cannot_open_future", error: "Kan ikke åpne en fremtidig dato." });

  const run = findOrCreateRoomRunForDate(req.params.id, date, req.user.id);
  ensureRunItemOptions(run.id);
  res.status(201).json(run);
});

// Undo for a just-completed room — powers the cleaner-facing "Angre" affordance for both a
// single room's "Fullfør rom" and the bulk "Huk av alle dagens oppgaver" action, and also the
// admin/manager "Angre"-when-already-completed control in the shared day-detail view (needed
// to fix a room wrongly completed by someone else's mistake — e.g. the complete-all-due bug
// fixed alongside this, which had no other way to undo once the original action's toast was
// gone). `resetItems` additionally un-checks every item, since only the bulk action force-checks
// them all; a single "Fullfør rom" click never touches item state, so undoing it must leave the
// cleaner's own checkmarks alone.
roomsRouter.post("/:id/reopen", requireAuth, requireRole("cleaner", "admin", "manager"), (req, res) => {
  const { status: scopeStatus, error: scopeError } = getRoomScoped(req.params.id, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });

  const run = findRoomRunForDate(req.params.id, todayInOslo());
  if (!run) return res.status(404).json({ code: "no_completed_run_to_undo", error: "Ingen fullført besøk å angre i dag" });

  // Also clears any approval-gate state — an undone room goes all the way back to "in progress",
  // not left stuck with a stale ready_for_approval_at/approved_at from before the undo.
  db.prepare(
    "UPDATE room_runs SET completed_at = NULL, signed_initials = NULL, ready_for_approval_at = NULL, approved_at = NULL, approved_by_initials = NULL WHERE id = ?"
  ).run(run.id);
  if (req.body?.resetItems) {
    db.prepare("UPDATE room_run_items SET done = 0, approved = 0 WHERE room_run_id = ?").run(run.id);
  }
  res.json({ ok: true });
});

// Only stamps when the room was already completed — i.e. this is a genuine retroactive edit,
// not just normal live progress during an in-progress visit (which never sends `initials`).
// Deliberately leaves completed_at/signed_initials untouched: that stays the cleaner's original,
// honest record of what they confirmed on the day; this is a separate, additive "changed
// afterward" trail so nobody can silently rewrite a signed-off visit.
function stampRoomRunEdit(runId, initials) {
  if (!initials || !initials.trim()) return;
  const run = db.prepare("SELECT completed_at FROM room_runs WHERE id = ?").get(runId);
  if (run?.completed_at) {
    db.prepare("UPDATE room_runs SET edited_at = datetime('now'), edited_by_initials = ? WHERE id = ?").run(initials.trim(), runId);
  }
}

roomsRouter.patch("/runs/:runId/items/:itemId", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  const { done, initials } = req.body;
  // A flervalg task (one with options, see room_run_item_options) documents WHICH alternative was
  // used — ticking it off without naming one would record exactly the thing it exists to capture
  // as blank, so the answer is required before it can be marked done. Unticking is never blocked.
  if (done && !itemSelectionSatisfied(req.params.itemId)) {
    return res.status(400).json({ code: "no_options_defined", error: "Velg minst ett alternativ for denne oppgaven først." });
  }
  const result = db.prepare("UPDATE room_run_items SET done = ? WHERE id = ? AND room_run_id = ?").run(done ? 1 : 0, req.params.itemId, req.params.runId);
  if (result.changes === 0) return res.status(404).json({ code: "not_found", error: "Not found" });
  stampRoomRunEdit(req.params.runId, initials);
  res.json({ ok: true });
});

// True unless this run item is a flervalg task with nothing ticked yet — i.e. "may this item be
// marked done". A plain task (no options at all) always passes, which is every task that existed
// before flervalg did.
function itemSelectionSatisfied(runItemId) {
  const counts = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(selected), 0) AS chosen FROM room_run_item_options WHERE run_item_id = ?")
    .get(runItemId);
  return counts.total === 0 || counts.chosen > 0;
}

// Ticking one alternative on a flervalg task. Kept separate from the item PATCH above for the
// same reason /approve is: one column per route, so each side's validation stays legible.
// Clearing the last remaining choice also clears `done` — the task can't stay "utført" while the
// answer it documents is blank (the same rule the PATCH above enforces, applied from this side).
roomsRouter.patch("/runs/:runId/items/:itemId/options/:optionId", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  const selected = req.body?.selected ? 1 : 0;
  const result = db
    .prepare(
      `UPDATE room_run_item_options SET selected = ?
       WHERE id = ? AND run_item_id = (SELECT id FROM room_run_items WHERE id = ? AND room_run_id = ?)`
    )
    .run(selected, req.params.optionId, req.params.itemId, req.params.runId);
  if (result.changes === 0) return res.status(404).json({ code: "not_found", error: "Not found" });

  if (!itemSelectionSatisfied(req.params.itemId)) {
    db.prepare("UPDATE room_run_items SET done = 0 WHERE id = ? AND room_run_id = ?").run(req.params.itemId, req.params.runId);
  }
  stampRoomRunEdit(req.params.runId, req.body?.initials);
  res.json({ ok: true });
});

// A separate route from the item-PATCH above (rather than one endpoint handling both `done` and
// `approved`) so a customer reviewing a requires_approval room can never reach the cleaner's own
// `done` field through this path — only their own `approved` column.
roomsRouter.patch("/runs/:runId/items/:itemId/approve", requireAuth, requireRole("customer", "admin", "manager"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const approvalError = requireCustomerApprovalRoom(req.user, roomRun.room_requires_approval);
  if (approvalError) return res.status(approvalError.status).json({ error: approvalError.error });

  const { approved } = req.body;
  const result = db.prepare("UPDATE room_run_items SET approved = ? WHERE id = ? AND room_run_id = ?").run(approved ? 1 : 0, req.params.itemId, req.params.runId);
  if (result.changes === 0) return res.status(404).json({ code: "not_found", error: "Not found" });
  res.json({ ok: true });
});

// A free-text note for the whole room's visit — same granularity as its photos (one shared
// list for the room, not per checklist item).
roomsRouter.patch("/runs/:runId/note", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  db.prepare("UPDATE room_runs SET note = ? WHERE id = ?").run(req.body?.note || null, req.params.runId);
  stampRoomRunEdit(req.params.runId, req.body?.initials);
  res.json({ ok: true });
});

// Lets a cleaner clear a whole room's remaining tasks in one tap — for a routine room they
// already know is fine, ticking every item individually is pure friction.
roomsRouter.post("/runs/:runId/items/complete-all", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  // Deliberately skips flervalg tasks nobody has answered yet — a blanket "merk alle" must not
  // be able to claim a soap was used without saying which one (see itemSelectionSatisfied).
  markAnswerableItemsDoneStmt.run(req.params.runId);
  stampRoomRunEdit(req.params.runId, req.body?.initials);
  res.json({ ok: true });
});

// For a requires_approval room, this is the cleaner's OWN sign-off, not the room's real
// completion — completed_at stays null (so every existing reader of it: reports, vaskeplan,
// history, dashboard, keeps treating the room as not-yet-done) until the customer's approver
// finishes the gate in POST /runs/:runId/approve below. A non-gated room behaves exactly as
// before this feature existed.
roomsRouter.post("/runs/:runId/complete", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  const initials = (req.body?.initials || "").trim();
  if (!initials) return res.status(400).json({ code: "initials_required_room", error: "Navn er påkrevd for å fullføre rommet." });

  if (roomRun.room_requires_approval) {
    db.prepare("UPDATE room_runs SET ready_for_approval_at = datetime('now'), signed_initials = ? WHERE id = ?").run(initials, roomRun.id);
    return res.json({ ok: true, awaitingApproval: true });
  }

  db.prepare("UPDATE room_runs SET completed_at = datetime('now'), signed_initials = ? WHERE id = ?").run(initials, roomRun.id);
  res.json({ ok: true });
});

// The customer's (or, as a fallback if the customer is unreachable, an admin/manager's) sign-off
// on a requires_approval room — this is what actually opens the completed_at gate. Deliberately
// separate from the cleaner's own /complete above rather than one endpoint with different
// behavior per role, so each side's required fields/validation stay simple and legible.
roomsRouter.post("/runs/:runId/approve", requireAuth, requireRole("customer", "admin", "manager"), (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const approvalError = requireCustomerApprovalRoom(req.user, roomRun.room_requires_approval);
  if (approvalError) return res.status(approvalError.status).json({ error: approvalError.error });

  if (!roomRun.ready_for_approval_at) return res.status(409).json({ code: "room_not_ready_for_approval", error: "Renholder har ikke fullført rommet ennå." });
  if (roomRun.approved_at) return res.status(409).json({ code: "room_already_approved", error: "Rommet er allerede godkjent." });

  const initials = (req.body?.initials || "").trim();
  if (!initials) return res.status(400).json({ code: "initials_required_approve_room", error: "Navn er påkrevd for å godkjenne rommet." });

  db.prepare(
    "UPDATE room_runs SET approved_at = datetime('now'), approved_by_initials = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(initials, roomRun.id);
  res.json({ ok: true });
});

roomsRouter.post("/runs/:runId/photos", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), upload.single("photo"), async (req, res) => {
  const { roomRun, status, code, error } = getRoomRunScoped(req.params.runId, req.user);
  if (error) return res.status(status).json({ code, error });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });
  if (!req.file) return res.status(400).json({ code: "no_file_uploaded", error: "No file uploaded (field name must be 'photo')" });
  await normalizeImageOrientation(path.join(process.env.UPLOADS_DIR || "uploads", req.file.filename));
  const kind = req.body.kind || "general";
  const info = db
    .prepare("INSERT INTO photos (room_run_id, file_path, kind) VALUES (?, ?, ?)")
    .run(req.params.runId, path.join("uploads", req.file.filename), kind);
  stampRoomRunEdit(req.params.runId, req.body.initials);
  res.status(201).json({ id: info.lastInsertRowid, file_path: req.file.filename });
});

roomsRouter.delete("/runs/:runId/photos/:photoId", requireAuth, requireRole("cleaner", "admin", "manager", "customer"), (req, res) => {
  const { roomRun, status: scopeStatus, error: scopeError } = getRoomRunScoped(req.params.runId, req.user);
  if (scopeError) return res.status(scopeStatus).json({ error: scopeError });
  const ownError = requireCustomerOwnsRoom(req.user, roomRun.room_responsible);
  if (ownError) return res.status(ownError.status).json({ error: ownError.error });

  const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND room_run_id = ?").get(req.params.photoId, req.params.runId);
  if (!photo) return res.status(404).json({ code: "not_found", error: "Not found" });

  removeUploadedFile(photo.file_path);
  db.prepare("DELETE FROM photos WHERE id = ?").run(photo.id);
  stampRoomRunEdit(req.params.runId, req.body?.initials);

  res.json({ ok: true });
});
