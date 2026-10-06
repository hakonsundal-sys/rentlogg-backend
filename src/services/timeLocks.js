import { db } from "../db.js";

// Period locks for Timeregistrering.
//
// Locking a month sets locked_at on the shifts that EXIST at that moment, and that is all the old
// lock did. A shift added afterwards — a forgotten day, a correction — sat in the middle of a
// closed, exported period unlocked, and nothing refused it. Payroll had already gone out without it.
//
// A period lock is therefore also recorded as a fact of its own: this range, for these people/places,
// is closed. Registering or moving hours into a closed period is refused, whether or not that
// particular day happened to have a shift in it. The row doubles as the audit trail of who locked
// and unlocked what and when, which the row flags alone never kept.
//
// Created here rather than in schema.sql so the module owns its own table, and the statements are
// `IF NOT EXISTS`, so running this on every boot is a no-op once it exists. There is deliberately no
// foreign key on the actor: a log of who locked payroll must outlive the account.
db.exec(`
  CREATE TABLE IF NOT EXISTS time_period_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    kind TEXT NOT NULL CHECK (kind IN ('lock', 'unlock')),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    user_id INTEGER,
    site_id INTEGER,
    order_id INTEGER,
    team_id INTEGER,
    employee_group_id INTEGER,
    actor_id INTEGER,
    actor_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_time_period_locks_company ON time_period_locks(company_id, from_date, to_date);
`);

const insertStmt = db.prepare(
  `INSERT INTO time_period_locks
     (company_id, kind, from_date, to_date, user_id, site_id, order_id, team_id, employee_group_id, actor_id, actor_name)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// filters: { user_id, site_id, order_id, team_id, employee_group_id } — any of them may be null.
export function recordPeriodLock({ companyId, locked, from, to, filters = {}, actor }) {
  insertStmt.run(
    companyId, locked ? "lock" : "unlock", from, to,
    filters.user_id ?? null, filters.site_id ?? null, filters.order_id ?? null,
    filters.team_id ?? null, filters.employee_group_id ?? null,
    actor?.id ?? null, actor?.name ?? null
  );
}

const coveringStmt = db.prepare(
  `SELECT * FROM time_period_locks
   WHERE company_id = ? AND from_date <= ? AND to_date >= ?
   ORDER BY id DESC`
);
const personStmt = db.prepare("SELECT team_id, employee_group_id FROM users WHERE id = ?");

// Is this person's working day, on this site/order, inside a period somebody has locked and nobody
// has unlocked since? The newest recorded decision that covers it wins: lock the month, later unlock
// one week of it, and that week is open again while the rest stays closed.
export function isPeriodLocked({ companyId, userId, siteId = null, orderId = null, workDate }) {
  const rows = coveringStmt.all(companyId, workDate, workDate);
  if (rows.length === 0) return false;
  const person = personStmt.get(userId) || {};
  for (const row of rows) {
    if (row.user_id != null && row.user_id !== userId) continue;
    if (row.site_id != null && row.site_id !== siteId) continue;
    if (row.order_id != null && row.order_id !== orderId) continue;
    if (row.team_id != null && row.team_id !== person.team_id) continue;
    if (row.employee_group_id != null && row.employee_group_id !== person.employee_group_id) continue;
    return row.kind === "lock";
  }
  return false;
}

export const PERIOD_LOCKED = {
  status: 409,
  code: "period_locked",
  error: "Perioden er låst. Be en administrator låse den opp før timer kan føres eller flyttes dit.",
};
