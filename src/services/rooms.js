import { db } from "../db.js";
import { todayInOslo, toOsloDateStr } from "./schedule.js";

// Same weekday convention as schedule.js: JS Date#getDay() — 0=Sunday..6=Saturday.

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

// Oslo-calendar-day difference, not raw millisecond math — a room completed at 23:58 Oslo
// one day and checked again at 00:05 Oslo the next day must read as "1 day since," not ~0.
function daysBetween(fromDateStr, toDateStr) {
  return Math.round((new Date(`${toDateStr}T00:00:00Z`) - new Date(`${fromDateStr}T00:00:00Z`)) / 86400000);
}

// Calendar date (1..31) of the Nth occurrence of `weekday` in year/month (0-indexed month),
// or null if that occurrence doesn't exist (e.g. a "5th Monday" in a short month).
// occurrence: 1..4 for first..fourth, -1 for "last". Recomputed fresh each call — this is
// what avoids the drift a fixed "every 30 days" interval would accumulate across months.
function nthWeekdayOfMonth(year, month, weekday, occurrence) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (occurrence === -1) {
    for (let d = daysInMonth; d >= 1; d--) {
      if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) return d;
    }
    return null;
  }
  let firstMatch = null;
  for (let d = 1; d <= 7; d++) {
    if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) {
      firstMatch = d;
      break;
    }
  }
  const target = firstMatch + (occurrence - 1) * 7;
  return target <= daysInMonth ? target : null;
}

// Room runs are stored in UTC; pre-filter to a +/-1 day UTC window, then resolve the exact
// Oslo calendar day in JS — same approach as schedule.js's site-run lookup.
const candidateRoomRunsStmt = db.prepare(
  `SELECT id, started_at, completed_at, cleaner_id FROM room_runs
   WHERE room_id = ? AND date(started_at) BETWEEN date(?, '-1 day') AND date(?, '+1 day')
   ORDER BY started_at DESC`
);

export function findRoomRunForDate(roomId, dateStr) {
  const candidates = candidateRoomRunsStmt.all(roomId, dateStr, dateStr);
  return candidates.find((r) => toOsloDateStr(r.started_at) === dateStr) || null;
}

export function getRoomStatusForDate(roomId, dateStr) {
  const run = findRoomRunForDate(roomId, dateStr);
  if (!run) return "missing";
  return run.completed_at ? "completed" : "in_progress";
}

const roomScheduleWeekdaysStmt = db.prepare("SELECT weekday FROM room_schedules WHERE room_id = ?");
const lastCompletedRoomRunStmt = db.prepare(
  `SELECT completed_at FROM room_runs WHERE room_id = ? AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1`
);

// Interval mode: due if never cleaned, or if it's been >= interval_days since the last
// completion (computed from the real last completed_at, not a fixed anchor — so changing
// interval_days later needs no migration, it just re-evaluates against real history).
// Monthly mode: due only on the Nth occurrence of a specific weekday in the current
// calendar month (e.g. "first Monday") — computed fresh per month, so it never drifts the
// way a fixed "every 30 days" interval would across 28/30/31-day months.
// Weekday mode: today's Oslo weekday matches a room_schedules row.
// No schedule configured at all: never "due" (but still open-able ad hoc).
export function isRoomDueOn(room, dateStr) {
  if (room.interval_days != null) {
    const last = lastCompletedRoomRunStmt.get(room.id);
    if (!last) return true;
    const lastOsloDay = toOsloDateStr(last.completed_at);
    return daysBetween(lastOsloDay, dateStr) >= room.interval_days;
  }
  if (room.monthly_weekday != null && room.monthly_occurrence != null) {
    const [year, month, day] = dateStr.split("-").map(Number);
    const targetDay = nthWeekdayOfMonth(year, month - 1, room.monthly_weekday, room.monthly_occurrence);
    return targetDay === day;
  }
  const weekdays = new Set(roomScheduleWeekdaysStmt.all(room.id).map((r) => r.weekday));
  if (weekdays.size === 0) return false;
  return weekdays.has(weekdayOf(dateStr));
}

const roomsForSiteStmt = db.prepare("SELECT * FROM rooms WHERE site_id = ? ORDER BY sort_order, id");
const itemCountStmt = db.prepare("SELECT COUNT(*) AS n FROM room_checklist_items WHERE room_id = ?");
const lastCleanedStmt = db.prepare(
  `SELECT completed_at FROM room_runs WHERE room_id = ? AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1`
);

export function getRoomsForSite(siteId, dateStr) {
  return roomsForSiteStmt.all(siteId).map((room) => ({
    ...room,
    dueToday: isRoomDueOn(room, dateStr),
    status: getRoomStatusForDate(room.id, dateStr),
    lastCleanedAt: lastCleanedStmt.get(room.id)?.completed_at || null,
    itemCount: itemCountStmt.get(room.id).n,
  }));
}

const roomItemsStmt = db.prepare("SELECT * FROM room_checklist_items WHERE room_id = ? ORDER BY sort_order");
const insertRoomRunStmt = db.prepare("INSERT INTO room_runs (room_id, cleaner_id) VALUES (?, ?)");
const insertRoomRunItemStmt = db.prepare(
  "INSERT INTO room_run_items (room_run_id, label, sort_order) VALUES (?, ?, ?)"
);
const roomRunByIdStmt = db.prepare("SELECT * FROM room_runs WHERE id = ?");

// Shared by the single-room check-in route and the bulk complete-all-due route. Reuses
// today's run if one already exists (completed or not — an already-completed run is returned
// as-is, never duplicated); otherwise creates one and snapshots the room's current task list.
export function findOrCreateTodayRoomRun(roomId, cleanerId) {
  const today = todayInOslo();
  const existing = findRoomRunForDate(roomId, today);
  if (existing) return existing;

  const info = insertRoomRunStmt.run(roomId, cleanerId || null);
  const items = roomItemsStmt.all(roomId);
  items.forEach((item, i) => insertRoomRunItemStmt.run(info.lastInsertRowid, item.label, i));
  return roomRunByIdStmt.get(info.lastInsertRowid);
}
