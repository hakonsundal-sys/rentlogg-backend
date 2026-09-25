import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import { sendTimesheetPdf, sendXlsx } from "../services/timeExport.js";
import {
  computePlannedVsActual, decimalHours, findOpenEntry, formatMinutes, getEntry,
  findOverlap, getLines, isValidDate, lineMinutes, listEntries, listTimeTypes, minutesBetween, nowStamp,
  osloTimeOf, overlapMessage,
  osloTimeToUtcStamp, payableMinutes, replaceLines, seedDefaultTimeTypes, stopEntry, validatePause, writeStampLine,
  backfillMissingLines,
  summarizeByUser, validateInterval,
} from "../services/timeEntries.js";
import {
  approvalLevelForUser, approvalStateFor, approvalsForEntry, clearApproval, getOrder,
  listApprovalLevels, listOrders, listProjects, listUserLevels, logEntryEvent, logForEntry,
  logForPeriod, orderIdForSite, recordApproval, seedApprovalLevels, seedOrdersForCompany, setUserLevel,
} from "../services/timeOrders.js";

// "Timeregistrering" — stamped shifts, hours per person, CSV to payroll. Mounted behind
// requireModule("timeclock") in server.js, so every route here already knows the caller's company
// has the module and none of them re-checks it.
//
// Stamping IN does not live here: a shift is born from the QR scan (POST /sites/checkin/:qrToken),
// which calls startEntryForCheckin. That keeps one scan as one action for the cleaner — she taps
// the same button she always has — and it's the only place that knows a check-in happened at all.
//
// No route here admits a 'customer': who worked how many hours is the cleaning company's own
// payroll data, not something the client they clean for gets to browse.
export const timeRouter = Router();

// Deliberately stricter than the app's usual "staff are unscoped within their own company" rule
// (see the engineering conventions, and training.js which made the same exception first): a cleaner
// reads and stamps only her own shifts. This is payroll data — a colleague's hours are no more her
// business than a colleague's password reset.
function managesTime(user) {
  return user.role === "admin" || user.role === "manager";
}

function getEntryScoped(entryId, user) {
  const entry = getEntry(entryId);
  if (!entry) return { status: 404, code: "not_found", error: "Not found" };
  if (entry.company_id !== user.company_id) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (entry.user_id !== user.id && !managesTime(user)) return { status: 403, code: "not_allowed", error: "Not allowed" };
  return { entry };
}

// A locked entry is one that has already gone to payroll. Nothing edits or deletes it until an
// admin lifts the lock — that's the entire point of having one, so the check sits in front of
// every mutating route rather than being remembered at each of them.
function lockGuard(entry) {
  if (!entry.locked) return null;
  return { status: 409, code: "entry_locked", error: "Perioden er låst. Lås den opp for å endre." };
}

// Default window: the current month, which is what both the admin's Timer page and a cleaner's own
// "mine timer" open on.
function parseRange(req) {
  const today = todayInOslo();
  const from = isValidDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = isValidDate(req.query.to) ? req.query.to : today;
  return { from, to };
}

// Attaches each shift's climb up the approval ladder. One small indexed query per row, which is
// what better-sqlite3 is good at — and the alternative, a join that fans a shift out into one row
// per level, would have to be collapsed again before anything could read it.
function withApproval(companyId) {
  const levels = listApprovalLevels(companyId);
  return (entry) => (entry ? { ...entry, approval: approvalStateFor(entry, levels) } : entry);
}

// One decorated shift, for every route that returns the row it just changed.
function entryWithApproval(entryId, companyId) {
  return withApproval(companyId)(getEntry(entryId));
}

// Team and ansattgruppe filter on the PERSON, not on the shift, so they are applied after the fact
// rather than joined into listEntries — which keeps the cleaner's own hot path free of two joins it
// will never use.
function matchesStaffFilters(req) {
  const teamId = req.query.team_id ? Number(req.query.team_id) : null;
  const groupId = req.query.employee_group_id ? Number(req.query.employee_group_id) : null;
  if (!teamId && !groupId) return () => true;
  const ids = new Set(
    db
      .prepare(
        `SELECT id FROM users WHERE company_id = ?${teamId ? " AND team_id = ?" : ""}${groupId ? " AND employee_group_id = ?" : ""}`
      )
      .all(...[req.user.company_id, teamId, groupId].filter((v) => v != null))
      .map((r) => r.id)
  );
  return (entry) => ids.has(entry.user_id);
}

// An explicit "pay her this many minutes" from the admin's form. Returns null when the field was
// left alone, the minute count when it holds one, and false for anything else — a silently ignored
// bad value here would mean paying the clock when somebody meant to override it.
function normalizeMinutes(value) {
  if (value == null || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) return false;
  return minutes;
}

// Which person's rows a request is allowed to see. A cleaner is pinned to herself whatever she
// asks for; an admin/driftsleder may filter to one person or see everyone.
function resolveUserFilter(req) {
  if (!managesTime(req.user)) return req.user.id;
  return req.query.user_id || null;
}

// --- The cleaner's own view ----------------------------------------------------------------------

// What the phone needs to render the stamp card: the running shift if there is one, today's
// finished ones, and this month's total so far.
timeRouter.get("/me/current", requireAuth, (req, res) => {
  const today = todayInOslo();
  const open = findOpenEntry(req.user.id);
  const todayEntries = listEntries({ companyId: req.user.company_id, from: today, to: today, userId: req.user.id });
  const monthEntries = listEntries({
    companyId: req.user.company_id, from: `${today.slice(0, 7)}-01`, to: today, userId: req.user.id,
  });
  res.json({
    open,
    today: todayEntries,
    today_minutes: todayEntries.reduce((sum, e) => sum + (e.minutes || 0), 0),
    month_minutes: monthEntries.reduce((sum, e) => sum + (e.minutes || 0), 0),
    // Surfaced to her, not just to the admin: the person who forgot to stamp out is the one who
    // still remembers when she actually left.
    missing: monthEntries.filter((e) => e.status === "missing_checkout"),
  });
});

timeRouter.get("/me", requireAuth, (req, res) => {
  const { from, to } = parseRange(req);
  res.json(listEntries({ companyId: req.user.company_id, from, to, userId: req.user.id }));
});

// Stamping out. A cleaner may only stop her own shift; an admin stopping somebody else's goes
// through PATCH below instead, which leaves an edit trail.
timeRouter.post("/entries/:id/stop", requireAuth, (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  if (entry.user_id !== req.user.id) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  const locked = lockGuard(entry);
  if (locked) return res.status(locked.status).json({ code: locked.code, error: locked.error });
  if (entry.ended_at) return res.status(409).json({ code: "already_stopped", error: "Du er allerede stemplet ut." });
  if (entry.status === "missing_checkout") {
    // Her shift was left open into a later day, so "now" is not when she left. Sending her to the
    // admin is the honest answer — anything else writes a made-up departure time into payroll.
    return res.status(409).json({ code: "checkout_too_late", error: "Stemplingen står åpen fra en tidligere dag. Be driftsleder rette den." });
  }

  const { latitude, longitude } = req.body || {};
  // She is asked for a break when stamping out rather than given a button to press twice during
  // the shift — a button she forgets to end costs her the rest of her hours, and at four in the
  // morning that is not a hypothetical (Håkon, 2026-09-24). Absent or 0 means no break.
  const pauseMinutes = Math.round(Number(req.body?.pause_minutes) || 0);
  const badPause = validatePause(entry.started_at, pauseMinutes);
  if (badPause) return res.status(400).json(badPause);
  res.json(stopEntry(entry, { latitude, longitude, pauseMinutes }));
});

// --- The admin's views ---------------------------------------------------------------------------

timeRouter.get("/entries", requireAuth, (req, res) => {
  // Stampings that closed before lønnsarter existed get their line here, once — see
  // backfillMissingLines. Without it they would sit on screen but drop out of the payroll export.
  if (managesTime(req.user)) backfillMissingLines(req.user.company_id);
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: resolveUserFilter(req), siteId: req.query.site_id || null,
    orderId: req.query.order_id || null,
    approval: ["approved", "pending"].includes(req.query.approval) ? req.query.approval : null,
  }).filter(matchesStaffFilters(req)).map(withApproval(req.user.company_id));
  // totals carries the per-lønnsart breakdown the Ansattvisning renders, so the timesheet and the
  // per-employee view are two readings of one response rather than two fetches that can disagree.
  res.json({ from, to, entries, totals: summarizeByUser(entries) });
});

// Planlagt mot faktisk: the weekly plan (site_schedules.assigned_cleaner_id) against what was
// actually stamped. See computePlannedVsActual for what each status means.
timeRouter.get("/planned", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to } = parseRange(req);
  res.json({
    from, to,
    rows: computePlannedVsActual({
      companyId: req.user.company_id, from, to,
      siteId: req.query.site_id || null, userId: req.query.user_id || null,
    }),
  });
});

// --- Godkjenning ---------------------------------------------------------------------------------

// A shift climbs a ladder of levels (Teamleder → Formann → Driftssjef → Administrasjon, whatever
// the company set up) and is fully approved only once every required level has signed. Who may sign
// is decided by the level a person sits at, NOT by their role: an admin with no level cannot
// approve, and a manager at "Driftssjef" signs there and nowhere else. That is deliberate — who
// approves whose hours is an org-chart question, and pinning it to admin/manager would have made
// four levels collapse back into one.
//
// Still not the lock: approval says "I have looked at this shift", the lock says "this period has
// been exported, nobody touches it".
function approverLevel(req, res) {
  const level = approvalLevelForUser(req.user.id);
  if (!level) {
    res.status(403).json({
      code: "no_approval_level",
      error: "Du er ikke tildelt et godkjenningsnivå. En administrator gjør det under Godkjenningsnivåer.",
    });
    return null;
  }
  return level;
}

// Writes the shift's derived approval state back onto the row, so every existing reader — the
// totals, the CSV, the filter — keeps working against one boolean instead of having to understand
// levels. The ladder is the truth; approved_at is its summary.
function syncApprovalSummary(entryId, companyId) {
  const entry = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(entryId);
  const state = approvalStateFor(entry, listApprovalLevels(companyId));
  const last = [...approvalsForEntry(entryId)].sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at))).pop();
  db.prepare("UPDATE time_entries SET approved_at = ?, approved_by = ?, approved_by_name = ? WHERE id = ?").run(
    state.fully_approved ? last?.approved_at ?? nowStamp() : null,
    state.fully_approved ? last?.approved_by ?? null : null,
    state.fully_approved ? last?.approved_by_name ?? null : null,
    entryId
  );
  return state;
}

timeRouter.post("/entries/:id/approve", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const level = approverLevel(req, res);
  if (!level) return;

  const approved = req.body?.approved !== false;
  if (entry.locked) return res.status(409).json({ code: "entry_locked", error: "Perioden er låst. Lås den opp for å endre." });
  if (approved && !entry.ended_at) {
    return res.status(409).json({ code: "cannot_approve_open", error: "Stemplingen er ikke avsluttet ennå." });
  }

  if (approved) {
    recordApproval(entry.id, level, req.user, req.body?.comment);
    // Approving revives a rejected shift: somebody has now looked at it and said yes.
    db.prepare("UPDATE time_entries SET rejected_at = NULL, rejected_by = NULL, rejected_by_name = NULL, rejection_comment = NULL WHERE id = ?").run(entry.id);
  } else {
    clearApproval(entry.id, level.id);
  }
  const state = syncApprovalSummary(entry.id, req.user.company_id);
  logEntryEvent({
    entryId: entry.id, companyId: entry.company_id, user: req.user,
    action: approved ? "approved" : "approval_cleared",
    status: state.fully_approved ? "Godkjent" : approved ? `Godkjent av ${level.name}` : "Venter",
    comment: req.body?.comment || level.name,
  });
  res.json(entryWithApproval(entry.id, req.user.company_id));
});

// Avvis: sending a shift back rather than quietly unticking it. The comment is required — a
// rejection without a reason just moves the confusion to the person who has to fix it.
timeRouter.post("/entries/:id/reject", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const level = approverLevel(req, res);
  if (!level) return;
  if (entry.locked) return res.status(409).json({ code: "entry_locked", error: "Perioden er låst. Lås den opp for å endre." });
  const comment = (req.body?.comment || "").trim();
  if (!comment) return res.status(400).json({ code: "rejection_comment_required", error: "Skriv hvorfor timen avvises — den som skal rette den trenger å vite det." });

  // Every signature so far comes off: the shift is going back to be changed, and a signature on
  // hours that are about to change means nothing.
  clearApproval(entry.id);
  db.prepare(
    "UPDATE time_entries SET rejected_at = ?, rejected_by = ?, rejected_by_name = ?, rejection_comment = ?, approved_at = NULL, approved_by = NULL, approved_by_name = NULL WHERE id = ?"
  ).run(nowStamp(), req.user.id, req.user.name || null, comment, entry.id);
  logEntryEvent({
    entryId: entry.id, companyId: entry.company_id, user: req.user,
    action: "rejected", status: "Avvist", comment,
  });
  res.json(entryWithApproval(entry.id, req.user.company_id));
});

// "Alle samtidig" — every shift in the current filter that this person's own level has not yet
// signed. Skips what it cannot legitimately touch and says how many, rather than silently doing
// less than the button promised.
timeRouter.post("/approve", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to, approved, user_id, site_id, order_id } = req.body;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ code: "invalid_date", error: "from og to må være datoer (YYYY-MM-DD)." });
  }
  if (typeof approved !== "boolean") {
    return res.status(400).json({ code: "approved_required", error: "approved må være true eller false" });
  }
  const level = approverLevel(req, res);
  if (!level) return;

  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: user_id || null, siteId: site_id || null, orderId: order_id || null,
  });

  let changed = 0;
  let skippedOpen = 0;
  let skippedLocked = 0;
  db.transaction(() => {
    for (const entry of entries) {
      if (entry.locked) {
        skippedLocked++;
        continue;
      }
      if (approved && !entry.ended_at) {
        skippedOpen++;
        continue;
      }
      if (approved) recordApproval(entry.id, level, req.user, null);
      else clearApproval(entry.id, level.id);
      syncApprovalSummary(entry.id, req.user.company_id);
      changed++;
    }
  })();

  // One log line for the batch rather than one per shift — a bulk approval is one decision, and
  // 200 identical rows would bury the individual corrections that matter.
  if (changed > 0 && entries.length > 0) {
    logEntryEvent({
      entryId: entries[0].id, companyId: req.user.company_id, user: req.user,
      action: approved ? "approved" : "approval_cleared",
      status: approved ? `Godkjent av ${level.name}` : "Venter",
      comment: `Masseoppdatering: ${changed} stemplinger ${from}–${to}`,
    });
  }
  res.json({ changed, skipped_open: skippedOpen, skipped_locked: skippedLocked, level: level.name });
});

// --- Lønnsarter ----------------------------------------------------------------------------------

// The arts a shift's hours and supplements are booked on. `code` is the string Unimicro reads on
// import, which makes it the real interface to payroll — editable here, and snapshotted onto every
// line so that editing it later never rewrites what an earlier period already exported.

timeRouter.get("/types", requireAuth, (req, res) => {
  res.json(listTimeTypes(req.user.company_id, { includeInactive: req.query.all === "1" }));
});

// Exactly one default art per company: setting a new one clears the old inside one transaction, so
// there is never an instant where a stamping could find two candidates, or none.
const makeDefaultType = db.transaction((companyId, typeId) => {
  db.prepare("UPDATE time_types SET is_default = 0 WHERE company_id = ?").run(companyId);
  db.prepare("UPDATE time_types SET is_default = 1 WHERE id = ?").run(typeId);
});

timeRouter.post("/types", requireAuth, requireRole("admin"), (req, res) => {
  const { kind, code, name, counts_as_work, is_default } = req.body;
  if (!code?.trim() || !name?.trim()) {
    return res.status(400).json({ code: "code_and_name_required", error: "Kode og navn er påkrevd." });
  }
  if (kind !== "hours" && kind !== "supplement") {
    return res.status(400).json({ code: "invalid_kind", error: "kind må være 'hours' eller 'supplement'" });
  }
  seedDefaultTimeTypes(req.user.company_id);
  const sortOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM time_types WHERE company_id = ?")
    .get(req.user.company_id).n;
  const info = db
    .prepare(
      `INSERT INTO time_types (company_id, kind, code, name, is_default, counts_as_work, sort_order)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(req.user.company_id, kind, code.trim(), name.trim(), counts_as_work === false ? 0 : 1, sortOrder);
  if (is_default && kind === "hours") makeDefaultType(req.user.company_id, info.lastInsertRowid);
  res.status(201).json(listTimeTypes(req.user.company_id, { includeInactive: true }));
});

const TYPE_PATCH_FIELDS = ["code", "name", "counts_as_work", "active", "sort_order"];

timeRouter.patch("/types/:id", requireAuth, requireRole("admin"), (req, res) => {
  const type = db.prepare("SELECT * FROM time_types WHERE id = ?").get(req.params.id);
  if (!type) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (type.company_id !== req.user.company_id) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  const fields = TYPE_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0 && !("is_default" in req.body)) {
    return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });
  }
  if (fields.length > 0) {
    const values = fields.map((f) => (typeof req.body[f] === "boolean" ? (req.body[f] ? 1 : 0) : req.body[f]));
    db.prepare(`UPDATE time_types SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...values, type.id);
  }
  if (req.body.is_default === true) makeDefaultType(req.user.company_id, type.id);
  res.json(listTimeTypes(req.user.company_id, { includeInactive: true }));
});

// Deactivated rather than deleted once the art has actually been used. Every line keeps its own
// snapshot of the code either way, but an art still explaining last month's export should drop out
// of the dropdowns without disappearing from the history it belongs to.
timeRouter.delete("/types/:id", requireAuth, requireRole("admin"), (req, res) => {
  const type = db.prepare("SELECT * FROM time_types WHERE id = ?").get(req.params.id);
  if (!type) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (type.company_id !== req.user.company_id) return res.status(403).json({ code: "not_allowed", error: "Not allowed" });

  const used = db.prepare("SELECT COUNT(*) AS n FROM time_entry_lines WHERE time_type_id = ?").get(type.id).n;
  if (used > 0) db.prepare("UPDATE time_types SET active = 0, is_default = 0 WHERE id = ?").run(type.id);
  else db.prepare("DELETE FROM time_types WHERE id = ?").run(type.id);
  res.json({ ok: true, deactivated: used > 0, used });
});

// --- Manuell registrering ------------------------------------------------------------------------

const insertManualStmt = db.prepare(
  `INSERT INTO time_entries (company_id, site_id, order_id, user_id, work_date, started_at, ended_at, source,
                             actual_minutes, minutes, billing_mode, fixed_minutes, note,
                             edited_at, edited_by_initials)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`
);


// The "Legg til timer" / "Legg til tillegg/annet" rows of one registration. An hours line may give
// fra/til and have its duration computed, or give the number of hours directly — both are how a
// shift actually gets written down, and Mobile Worker accepts both too.
function parseLines(body, companyId) {
  if (!Array.isArray(body.lines)) return { lines: null };
  const typesById = new Map(listTimeTypes(companyId, { includeInactive: true }).map((t) => [t.id, t]));
  const parsed = [];

  for (const raw of body.lines) {
    const type = typesById.get(Number(raw.time_type_id));
    if (!type) return { error: { code: "unknown_time_type", error: "Ukjent lønnsart." } };

    if (type.kind === "supplement") {
      const quantity = Number(raw.quantity);
      if (!(quantity > 0)) return { error: { code: "invalid_quantity", error: "Antall på et tillegg må være større enn null." } };
      parsed.push({ time_type_id: type.id, quantity, description: raw.description });
      continue;
    }

    // fra/til wins when both are given, because two people reading the same row should not be able
    // to disagree about it; a bare number of hours is the fallback for "she worked 2 hours, I don't
    // know exactly when".
    let minutes = lineMinutes(raw.start_time, raw.end_time);
    if (minutes == null) minutes = Math.round(Number(String(raw.minutes ?? "").toString().replace(",", ".")) || 0);
    if (!(minutes > 0)) return { error: { code: "invalid_line_minutes", error: "Hver timelinje må ha enten fra/til eller et antall timer." } };
    if (minutes > 24 * 60) return { error: { code: "interval_too_long", error: "En stempling kan ikke vare mer enn ett døgn." } };
    parsed.push({ time_type_id: type.id, start_time: raw.start_time || null, end_time: raw.end_time || null, minutes, description: raw.description });
  }
  return { lines: parsed };
}

// Registering a shift afterwards — somebody worked without scanning, or a phone was flat. Always
// carries source='manual' plus the edit trail from the first save, so a hand-entered shift is never
// indistinguishable from a stamped one in an export.
//
// Two ways to write one: a plain from/to shift (what a stamping would have produced), or a set of
// lines on named lønnsarter — 16:00–16:30 ordinary plus 16:30–18:00 overtime plus a night
// supplement. With lines, they decide the payable total and the from/to is only the outer frame.
timeRouter.post("/entries", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site_id, user_id, work_date, start_time, end_time, note } = req.body;
  const minutesOverride = normalizeMinutes(req.body.minutes);
  if (minutesOverride === false) {
    return res.status(400).json({ code: "invalid_minutes", error: "Timer må være et positivt antall minutter." });
  }
  if ((!site_id && !req.body.order_id) || !user_id || !isValidDate(work_date) || !start_time) {
    return res.status(400).json({ code: "missing_fields", error: "Ansatt, dato, starttid og enten lokasjon eller ordre er påkrevd." });
  }
  const { lines, error: lineError } = parseLines(req.body, req.user.company_id);
  if (lineError) return res.status(400).json(lineError);

  // Either a building, or an order with no building at all — internal time, driving, absence.
  // This is the branch that makes "hun glemte å føre ferie" registrable in the first place.
  const site = site_id ? db.prepare("SELECT * FROM sites WHERE id = ?").get(site_id) : null;
  if (site_id && (!site || site.company_id !== req.user.company_id)) {
    return res.status(400).json({ code: "unknown_site", error: "Ukjent lokasjon" });
  }
  const order = req.body.order_id
    ? getOrder(req.body.order_id, req.user.company_id)
    : site
      ? getOrder(orderIdForSite(site.id), req.user.company_id)
      : null;
  if (req.body.order_id && !order) return res.status(400).json({ code: "unknown_order", error: "Ukjent ordre" });
  if (!site && !order?.allows_manual) {
    return res.status(400).json({ code: "order_needs_site", error: "Denne ordren må føres på en lokasjon." });
  }
  // Same rule as training's getStaffTarget: never a customer, never a super_admin, never another
  // company's employee.
  const target = db.prepare("SELECT id, role, company_id FROM users WHERE id = ?").get(user_id);
  if (!target || target.company_id !== req.user.company_id || target.role === "customer" || target.role === "super_admin") {
    return res.status(400).json({ code: "unknown_user", error: "Ukjent ansatt" });
  }

  const startedAt = osloTimeToUtcStamp(work_date, start_time);
  if (!startedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });
  const endedAt = end_time ? osloTimeToUtcStamp(work_date, end_time) : null;
  if (end_time && !endedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });

  const intervalError = validateInterval(startedAt, endedAt);
  if (intervalError) return res.status(400).json({ code: intervalError.code, error: intervalError.error });

  const clash = findOverlap({ userId: target.id, startedAt, endedAt });
  if (clash) return res.status(409).json({ code: "overlapping_hours", error: overlapMessage(clash) });

  const actual = minutesBetween(startedAt, endedAt);
  // An order with no site has no rammetimetall to fall back on, so it is always paid by what was
  // written down.
  const billing = site ? billingFor(site, minutesOverride) : { billing_mode: minutesOverride != null ? "manual" : "actual", fixed_minutes: null };
  const info = insertManualStmt.run(
    req.user.company_id, site?.id ?? null, order?.id ?? null, target.id, work_date, startedAt, endedAt, actual,
    resolveMinutes({ billing, actual, minutesOverride }), billing.billing_mode, billing.fixed_minutes,
    (note || "").trim() || null, nowStamp(), req.user.name || null
  );

  const entry = getEntry(info.lastInsertRowid);
  if (lines) applyLines(entry, lines, req.user.company_id);
  else writeStampLine(db.prepare("SELECT * FROM time_entries WHERE id = ?").get(entry.id));
  logEntryEvent({
    entryId: entry.id, companyId: req.user.company_id, user: req.user,
    action: "created", status: "Registrert manuelt",
    comment: [order?.name, site?.name, note].filter(Boolean).join(" · ") || null,
  });
  res.status(201).json(entryWithApproval(entry.id, req.user.company_id));
});

// Lines decide the payable total once they exist: "6t ordinær + 1t 30m overtid" is 7t 30m, and
// lunch is stored and exported but never counted. Writing the sum back onto the entry is what lets
// every existing reader — the totals, the cleaner's own card, the planned-vs-actual report — keep
// working without knowing lines exist at all.
function applyLines(entry, lines, companyId) {
  const workedMinutes = replaceLines(entry, lines, companyId);
  // Once an admin has rewritten the lines by hand, they are what payroll reads — so pause_minutes
  // is re-derived from them rather than left showing what she originally answered at stamp-out.
  // Two numbers that disagree about the same break is exactly the thing somebody queries months
  // later, and the lines are the ones that got exported.
  const pause = getLines(entry.id)
    .filter((l) => l.kind === "hours" && !l.counts_as_work)
    .reduce((sum, l) => sum + (l.minutes || 0), 0);
  db.prepare("UPDATE time_entries SET minutes = ?, pause_minutes = ?, billing_mode = 'lines' WHERE id = ?")
    .run(workedMinutes, pause, entry.id);
}

// "Før timer" — the cleaner registering her own hours on an order that has no building: a staff
// meeting, driving between sites, a day of holiday or sick leave. Until orders existed she could
// not record any of it, because there was no QR code to scan for it.
//
// Deliberately NOT the admin's POST /entries with a looser role check. Three things are fixed here
// and cannot be passed in: it is always her own hours, always on an order marked allows_manual (a
// customer order is what the QR scan is for), and always source='manual' so it is visible as
// hand-entered in every export. She can create and she can see; correcting and deleting stay with
// the driftsleder, same as a stamping.
timeRouter.post("/me/entries", requireAuth, (req, res) => {
  const { order_id, work_date, start_time, end_time, time_type_id, hours, note } = req.body;
  if (!order_id || !isValidDate(work_date) || !start_time) {
    return res.status(400).json({ code: "missing_fields", error: "Ordre, dato og starttid er påkrevd." });
  }

  const order = getOrder(order_id, req.user.company_id);
  if (!order) return res.status(400).json({ code: "unknown_order", error: "Ukjent ordre" });
  if (!order.allows_manual) {
    return res.status(403).json({ code: "order_needs_site", error: "Denne ordren føres ved å skanne QR-koden på stedet." });
  }

  const startedAt = osloTimeToUtcStamp(work_date, start_time);
  if (!startedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });
  const endedAt = end_time ? osloTimeToUtcStamp(work_date, end_time) : null;
  if (end_time && !endedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });
  const intervalError = validateInterval(startedAt, endedAt);
  if (intervalError) return res.status(400).json({ code: intervalError.code, error: intervalError.error });

  // A locked period is closed to everybody, including the person whose hours they are.
  const locked = db
    .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE company_id = ? AND user_id = ? AND work_date = ? AND locked_at IS NOT NULL")
    .get(req.user.company_id, req.user.id, work_date).n;
  if (locked > 0) {
    return res.status(409).json({ code: "entry_locked", error: "Timene for denne dagen er låst. Snakk med driftsleder." });
  }

  // Either fra/til, or a bare number of hours — "jeg var syk hele dagen" is 7,5 timer, not a clock
  // reading, and forcing one would just get a made-up one.
  const typed = normalizeMinutes(hours != null && hours !== "" ? Math.round(Number(String(hours).replace(",", ".")) * 60) : null);
  if (typed === false) return res.status(400).json({ code: "invalid_minutes", error: "Timer må være et positivt antall." });
  const actual = minutesBetween(startedAt, endedAt);
  const minutes = typed ?? actual;
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ code: "missing_duration", error: "Fyll ut enten sluttid eller antall timer." });
  }

  const type = listTimeTypes(req.user.company_id).find((t) => t.id === Number(time_type_id) && t.kind === "hours");
  if (time_type_id && !type) return res.status(400).json({ code: "unknown_time_type", error: "Ukjent lønnsart." });

  // She gave a duration instead of an end time ("syk hele dagen, 7,5 timer"), so the end is derived
  // rather than left empty. Without this the row has no ended_at and is indistinguishable from a
  // shift she is still standing in — her own time-clock card would show a holiday as running.
  const closedAt = endedAt || db.prepare("SELECT datetime(?, ?) AS t").get(startedAt, `+${minutes} minutes`).t;

  // Her own registration is checked against her own shifts too — a holiday booked over a day she
  // actually stamped in is the same double payment, whoever typed it.
  const clash = findOverlap({ userId: req.user.id, startedAt, endedAt: closedAt });
  if (clash) return res.status(409).json({ code: "overlapping_hours", error: overlapMessage(clash) });

  const info = insertManualStmt.run(
    req.user.company_id, null, order.id, req.user.id, work_date, startedAt, closedAt, actual ?? minutes,
    minutes, "lines", null, (note || "").trim() || null, nowStamp(), req.user.name || null
  );
  const entry = getEntry(info.lastInsertRowid);
  applyLines(entry, [{ time_type_id: type?.id ?? null, minutes, start_time: end_time ? start_time : null, end_time: end_time || null }], req.user.company_id);
  // applyLines writes back the PAYABLE total, which is zero for ferie and sykefravær. The hours
  // were still registered, so the response says how many — otherwise her confirmation reads "0t 00m
  // ført på Fravær", which is true of the payroll sum and useless to her.
  logEntryEvent({
    entryId: entry.id, companyId: req.user.company_id, user: req.user,
    action: "created", status: "Ført av ansatt",
    comment: [order.name, type?.name, note].filter(Boolean).join(" · ") || null,
  });
  res.status(201).json(getEntry(entry.id));
});

// A number an admin typed wins over both the clock and the site's frame, and says so in
// billing_mode — a payroll correction has to be visible as one, not disguised as a measurement.
function billingFor(site, minutesOverride) {
  if (Number.isInteger(minutesOverride) && minutesOverride >= 0) {
    return { billing_mode: "manual", fixed_minutes: null };
  }
  const fixed = site.time_billing_mode === "fixed" && site.time_fixed_minutes > 0;
  return { billing_mode: fixed ? "fixed" : "actual", fixed_minutes: fixed ? site.time_fixed_minutes : null };
}

// The break she reported at stamp-out survives an admin correcting the clock. Leaving it out here
// meant a corrected shift silently paid the break back: 3 timer med 20 min pause kom ut som 3 timer.
function resolveMinutes({ billing, actual, minutesOverride, pauseMinutes = 0 }) {
  if (billing.billing_mode === "manual") return minutesOverride;
  return payableMinutes({ ...billing, actual_minutes: actual, pause_minutes: pauseMinutes });
}

const PATCH_TIME_FIELDS = ["start_time", "end_time", "note", "minutes", "work_date", "lines"];

// Correcting a shift. Every save stamps edited_at/edited_by_initials — the same pair room_runs
// already carries for a corrected checklist — because a changed hour is exactly the thing somebody
// will ask about three months later.
timeRouter.patch("/entries/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const locked = lockGuard(entry);
  if (locked) return res.status(locked.status).json({ code: locked.code, error: locked.error });
  if (!PATCH_TIME_FIELDS.some((f) => f in req.body)) {
    return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });
  }

  const workDate = "work_date" in req.body ? req.body.work_date : entry.work_date;
  if (!isValidDate(workDate)) return res.status(400).json({ code: "invalid_date", error: "Ugyldig dato." });

  const startTime = "start_time" in req.body ? req.body.start_time : osloTimeOf(entry.started_at);
  const startedAt = osloTimeToUtcStamp(workDate, startTime);
  if (!startedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });

  // An explicit empty end_time reopens the shift; omitting the field keeps whatever it had.
  let endedAt = entry.ended_at;
  if ("end_time" in req.body || "work_date" in req.body) {
    const endTime = "end_time" in req.body ? req.body.end_time : osloTimeOf(entry.ended_at);
    endedAt = endTime ? osloTimeToUtcStamp(workDate, endTime) : null;
    if (endTime && !endedAt) return res.status(400).json({ code: "invalid_time", error: "Ugyldig klokkeslett." });
  }

  const intervalError = validateInterval(startedAt, endedAt);
  if (intervalError) return res.status(400).json({ code: intervalError.code, error: intervalError.error });

  const minutesOverride = normalizeMinutes(req.body.minutes);
  if (minutesOverride === false) {
    return res.status(400).json({ code: "invalid_minutes", error: "Timer må være et positivt antall minutter." });
  }
  const { lines, error: lineError } = parseLines(req.body, req.user.company_id);
  if (lineError) return res.status(400).json(lineError);

  // Excluding this shift from its own overlap check, or every edit would collide with itself.
  const clash = findOverlap({ userId: entry.user_id, startedAt, endedAt, excludeEntryId: entry.id });
  if (clash) return res.status(409).json({ code: "overlapping_hours", error: overlapMessage(clash) });

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(entry.site_id);
  const actual = minutesBetween(startedAt, endedAt);
  // A correction that gives the shift a real end time also clears the auto-close flag: once a human
  // has decided when she left, "nobody stamped out" is no longer the story of this row.
  const autoClosedReason = endedAt && "end_time" in req.body ? null : entry.auto_closed_reason;
  // The entry keeps the billing rule it was closed under, rather than being re-priced against
  // whatever the site says today — changing a site's rammetimetall must not reach backwards into a
  // shift just because somebody later fixed a typo in its end time. A shift that never had one
  // (it's being closed for the first time here) takes the site's current rule.
  const billing = minutesOverride != null
    ? { billing_mode: "manual", fixed_minutes: null }
    : entry.billing_mode && entry.billing_mode !== "manual"
      ? { billing_mode: entry.billing_mode, fixed_minutes: entry.fixed_minutes }
      : billingFor(site, null);

  db.prepare(
    `UPDATE time_entries SET work_date = ?, started_at = ?, ended_at = ?, actual_minutes = ?, minutes = ?,
            billing_mode = ?, fixed_minutes = ?, auto_closed_reason = ?, note = ?,
            edited_at = ?, edited_by_initials = ? WHERE id = ?`
  ).run(
    workDate, startedAt, endedAt, actual,
    resolveMinutes({ billing, actual, minutesOverride, pauseMinutes: entry.pause_minutes }),
    billing.billing_mode, billing.fixed_minutes,
    autoClosedReason, "note" in req.body ? (req.body.note || "").trim() || null : entry.note,
    nowStamp(), req.user.name || null, entry.id
  );

  if (lines) applyLines(entry, lines, req.user.company_id);
  else if (entry.lines?.length <= (entry.pause_minutes > 0 ? 2 : 1)) {
    // A stamped shift carries one auto-written line for its whole duration, or two when she
    // reported a break. Rewrite them so the hours the correction just changed are the hours payroll
    // reads — but never touch a hand-built set of lines the admin is not editing right now.
    writeStampLine(db.prepare("SELECT * FROM time_entries WHERE id = ?").get(entry.id));
  }

  // An approval says "I looked at these hours". Once the hours change it no longer says anything
  // true, so every signature on the ladder comes off and the shift goes back in front of whoever
  // signed it. Deliberately not silent: the row visibly returns to "Venter".
  const hadApprovals = approvalsForEntry(entry.id).length > 0;
  if (hadApprovals) {
    clearApproval(entry.id);
    db.prepare("UPDATE time_entries SET approved_at = NULL, approved_by = NULL, approved_by_name = NULL WHERE id = ?").run(entry.id);
  }
  logEntryEvent({
    entryId: entry.id, companyId: entry.company_id, user: req.user, action: "edited",
    status: hadApprovals ? "Venter (godkjenning fjernet)" : "Endret",
    comment: req.body.note || describeEdit(entry, { workDate, startedAt, endedAt }),
  });
  res.json(entryWithApproval(entry.id, req.user.company_id));
});

// What actually changed, in the words somebody reading the log three months later would use.
function describeEdit(before, after) {
  const parts = [];
  if (before.work_date !== after.workDate) parts.push(`dato ${before.work_date} → ${after.workDate}`);
  if (before.started_at !== after.startedAt) parts.push(`inn ${osloTimeOf(before.started_at)} → ${osloTimeOf(after.startedAt)}`);
  if (before.ended_at !== after.endedAt) parts.push(`ut ${osloTimeOf(before.ended_at) || "—"} → ${osloTimeOf(after.endedAt) || "—"}`);
  return parts.join(", ") || null;
}

timeRouter.delete("/entries/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const locked = lockGuard(entry);
  if (locked) return res.status(locked.status).json({ code: locked.code, error: locked.error });

  // The log rows reference this entry, so they go with it — a log line pointing at a shift that no
  // longer exists explains nothing. The deletion itself is what the edit trail on every OTHER shift
  // is for; a deleted shift leaves the period's totals, which is where it would be noticed.
  db.prepare("DELETE FROM time_entry_approvals WHERE entry_id = ?").run(entry.id);
  db.prepare("DELETE FROM time_entry_log WHERE entry_id = ?").run(entry.id);
  db.prepare("DELETE FROM time_entry_lines WHERE entry_id = ?").run(entry.id);
  db.prepare("DELETE FROM time_entries WHERE id = ?").run(entry.id);
  res.json({ ok: true });
});

// --- Locking -------------------------------------------------------------------------------------

// Locks (or unlocks) a whole period at once, which is how payroll actually works: a month is
// closed, not one shift at a time. admin only — a driftsleder corrects hours, an admin is the one
// who declares them final.
//
// A still-running shift can't be locked: freezing an entry that has no end time yet would leave
// somebody's hours permanently at zero, which is the one thing a lock must never quietly do.
timeRouter.post("/lock", requireAuth, requireRole("admin"), (req, res) => {
  const { from, to, locked, user_id, site_id } = req.body;
  if (!isValidDate(from) || !isValidDate(to)) {
    return res.status(400).json({ code: "invalid_date", error: "from og to må være datoer (YYYY-MM-DD)." });
  }
  if (typeof locked !== "boolean") {
    return res.status(400).json({ code: "locked_required", error: "locked må være true eller false" });
  }

  const conditions = ["company_id = ?", "work_date >= ?", "work_date <= ?"];
  const params = [req.user.company_id, from, to];
  if (user_id) {
    conditions.push("user_id = ?");
    params.push(user_id);
  }
  if (site_id) {
    conditions.push("site_id = ?");
    params.push(site_id);
  }
  if (locked) conditions.push("ended_at IS NOT NULL");

  const info = db
    .prepare(
      locked
        ? `UPDATE time_entries SET locked_at = ?, locked_by = ? WHERE ${conditions.join(" AND ")}`
        : `UPDATE time_entries SET locked_at = NULL, locked_by = NULL WHERE ${conditions.join(" AND ")}`
    )
    .run(...(locked ? [nowStamp(), req.user.id, ...params] : params));

  const stillOpen = locked
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM time_entries
           WHERE company_id = ? AND work_date >= ? AND work_date <= ? AND ended_at IS NULL`
        )
        .get(req.user.company_id, from, to).n
    : 0;
  res.json({ changed: info.changes, skipped_open: stillOpen });
});

// --- Prosjekt og ordre ---------------------------------------------------------------------------

// The dimension hours are booked on. A site is a building with a QR code; an order is what gets
// invoiced and reported on, and not every order is a building — "Intern tid", "Kjøring" and
// "Fravær" have no site at all, which is exactly why hours could not be booked to them before.
timeRouter.get("/orders", requireAuth, (req, res) => {
  const orders = listOrders(req.user.company_id, { includeInactive: req.query.all === "1" });
  // A cleaner only ever needs the ones she can book on herself, and has no business browsing the
  // company's order book.
  if (!managesTime(req.user)) return res.json(orders.filter((o) => o.allows_manual));
  res.json(orders);
});

timeRouter.get("/projects", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(listProjects(req.user.company_id));
});

const ORDER_FIELDS = [
  "project_id", "number", "name", "kind", "client_id", "manager_id",
  "cost_center", "labels", "invoice_comment", "allows_manual", "active", "sort_order",
];

timeRouter.post("/orders", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, kind } = req.body;
  if (!name?.trim()) return res.status(400).json({ code: "name_required", error: "Navn er påkrevd." });
  const error = validateOrderRefs(req.body, req.user.company_id);
  if (error) return res.status(400).json(error);

  seedOrdersForCompany(req.user.company_id);
  const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM orders WHERE company_id = ?").get(req.user.company_id).n;
  const info = db
    .prepare(
      `INSERT INTO orders (company_id, project_id, number, name, kind, client_id, manager_id,
                           cost_center, labels, invoice_comment, allows_manual, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.company_id, req.body.project_id || null, (req.body.number || "").trim() || null, name.trim(),
      kind === "internal" || kind === "absence" ? kind : "customer",
      req.body.client_id || null, req.body.manager_id || null,
      (req.body.cost_center || "").trim() || null, (req.body.labels || "").trim() || null,
      (req.body.invoice_comment || "").trim() || null,
      // An order with no building has to be bookable by hand, or nobody can ever put hours on it.
      req.body.allows_manual || kind === "internal" || kind === "absence" ? 1 : 0,
      sortOrder
    );
  res.status(201).json(listOrders(req.user.company_id, { includeInactive: true }));
});

timeRouter.patch("/orders/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const order = getOrder(req.params.id, req.user.company_id);
  if (!order) return res.status(404).json({ code: "not_found", error: "Not found" });
  const refError = validateOrderRefs(req.body, req.user.company_id);
  if (refError) return res.status(400).json(refError);

  const fields = ORDER_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });
  const values = fields.map((f) => (typeof req.body[f] === "boolean" ? (req.body[f] ? 1 : 0) : req.body[f]));
  db.prepare(`UPDATE orders SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...values, order.id);
  res.json(listOrders(req.user.company_id, { includeInactive: true }));
});

// Never a hard delete once hours hang off it: the entries keep pointing somewhere real, and an
// order that explains last quarter's invoice should leave the dropdowns without leaving the books.
timeRouter.delete("/orders/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const order = getOrder(req.params.id, req.user.company_id);
  if (!order) return res.status(404).json({ code: "not_found", error: "Not found" });
  const used = db.prepare("SELECT COUNT(*) AS n FROM time_entries WHERE order_id = ?").get(order.id).n;
  if (used > 0) db.prepare("UPDATE orders SET active = 0 WHERE id = ?").run(order.id);
  else {
    db.prepare("UPDATE sites SET order_id = NULL WHERE order_id = ?").run(order.id);
    db.prepare("DELETE FROM orders WHERE id = ?").run(order.id);
  }
  res.json({ ok: true, deactivated: used > 0, used });
});

// Every foreign key in an order body has to belong to the same company — the rule from the
// engineering conventions, applied here rather than trusted.
function validateOrderRefs(body, companyId) {
  if (body.project_id) {
    const project = db.prepare("SELECT company_id FROM projects WHERE id = ?").get(body.project_id);
    if (!project || project.company_id !== companyId) return { code: "unknown_project", error: "Ukjent prosjekt" };
  }
  if (body.client_id) {
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(body.client_id);
    if (!client || client.company_id !== companyId) return { code: "unknown_client", error: "Ukjent kunde" };
  }
  if (body.manager_id) {
    const manager = db.prepare("SELECT company_id, role FROM users WHERE id = ?").get(body.manager_id);
    if (!manager || manager.company_id !== companyId || manager.role === "customer") {
      return { code: "unknown_user", error: "Ukjent ansatt" };
    }
  }
  return null;
}

timeRouter.post("/projects", requireAuth, requireRole("admin", "manager"), (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ code: "name_required", error: "Navn er påkrevd." });
  const error = validateOrderRefs(req.body, req.user.company_id);
  if (error) return res.status(400).json(error);
  const sortOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM projects WHERE company_id = ?").get(req.user.company_id).n;
  db.prepare("INSERT INTO projects (company_id, number, name, client_id, manager_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
    .run(req.user.company_id, (req.body.number || "").trim() || null, req.body.name.trim(), req.body.client_id || null, req.body.manager_id || null, sortOrder);
  res.status(201).json(listProjects(req.user.company_id));
});

// Filing a site under an order. Lives here rather than in sites.js because the order only exists
// for companies that have this module, and sites.js must stay unaware of it.
timeRouter.patch("/sites/:id/order", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  if (!site || site.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Not found" });
  if (req.body.order_id && !getOrder(req.body.order_id, req.user.company_id)) {
    return res.status(400).json({ code: "unknown_order", error: "Ukjent ordre" });
  }
  db.prepare("UPDATE sites SET order_id = ? WHERE id = ?").run(req.body.order_id || null, site.id);
  res.json({ ok: true });
});

// --- Godkjenningsnivåer --------------------------------------------------------------------------

// The ladder a shift climbs. Who may approve is an org-chart question, not a role question: a
// person with no level cannot approve even if they are an admin, and a manager at "Driftssjef"
// signs at that level and no other.
timeRouter.get("/approval-levels", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json({
    levels: listApprovalLevels(req.user.company_id),
    users: listUserLevels(req.user.company_id),
    mine: approvalLevelForUser(req.user.id),
  });
});

timeRouter.post("/approval-levels", requireAuth, requireRole("admin"), (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ code: "name_required", error: "Navn er påkrevd." });
  seedApprovalLevels(req.user.company_id);
  const step = Number(req.body.step) || db.prepare("SELECT COALESCE(MAX(step), 0) + 1 AS n FROM approval_levels WHERE company_id = ?").get(req.user.company_id).n;
  db.prepare("INSERT INTO approval_levels (company_id, name, step, required) VALUES (?, ?, ?, ?)")
    .run(req.user.company_id, req.body.name.trim(), step, req.body.required === false ? 0 : 1);
  res.status(201).json(listApprovalLevels(req.user.company_id));
});

timeRouter.patch("/approval-levels/:id", requireAuth, requireRole("admin"), (req, res) => {
  const level = db.prepare("SELECT * FROM approval_levels WHERE id = ?").get(req.params.id);
  if (!level || level.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Not found" });
  const fields = ["name", "step", "required"].filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });
  const values = fields.map((f) => (typeof req.body[f] === "boolean" ? (req.body[f] ? 1 : 0) : req.body[f]));
  db.prepare(`UPDATE approval_levels SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...values, level.id);
  res.json(listApprovalLevels(req.user.company_id));
});

// Removing a level keeps the sign-offs already made at it — they carry their own snapshot of the
// name, and deleting the evidence that somebody approved something is not a thing this app does.
timeRouter.delete("/approval-levels/:id", requireAuth, requireRole("admin"), (req, res) => {
  const level = db.prepare("SELECT * FROM approval_levels WHERE id = ?").get(req.params.id);
  if (!level || level.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Not found" });
  db.prepare("DELETE FROM user_approval_levels WHERE level_id = ?").run(level.id);
  db.prepare("DELETE FROM approval_levels WHERE id = ?").run(level.id);
  res.json(listApprovalLevels(req.user.company_id));
});

timeRouter.patch("/approval-levels/users/:userId", requireAuth, requireRole("admin"), (req, res) => {
  const target = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(req.params.userId);
  if (!target || target.company_id !== req.user.company_id || target.role === "customer" || target.role === "super_admin") {
    return res.status(404).json({ code: "not_found", error: "Not found" });
  }
  if (req.body.level_id) {
    const level = db.prepare("SELECT company_id FROM approval_levels WHERE id = ?").get(req.body.level_id);
    if (!level || level.company_id !== req.user.company_id) return res.status(400).json({ code: "unknown_level", error: "Ukjent nivå" });
  }
  setUserLevel(req.user.company_id, target.id, req.body.level_id || null);
  res.json(listUserLevels(req.user.company_id));
});

// --- Endringslogg --------------------------------------------------------------------------------

timeRouter.get("/log", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to } = parseRange(req);
  res.json(logForPeriod({
    companyId: req.user.company_id, from, to,
    userId: req.query.user_id || null, siteId: req.query.site_id || null,
  }));
});

timeRouter.get("/entries/:id/log", requireAuth, (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  res.json(logForEntry(entry.id));
});

// --- Team og ansattgrupper -----------------------------------------------------------------------

// Three ways of slicing the same staff, none of which replaces the others: Avdeling is the org unit
// a person is paid under (Rentlogg already had it), Team is where they physically work, Gruppe is
// what kind of staff they are. All three filter the timesheet.
//
// One generic pair of handlers rather than two near-identical sets — the two registers differ only
// in their table name, and a copy would drift.
const STAFF_REGISTERS = {
  teams: { table: "teams", column: "team_id", label: "team" },
  "employee-groups": { table: "employee_groups", column: "employee_group_id", label: "ansattgruppe" },
};

function staffRegister(req, res) {
  const register = STAFF_REGISTERS[req.params.register];
  if (!register) {
    res.status(404).json({ code: "not_found", error: "Not found" });
    return null;
  }
  return register;
}

function listStaffRegister(register, companyId) {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.${register.column} = r.id) AS user_count
       FROM ${register.table} r WHERE r.company_id = ? ORDER BY r.sort_order, r.name`
    )
    .all(companyId)
    .map((r) => ({ ...r, active: !!r.active }));
}

timeRouter.get("/registers/:register", requireAuth, (req, res) => {
  const register = staffRegister(req, res);
  if (!register) return;
  res.json(listStaffRegister(register, req.user.company_id));
});

timeRouter.post("/registers/:register", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const register = staffRegister(req, res);
  if (!register) return;
  if (!req.body.name?.trim()) return res.status(400).json({ code: "name_required", error: "Navn er påkrevd." });
  const sortOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${register.table} WHERE company_id = ?`).get(req.user.company_id).n;
  db.prepare(`INSERT INTO ${register.table} (company_id, name, sort_order) VALUES (?, ?, ?)`)
    .run(req.user.company_id, req.body.name.trim(), sortOrder);
  res.status(201).json(listStaffRegister(register, req.user.company_id));
});

timeRouter.patch("/registers/:register/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const register = staffRegister(req, res);
  if (!register) return;
  const row = db.prepare(`SELECT * FROM ${register.table} WHERE id = ?`).get(req.params.id);
  if (!row || row.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Not found" });
  const fields = ["name", "active", "sort_order"].filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });
  // The field names are a fixed list, but the values came straight off the request. POST above
  // already refuses a blank name; without the same check here a rename to "" saved a nameless row
  // that the timesheet's team filter then rendered as an unidentifiable blank, and a name of null
  // hit the NOT NULL column and surfaced as a 500 rather than a 400.
  if ("name" in req.body && !(typeof req.body.name === "string" && req.body.name.trim())) {
    return res.status(400).json({ code: "name_required", error: "Navn er påkrevd." });
  }
  // sort_order goes into an INTEGER column; a string or an object reaches better-sqlite3 as an
  // unbindable value and throws the same unhelpful 500.
  if ("sort_order" in req.body && !Number.isInteger(req.body.sort_order)) {
    return res.status(400).json({ code: "invalid_sort_order", error: "sort_order må være et heltall." });
  }
  const values = fields.map((f) => {
    if (f === "name") return req.body.name.trim();
    if (f === "active") return req.body.active ? 1 : 0;
    return req.body[f];
  });
  db.prepare(`UPDATE ${register.table} SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`).run(...values, row.id);
  res.json(listStaffRegister(register, req.user.company_id));
});

// The people keep their jobs; they just stop being in this team. Nothing about a person's hours
// depends on the row, so unlike an order or a lønnsart this one can genuinely be deleted.
timeRouter.delete("/registers/:register/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const register = staffRegister(req, res);
  if (!register) return;
  const row = db.prepare(`SELECT * FROM ${register.table} WHERE id = ?`).get(req.params.id);
  if (!row || row.company_id !== req.user.company_id) return res.status(404).json({ code: "not_found", error: "Not found" });
  db.prepare(`UPDATE users SET ${register.column} = NULL WHERE ${register.column} = ?`).run(row.id);
  db.prepare(`DELETE FROM ${register.table} WHERE id = ?`).run(row.id);
  res.json(listStaffRegister(register, req.user.company_id));
});

// Who is in which team/group. Lives here rather than on /auth/users because both registers only
// exist for a company that has this module.
timeRouter.get("/staff", requireAuth, requireRole("admin", "manager"), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT u.id, u.name, u.employee_number, u.team_id, u.employee_group_id, u.department_id,
                t.name AS team_name, g.name AS group_name, d.name AS department_name
         FROM users u
         LEFT JOIN teams t ON t.id = u.team_id
         LEFT JOIN employee_groups g ON g.id = u.employee_group_id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.company_id = ? AND u.role NOT IN ('customer', 'super_admin')
         ORDER BY u.name`
      )
      .all(req.user.company_id)
  );
});

timeRouter.patch("/staff/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const target = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(req.params.id);
  if (!target || target.company_id !== req.user.company_id || target.role === "customer" || target.role === "super_admin") {
    return res.status(404).json({ code: "not_found", error: "Not found" });
  }
  for (const [field, register] of [["team_id", STAFF_REGISTERS.teams], ["employee_group_id", STAFF_REGISTERS["employee-groups"]]]) {
    if (!(field in req.body)) continue;
    const value = req.body[field] || null;
    if (value) {
      const row = db.prepare(`SELECT company_id FROM ${register.table} WHERE id = ?`).get(value);
      if (!row || row.company_id !== req.user.company_id) {
        return res.status(400).json({ code: "unknown_register_row", error: `Ukjent ${register.label}` });
      }
    }
    db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, target.id);
  }
  res.json({ ok: true });
});

// --- Ugyldige data -------------------------------------------------------------------------------

// Mobile Worker keeps a screen for registrations that cannot go anywhere. Ours answers the same
// question in our own terms: what, in this period, would silently break or distort a payroll
// export? Every reason here is something a human has to fix — none of it can be guessed.
timeRouter.get("/attention", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: req.query.user_id || null, siteId: req.query.site_id || null, orderId: req.query.order_id || null,
  });

  const problems = [];
  for (const entry of entries) {
    const reasons = [];
    // Only genuine faults belong here. "Pågår fortsatt" and "ikke godkjent" were on this list at
    // first, and made it flag every row in a fresh period — a screen that cries wolf on 79 of 79
    // rows is one nobody opens twice. Both are answered by the timesheet's own approval filter.
    //
    // Zero hours would be exported as a real, paid nothing.
    if (entry.status === "missing_checkout") reasons.push({ code: "missing_checkout", text: "Mangler utstempling — teller null timer" });
    // Without an order the row lands in the export with blank Prosjekt/Ordre columns.
    if (!entry.order_id) reasons.push({ code: "no_order", text: "Ingen ordre — lokasjonen er ikke lagt under en" });
    // Without lines it has no lønnsart, and the line-level export skips straight past it.
    if (entry.ended_at && (!entry.lines || entry.lines.length === 0)) reasons.push({ code: "no_lines", text: "Ingen lønnsart" });
    if (entry.rejected) reasons.push({ code: "rejected", text: `Avvist: ${entry.rejection_comment || ""}`.trim() });
    // A shift still running is somebody at work, not a fault — but one left open across a lock or an
    // export would be, so it counts only once the period it belongs to is being closed.
    // Rows that predate the check, or that arrived some other way. The save path refuses new ones,
    // but a list that only looks forward would leave the existing damage invisible.
    const clash = findOverlap({ userId: entry.user_id, startedAt: entry.started_at, endedAt: entry.ended_at, excludeEntryId: entry.id });
    if (clash) reasons.push({ code: "overlap", text: overlapMessage(clash) });
    if (reasons.length) problems.push({ entry, reasons });
  }

  // Ordered by how badly each row breaks the export, so the list is worked from the top.
  // Overlap outranks everything: it is the only fault here that pays the same hour twice.
  const weight = { overlap: 6, missing_checkout: 5, no_order: 4, no_lines: 4, no_employee_number: 3, rejected: 2 };
  // …and the reasons WITHIN a row are ordered the same way, so the first line somebody reads is the
  // worst one rather than whichever check happened to run first.
  const worst = (p) => Math.max(...p.reasons.map((r) => weight[r.code] || 0));
  for (const problem of problems) problem.reasons.sort((a, b) => (weight[b.code] || 0) - (weight[a.code] || 0));
  problems.sort((a, b) => worst(b) - worst(a) || a.entry.work_date.localeCompare(b.entry.work_date));

  // Staff without a number are a company-wide problem, not a per-row one, and are listed here
  // instead of on every shift they worked. This was a per-row reason first, and one employee without
  // a number produced 39 identical lines — the banner says the same thing once, names the people,
  // and points at where it is fixed.
  const missingNumbers = db
    .prepare(
      `SELECT id, name FROM users WHERE company_id = ? AND role NOT IN ('customer','super_admin')
         AND active = 1 AND (employee_number IS NULL OR employee_number = '') ORDER BY name`
    )
    .all(req.user.company_id);

  res.json({ from, to, problems, missing_employee_numbers: missingNumbers, checked: entries.length });
});

// --- CSV -----------------------------------------------------------------------------------------

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const STATUS_LABELS = {
  closed: "Fullført",
  open: "Pågår",
  auto_closed: "Auto-avsluttet",
  missing_checkout: "Mangler utstempling",
};
const BILLING_LABELS = {
  actual: "Faktisk tid",
  fixed: "Rammetimer",
  manual: "Manuelt satt",
  // A shift whose hours come from its own lines rather than from one rule applied to the clock.
  lines: "Timelinjer",
};

// One row per LINE, not per stamping — because the line is what payroll actually imports: Unimicro
// reads the lønnsart code, and "7t 30m" on a shift means nothing to it until it is split into
// "6t ordinær" and "1t 30m overtid 50 %". A shift with no lines at all (still running, or missing
// its stamp-out) still gets one row, so nothing silently drops out of the sheet between the screen
// and the export.
//
// The BOM and \r\n line endings match reports.js's existing CSV: without them Excel on Norwegian
// Windows mangles æøå and puts everything on one line.
timeRouter.get("/entries.csv", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: req.query.user_id || null, siteId: req.query.site_id || null,
    orderId: req.query.order_id || null,
    approval: ["approved", "pending"].includes(req.query.approval) ? req.query.approval : null,
  }).filter(matchesStaffFilters(req));

  const header = [
    "Dato", "Ansatt", "Ansattnummer", "Prosjekt", "Ordre", "Ordrenummer", "Lokasjon",
    "Lønnsart", "Lønnsartkode", "Fra", "Til", "Timer", "Timer (desimal)",
    "Antall", "Teller som arbeid", "Linjebeskrivelse",
    "Inn", "Ut", "Faktisk tid", "Sum timer", "Beregning", "Status", "Kilde", "GPS inn", "GPS ut",
    "Planlagt renholder", "Godkjent", "Godkjent av", "Avvist", "Låst", "Endret", "Notat",
  ];
  const rows = [header.map(csvEscape).join(",")];

  // Everything about the shift itself repeats on each of its lines. Deliberate: a payroll import
  // reads one row at a time and cannot carry context down from the row above, and a human sorting
  // the sheet by employee would otherwise tear the context away from the numbers.
  const entryColumns = (entry) => [
    osloTimeOf(entry.started_at),
    osloTimeOf(entry.ended_at),
    formatMinutes(entry.actual_minutes),
    formatMinutes(entry.minutes),
    BILLING_LABELS[entry.billing_mode] || "",
    STATUS_LABELS[entry.status] || entry.status,
    entry.source === "manual" ? "Manuelt registrert" : "QR-skanning",
    entry.start_gps_verified ? "Ja" : "Nei",
    entry.ended_at ? (entry.end_gps_verified ? "Ja" : "Nei") : "",
    entry.assigned_cleaner_name || "",
    entry.approved ? "Ja" : "Nei",
    entry.approved_by_name || "",
    entry.rejected ? `Avvist: ${entry.rejection_comment || ""}`.trim() : "",
    entry.locked ? "Ja" : "Nei",
    entry.edited_at ? `${entry.edited_at.slice(0, 10)} ${entry.edited_by_initials || ""}`.trim() : "",
    entry.note || "",
  ];

  for (const entry of entries) {
    const entryLines = entry.lines?.length ? entry.lines : [null];
    for (const line of entryLines) {
      const isSupplement = line?.kind === "supplement";
      rows.push(
        [
          entry.work_date,
          entry.user_name,
          entry.employee_number || "",
          entry.project_name || "",
          entry.order_name || "",
          entry.order_number || "",
          entry.site_name || "",
          line?.type_name || "",
          line?.type_code || "",
          line?.start_time || "",
          line?.end_time || "",
          line && !isSupplement ? formatMinutes(line.minutes) : "",
          line && !isSupplement ? decimalHours(line.minutes) : "",
          isSupplement ? String(line.quantity ?? "").replace(".", ",") : "",
          line && !isSupplement ? (line.counts_as_work ? "Ja" : "Nei") : "",
          line?.description || "",
          ...entryColumns(entry),
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }

  // Per-person totals under the rows, blank-line separated: the sheet is read by a person before it
  // is read by a payroll system, and "what do I pay her" shouldn't require a pivot table. Broken
  // down by lønnsart for the same reason the export itself is.
  rows.push("");
  rows.push(["Ansatt", "Ansattnummer", "Lønnsart", "Lønnsartkode", "Timer", "Timer (desimal)", "Antall"].map(csvEscape).join(","));
  for (const total of summarizeByUser(entries)) {
    for (const type of total.types) {
      const isSupplement = type.kind === "supplement";
      rows.push(
        [
          total.user_name, total.employee_number || "", type.name || "", type.code || "",
          isSupplement ? "" : formatMinutes(type.minutes),
          isSupplement ? "" : decimalHours(type.minutes),
          isSupplement ? String(type.quantity).replace(".", ",") : "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    rows.push(
      ["", "", "Sum betalbart", "", formatMinutes(total.minutes), decimalHours(total.minutes), ""]
        .map(csvEscape)
        .join(",")
    );
  }

  const csv = `﻿${rows.join("\r\n")}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timer-${from}-${to}.csv`);
  res.send(csv);
});

// --- Excel og PDF --------------------------------------------------------------------------------

// The same rows as the CSV, in the two formats Mobile Worker also offers from its "Mer" menu, and
// read by different people: the spreadsheet by whoever moves hours into payroll, the PDF by whoever
// wants the month on paper.
//
// Built from one shared table so the three exports can never disagree about what a period contains.
function exportRows(req) {
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: req.query.user_id || null, siteId: req.query.site_id || null, orderId: req.query.order_id || null,
    approval: ["approved", "pending"].includes(req.query.approval) ? req.query.approval : null,
  }).filter(matchesStaffFilters(req));

  const header = [
    "Dato", "Ansatt", "Ansattnummer", "Prosjekt", "Ordre", "Ordrenummer", "Lokasjon",
    "Lønnsart", "Lønnsartkode", "Fra", "Til", "Timer", "Antall", "Teller som arbeid",
    "Sum arbeidede timer", "Status", "Kilde", "Godkjent", "Godkjent av", "Låst", "Notat",
  ];

  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines?.length ? entry.lines : [null]) {
      const isSupplement = line?.kind === "supplement";
      rows.push([
        entry.work_date,
        entry.user_name,
        entry.employee_number || "",
        entry.project_name || "",
        entry.order_name || "",
        entry.order_number || "",
        entry.site_name || "",
        line?.type_name || "",
        line?.type_code || "",
        line?.start_time || "",
        line?.end_time || "",
        // A real number, not a string: the whole point of the spreadsheet is that these can be
        // summed in Excel without anybody re-typing them.
        line && !isSupplement ? round2((line.minutes || 0) / 60) : "",
        isSupplement ? Number(line.quantity ?? 0) : "",
        line && !isSupplement ? (line.counts_as_work ? "Ja" : "Nei") : "",
        round2((entry.minutes || 0) / 60),
        STATUS_LABELS[entry.status] || entry.status,
        entry.source === "manual" ? "Manuelt registrert" : "QR-skanning",
        entry.approved ? "Ja" : "Nei",
        entry.approved_by_name || "",
        entry.locked ? "Ja" : "Nei",
        entry.note || "",
      ]);
    }
  }
  return { from, to, header, rows, entries };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

timeRouter.get("/entries.xlsx", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to, header, rows, entries } = exportRows(req);
  const totals = summarizeByUser(entries);

  // The per-person summary goes under the rows, blank-line separated, exactly as in the CSV — the
  // sheet is read by a person before it is read by a payroll system.
  const all = [header, ...rows, [], ["Ansatt", "Ansattnummer", "Lønnsart", "Lønnsartkode", "Timer", "Antall"]];
  for (const total of totals) {
    for (const type of total.types) {
      all.push([
        total.user_name, total.employee_number || "", type.name || "", type.code || "",
        type.kind === "supplement" ? "" : round2(type.minutes / 60),
        type.kind === "supplement" ? Number(type.quantity) : "",
      ]);
    }
    all.push(["", "", "Sum arbeidede timer", "", round2(total.minutes / 60), ""]);
  }

  sendXlsx(res, { filename: `timer-${from}-${to}.xlsx`, sheetName: `Timer ${from.slice(0, 7)}`, rows: all });
});

timeRouter.get("/entries.pdf", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to, entries } = exportRows(req);
  const totals = summarizeByUser(entries);

  // Deliberately fewer columns than the spreadsheet: a PDF is read, not calculated with, and
  // twenty-one columns on A4 landscape is a grey smear.
  const columns = [
    { label: "Dato", width: 1.1 },
    { label: "Ansatt", width: 2 },
    { label: "Nr.", width: 0.7 },
    { label: "Ordre", width: 2.2 },
    { label: "Inn", width: 0.8, align: "right" },
    { label: "Ut", width: 0.8, align: "right" },
    { label: "Lønnsarter", width: 3.4 },
    { label: "Timer", width: 1, align: "right" },
    { label: "Godkjent", width: 1.6 },
  ];

  const rows = entries.map((entry) => [
    entry.work_date,
    entry.user_name,
    entry.employee_number || "",
    [entry.order_number, entry.order_name].filter(Boolean).join(" ") || entry.site_name || "",
    osloTimeOf(entry.started_at),
    osloTimeOf(entry.ended_at) || "—",
    (entry.lines || [])
      .map((l) => `${l.type_name}: ${l.kind === "supplement" ? `${l.quantity} stk` : formatMinutes(l.minutes)}`)
      .join(", "),
    formatMinutes(entry.minutes),
    entry.approved ? entry.approved_by_name || "Ja" : entry.rejected ? "Avvist" : "Venter",
  ]);

  const grand = totals.reduce((sum, t) => sum + t.minutes, 0);
  sendTimesheetPdf(res, {
    filename: `timer-${from}-${to}.pdf`,
    title: "Timeliste",
    subtitle: `${from} – ${to} · ${entries.length} stemplinger · ${totals.length} ansatte · ${formatMinutes(grand)} totalt`,
    columns,
    rows,
    totals: ["", `Sum (${totals.length} ansatte)`, "", "", "", "", "", formatMinutes(grand), ""],
  });
});
