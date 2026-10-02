import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeOriginalName, normalizeImageOrientation, imageFileFilter } from "../utils/uploads.js";
import { normalizeLanguage } from "../utils/languages.js";
import { enabledModulesForCompany } from "../modules.js";

export const authRouter = Router();

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: `${process.env.UPLOADS_DIR || "uploads"}/avatars`,
    filename: (req, file, cb) => cb(null, `${req.user.id}-${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Bounds brute-force/credential-stuffing attempts against /login — bcrypt's own cost (~50-100ms)
// slows a single guess but doesn't stop a sustained attempt without something like this. Keyed
// by IP, not email, so it can't be used to lock a real user out of their own account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "too_many_login_attempts", error: "For mange innloggingsforsøk. Prøv igjen om litt." },
});

// Used only to keep bcrypt.compareSync's timing constant when the email doesn't exist at all —
// see the comment on POST /login below.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("no-such-user-timing-guard", 10);

// Self-closing bootstrap: this used to be a fully open "create any account, any role" endpoint
// with no guard at all — a real security hole. Now it can only ever create the very first
// super_admin (Rentlogg's own operator account, company_id null); once one exists, it's
// permanently closed. Every other account (company admins, managers, cleaners, customers) is
// created via the invitation flow instead (see invitations.js).
authRouter.post("/register", (req, res) => {
  const { name, email, password, role } = req.body;
  const superAdminExists = db.prepare("SELECT 1 FROM users WHERE role = 'super_admin'").get();
  if (superAdminExists) {
    return res.status(403).json({ code: "signup_closed", error: "Registrering er stengt. Kontakt en administrator for tilgang." });
  }
  if (!name || !email || !password || role !== "super_admin") {
    return res.status(400).json({ code: "superadmin_fields_required", error: "name, email, password er påkrevd, og role må være 'super_admin'." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ code: "email_taken", error: "Email already registered" });

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, 'super_admin', NULL, NULL)")
    .run(name, email, password_hash);

  res.status(201).json({ id: info.lastInsertRowid, name, email, role: "super_admin" });
});

authRouter.post("/login", loginLimiter, (req, res) => {
  // Every write path stores the email lower-cased, but this lookup compared it byte for byte, so
  // a phone that capitalises the first letter of a field — or a paste that carried a trailing
  // space — failed with a plain "invalid_credentials" that looks exactly like a wrong password.
  // Normalising here (and matching NOCASE, as the duplicate checks below already do) closes the
  // gap from both ends, including for a row stored with an uppercase address before this existed.
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = req.body?.password;
  // bcrypt.compareSync throws on a non-string, which turned a request with no password field at
  // all into a 500. A missing password is simply not a valid credential; say so.
  if (typeof password !== "string" || password === "") {
    return res.status(401).json({ code: "invalid_credentials", error: "Invalid email or password" });
  }
  const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
  // Always run a bcrypt compare, even for an unknown email — comparing against a fixed dummy
  // hash keeps the response time the same either way, so a timing difference can't be used to
  // enumerate which emails have accounts (an unknown email used to return near-instantly, since
  // `!user ||` short-circuited before bcrypt ever ran).
  const passwordOk = bcrypt.compareSync(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json({ code: "invalid_credentials", error: "Invalid email or password" });
  }
  // Checked only after the password is confirmed correct — telling someone who doesn't even know
  // the right password that the account exists but is deactivated would leak more than a plain
  // "Invalid email or password" does, and a check placed *before* the bcrypt compare above would
  // also reopen exactly the timing side-channel that comment is guarding against.
  if (!user.active) {
    return res.status(403).json({ code: "account_deactivated", error: "Denne kontoen er deaktivert. Kontakt en administrator." });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, client_id: user.client_id, company_id: user.company_id },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    // language rides in the user object, deliberately not in the JWT — it isn't an authorization
    // claim, and a token minted before someone switched language would keep serving the stale
    // value for the rest of its 12h life.
    user: {
      id: user.id, name: user.name, role: user.role,
      client_id: user.client_id, company_id: user.company_id, language: user.language ?? null,
      // Which add-on modules this company has — rides alongside language, and for the same reason:
      // it decides what the UI shows, not what the caller may do (requireModule does that, per
      // request), so a stale copy in an old token's session can't grant anything.
      modules: enabledModulesForCompany(user.company_id),
    },
  });
});

// Staff directory — originally just a lightweight picker source (e.g. assigning a cleaner to a
// site's schedule, which still calls this with ?role=cleaner and only ever used id/name/email/
// role), now also the data source for the "Ansatte" admin page, which additionally wants phone,
// department, and signup date. Scoped to the caller's own company for admin/manager — company_id
// is null for a request with none (shouldn't happen for them, but WHERE company_id = ? against
// NULL naturally matches nothing rather than leaking every company's staff). super_admin has no
// company of its own and manages staff across every company instead (see GET /users below), so
// it's exempted from that scoping. No explicit ?role filter defaults to every non-customer role —
// a customer account isn't "staff" and has no department, and the one existing caller of the
// unfiltered form doesn't exist (the only current caller always passes ?role=cleaner), so this
// default was always somewhat accidental; tightened here since "Ansatte" is the first real user
// of it.
const STAFF_FIELDS = "id, name, email, role, phone, department_id, active, created_at, language";
// Same fields, plus which company each row belongs to — only meaningful for super_admin's
// cross-company view (an admin/manager's own rows are all their own company already). client_id/
// client_name are only populated for role='customer' rows ("Kundebrukere") — null for staff.
const STAFF_LIST_FIELDS =
  "u.id, u.name, u.email, u.role, u.phone, u.employee_number, u.department_id, u.active, u.created_at, u.company_id, c.name AS company_name, u.client_id, cl.name AS client_name, u.language";
const STAFF_LIST_JOIN = "LEFT JOIN companies c ON c.id = u.company_id LEFT JOIN clients cl ON cl.id = u.client_id";
// The roles an account can be MOVED between — never 'customer' (a different account shape, tied
// to a client) or 'super_admin' (Rentlogg's own operator account).
const STAFF_ROLES = ["admin", "manager", "cleaner"];
// What POST /users may create. 'customer' is allowed here, unlike above, because creating one is
// unambiguous as long as it names the client it belongs to — it is *converting* an existing
// account between the two shapes that has no sensible meaning.
const CREATABLE_ROLES = [...STAFF_ROLES, "customer"];

authRouter.get("/users", requireAuth, requireRole("admin", "manager", "super_admin"), (req, res) => {
  const { role, company_id } = req.query;
  // super_admin is excluded unconditionally, not just by the default filter below — it's not
  // "staff" any company or even another super_admin edits from this list (matches getStaffTarget's
  // same exclusion for the mutation routes further down).
  const conditions = ["u.role != 'customer'", "u.role != 'super_admin'"];
  const params = [];
  if (role) {
    conditions[0] = "u.role = ?";
    params.push(role);
  }
  if (req.user.role === "super_admin") {
    if (company_id) {
      conditions.push("u.company_id = ?");
      params.push(company_id);
    }
  } else {
    conditions.push("u.company_id = ?");
    params.push(req.user.company_id);
  }
  const rows = db
    .prepare(`SELECT ${STAFF_LIST_FIELDS} FROM users u ${STAFF_LIST_JOIN} WHERE ${conditions.join(" AND ")} ORDER BY u.name`)
    .all(...params);
  res.json(rows);
});

// Creates a staff account directly, with a password the admin sets on the spot. The invite flow
// (POST /invitations) stays the right tool when the new user has a work email they actually read
// and can pick their own password from a link — but that's not how OKV onboards a cleaner, who is
// typically handed a username and a standard password on their first shift, often at a site, from
// someone else's phone. Before this existed, the only way to get such an account created was to
// issue an invitation and then accept it on the person's behalf. Admin-only (same as invitations
// and the password reset below); deliberately can't create a 'customer' account, which is tied to
// a client_id and belongs to the invite flow.
authRouter.post("/users", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { name, password, role } = req.body;
  // Stored lower-cased: POST /login looks the email up with a plain "=" (SQLite compares TEXT
  // case-sensitively by default), so a stray capital typed at creation time would silently lock
  // the account to exactly that spelling. The duplicate check below is case-insensitive for the
  // same reason — older rows created via the invite flow keep whatever case was typed there.
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!name || !name.trim() || !email) return res.status(400).json({ code: "name_and_email_required", error: "Navn og e-post er påkrevd." });
  if (!CREATABLE_ROLES.includes(role)) return res.status(400).json({ code: "invalid_role", error: "Ugyldig rolle" });
  // 6, not the password reset's 8 — confirmed with Håkon 2026-09-18: OKV's standard starting
  // password for a new cleaner is 7 characters, and the accounts created before this endpoint
  // existed (via invite-accept, which has no minimum at all) already use it. An 8-char minimum
  // here would just push staff creation back out of the app again.
  if (!password || password.length < 6) return res.status(400).json({ code: "password_too_short_6", error: "Passordet må være minst 6 tegn." });

  // Same shape as POST /invitations: a super_admin has no company of its own, so it has to say
  // which company the account lands in; for everyone else the body is never trusted for this.
  let companyId = req.user.company_id;
  if (req.user.role === "super_admin") {
    companyId = req.body.company_id;
    if (!companyId) return res.status(400).json({ code: "company_id_required", error: "company_id er påkrevd når du oppretter som super_admin" });
    if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId)) {
      return res.status(400).json({ code: "unknown_company", error: "Ukjent firma" });
    }
  }

  // Set by whoever creates the account, not by the account holder: a cleaner who doesn't read
  // Norwegian can't realistically find a Norwegian-labelled language picker on their own. Optional
  // — omitted means NULL, which renders as Norwegian and can still be changed later.
  const language = normalizeLanguage(req.body.language);
  if (language === undefined) return res.status(400).json({ code: "unsupported_language", error: "Ukjent språk." });

  // A customer account is scoped by its client, not by a department: every customer-facing check
  // in the app keys off client_id, so an unvalidated one here would hand that account another
  // company's data. Validated against the company the account lands in, exactly as
  // POST /invitations does for the same role.
  const isCustomerRole = role === "customer";
  let clientId = null;
  if (isCustomerRole) {
    clientId = req.body.client_id ?? null;
    if (!clientId) return res.status(400).json({ code: "client_id_required", error: "Velg hvilken kunde brukeren hører til." });
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(clientId);
    if (!client || client.company_id !== companyId) {
      return res.status(400).json({ code: "unknown_client", error: "Ukjent kunde" });
    }
  }

  // Departments are a staff-only grouping (see db.js on users.department_id), so a customer never
  // gets one even if the caller sends it.
  const departmentId = isCustomerRole ? null : req.body.department_id ?? null;
  if (departmentId != null) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(departmentId);
    if (!department || department.company_id !== companyId) {
      return res.status(400).json({ code: "unknown_department", error: "Ukjent avdeling" });
    }
  }

  if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    return res.status(409).json({ code: "email_taken", error: "En konto med denne e-posten finnes allerede" });
  }

  // Optional at creation — the number often comes from payroll after the person has started, and
  // blocking the account on it would just mean nobody gets created.
  const employeeNumber = typeof req.body.employee_number === "string" ? req.body.employee_number.trim() || null : null;
  if (employeeNumber) {
    const clash = db.prepare("SELECT id FROM users WHERE employee_number = ? AND company_id IS ?").get(employeeNumber, companyId);
    if (clash) return res.status(409).json({ code: "employee_number_taken", error: "En annen ansatt har allerede dette ansattnummeret." });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      "INSERT INTO users (name, email, password_hash, role, company_id, department_id, client_id, language, employee_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(name.trim(), email, password_hash, role, companyId, departmentId, clientId, language, employeeNumber);

  // Any invitation still pending for this address is now moot — the account it would have created
  // exists. Mirrors the "one valid link per email at a time" rule POST /invitations already keeps.
  db.prepare("UPDATE invitations SET status = 'revoked' WHERE email = ? AND status = 'pending'").run(email);

  // Same row shape GET /users returns (company_id/company_name included), so "Ansatte" can drop
  // the new account straight into the list it already has without a refetch — STAFF_FIELDS alone
  // would leave a super_admin's row with no company, and its department <select> empty.
  res.status(201).json(
    db
      .prepare(`SELECT ${STAFF_LIST_FIELDS} FROM users u ${STAFF_LIST_JOIN} WHERE u.id = ?`)
      .get(info.lastInsertRowid)
  );
});

// Shared by every /users/:id/* route below: same company (unless the requester is super_admin,
// who manages every company's staff and so is exempt from that check), and never a super_admin
// target — that account is Rentlogg's own operator surface, not something even another
// super_admin edits from this list. A customer target is refused too UNLESS the caller opts in
// with allowCustomer (only the routes that make sense for a customer account — details, password,
// active, delete — pass that; role reassignment never does, since STAFF_ROLES has no 'customer').
function getStaffTarget(id, requester, { allowCustomer = false } = {}) {
  const target = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(id);
  if (!target) return { status: 404, code: "not_found", error: "Not found" };
  if (target.role === "super_admin") return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (target.role === "customer" && !allowCustomer) return { status: 403, code: "not_allowed", error: "Not allowed" };
  if (requester.role !== "super_admin" && target.company_id !== requester.company_id) {
    return { status: 403, code: "not_allowed", error: "Not allowed" };
  }
  return { target };
}

// Edits a staff member's own details from "Ansatte" — department, and (since the accounts are
// created by an admin rather than by the person themselves, so a typo lands in the account and
// stays there) name, email and phone too. Role, password and active status each have their own
// endpoint below, with their own stricter guards. Every field is optional: the list sends
// department_id alone when the inline <select> changes, and name/email/phone together when the
// edit row is saved. Also doubles as "Kundebrukere"'s edit-details route (name/email/phone only
// — department_id is staff-only and rejected below for a customer target) since the two lists
// share this same shape of inline edit.
const USER_PATCH_FIELDS = ["name", "email", "phone", "employee_number", "department_id", "language"];

authRouter.patch("/users/:id", requireAuth, requireRole("admin", "manager", "super_admin"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user, { allowCustomer: true });
  if (error) return res.status(status).json({ code, error });
  if (target.role === "customer" && "department_id" in req.body) {
    return res.status(400).json({ code: "customer_has_no_department", error: "Kundebrukere har ingen avdeling." });
  }

  const updates = {};

  if ("department_id" in req.body) {
    const departmentId = req.body.department_id;
    if (departmentId != null) {
      // Validated against the target user's own company, not the requester's — the two are always
      // the same for admin/manager (getStaffTarget already enforced that), but a super_admin has no
      // company of their own, so the department has to match whoever is actually being edited.
      const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(departmentId);
      if (!department || department.company_id !== target.company_id) {
        return res.status(400).json({ code: "unknown_department", error: "Ukjent avdeling" });
      }
    }
    updates.department_id = departmentId ?? null;
  }

  if ("name" in req.body) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ code: "name_required", error: "Navn kan ikke være tomt." });
    updates.name = name;
  }

  if ("email" in req.body) {
    // Lower-cased and uniqueness-checked exactly like POST /users — this is the login itself, so a
    // duplicate would make one of the two accounts unreachable (POST /login takes the first match).
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email) return res.status(400).json({ code: "email_required", error: "E-post kan ikke være tom." });
    const clash = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?").get(email, target.id);
    if (clash) return res.status(409).json({ code: "email_taken", error: "En annen konto bruker allerede denne e-posten" });
    updates.email = email;
  }

  if ("phone" in req.body) {
    const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
    updates.phone = phone || null;
  }

  // Ansattnummer: the id payroll knows this person by. Kept free text rather than an integer —
  // OKV's own numbers come out of the payroll system, and a leading zero or a letter prefix is
  // exactly the kind of thing that must survive a round trip. Unique within the company, because
  // two people sharing one number is the one mistake that silently pays the wrong person.
  if ("employee_number" in req.body) {
    const number = typeof req.body.employee_number === "string" ? req.body.employee_number.trim() : "";
    if (number) {
      const clash = db
        .prepare("SELECT id FROM users WHERE employee_number = ? AND company_id IS ? AND id != ?")
        .get(number, target.company_id, target.id);
      if (clash) {
        return res.status(409).json({ code: "employee_number_taken", error: "En annen ansatt har allerede dette ansattnummeret." });
      }
    }
    updates.employee_number = number || null;
  }

  if ("language" in req.body) {
    const language = normalizeLanguage(req.body.language);
    if (language === undefined) return res.status(400).json({ code: "unsupported_language", error: "Ukjent språk." });
    updates.language = language;
  }

  const fields = USER_PATCH_FIELDS.filter((f) => f in updates);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });

  db.prepare(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`)
    .run(...fields.map((f) => updates[f]), req.params.id);

  res.json(
    db
      .prepare(`SELECT ${STAFF_LIST_FIELDS} FROM users u ${STAFF_LIST_JOIN} WHERE u.id = ?`)
      .get(req.params.id)
  );
});

// Lets an admin (or super_admin, across companies) set a new password for a locked-out/forgotten-
// password staff member without routing them through the invite flow again (which would need a
// fresh email invite + link click — impractical for a cleaner who's just standing there on
// shift). Deliberately admin-only (not manager, unlike the rest of this file) and deliberately
// can't target another admin — this stays a recovery tool for regular staff (and, since
// "Kundebrukere" reuses this same route, customer) accounts, not a way to take over a co-admin's
// (or, for super_admin, any company's admin's) login. If Rentlogg support ever needs to unlock a
// company admin directly, that's a deliberately separate decision from this endpoint, not an
// accidental side effect of it.
authRouter.patch("/users/:id/password", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user, { allowCustomer: true });
  if (error) return res.status(status).json({ code, error });
  if (!["cleaner", "manager", "customer"].includes(target.role)) {
    return res.status(403).json({ code: "password_reset_role_not_allowed", error: "Kan bare tilbakestille passord for renholdere, driftsledere og kundebrukere." });
  }

  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ code: "password_too_short_8", error: "Passordet må være minst 8 tegn." });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, req.params.id);
  res.json({ ok: true });
});

// Reassigns a staff member between admin/manager/cleaner — deliberately can't convert to/from
// 'customer' (a different account shape entirely, tied to a client_id this endpoint knows nothing
// about) or touch a super_admin. Admin-only (or super_admin, across every company), and can't
// target yourself — self-demoting out of admin here would lock you out of this very page with no
// recovery route (no self-service "restore my own role" exists, and a company might have only the
// one admin). Unlike the password endpoint, this is allowed to target another admin: demoting a
// co-admin is a legitimate "remove someone's access" action, and promoting a trusted manager to
// admin is exactly what this exists to support in the first place.
authRouter.patch("/users/:id/role", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ code, error });
  if (target.id === req.user.id) return res.status(403).json({ code: "cannot_change_own_role", error: "Du kan ikke endre din egen rolle." });

  const { role } = req.body;
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ code: "invalid_role", error: "Ugyldig rolle" });

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json(db.prepare(`SELECT ${STAFF_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
});

// Blocks/restores login without touching any of a user's existing history (visits, avvik, schedule
// assignments) — the reversible alternative to DELETE below. Admin-only (or super_admin, across
// every company); can't target yourself for the same lockout reason as the role endpoint above.
// Doesn't force out a session already issued before deactivation (no token-revocation in this app
// — see db.js's comment on the column) so this takes effect on that person's *next* login attempt,
// not necessarily immediately. Also "Kundebrukere"'s deactivate/reactivate — the same reversible
// block-login concept applies just as well to a customer account.
authRouter.patch("/users/:id/active", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user, { allowCustomer: true });
  if (error) return res.status(status).json({ code, error });
  if (target.id === req.user.id) return res.status(403).json({ code: "cannot_deactivate_self", error: "Du kan ikke deaktivere din egen konto." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ code: "invalid_active_flag", error: "active må være true eller false" });

  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(req.body.active ? 1 : 0, req.params.id);
  res.json(db.prepare(`SELECT ${STAFF_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
});

// A real DELETE, not just deactivation — for the case that actually calls for it (a duplicate or
// test account with no real activity yet). Refuses once the user has any genuine history
// (checklist_runs.cleaner_id, room_runs.cleaner_id, deviations.reported_by, or invitations.
// invited_by all NOT NULL FKs — the delete would fail on any of them anyway with foreign_keys=ON,
// this just gives a clear reason instead of a raw SQLite constraint error) and points at
// deactivating instead, which is almost always the right call for a real former employee (or, for
// a customer account, one from a contact who's left that company).
// site_schedules/room_schedules.assigned_cleaner_id are nullable scheduling metadata, not history
// — cleared automatically as part of the delete rather than also blocking on those. Admin-only
// (or super_admin, across every company).
authRouter.delete("/users/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, code, error } = getStaffTarget(req.params.id, req.user, { allowCustomer: true });
  if (error) return res.status(status).json({ code, error });
  if (target.id === req.user.id) return res.status(403).json({ code: "cannot_delete_self", error: "Du kan ikke slette din egen konto." });

  const counts = {
    besøk: db.prepare("SELECT COUNT(*) AS n FROM checklist_runs WHERE cleaner_id = ?").get(req.params.id).n,
    romvisitter: db.prepare("SELECT COUNT(*) AS n FROM room_runs WHERE cleaner_id = ?").get(req.params.id).n,
    avvik: db.prepare("SELECT COUNT(*) AS n FROM deviations WHERE reported_by = ?").get(req.params.id).n,
    invitasjoner: db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE invited_by = ?").get(req.params.id).n,
    // Training they received, and training they registered for someone else — both are the same
    // kind of documentation as the rows above. Without these two the DELETE below didn't just lose
    // the history, it failed outright: training_records references users(id) and foreign keys are
    // on, so a trained employee came back as a bare 500 instead of "har historikk, deaktiver i
    // stedet". Assignments are deliberately absent — a course someone was merely told to take is a
    // plan, not history, and is cleared below like the scheduling links are.
    opplæring: db.prepare("SELECT COUNT(*) AS n FROM training_records WHERE user_id = ?").get(req.params.id).n,
    "registrerte opplæringer": db.prepare("SELECT COUNT(*) AS n FROM training_records WHERE registered_by = ?").get(req.params.id).n,
  };
  const withHistory = Object.entries(counts).filter(([, n]) => n > 0);
  if (withHistory.length > 0) {
    return res.status(409).json({
      error: `Kan ikke slettes: har historikk (${withHistory.map(([label, n]) => `${n} ${label}`).join(", ")}). Deaktiver i stedet.`,
    });
  }

  const deleteUser = db.transaction((id) => {
    db.prepare("UPDATE site_schedules SET assigned_cleaner_id = NULL WHERE assigned_cleaner_id = ?").run(id);
    db.prepare("UPDATE room_schedules SET assigned_cleaner_id = NULL WHERE assigned_cleaner_id = ?").run(id);
    // Same treatment as the two above, for the same reason: these are plans pointing at a person,
    // not a record of anything that happened, and they hold a foreign key that would otherwise
    // block the delete.
    db.prepare("DELETE FROM training_assignments WHERE user_id = ?").run(id);
    db.prepare("UPDATE training_assignments SET assigned_by = NULL WHERE assigned_by = ?").run(id);
    // Who first wrote a course down, and who switched a module on, are notes about the row rather
    // than about the person — the course and the module outlive whoever set them up. Left alone
    // they are foreign keys too, and they blocked the delete just as silently.
    db.prepare("UPDATE training_courses SET created_by = NULL WHERE created_by = ?").run(id);
    db.prepare("UPDATE company_modules SET enabled_by = NULL WHERE enabled_by = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  deleteUser(req.params.id);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, client_id, company_id, avatar_url, phone, created_at, language FROM users WHERE id = ?")
    .get(req.user.id);
  res.json({ ...user, modules: enabledModulesForCompany(user.company_id) });
});

authRouter.patch("/me", requireAuth, (req, res) => {
  const fields = ["name", "phone", "language"].filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ code: "no_valid_fields", error: "No valid fields to update" });

  // Validated rather than stored as typed: an unknown code would silently fall back to Norwegian
  // on every render, which reads as "the language picker is broken" to whoever just set it.
  if ("language" in req.body && normalizeLanguage(req.body.language) === undefined) {
    return res.status(400).json({ code: "unsupported_language", error: "Ukjent språk." });
  }

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => (f === "language" ? normalizeLanguage(req.body[f]) : req.body[f]));
  db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...values, req.user.id);

  const user = db
    .prepare("SELECT id, name, email, role, client_id, company_id, avatar_url, phone, created_at, language FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

// Changing your own password — the one thing PATCH /users/:id/password deliberately can't do for
// an admin (it only ever targets cleaners, managers and customers, so an admin can't be reset by a
// co-admin), which left admins with no way to rotate their own credentials at all. Requires the
// current password even though the caller is already authenticated: a JWT lives 12h, so a borrowed
// or forgotten session shouldn't be enough to take the account over permanently.
authRouter.patch("/me/password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ code: "password_too_short_8", error: "Passordet må være minst 8 tegn." });
  }

  const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword || "", user.password_hash)) {
    return res.status(403).json({ code: "current_password_wrong", error: "Nåværende passord er feil." });
  }

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), req.user.id);
  // Tokens already issued stay valid until they expire — there's no revocation list, and the 12h
  // lifetime is the bound on that. Worth knowing before treating this as "kick everyone out".
  res.json({ ok: true });
});

authRouter.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ code: "no_file_uploaded", error: "No file uploaded (field name must be 'avatar')" });
  await normalizeImageOrientation(path.join(`${process.env.UPLOADS_DIR || "uploads"}/avatars`, req.file.filename));
  const avatar_url = `/uploads/avatars/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatar_url, req.user.id);
  res.json({ avatar_url });
});
