import { db } from "../db.js";
import { getRoomCompletionForSiteDate } from "./rooms.js";

// Weekday convention throughout this module: JS Date#getDay() — 0=Sunday..6=Saturday.
// Render runs in UTC, so "today" and any per-day matching must be computed in Europe/Oslo
// local time, not server time, or "I DAG"/schedule matching drifts a day near midnight.

export function todayInOslo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
}

// Only ever used for "what calendar day just ended" (e.g. a morning digest reporting on
// yesterday's visits) — a flat 24h offset before formatting is safe at day granularity since
// Oslo is at most +/-2h from UTC, never enough to skip or repeat a calendar day.
export function yesterdayInOslo() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(d);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

export function toOsloDateStr(sqliteDatetime) {
  const iso = `${sqliteDatetime.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date(iso));
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Runs are stored in UTC; pre-filter to a +/-1 day UTC window (cheap, index-friendly), then
// resolve the exact Oslo calendar day in JS to avoid UTC/Oslo boundary mismatches.
const candidateRunsStmt = db.prepare(
  `SELECT id, started_at, completed_at, gps_verified FROM checklist_runs
   WHERE site_id = ? AND date(started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
   ORDER BY started_at DESC`
);

const runItemCountsStmt = db.prepare(
  `SELECT COUNT(*) AS total, SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
   FROM checklist_run_items WHERE run_id = ?`
);

export function findRunForSiteDate(siteId, dateStr) {
  const candidates = candidateRunsStmt.all(siteId, dateStr, dateStr);
  return candidates.find((r) => toOsloDateStr(r.started_at) === dateStr) || null;
}

export function getRunStatusForSiteDate(siteId, dateStr) {
  const run = findRunForSiteDate(siteId, dateStr);
  if (!run) return "missing";
  return run.completed_at ? "completed" : "in_progress";
}

const sitesScheduledOnWeekdayStmt = db.prepare(
  `SELECT s.*, sch.assigned_cleaner_id, u.name AS assigned_cleaner_name
   FROM site_schedules sch
   JOIN sites s ON s.id = sch.site_id
   LEFT JOIN users u ON u.id = sch.assigned_cleaner_id
   WHERE sch.weekday = ? AND s.company_id = ?
   ORDER BY s.name`
);

// Sites scheduled on a given date, each tagged with whether today's run is missing/in_progress/completed.
export function getSitesScheduledOn(dateStr, companyId) {
  const weekday = weekdayOf(dateStr);
  return sitesScheduledOnWeekdayStmt.all(weekday, companyId).map((site) => ({
    ...site,
    scheduleStatus: getRunStatusForSiteDate(site.id, dateStr),
  }));
}

const scheduleWeekdaysStmt = db.prepare("SELECT weekday FROM site_schedules WHERE site_id = ?");

// Computes attendance stats for a month. Days after "today" are never counted (whether that's
// because the month is the current one and hasn't finished yet, or a future month entirely) —
// otherwise every current-month report shows a misleading "missing" count for days that simply
// haven't happened yet.
export function computeMonthlyReport({ month, siteId, departmentId, companyId }) {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monthStr);
  const today = todayInOslo();
  const totalDays = daysInMonth(year, mon);

  let sites;
  if (siteId) {
    sites = db.prepare("SELECT * FROM sites WHERE id = ? AND company_id = ?").all(siteId, companyId);
  } else if (departmentId) {
    sites = db.prepare("SELECT * FROM sites WHERE department_id = ? AND company_id = ?").all(departmentId, companyId);
  } else {
    sites = db.prepare("SELECT * FROM sites WHERE company_id = ?").all(companyId);
  }

  const scheduleBySite = new Map(
    sites.map((site) => [site.id, new Set(scheduleWeekdaysStmt.all(site.id).map((r) => r.weekday))])
  );

  let plannedDays = 0;
  let completedDays = 0;
  let missingDays = 0;
  const rows = [];

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = formatDate(year, mon, day);
    if (dateStr > today) continue;
    const weekday = weekdayOf(dateStr);

    for (const site of sites) {
      if (!scheduleBySite.get(site.id).has(weekday)) continue;

      plannedDays++;
      const run = findRunForSiteDate(site.id, dateStr);

      // Room-based site with at least one room actually due that day: judge "completed" by
      // whether those rooms actually got done, not by whether the flat visit wrapper was
      // closed — a cleaner can tap "Avslutt besøk" after finishing 2 of 29 rooms. Falls back
      // to the flat-run check for a non-room site, or a room-based one with nothing due that
      // particular day (rare — the site-level weekly plan and each room's own schedule aren't
      // required to agree).
      const roomCompletion = getRoomCompletionForSiteDate(site.id, dateStr);
      let completed, tasksCompleted, tasksTotal;
      if (roomCompletion && roomCompletion.dueCount > 0) {
        tasksTotal = roomCompletion.dueCount;
        tasksCompleted = roomCompletion.completedCount;
        completed = roomCompletion.completedCount === roomCompletion.dueCount;
      } else {
        const itemCounts = run ? runItemCountsStmt.get(run.id) : null;
        tasksTotal = itemCounts ? itemCounts.total || 0 : 0;
        tasksCompleted = itemCounts ? itemCounts.done || 0 : 0;
        completed = !!(run && run.completed_at);
      }
      if (completed) completedDays++;
      else missingDays++;

      rows.push({
        date: dateStr,
        site_id: site.id,
        site_name: site.name,
        // sites.room_count is only ever set at site-creation time and never kept in sync as
        // rooms get added/removed afterward — roomCompletion.totalRooms is the real, current
        // count, computed fresh from the rooms table itself. Falls back to the stale column
        // only for a non-room site, where it's meaningless anyway (always 0).
        room_count: roomCompletion?.totalRooms ?? (site.room_count || 0),
        status: completed ? "completed" : run ? "in_progress" : "missing",
        tasksCompleted,
        tasksTotal,
      });
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.site_name.localeCompare(b.site_name));
  const attendancePct = plannedDays > 0 ? Math.round((completedDays / plannedDays) * 100) : 0;

  return { attendancePct, plannedDays, completedDays, missingDays, rows };
}
