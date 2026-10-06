// Lookup indexes. Run from db.js once every table and every ensureColumn column exists.
//
// Why a separate list at the end instead of CREATE INDEX lines in schema.sql: schema.sql runs
// BEFORE the ensureColumn calls, and several of the columns below (photos.room_run_id,
// room_run_items.room_checklist_item_id, deviations.room_id, users.company_id) only exist after
// them on a database that was created before they were added. An index on such a column inside
// schema.sql crashes the boot of every existing database. Everything here is CREATE INDEX IF NOT
// EXISTS, so it is a no-op once built, and building them on first boot of a large database takes
// a fraction of a second.
//
// Most foreign-key columns had no index at all (64 of 105), so each "give me this room's/run's/
// site's rows" lookup read the whole table. SQLite is single-threaded in this process, so every
// such scan stalls every user. Measured on a seeded 60-room site with 100k run items:
//   cleaner day view 370 ms -> 31 ms, vaskeplan grid 3.6 s -> 0.24 s, monthly report 9.4 s -> 0.8 s,
//   deleting a site 14 s -> 0.2 s.
const INDEXES = [
  // Room tasks and their run snapshots.
  ["idx_room_checklist_items_room", "room_checklist_items(room_id, sort_order)"],
  ["idx_room_run_items_run", "room_run_items(room_run_id, sort_order)"],
  // "When was this task last done" (interval and periodic tasks) filters on the template link.
  ["idx_room_run_items_template", "room_run_items(room_checklist_item_id, done)"],
  ["idx_room_run_item_options_option", "room_run_item_options(option_id)"],
  ["idx_room_item_options_chemical", "room_checklist_item_options(chemical_id)"],

  // Runs, looked up by room/site and a date window (see the started_at range in services/rooms.js
  // and schedule.js: a plain range on started_at can use these, date(started_at) could not).
  ["idx_room_runs_room_started", "room_runs(room_id, started_at)"],
  ["idx_room_runs_room_completed", "room_runs(room_id, completed_at)"],
  ["idx_runs_site_started", "checklist_runs(site_id, started_at)"],
  ["idx_runs_cleaner", "checklist_runs(cleaner_id)"],
  ["idx_checklist_run_items_run", "checklist_run_items(run_id)"],

  // Photos hang off a run, a room run or a deviation; and /uploads finds one by its stored path.
  ["idx_photos_room_run", "photos(room_run_id)"],
  ["idx_photos_run", "photos(run_id)"],
  ["idx_photos_deviation", "photos(deviation_id)"],
  ["idx_photos_path", "photos(file_path)"],
  ["idx_site_documents_site", "site_documents(site_id)"],
  ["idx_site_documents_path", "site_documents(file_path)"],
  ["idx_simple_checklist_photos_path", "simple_checklist_photos(file_path)"],

  ["idx_deviations_run", "deviations(run_id)"],
  ["idx_deviations_room", "deviations(room_id)"],
  ["idx_users_company_role", "users(company_id, role)"],

  // Time registration.
  ["idx_time_entries_run", "time_entries(run_id)"],
  ["idx_user_approval_levels_level", "user_approval_levels(level_id)"],
  ["idx_entry_log_company_at", "time_entry_log(company_id, at)"],
];

export function ensureIndexes(db) {
  const build = db.transaction(() => {
    for (const [name, target] of INDEXES) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
  });
  build();
}
