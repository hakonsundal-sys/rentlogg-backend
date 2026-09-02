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

  const deviations = db
    .prepare(
      `SELECT d.*, rm.name AS room_name FROM deviations d
       LEFT JOIN rooms rm ON rm.id = d.room_id
       WHERE d.run_id = ? ORDER BY d.created_at DESC`
    )
    .all(run.id);

  return { ...run, items, photos, rooms, deviations };
}

export function canAccessRun(run, user) {
  if (user.role === "cleaner") return run.cleaner_id === user.id;
  if (user.role === "customer") return run.site_client_id === user.client_id;
  return true; // admin/manager
}
