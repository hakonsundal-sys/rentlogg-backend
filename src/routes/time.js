import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { todayInOslo } from "../services/schedule.js";
import {
  computePlannedVsActual, decimalHours, findOpenEntry, formatMinutes, getEntry,
  isValidDate, listEntries, minutesBetween, nowStamp, osloTimeOf, osloTimeToUtcStamp,
  payableMinutes, stopEntry, summarizeByUser, validateInterval,
} from "../services/timeEntries.js";

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
  res.json(stopEntry(entry, { latitude, longitude }));
});

// --- The admin's views ---------------------------------------------------------------------------

timeRouter.get("/entries", requireAuth, (req, res) => {
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: resolveUserFilter(req), siteId: req.query.site_id || null,
  });
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

const insertManualStmt = db.prepare(
  `INSERT INTO time_entries (company_id, site_id, user_id, work_date, started_at, ended_at, source,
                             actual_minutes, minutes, billing_mode, fixed_minutes, note,
                             edited_at, edited_by_initials)
   VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`
);

// Registering a shift afterwards — somebody worked without scanning, or a phone was flat. Always
// carries source='manual' plus the edit trail from the first save, so a hand-entered shift is never
// indistinguishable from a stamped one in an export.
timeRouter.post("/entries", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { site_id, user_id, work_date, start_time, end_time, note } = req.body;
  const minutesOverride = normalizeMinutes(req.body.minutes);
  if (minutesOverride === false) {
    return res.status(400).json({ code: "invalid_minutes", error: "Timer må være et positivt antall minutter." });
  }
  if (!site_id || !user_id || !isValidDate(work_date) || !start_time) {
    return res.status(400).json({ code: "missing_fields", error: "Lokasjon, ansatt, dato og starttid er påkrevd." });
  }

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(site_id);
  if (!site || site.company_id !== req.user.company_id) {
    return res.status(400).json({ code: "unknown_site", error: "Ukjent lokasjon" });
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

  const actual = minutesBetween(startedAt, endedAt);
  const billing = billingFor(site, minutesOverride);
  const info = insertManualStmt.run(
    site.company_id, site.id, target.id, work_date, startedAt, endedAt, actual,
    resolveMinutes({ billing, actual, minutesOverride }), billing.billing_mode, billing.fixed_minutes,
    (note || "").trim() || null, nowStamp(), req.user.name || null
  );
  res.status(201).json(getEntry(info.lastInsertRowid));
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

function resolveMinutes({ billing, actual, minutesOverride }) {
  if (billing.billing_mode === "manual") return minutesOverride;
  return payableMinutes({ ...billing, actual_minutes: actual });
}

const PATCH_TIME_FIELDS = ["start_time", "end_time", "note", "minutes", "work_date"];

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
    resolveMinutes({ billing, actual, minutesOverride }), billing.billing_mode, billing.fixed_minutes,
    autoClosedReason, "note" in req.body ? (req.body.note || "").trim() || null : entry.note,
    nowStamp(), req.user.name || null, entry.id
  );
  res.json(getEntry(entry.id));
});

timeRouter.delete("/entries/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { entry, status, code, error } = getEntryScoped(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  const locked = lockGuard(entry);
  if (locked) return res.status(locked.status).json({ code: locked.code, error: locked.error });

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
const BILLING_LABELS = { actual: "Faktisk tid", fixed: "Rammetimer", manual: "Manuelt satt" };

// One row per stamping, not per person — payroll wants to be able to see the shift behind a total,
// and so does anybody answering a question about a particular day. The BOM and \r\n line endings
// match reports.js's existing CSV: without them Excel on Norwegian Windows mangles æøå and puts
// everything on one line.
timeRouter.get("/entries.csv", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { from, to } = parseRange(req);
  const entries = listEntries({
    companyId: req.user.company_id, from, to,
    userId: req.query.user_id || null, siteId: req.query.site_id || null,
  });

  const header = [
    "Dato", "Ansatt", "Lokasjon", "Inn", "Ut", "Faktisk tid", "Timer", "Timer (desimal)",
    "Beregning", "Status", "Kilde", "GPS inn", "GPS ut", "Planlagt renholder", "Låst", "Endret", "Notat",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const entry of entries) {
    lines.push(
      [
        entry.work_date,
        entry.user_name,
        entry.site_name,
        osloTimeOf(entry.started_at),
        osloTimeOf(entry.ended_at),
        formatMinutes(entry.actual_minutes),
        formatMinutes(entry.minutes),
        decimalHours(entry.minutes),
        BILLING_LABELS[entry.billing_mode] || "",
        STATUS_LABELS[entry.status] || entry.status,
        entry.source === "manual" ? "Manuelt registrert" : "QR-skanning",
        entry.start_gps_verified ? "Ja" : "Nei",
        entry.ended_at ? (entry.end_gps_verified ? "Ja" : "Nei") : "",
        entry.assigned_cleaner_name || "",
        entry.locked ? "Ja" : "Nei",
        entry.edited_at ? `${entry.edited_at.slice(0, 10)} ${entry.edited_by_initials || ""}`.trim() : "",
        entry.note || "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  // A per-person total under the rows, blank-line separated: the sheet is read by a person before
  // it's read by a payroll system, and "what do I pay her" shouldn't require a pivot table.
  lines.push("");
  lines.push(["Ansatt", "Timer", "Timer (desimal)", "Stemplinger", "Mangler utstempling"].map(csvEscape).join(","));
  for (const total of summarizeByUser(entries)) {
    lines.push(
      [total.user_name, formatMinutes(total.minutes), decimalHours(total.minutes), total.entry_count, total.missing_count]
        .map(csvEscape)
        .join(",")
    );
  }

  const csv = `﻿${lines.join("\r\n")}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timer-${from}-${to}.csv`);
  res.send(csv);
});
