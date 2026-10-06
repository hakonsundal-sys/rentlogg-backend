import { db } from "../db.js";

const userCompanyStmt = db.prepare("SELECT company_id, role FROM users WHERE id = ?");

// A weekday in the app's own convention (Date#getDay, 0 = Sunday). Accepts the digit-string a form
// might send; returns null for anything that is not a whole number from 0 to 6. The route checks
// used to be `weekday < 0 || weekday > 6`, which let "abc" through to a database CHECK (a 500) and
// stored 2.5, a day that never matches anything.
export function weekdayFrom(raw) {
  if (raw === undefined || raw === null || raw === "" || typeof raw === "boolean") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

// Turns the assigned_cleaner_id of a schedule request into an id we trust, or says why not.
//   { value: null }    nobody assigned (the normal case)
//   { value: <id> }    a staff member of the caller's own company
//   { error: ... }     anything else — unknown user, another company's user, a customer
// The id used to be stored as sent, and every read joins users for the NAME with no company check,
// so one company's admin could post another company's user id and read that person's full name back
// (ids are sequential), and the foreign user stayed attached to the plan.
export function assigneeFrom(raw, companyId) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return { error: "invalid_assignee" };
  const user = userCompanyStmt.get(id);
  if (!user || user.company_id !== companyId || user.role === "customer" || user.role === "super_admin") {
    return { error: "invalid_assignee" };
  }
  return { value: id };
}

export const INVALID_ASSIGNEE = {
  code: "invalid_assignee",
  error: "assigned_cleaner_id must be a staff member in your own company",
};
