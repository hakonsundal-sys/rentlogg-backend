import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE || "./data/rentlogg.db";
const dbDir = path.dirname(dbFile);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// A CHECK constraint can't be altered with ADD COLUMN, so an existing database (created before
// the super_admin role existed) needs a one-time table rebuild to accept it. Guarded by reading
// the table's own stored SQL rather than a version flag, so it's safe to run on every boot and
// a no-op on both fresh databases (schema.sql already includes super_admin) and already-migrated
// ones.
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
if (!usersSql.includes("super_admin")) {
  // legacy_alter_table stops the RENAME below from rewriting every other table's stored FK text
  // (checklist_runs.cleaner_id, deviations.reported_by, site_schedules.assigned_cleaner_id, ...)
  // to point at "users_old" — without it, SQLite silently repoints them on rename, and then the
  // final DROP TABLE users_old fails with a foreign key violation because those tables still
  // reference it. With it off, every other table's "REFERENCES users(id)" is left untouched and
  // simply resolves correctly again once the new "users" table exists under the same name.
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    ALTER TABLE users RENAME TO users_old;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager', 'cleaner', 'customer')),
      client_id INTEGER REFERENCES clients(id),
      avatar_url TEXT,
      phone TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, name, email, password_hash, role, client_id, avatar_url, phone, created_at)
      SELECT id, name, email, password_hash, role, client_id, avatar_url, phone, created_at FROM users_old;
    DROP TABLE users_old;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

ensureColumn("clients", "contact_name", "contact_name TEXT");
ensureColumn("clients", "phone", "phone TEXT");
ensureColumn("clients", "address", "address TEXT");
ensureColumn("sites", "room_count", "room_count INTEGER DEFAULT 0");
ensureColumn("users", "avatar_url", "avatar_url TEXT");
ensureColumn("users", "phone", "phone TEXT");
ensureColumn("deviations", "title", "title TEXT");
ensureColumn("photos", "room_run_id", "room_run_id INTEGER REFERENCES room_runs(id)");
ensureColumn("rooms", "monthly_weekday", "monthly_weekday INTEGER");
ensureColumn("rooms", "monthly_occurrence", "monthly_occurrence INTEGER");
// Which party is responsible for this room — 'company' (the cleaning company, e.g. OKV) or
// 'customer' (that site's own client, who fills out this room's checklist themselves). A site
// can mix both: a cleaner's live "Dagens plan" only ever shows 'company' rooms, and a customer
// can only fill out (not just view) rooms marked 'customer' for their own client. No CHECK
// constraint (matches every other ensureColumn'd field in this file) — validated in the route.
ensureColumn("rooms", "responsible", "responsible TEXT DEFAULT 'company'");
ensureColumn("checklist_runs", "signed_initials", "signed_initials TEXT");
ensureColumn("room_runs", "signed_initials", "signed_initials TEXT");
ensureColumn("deviations", "room_id", "room_id INTEGER REFERENCES rooms(id)");
ensureColumn("deviations", "room_task_label", "room_task_label TEXT");
ensureColumn("deviations", "reported_by_initials", "reported_by_initials TEXT");
ensureColumn("deviations", "reply_text", "reply_text TEXT");
ensureColumn("deviations", "replied_by_initials", "replied_by_initials TEXT");
ensureColumn("deviations", "replied_at", "replied_at TEXT");
ensureColumn("deviations", "assigned_to", "assigned_to TEXT");
ensureColumn("deviations", "customer_approved_at", "customer_approved_at TEXT");
ensureColumn("deviations", "customer_approved_by_initials", "customer_approved_by_initials TEXT");
ensureColumn("room_runs", "edited_at", "edited_at TEXT");
ensureColumn("room_runs", "edited_by_initials", "edited_by_initials TEXT");
ensureColumn("checklist_runs", "edited_at", "edited_at TEXT");
ensureColumn("checklist_runs", "edited_by_initials", "edited_by_initials TEXT");
ensureColumn("sites", "report_recipients", "report_recipients TEXT");
// Null = use the scheduler's default (07:00 Europe/Oslo) — only sites that need something else
// (e.g. a customer whose report should land after their own morning routine) set this.
ensureColumn("sites", "report_send_hour", "report_send_hour INTEGER");
ensureColumn("users", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("clients", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("sites", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("checklist_templates", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("invitations", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("sites", "department_id", "department_id INTEGER REFERENCES departments(id)");
ensureColumn("checklist_runs", "note", "note TEXT");
ensureColumn("room_runs", "note", "note TEXT");
// Per-item schedule override: null (the common case) means "due every time the room is
// cleaned" — same default as before this existed. Set only for a task that's less frequent
// than the room itself (e.g. a daily-cleaned room with one monthly task). Reuses the same
// "Nth weekday of month" shape as rooms.monthly_weekday/monthly_occurrence: both set together
// means "only the Nth occurrence of that weekday in the month" ("Månedlig" mode). The weekly
// mode (one or more specific weekdays, every week) used to be encoded here too as
// monthly_weekday set with monthly_occurrence null (2026-09-21) — superseded below by
// room_checklist_item_weekdays, which supports more than one day per item; monthly_weekday is
// now null whenever an item is in weekly mode.
ensureColumn("room_checklist_items", "monthly_weekday", "monthly_weekday INTEGER");
ensureColumn("room_checklist_items", "monthly_occurrence", "monthly_occurrence INTEGER");
// interval_days ("annenhver uke" etc): mutually exclusive with monthly_weekday/monthly_occurrence
// (routes/rooms.js's PATCH clears one when the other is set, same as rooms.interval_days already
// does for room-level schedules). Originally left unbuilt because items had no reliable per-item
// completion history to measure "days since last done" against — resolved by the
// room_run_items.room_checklist_item_id link added below, which this reuses.
ensureColumn("room_checklist_items", "interval_days", "interval_days INTEGER");
// Stable link back to the template item a given day's room_run_item was snapshotted from —
// room_run_items previously only carried a copy of the label, with no way to reliably tell
// "was this specific monthly task done this month" from history (a renamed item would silently
// break a label-based match). Nullable since it's only populated going forward; old rows stay
// label-only.
ensureColumn("room_run_items", "room_checklist_item_id", "room_checklist_item_id INTEGER REFERENCES room_checklist_items(id)");
// Set when a checklist_runs row was created after the fact (vaskeplan grid's "Sjekk inn i
// etterkant" on a day nobody actually scanned the site QR for) rather than by a real check-in —
// started_at is backdated to the day it represents either way, so this is the only way to tell
// the two apart later (report/log views surface it as a visible "entered late" notice).
ensureColumn("checklist_runs", "backdated", "backdated INTEGER DEFAULT 0");
// Which region/department a staff member belongs to — same company-wide tags (Vest/Sør/Øst/Midt)
// sites already use, assignable from the "Ansatte" admin page. Nullable/optional like sites'
// own department_id; a customer user has no use for this (departments are staff-only).
ensureColumn("users", "department_id", "department_id INTEGER REFERENCES departments(id)");
// Deactivating a user (from "Ansatte") blocks future logins without deleting them — keeps their
// name attached to their existing history (visits, avvik) intact, unlike a hard delete. Doesn't
// revoke a JWT already issued before deactivation (there's no token-revocation/blacklist in this
// app) — that session just keeps working until its own 12h expiry.
ensureColumn("users", "active", "active INTEGER NOT NULL DEFAULT 1");

// Customer approval gate: a room can be flagged so a customer-side user must approve the
// cleaner's checklist before the room counts as complete (distinct from rooms.responsible, where
// the customer does the cleaning themselves — here OKV still cleans, the customer just signs off
// on it afterward). See room_runs'/room_run_items' own comments below for how the gate works.
ensureColumn("rooms", "requires_approval", "requires_approval INTEGER DEFAULT 0");
// Set when a cleaner finishes a requires_approval room instead of completed_at (which stays
// unset until the customer actually approves — every existing completed_at reader in the app,
// reports/vaskeplan/history/dashboard, keeps meaning exactly what it always has: "genuinely
// done"). signed_initials is reused for the cleaner's own name at this point, same column as a
// non-gated room's completion already uses.
ensureColumn("room_runs", "ready_for_approval_at", "ready_for_approval_at TEXT");
ensureColumn("room_runs", "approved_at", "approved_at TEXT");
ensureColumn("room_runs", "approved_by_initials", "approved_by_initials TEXT");
// Parallel to room_run_items.done — the customer approver's own per-item sign-off, checked while
// reviewing the exact same list the cleaner just went through.
ensureColumn("room_run_items", "approved", "approved INTEGER DEFAULT 0");

// Departments started out (2026-09-07) as a per-client sub-grouping with a NOT NULL client_id,
// before it turned out the actual need was an internal, company-wide region tag (Vest/Sør/Øst/
// Midt) independent of client — see schema.sql's comment on the table. A database created
// during that short window has the old client_id column; rebuild it away here. Guarded by
// reading the table's own stored SQL, so this is a no-op on both a fresh database (schema.sql
// already has the new shape) and one already migrated. Same legacy_alter_table dance as the
// users-role rebuild above, needed because sites/invitations still hold a plain
// "REFERENCES departments(id)" column that a RENAME would otherwise silently repoint.
const departmentsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'departments'").get()?.sql || "";
if (departmentsSql.includes("client_id")) {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    ALTER TABLE departments RENAME TO departments_old;
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO departments (id, name, company_id, created_at)
      SELECT id, name, company_id, created_at FROM departments_old;
    DROP TABLE departments_old;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

// One-time backfill: any pre-existing database has real data with no company yet. Give it a
// home ("OKV Gruppen", the only company Rentlogg had before this became multi-tenant) rather
// than leaving it ownerless — a null company_id would otherwise make it invisible everywhere
// once every route starts filtering by company_id, as if the data had vanished.
if (db.prepare("SELECT COUNT(*) AS n FROM companies").get().n === 0) {
  const existingData = db.prepare("SELECT COUNT(*) AS n FROM sites").get().n;
  if (existingData > 0) {
    const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run("OKV Gruppen");
    const companyId = info.lastInsertRowid;
    db.prepare("UPDATE users SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE clients SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE sites SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE checklist_templates SET company_id = ? WHERE company_id IS NULL").run(companyId);
  }
}

// One-time: items using the old single-day "weekly" mode (monthly_weekday set, monthly_occurrence
// null — see room_checklist_items.monthly_weekday's comment above) move that one day into the new
// room_checklist_item_weekdays table, freeing monthly_weekday to mean only the true "Nth weekday of
// month" mode from here on. Naturally idempotent: once migrated, monthly_weekday is null, so the
// SELECT below finds nothing on later boots.
const oldWeeklyItems = db
  .prepare("SELECT id, monthly_weekday FROM room_checklist_items WHERE monthly_weekday IS NOT NULL AND monthly_occurrence IS NULL")
  .all();
if (oldWeeklyItems.length > 0) {
  const insertItemWeekday = db.prepare("INSERT OR IGNORE INTO room_checklist_item_weekdays (item_id, weekday) VALUES (?, ?)");
  const clearMonthlyWeekday = db.prepare("UPDATE room_checklist_items SET monthly_weekday = NULL WHERE id = ?");
  db.transaction(() => {
    for (const item of oldWeeklyItems) {
      insertItemWeekday.run(item.id, item.monthly_weekday);
      clearMonthlyWeekday.run(item.id);
    }
  })();
}
