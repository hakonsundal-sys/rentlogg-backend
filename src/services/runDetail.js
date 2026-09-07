import { db } from "../db.js";
import { toOsloDateStr } from "./schedule.js";
import { findRoomRunForDate } from "./rooms.js";

const roomRunItemsStmt = db.prepare("SELECT * FROM room_run_items WHERE room_run_id = ? ORDER BY sort_order");
const roomRunPhotosStmt = db.prepare("SELECT * FROM photos WHERE room_run_id = ?");

// Single source of truth for "everything about one checklist visit" — used by the JSON detail
// endpoint (GET /checklists/runs/:id) and by the report endpoints (HTML/PDF), so the Oslo-day
// room-matching logic only lives in one place instead of being copied a third time.
export function getRunDetail(runId) {
  const run = db
    .prepare(
      `SELECT r.*, s.name AS site_name, s.address AS site_address, s.client_id AS site_client_id,
              s.department_id AS site_department_id, s.company_id AS site_company_id,
              c.name AS client_name, u.name AS cleaner_name
       FROM checklist_runs r
       JOIN sites s ON s.id = r.site_id
       JOIN users u ON u.id = r.cleaner_id
       LEFT JOIN clients c ON c.id = s.client_id
       WHERE r.id = ?`
    )
    .get(runId);
  if (!run) return null;

  const items = db.prepare("SELECT * FROM checklist_run_items WHERE run_id = ? ORDER BY sort_order").all(run.id);
  const photos = db.prepare("SELECT * FROM photos WHERE run_id = ?").all(run.id);

  // Room-enabled sites don't populate checklist_run_items (their tasks live per-room), so the
  // flat "Sjekkliste" list above is empty for them. Attach each room's status/items for the same
  // Oslo calendar day as this run, so the detail view (and the report) shows what was actually done.
  const siteRooms = db.prepare("SELECT id, name FROM rooms WHERE site_id = ? ORDER BY sort_order, id").all(run.site_id);
  const dateStr = toOsloDateStr(run.started_at);
  const rooms = siteRooms.map((room) => {
    const roomRun = findRoomRunForDate(room.id, dateStr);
    return {
      id: room.id,
      name: room.name,
      roomRunId: roomRun?.id || null,
      completed_at: roomRun?.completed_at || null,
      signed_initials: roomRun?.signed_initials || null,
      edited_at: roomRun?.edited_at || null,
      edited_by_initials: roomRun?.edited_by_initials || null,
      items: roomRun ? roomRunItemsStmt.all(roomRun.id) : [],
      photos: roomRun ? roomRunPhotosStmt.all(roomRun.id) : [],
    };
  });

  const deviationRows = db
    .prepare(
      `SELECT d.*, rm.name AS room_name FROM deviations d
       LEFT JOIN rooms rm ON rm.id = d.room_id
       WHERE d.run_id = ? ORDER BY d.created_at DESC`
    )
    .all(run.id);

  // Same batched-lookup shape as deviations.js's withPhotosAndRun — getRunDetail's deviations
  // previously carried no photos at all, so anything reading runDetail.deviations directly
  // (the report, CleanerHistoryView's avvik list) silently dropped avvik photos even though
  // GET /deviations itself has always included them.
  const deviationIds = deviationRows.map((d) => d.id);
  const deviationPhotosById = {};
  if (deviationIds.length) {
    const placeholders = deviationIds.map(() => "?").join(",");
    db.prepare(`SELECT * FROM photos WHERE deviation_id IN (${placeholders})`)
      .all(...deviationIds)
      .forEach((p) => {
        (deviationPhotosById[p.deviation_id] ??= []).push(p);
      });
  }
  const deviations = deviationRows.map((d) => ({ ...d, photos: deviationPhotosById[d.id] || [] }));

  return { ...run, items, photos, rooms, deviations };
}

export function canAccessRun(run, user) {
  // A day's checklist_run is shared per site, not owned by whoever happened to check in first —
  // POST /sites/checkin/:qrToken hands any cleaner back that same existing run if one already
  // exists for the site today. Restricting reads to run.cleaner_id === user.id broke exactly
  // that flow: a second cleaner scanning the same site the same day got a runId back, then was
  // immediately 403'd fetching its detail. Cleaners already have unscoped-within-their-company
  // read access to sites (GET /sites filters by company only, not per-cleaner), so scoping this
  // to "same company" isn't a new boundary for them, just the multi-tenant floor everyone gets.
  if (user.role === "customer") {
    return user.department_id ? run.site_department_id === user.department_id : run.site_client_id === user.client_id;
  }
  return run.site_company_id === user.company_id; // cleaner/admin/manager
}
