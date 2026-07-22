import { db } from "../db.js";

// Weekday convention throughout this module: JS Date#getDay() — 0=Sunday..6=Saturday.
// Render runs in UTC, so "today" and any per-day matching must be computed in Europe/Oslo
// local time, not server time, or "I DAG"/schedule matching drifts a day near midnight.

export function todayInOslo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
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
  `SELECT id, started_at, completed_at FROM checklist_runs
   WHERE site_id = ? AND date(started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
   ORDER BY started_at DESC`
);

const runItemCountsStmt = db.prepare(
  `SELECT COUNT(*) AS total, SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
   FROM checklist_run_items WHERE run_id = ?`
);

function findRunForSiteDate(siteId, dateStr) {
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
   WHERE sch.weekday = ?
   ORDER BY s.name`
);

// Sites scheduled on a given date, each tagged with whether today's run is missing/in_progress/completed.
export function getSitesScheduledOn(dateStr) {
  const weekday = weekdayOf(dateStr);
  return sitesScheduledOnWeekdayStmt.all(weekday).map((site) => ({
    ...site,
    scheduleStatus: getRunStatusForSiteDate(site.id, dateStr),
  }));
}

const scheduleWeekdaysStmt = db.prepare("SELECT weekday FROM site_schedules WHERE site_id = ?");

// Computes attendance stats for a month. Days after "today" are never counted (whether that's
// because the month is the current one and hasn't finished yet, or a future month entirely) —
// otherwise every current-month report shows a misleading "missing" count for days that simply
// haven't happened yet.
export function computeMonthlyReport({ month, siteId }) {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monthStr);
  const today = todayInOslo();
  const totalDays = daysInMonth(year, mon);

  const sites = siteId
    ? db.prepare("SELECT * FROM sites WHERE id = ?").all(siteId)
    : db.prepare("SELECT * FROM sites").all();

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
      const completed = !!(run && run.completed_at);
      if (completed) completedDays++;
      else missingDays++;

      const itemCounts = run ? runItemCountsStmt.get(run.id) : null;
      rows.push({
        date: dateStr,
        site_id: site.id,
        site_name: site.name,
        room_count: site.room_count || 0,
        status: completed ? "completed" : run ? "in_progress" : "missing",
        tasksCompleted: itemCounts ? itemCounts.done || 0 : 0,
        tasksTotal: itemCounts ? itemCounts.total || 0 : 0,
      });
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date) || a.site_name.localeCompare(b.site_name));
  const attendancePct = plannedDays > 0 ? Math.round((completedDays / plannedDays) * 100) : 0;

  return { attendancePct, plannedDays, completedDays, missingDays, rows };
}
