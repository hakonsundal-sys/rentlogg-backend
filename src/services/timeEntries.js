import { db } from "../db.js";
import { isModuleEnabled } from "../modules.js";
import { isWithinSiteRadius } from "../utils/geo.js";
import { todayInOslo, toOsloDateStr } from "./schedule.js";

// Timeregistrering ("Timeklokke"): everything that reads or writes a time_entry, in one place, so
// the QR check-in in routes/sites.js can start a shift without knowing any of the rules.
//
// See schema.sql's comment on time_entries for why this is a table of its own instead of hours
// read off checklist_runs. The short version: a run is shared per site per day, a shift is not.
//
// Weekday convention here is the app's own — Date#getDay(), 0=søndag..6=lørdag — matching
// site_schedules and services/schedule.js. (Getting this backwards once already cost 11 sites a
// corrected import.)

export const BILLING_MODES = ["actual", "fixed"];
const MINUTES_PER_DAY = 24 * 60;

// --- Time helpers ------------------------------------------------------------------------------

// SQLite's datetime('now') is UTC with a space instead of a T; Date needs both fixed.
function parseStamp(value) {
  return value ? new Date(`${String(value).replace(" ", "T")}Z`) : null;
}

export function nowStamp() {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}

export function minutesBetween(startedAt, endedAt) {
  const start = parseStamp(startedAt);
  const end = parseStamp(endedAt);
  if (!start || !end) return null;
  return Math.round((end - start) / 60000);
}

// "2t 35m" — how every hour figure is written in the UI and the CSV. Minutes alone are unreadable
// on a monthly total ("9 480 minutter"), and decimal hours invite silently rounding payroll.
export function formatMinutes(minutes) {
  if (minutes == null) return "";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}t ${String(abs % 60).padStart(2, "0")}m`;
}

// Decimal hours, for the CSV column a payroll system actually imports. Two decimals: a quarter
// hour is 0.25 exactly, and anything finer than that isn't real in this domain anyway.
export function decimalHours(minutes) {
  if (minutes == null) return "";
  return (minutes / 60).toFixed(2).replace(".", ",");
}

// --- Billing -----------------------------------------------------------------------------------

// The site's own rule, read once at the moment an entry is closed and then frozen onto the row.
// 'fixed' without a rammetimetall set would silently pay nothing, so it degrades to the clock
// rather than to zero — the admin UI requires the number, but a hand-edited database shouldn't be
// able to erase somebody's hours.
export function billingForSite(site) {
  const fixed = site.time_billing_mode === "fixed" && site.time_fixed_minutes > 0;
  return {
    billing_mode: fixed ? "fixed" : "actual",
    fixed_minutes: fixed ? site.time_fixed_minutes : null,
  };
}

// What this shift is worth, given how long it lasted and which rule applies. A fixed-frame site
// pays its frame from the moment the shift is closed at all, however short or long it ran — that
// is what "fast rammetimetall uavhengig av hvor mange timer de faktisk var der" means. An entry
// that was never closed is worth nothing yet, in either mode: no stamp-out, no hours.
export function payableMinutes({ billing_mode, fixed_minutes, actual_minutes }) {
  if (actual_minutes == null) return null;
  if (billing_mode === "fixed") return fixed_minutes ?? actual_minutes;
  return actual_minutes;
}

// --- Row shaping -------------------------------------------------------------------------------

// 'open'             stamped in, still running
// 'closed'           stamped in and out, the ordinary case
// 'auto_closed'      closed for her at the moment she stamped in somewhere else — a real end time,
//                    but not one she chose, so the admin list marks it for a glance-over
// 'missing_checkout' left open into a later day; has no end time at all and counts zero hours
//                    until somebody corrects it by hand
export function statusOf(entry) {
  if (!entry.ended_at) return entry.auto_closed_reason ? "missing_checkout" : "open";
  return entry.auto_closed_reason ? "auto_closed" : "closed";
}

const entryRowStmt = db.prepare(
  `SELECT t.*, s.name AS site_name, u.name AS user_name, sch.assigned_cleaner_id,
          au.name AS assigned_cleaner_name
   FROM time_entries t
   JOIN sites s ON s.id = t.site_id
   JOIN users u ON u.id = t.user_id
   LEFT JOIN site_schedules sch
     ON sch.site_id = t.site_id
    AND sch.weekday = CAST(strftime('%w', t.work_date) AS INTEGER)
   LEFT JOIN users au ON au.id = sch.assigned_cleaner_id
   WHERE t.id = ?`
);

// strftime('%w') is 0=Sunday, the same convention as Date#getDay() — which is why the join above
// can compare it straight against site_schedules.weekday without translating.
export function decorate(entry) {
  if (!entry) return null;
  return {
    ...entry,
    status: statusOf(entry),
    start_gps_verified: !!entry.start_gps_verified,
    end_gps_verified: !!entry.end_gps_verified,
    locked: !!entry.locked_at,
    // "Planned vs actual" at the level of one row: was this person the one the weekly plan
    // expected at this site on this weekday? null when the site has no plan for that day at all.
    as_planned: entry.assigned_cleaner_id == null ? null : entry.assigned_cleaner_id === entry.user_id,
  };
}

export function getEntry(id) {
  return decorate(entryRowStmt.get(id));
}

// --- Stamping ----------------------------------------------------------------------------------

const openEntriesForUserStmt = db.prepare(
  "SELECT * FROM time_entries WHERE user_id = ? AND ended_at IS NULL AND auto_closed_reason IS NULL ORDER BY started_at"
);

export function findOpenEntry(userId) {
  const open = openEntriesForUserStmt.all(userId)[0];
  return open ? getEntry(open.id) : null;
}

const siteByIdStmt = db.prepare("SELECT * FROM sites WHERE id = ?");

// Closes whatever the person left hanging, on the way into a new stamping. Two genuinely different
// cases, deliberately handled differently rather than with one "just close it" rule:
//
//  - same working day, another site: she left the first place when she arrived at the second, so
//    the departure time is known well enough to use. Flagged all the same, since she didn't stamp
//    it herself.
//  - an earlier day: nobody knows when she went home, and guessing would put invented minutes into
//    a payroll export. Left with no ended_at, worth zero hours, and surfaced to the admin as
//    "mangler utstempling" until a human fixes it.
function closeDanglingEntries(userId, workDate, at) {
  const open = openEntriesForUserStmt.all(userId);
  const closeSameDay = db.prepare(
    `UPDATE time_entries SET ended_at = ?, actual_minutes = ?, minutes = ?, billing_mode = ?,
            fixed_minutes = ?, auto_closed_reason = 'new_checkin' WHERE id = ?`
  );
  const markStale = db.prepare("UPDATE time_entries SET auto_closed_reason = 'stale' WHERE id = ?");

  for (const entry of open) {
    if (entry.work_date !== workDate) {
      markStale.run(entry.id);
      continue;
    }
    const site = siteByIdStmt.get(entry.site_id);
    const billing = billingForSite(site);
    const actual = minutesBetween(entry.started_at, at);
    closeSameDay.run(at, actual, payableMinutes({ ...billing, actual_minutes: actual }), billing.billing_mode, billing.fixed_minutes, entry.id);
  }
}

const insertEntryStmt = db.prepare(
  `INSERT INTO time_entries (company_id, site_id, user_id, work_date, started_at, source, run_id,
                             start_gps_verified, start_latitude, start_longitude)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Called from the QR check-in (routes/sites.js). Returns the entry, or null when the company
// doesn't have the module — the check-in itself must work exactly as before for everyone else, so
// the gate lives here rather than making sites.js know about modules.
//
// Re-scanning the same site while already stamped in there returns the running entry untouched,
// mirroring how the check-in itself reuses the day's run instead of creating a second one. Without
// that, a cleaner who rescans to reopen her checklist would restart her own shift clock.
export function startEntryForCheckin({ site, user, latitude, longitude, runId }) {
  if (!isModuleEnabled(user.company_id, "timeclock")) return null;

  const at = nowStamp();
  const workDate = todayInOslo();

  const alreadyHere = openEntriesForUserStmt.all(user.id).find((e) => e.site_id === site.id && e.work_date === workDate);
  if (alreadyHere) return getEntry(alreadyHere.id);

  closeDanglingEntries(user.id, workDate, at);

  const info = insertEntryStmt.run(
    site.company_id, site.id, user.id, workDate, at, "qr", runId || null,
    isWithinSiteRadius(site, latitude, longitude), latitude ?? null, longitude ?? null
  );
  return getEntry(info.lastInsertRowid);
}

const stopEntryStmt = db.prepare(
  `UPDATE time_entries SET ended_at = ?, actual_minutes = ?, minutes = ?, billing_mode = ?, fixed_minutes = ?,
          end_gps_verified = ?, end_latitude = ?, end_longitude = ?
   WHERE id = ?`
);

// Stamping out. The site's billing rule is read here, at the end of the shift, and written onto the
// row — from this point the entry carries its own answer and stops depending on the site's current
// settings.
export function stopEntry(entry, { latitude, longitude }) {
  const site = siteByIdStmt.get(entry.site_id);
  const at = nowStamp();
  const actual = minutesBetween(entry.started_at, at);
  const billing = billingForSite(site);
  stopEntryStmt.run(
    at, actual, payableMinutes({ ...billing, actual_minutes: actual }), billing.billing_mode, billing.fixed_minutes,
    isWithinSiteRadius(site, latitude, longitude), latitude ?? null, longitude ?? null, entry.id
  );
  return getEntry(entry.id);
}

// --- Listing -----------------------------------------------------------------------------------

// from/to are inclusive Oslo working days. user_id/site_id narrow further; the caller is
// responsible for having already restricted user_id to somebody they're allowed to read.
export function listEntries({ companyId, from, to, userId, siteId }) {
  const conditions = ["t.company_id = ?", "t.work_date >= ?", "t.work_date <= ?"];
  const params = [companyId, from, to];
  if (userId) {
    conditions.push("t.user_id = ?");
    params.push(userId);
  }
  if (siteId) {
    conditions.push("t.site_id = ?");
    params.push(siteId);
  }
  return db
    .prepare(
      `SELECT t.*, s.name AS site_name, u.name AS user_name, sch.assigned_cleaner_id,
              au.name AS assigned_cleaner_name
       FROM time_entries t
       JOIN sites s ON s.id = t.site_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN site_schedules sch
         ON sch.site_id = t.site_id
        AND sch.weekday = CAST(strftime('%w', t.work_date) AS INTEGER)
       LEFT JOIN users au ON au.id = sch.assigned_cleaner_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.work_date DESC, t.started_at DESC`
    )
    .all(...params)
    .map(decorate);
}

// --- Planned vs actual ---------------------------------------------------------------------------

const scheduleRowsStmt = db.prepare(
  `SELECT sch.site_id, sch.weekday, sch.assigned_cleaner_id, s.name AS site_name,
          s.time_billing_mode, s.time_fixed_minutes, u.name AS assigned_cleaner_name
   FROM site_schedules sch
   JOIN sites s ON s.id = sch.site_id
   LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
   WHERE s.company_id = ?`
);

function eachDate(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && days.length <= 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

// The comparison the whole module exists to make possible: the weekly plan (site_schedules, with
// its assigned_cleaner_id) against what was actually stamped.
//
// Four kinds of row come out, and only the first is uninteresting:
//  - 'ok'          planned, and the planned person stamped
//  - 'substitute'  planned, but somebody else stamped — normal here (cleaners cover for each
//                  other), so it's information, not an error
//  - 'no_show'     planned, nobody stamped at all
//  - 'unplanned'   somebody stamped on a day the site has no plan for
//
// planned_minutes is the site's rammetimetall where one is set. A site paid by the clock has no
// planned number to compare against — that column is simply blank for it rather than invented.
export function computePlannedVsActual({ companyId, from, to, siteId, userId }) {
  const entries = listEntries({ companyId, from, to, siteId, userId });
  const entriesByKey = new Map();
  for (const entry of entries) {
    const key = `${entry.site_id}:${entry.work_date}`;
    if (!entriesByKey.has(key)) entriesByKey.set(key, []);
    entriesByKey.get(key).push(entry);
  }

  const schedules = scheduleRowsStmt.all(companyId).filter((row) => !siteId || row.site_id === Number(siteId));
  const rows = [];
  const seen = new Set();

  for (const date of eachDate(from, to)) {
    const weekday = weekdayOf(date);
    for (const schedule of schedules) {
      if (schedule.weekday !== weekday) continue;
      const key = `${schedule.site_id}:${date}`;
      const dayEntries = entriesByKey.get(key) || [];
      seen.add(key);
      // Filtering by one person turns this into "her" sheet, so a day she wasn't planned for and
      // didn't work isn't her no-show to answer for.
      if (userId && dayEntries.length === 0 && String(schedule.assigned_cleaner_id) !== String(userId)) continue;

      const planned = schedule.time_billing_mode === "fixed" ? schedule.time_fixed_minutes : null;
      const actualMinutes = dayEntries.reduce((sum, e) => sum + (e.minutes || 0), 0);
      const names = [...new Set(dayEntries.map((e) => e.user_name))];
      let status = "no_show";
      if (dayEntries.length > 0) {
        status = dayEntries.some((e) => e.user_id === schedule.assigned_cleaner_id) || schedule.assigned_cleaner_id == null
          ? "ok"
          : "substitute";
      }

      rows.push({
        date,
        site_id: schedule.site_id,
        site_name: schedule.site_name,
        assigned_cleaner_id: schedule.assigned_cleaner_id,
        assigned_cleaner_name: schedule.assigned_cleaner_name,
        actual_names: names,
        entry_count: dayEntries.length,
        planned_minutes: planned,
        actual_minutes: dayEntries.length ? actualMinutes : null,
        status,
      });
    }
  }

  // Everything stamped on a day the plan says nothing about — an extra visit, a one-off, or a site
  // whose weekly plan was never filled in. Left out and these hours would be invisible in the very
  // report meant to account for all of them.
  for (const [key, dayEntries] of entriesByKey) {
    if (seen.has(key)) continue;
    const first = dayEntries[0];
    rows.push({
      date: first.work_date,
      site_id: first.site_id,
      site_name: first.site_name,
      assigned_cleaner_id: null,
      assigned_cleaner_name: null,
      actual_names: [...new Set(dayEntries.map((e) => e.user_name))],
      entry_count: dayEntries.length,
      planned_minutes: null,
      actual_minutes: dayEntries.reduce((sum, e) => sum + (e.minutes || 0), 0),
      status: "unplanned",
    });
  }

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.site_name.localeCompare(b.site_name, "nb"));
  return rows;
}

// Per-person totals for the period — the top of the admin's Timer page, and the numbers that go to
// payroll. `open_count`/`missing_count` are there so a total is never read as final while somebody
// is still stamped in or a stamp-out is missing.
export function summarizeByUser(entries) {
  const byUser = new Map();
  for (const entry of entries) {
    if (!byUser.has(entry.user_id)) {
      byUser.set(entry.user_id, {
        user_id: entry.user_id, user_name: entry.user_name,
        minutes: 0, actual_minutes: 0, entry_count: 0, open_count: 0, missing_count: 0,
        locked_count: 0, site_ids: new Set(),
      });
    }
    const row = byUser.get(entry.user_id);
    row.minutes += entry.minutes || 0;
    row.actual_minutes += entry.actual_minutes || 0;
    row.entry_count++;
    if (entry.status === "open") row.open_count++;
    if (entry.status === "missing_checkout") row.missing_count++;
    if (entry.locked) row.locked_count++;
    row.site_ids.add(entry.site_id);
  }
  return [...byUser.values()]
    .map(({ site_ids, ...row }) => ({ ...row, site_count: site_ids.size }))
    .sort((a, b) => a.user_name.localeCompare(b.user_name, "nb"));
}

// --- Validation ----------------------------------------------------------------------------------

export function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// "HH:MM" as typed in the admin's edit form, combined with the entry's own working day. Kept in
// Oslo local time in the UI and converted here, since that's the clock the person actually read
// off the wall — storing what they typed as if it were UTC would shift every shift by an hour or
// two depending on the season.
export function osloTimeToUtcStamp(dateStr, timeStr) {
  if (!isValidDate(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) return null;
  // Find the UTC instant whose Oslo wall clock reads dateStr/timeStr, by trying both plausible
  // offsets — simpler and more robust across DST than hardcoding +01/+02.
  for (const offset of [0, 1, 2, 3]) {
    const candidate = new Date(`${dateStr}T${timeStr}:00Z`);
    candidate.setUTCHours(candidate.getUTCHours() - offset);
    const stamp = candidate.toISOString().slice(0, 19).replace("T", " ");
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(candidate);
    const get = (type) => parts.find((p) => p.type === type).value;
    if (`${get("year")}-${get("month")}-${get("day")}` === dateStr && `${get("hour")}:${get("minute")}` === timeStr) {
      return stamp;
    }
  }
  return null;
}

// The Oslo wall clock an entry's stored UTC stamp corresponds to — the inverse of the above, used
// to fill the edit form and the CSV.
export function osloTimeOf(stamp) {
  if (!stamp) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(parseStamp(stamp));
}

export function osloDateOf(stamp) {
  return stamp ? toOsloDateStr(stamp) : "";
}

// An end before its own start, or a shift longer than a calendar day, is a typo rather than a
// shift — both would otherwise go into payroll as a very large or negative number.
export function validateInterval(startedAt, endedAt) {
  if (!endedAt) return null;
  const minutes = minutesBetween(startedAt, endedAt);
  if (minutes < 0) return { code: "end_before_start", error: "Utstempling kan ikke være før innstempling." };
  if (minutes > MINUTES_PER_DAY) return { code: "interval_too_long", error: "En stempling kan ikke vare mer enn ett døgn." };
  return null;
}
