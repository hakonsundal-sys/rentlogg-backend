import { db } from "./../db.js";
import { nowStamp } from "./timeEntries.js";

// Prosjekt, ordre, godkjenningsnivåer og endringslogg — the parts of Timeregistrering that came
// out of reading OKV's own Mobile Worker (2026-09-23) rather than out of the QR check-in.
//
// Kept apart from timeEntries.js on purpose: that file is about what a shift IS and how it is
// measured. This one is about the structure a shift is filed under and the people who sign it off.

// --- Prosjekt og ordre ---------------------------------------------------------------------------

// Every company that starts using the module gets a home for its hours: one project, one order per
// site it already has, and the two orders that have no building at all. Without this, an existing
// company would turn the module on and find nothing to book time against but the sites — which is
// exactly the gap that made internal time and absence impossible to register.
//
// Runs once, guarded on there being no orders at all, so an admin who deliberately deletes one
// never has it quietly reappear.
const countOrdersStmt = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE company_id = ?");

export function seedOrdersForCompany(companyId) {
  if (!companyId || countOrdersStmt.get(companyId).n > 0) return;

  db.transaction(() => {
    const projectId = db
      .prepare("INSERT INTO projects (company_id, number, name, sort_order) VALUES (?, '1', 'Renhold', 0)")
      .run(companyId).lastInsertRowid;

    const insertOrder = db.prepare(
      `INSERT INTO orders (company_id, project_id, number, name, kind, client_id, allows_manual, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const linkSite = db.prepare("UPDATE sites SET order_id = ? WHERE id = ?");

    // One order per existing site, numbered from the site id so the numbers are stable and don't
    // collide with the internal orders below.
    const sites = db.prepare("SELECT id, name, client_id FROM sites WHERE company_id = ? ORDER BY name").all(companyId);
    sites.forEach((site, i) => {
      const orderId = insertOrder.run(companyId, projectId, String(1000 + site.id), site.name, "customer", site.client_id, 0, i + 10).lastInsertRowid;
      linkSite.run(orderId, site.id);
    });

    // The orders with no building, named and numbered as OKV's own Mobile Worker has them
    // (read off their live data 2026-09-24) so the two systems can be read side by side.
    // allows_manual = 1 is what lets somebody book hours on them without a QR code to scan.
    const internalProject = db
      .prepare("INSERT INTO projects (company_id, number, name, sort_order) VALUES (?, '2', 'Intern tid', 99)")
      .run(companyId).lastInsertRowid;
    insertOrder.run(companyId, internalProject, "200", "Intern ufakturerbar tid", "internal", null, 1, 1);
    insertOrder.run(companyId, internalProject, "201", "Fravær", "absence", null, 1, 2);
  })();
}

export function listOrders(companyId, { includeInactive = false } = {}) {
  seedOrdersForCompany(companyId);
  return db
    .prepare(
      `SELECT o.*, p.name AS project_name, p.number AS project_number, c.name AS client_name,
              u.name AS manager_name,
              (SELECT COUNT(*) FROM sites s WHERE s.order_id = o.id) AS site_count
       FROM orders o
       LEFT JOIN projects p ON p.id = o.project_id
       LEFT JOIN clients c ON c.id = o.client_id
       LEFT JOIN users u ON u.id = o.manager_id
       WHERE o.company_id = ?${includeInactive ? "" : " AND o.active = 1"}
       ORDER BY p.sort_order, p.id, o.sort_order, o.id`
    )
    .all(companyId)
    .map((o) => ({ ...o, active: !!o.active, allows_manual: !!o.allows_manual }));
}

export function listProjects(companyId) {
  seedOrdersForCompany(companyId);
  return db
    .prepare(
      `SELECT p.*, c.name AS client_name, u.name AS manager_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = p.manager_id
       WHERE p.company_id = ? ORDER BY p.sort_order, p.id`
    )
    .all(companyId)
    .map((p) => ({ ...p, active: !!p.active }));
}

export function getOrder(orderId, companyId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order || order.company_id !== companyId) return null;
  return order;
}

// The order a stamping belongs to: the one its site is filed under. Null when the site has not been
// filed yet, which is fine — the entry simply carries no order until somebody files it.
const siteOrderStmt = db.prepare("SELECT order_id FROM sites WHERE id = ?");

export function orderIdForSite(siteId) {
  return siteOrderStmt.get(siteId)?.order_id ?? null;
}

// --- Godkjenningsnivåer --------------------------------------------------------------------------

// OKV's own ladder, read off their Mobile Worker. Seeded per company on first use, then theirs to
// change — the levels are an org chart, and a company that doesn't have a "Formann" should be able
// to delete it rather than work around it.
const DEFAULT_LEVELS = [
  { name: "Teamleder", step: 1, required: 0 },
  { name: "Formann", step: 2, required: 1 },
  { name: "Driftssjef", step: 3, required: 1 },
  { name: "Administrasjon", step: 4, required: 1 },
];

const countLevelsStmt = db.prepare("SELECT COUNT(*) AS n FROM approval_levels WHERE company_id = ?");

export function seedApprovalLevels(companyId) {
  if (!companyId || countLevelsStmt.get(companyId).n > 0) return;
  const insert = db.prepare("INSERT INTO approval_levels (company_id, name, step, required) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const level of DEFAULT_LEVELS) insert.run(companyId, level.name, level.step, level.required);
  })();
}

export function listApprovalLevels(companyId) {
  seedApprovalLevels(companyId);
  return db
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM user_approval_levels ual WHERE ual.level_id = l.id) AS user_count
       FROM approval_levels l WHERE l.company_id = ? ORDER BY l.step, l.id`
    )
    .all(companyId)
    .map((l) => ({ ...l, required: !!l.required }));
}

// Which level this person signs at, if any. Somebody with no level cannot approve at all — that is
// the access rule, deliberately separate from the admin/manager role, because who may approve is an
// org-chart question and not a permissions one.
const levelForUserStmt = db.prepare(
  `SELECT l.* FROM user_approval_levels ual JOIN approval_levels l ON l.id = ual.level_id
   WHERE ual.user_id = ?`
);

export function approvalLevelForUser(userId) {
  return levelForUserStmt.get(userId) || null;
}

export function listUserLevels(companyId) {
  seedApprovalLevels(companyId);
  return db
    .prepare(
      `SELECT u.id AS user_id, u.name AS user_name, u.role, ual.level_id, l.name AS level_name, l.step
       FROM users u
       LEFT JOIN user_approval_levels ual ON ual.user_id = u.id
       LEFT JOIN approval_levels l ON l.id = ual.level_id
       WHERE u.company_id = ? AND u.role NOT IN ('customer', 'super_admin')
       ORDER BY u.name`
    )
    .all(companyId);
}

export function setUserLevel(companyId, userId, levelId) {
  if (!levelId) {
    db.prepare("DELETE FROM user_approval_levels WHERE user_id = ?").run(userId);
    return;
  }
  db.prepare(
    `INSERT INTO user_approval_levels (company_id, user_id, level_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET level_id = excluded.level_id, company_id = excluded.company_id`
  ).run(companyId, userId, levelId);
}

// --- Godkjenning av én vakt ----------------------------------------------------------------------

const approvalsForEntryStmt = db.prepare(
  "SELECT * FROM time_entry_approvals WHERE entry_id = ? ORDER BY level_step, id"
);

export function approvalsForEntry(entryId) {
  return approvalsForEntryStmt.all(entryId);
}

// The whole state of one shift's climb up the ladder, in the shape both the grid and the API need.
// `next` is the level whose turn it is: the lowest required level that has not signed. A shift is
// fully approved only when every required level has.
export function approvalStateFor(entry, levels) {
  const done = approvalsForEntry(entry.id);
  const doneByLevel = new Map(done.map((a) => [a.level_id, a]));
  const steps = levels.map((level) => ({
    level_id: level.id,
    name: level.name,
    step: level.step,
    required: !!level.required,
    approved: doneByLevel.has(level.id),
    approved_by_name: doneByLevel.get(level.id)?.approved_by_name || null,
    approved_at: doneByLevel.get(level.id)?.approved_at || null,
  }));
  const pending = steps.filter((s) => s.required && !s.approved);
  return {
    steps,
    next_level_id: pending[0]?.level_id ?? null,
    next_level_name: pending[0]?.name ?? null,
    fully_approved: pending.length === 0 && steps.length > 0,
    approved_count: steps.filter((s) => s.approved).length,
    required_count: steps.filter((s) => s.required).length,
  };
}

const insertApprovalStmt = db.prepare(
  `INSERT INTO time_entry_approvals (entry_id, level_id, level_name, level_step, approved_at, approved_by, approved_by_name, comment)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(entry_id, level_id) DO UPDATE SET
     approved_at = excluded.approved_at, approved_by = excluded.approved_by,
     approved_by_name = excluded.approved_by_name, comment = excluded.comment`
);

export function recordApproval(entryId, level, user, comment) {
  insertApprovalStmt.run(
    entryId, level.id, level.name, level.step, nowStamp(), user.id, user.name || null, (comment || "").trim() || null
  );
}

export function clearApproval(entryId, levelId) {
  if (levelId) db.prepare("DELETE FROM time_entry_approvals WHERE entry_id = ? AND level_id = ?").run(entryId, levelId);
  else db.prepare("DELETE FROM time_entry_approvals WHERE entry_id = ?").run(entryId);
}

// --- Endringslogg --------------------------------------------------------------------------------

const insertLogStmt = db.prepare(
  "INSERT INTO time_entry_log (entry_id, company_id, at, user_id, user_name, action, status, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);

// Append-only. Every state change a shift goes through writes one row, so the question "why does
// this say 6 hours when she was there 8" has an answer that does not depend on anybody remembering.
export function logEntryEvent({ entryId, companyId, user, action, status, comment }) {
  insertLogStmt.run(
    entryId, companyId, nowStamp(), user?.id ?? null, user?.name ?? null, action, status ?? null,
    (comment || "").trim() || null
  );
}

export function logForEntry(entryId) {
  return db.prepare("SELECT * FROM time_entry_log WHERE entry_id = ? ORDER BY at DESC, id DESC").all(entryId);
}

export function logForPeriod({ companyId, from, to, userId, siteId }) {
  const conditions = ["l.company_id = ?", "t.work_date >= ?", "t.work_date <= ?"];
  const params = [companyId, from, to];
  if (userId) {
    conditions.push("t.user_id = ?");
    params.push(userId);
  }
  if (siteId) {
    conditions.push("t.site_id = ?");
    params.push(siteId);
  }
  return db
    .prepare(
      `SELECT l.*, t.work_date, t.user_id AS entry_user_id, eu.name AS entry_user_name,
              s.name AS site_name, o.name AS order_name
       FROM time_entry_log l
       JOIN time_entries t ON t.id = l.entry_id
       LEFT JOIN users eu ON eu.id = t.user_id
       LEFT JOIN sites s ON s.id = t.site_id
       LEFT JOIN orders o ON o.id = t.order_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY l.at DESC, l.id DESC
       LIMIT 500`
    )
    .all(...params);
}
