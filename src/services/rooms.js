import { db } from "../db.js";
import { todayInOslo, toOsloDateStr, findRunForSiteDate } from "./schedule.js";

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
  `SELECT id, started_at, completed_at, cleaner_id, signed_initials, edited_at, edited_by_initials, note FROM room_runs
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

// Same "Nth weekday of month" check as isRoomDueOn's monthly mode, just scoped to one
// checklist item instead of the whole room. No interval_days mode here (unlike rooms): an
// item has no completion history of its own to measure "days since last done" against, so
// only the pure-calendar monthly mode is supported. No schedule set at all means due every
// time the room is — the pre-existing behavior for every item created before this existed.
export function isItemDueOn(item, dateStr) {
  if (item.monthly_weekday == null || item.monthly_occurrence == null) return true;
  const [year, month, day] = dateStr.split("-").map(Number);
  const targetDay = nthWeekdayOfMonth(year, month - 1, item.monthly_weekday, item.monthly_occurrence);
  return targetDay === day;
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
    signedInitials: findRoomRunForDate(room.id, dateStr)?.signed_initials || null,
  }));
}

// Powers oversight views (monthly report, dashboard) that previously judged a room-based site's
// day purely by whether the flat checklist_runs wrapper got closed ("Avslutt besøk") — true even
// if the cleaner tapped that after finishing 2 of 29 rooms. This instead counts the rooms that
// were actually due that day and how many of them were actually completed. Returns null for a
// site with no rooms at all, so callers can tell "not room-based" apart from "room-based, 0 due".
export function getRoomCompletionForSiteDate(siteId, dateStr) {
  const rooms = roomsForSiteStmt.all(siteId);
  if (rooms.length === 0) return null;
  const dueRooms = rooms.filter((room) => isRoomDueOn(room, dateStr));
  const completedCount = dueRooms.filter((room) => getRoomStatusForDate(room.id, dateStr) === "completed").length;
  return { dueCount: dueRooms.length, completedCount, totalRooms: rooms.length };
}

// Powers the room×day "vaskeplan" grid on Rapporter/customer views: for one site and month,
// every room's day-by-day status — reusing the exact same due/status logic the cleaner app and
// monthly report already use, so this view always agrees with what they show. Days after today
// are left out entirely (not "missing") since nothing was due to have happened yet. Also
// returns the flat checklist_run id behind each day (one per site per day, shared by every
// room that day), so a UI can link a cell straight to that day's editable checklist.
export function getRoomGridForSiteMonth(siteId, year, month) {
  const rooms = roomsForSiteStmt.all(siteId);
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = todayInOslo();
  const runsByDate = {};

  const roomRows = rooms.map((room) => {
    const days = {};
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (dateStr > today) break;
      days[dateStr] = isRoomDueOn(room, dateStr) ? getRoomStatusForDate(room.id, dateStr) : "not_due";
      if (!(dateStr in runsByDate)) runsByDate[dateStr] = findRunForSiteDate(siteId, dateStr)?.id || null;
    }
    return { id: room.id, name: room.name, days };
  });

  return { rooms: roomRows, runsByDate };
}

const roomItemsStmt = db.prepare("SELECT * FROM room_checklist_items WHERE room_id = ? ORDER BY sort_order");
const insertRoomRunStmt = db.prepare("INSERT INTO room_runs (room_id, cleaner_id) VALUES (?, ?)");
const insertRoomRunItemStmt = db.prepare(
  "INSERT INTO room_run_items (room_run_id, room_checklist_item_id, label, sort_order) VALUES (?, ?, ?, ?)"
);
const roomRunByIdStmt = db.prepare("SELECT * FROM room_runs WHERE id = ?");

// Shared by the single-room check-in route and the bulk complete-all-due route. Reuses
// today's run if one already exists (completed or not — an already-completed run is returned
// as-is, never duplicated); otherwise creates one and snapshots the room's current task list —
// filtered to just today's due items, so a monthly task in an otherwise-daily room only shows
// up on its own day instead of nagging the cleaner about it every visit.
export function findOrCreateTodayRoomRun(roomId, cleanerId) {
  const today = todayInOslo();
  const existing = findRoomRunForDate(roomId, today);
  if (existing) return existing;

  const info = insertRoomRunStmt.run(roomId, cleanerId || null);
  const items = roomItemsStmt.all(roomId).filter((item) => isItemDueOn(item, today));
  items.forEach((item, i) => insertRoomRunItemStmt.run(info.lastInsertRowid, item.id, item.label, i));
  return roomRunByIdStmt.get(info.lastInsertRowid);
}

const monthlyChecklistItemsForSiteStmt = db.prepare(
  `SELECT rci.id, rci.label, rci.monthly_weekday, rci.monthly_occurrence, r.id AS room_id, r.name AS room_name
   FROM room_checklist_items rci JOIN rooms r ON r.id = rci.room_id
   WHERE r.site_id = ? AND rci.monthly_weekday IS NOT NULL AND rci.monthly_occurrence IS NOT NULL
   ORDER BY r.sort_order, r.id, rci.sort_order`
);
const lastMonthlyItemCompletionStmt = db.prepare(
  `SELECT rr.started_at FROM room_run_items rri JOIN room_runs rr ON rr.id = rri.room_run_id
   WHERE rri.room_checklist_item_id = ? AND rri.done = 1 AND date(rr.started_at) BETWEEN ? AND ?
   ORDER BY rr.started_at DESC LIMIT 1`
);

// Powers the "which monthly tasks are done this month" overview: every room_checklist_item
// with a monthly schedule, its calculated due date for the given month, and — via the stable
// room_checklist_item_id link on room_run_items — whether (and when) it was actually marked
// done that month. `status` is "not_applicable" for the rare case a room has no Nth occurrence
// of its weekday this month (e.g. a "5th Monday" in a 4-Monday month).
export function getMonthlyItemsForSite(siteId, yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const monthStart = `${yearMonth}-01`;
  const monthEnd = `${yearMonth}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  const today = todayInOslo();

  return monthlyChecklistItemsForSiteStmt.all(siteId).map((item) => {
    const dueDay = nthWeekdayOfMonth(year, month - 1, item.monthly_weekday, item.monthly_occurrence);
    const dueDate = dueDay ? `${yearMonth}-${String(dueDay).padStart(2, "0")}` : null;
    const completion = dueDate ? lastMonthlyItemCompletionStmt.get(item.id, monthStart, monthEnd) : null;

    let status;
    if (!dueDate) status = "not_applicable";
    else if (completion) status = "completed";
    else if (dueDate <= today) status = "missing";
    else status = "upcoming";

    return {
      roomId: item.room_id,
      roomName: item.room_name,
      itemId: item.id,
      label: item.label,
      dueDate,
      completedAt: completion?.started_at || null,
      status,
    };
  });
}
