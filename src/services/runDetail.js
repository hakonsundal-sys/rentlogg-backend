import { db } from "../db.js";
import { toOsloDateStr } from "./schedule.js";
import { findRoomRunForDate } from "./rooms.js";

const roomRunItemsStmt = db.prepare(
  `SELECT rri.*, rci.monthly_weekday IS NOT NULL AS monthly
   FROM room_run_items rri LEFT JOIN room_checklist_items rci ON rci.id = rri.room_checklist_item_id
   WHERE rri.room_run_id = ? ORDER BY rri.sort_order`
);
const roomRunPhotosStmt = db.prepare("SELECT * FROM photos WHERE room_run_id = ?");
const siteRoomsStmt = db.prepare("SELECT id, name FROM rooms WHERE site_id = ? ORDER BY sort_order, id");

// Room-enabled sites don't populate checklist_run_items (their tasks live per-room). Each room's
// status/items for a given Oslo calendar day is independent of whether a flat checklist_runs
// wrapper exists for that day at all — a room_run is created the moment a cleaner opens that
// room, with no dependency on the site-level QR check-in happening the same calendar day. Shared
// by getRunDetail (a real run exists) and getVirtualDayDetail (no run exists yet, but some rooms
// may still have real data) so both agree on exactly what a day's rooms looked like.
function buildRoomsForDate(siteId, dateStr) {
  return siteRoomsStmt.all(siteId).map((room) => {
    const roomRun = findRoomRunForDate(room.id, dateStr);
    return {
      id: room.id,
      name: room.name,
      roomRunId: roomRun?.id || null,
      completed_at: roomRun?.completed_at || null,
      signed_initials: roomRun?.signed_initials || null,
      edited_at: roomRun?.edited_at || null,
      edited_by_initials: roomRun?.edited_by_initials || null,
      note: roomRun?.note || null,
      items: roomRun ? roomRunItemsStmt.all(roomRun.id) : [],
      photos: roomRun ? roomRunPhotosStmt.all(roomRun.id) : [],
    };
  });
}

// Single source of truth for "everything about one checklist visit" — used by the JSON detail
// endpoint (GET /checklists/runs/:id) and by the report endpoints (HTML/PDF), so the Oslo-day
// room-matching logic only lives in one place instead of being copied a third time.
export function getRunDetail(runId) {
  const run = db
    .prepare(
      `SELECT r.*, s.name AS site_name, s.address AS site_address, s.client_id AS site_client_id,
              s.company_id AS site_company_id, c.name AS client_name, u.name AS cleaner_name
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
  const rooms = buildRoomsForDate(run.site_id, toOsloDateStr(run.started_at));

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

// The vaskeplan grid used to only be able to open a day that already had a flat checklist_runs
// row — but that row only ever gets created by a site-level QR scan, while individual room_runs
// (see buildRoomsForDate) don't depend on it existing at all. That left days with real room
// activity but no same-day QR check-in completely unreachable from the grid. This builds the
// same shape getRunDetail returns, straight from site+date, for exactly that case. `id: null`
// signals to the frontend that there's no real run to generate a PDF/HTML report from or to
// attach a top-level signature to — editing is still possible per-room, but only for rooms that
// already have a real room_run that day (same rule as any other day, virtual or not).
export function getVirtualDayDetail(site, dateStr) {
  const rooms = buildRoomsForDate(site.id, dateStr);
  if (rooms.length === 0) return null; // not a room-based site — nothing to show without a real run

  return {
    id: null,
    site_id: site.id,
    site_name: site.name,
    site_address: site.address,
    site_client_id: site.client_id,
    site_company_id: site.company_id,
    cleaner_name: null,
    started_at: `${dateStr}T00:00:00`,
    completed_at: null,
    signed_initials: null,
    edited_at: null,
    edited_by_initials: null,
    note: null,
    items: [],
    photos: [],
    rooms,
    // No flat run to anchor a same-day deviation lookup to — avvik for this site stay visible
    // elsewhere (Avvik page, GET /deviations) regardless, so this isn't a real information loss.
    deviations: [],
  };
}

export function canAccessRun(run, user) {
  // A day's checklist_run is shared per site, not owned by whoever happened to check in first —
  // POST /sites/checkin/:qrToken hands any cleaner back that same existing run if one already
  // exists for the site today. Restricting reads to run.cleaner_id === user.id broke exactly
  // that flow: a second cleaner scanning the same site the same day got a runId back, then was
  // immediately 403'd fetching its detail. Cleaners already have unscoped-within-their-company
  // read access to sites (GET /sites filters by company only, not per-cleaner), so scoping this
  // to "same company" isn't a new boundary for them, just the multi-tenant floor everyone gets.
  if (user.role === "customer") return run.site_client_id === user.client_id;
  return run.site_company_id === user.company_id; // cleaner/admin/manager
}
