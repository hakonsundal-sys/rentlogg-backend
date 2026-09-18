import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "node:path";
import rateLimit from "express-rate-limit";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeOriginalName, normalizeImageOrientation, imageFileFilter } from "../utils/uploads.js";

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
  message: { error: "For mange innloggingsforsøk. Prøv igjen om litt." },
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
    return res.status(403).json({ error: "Registrering er stengt. Kontakt en administrator for tilgang." });
  }
  if (!name || !email || !password || role !== "super_admin") {
    return res.status(400).json({ error: "name, email, password er påkrevd, og role må være 'super_admin'." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, 'super_admin', NULL, NULL)")
    .run(name, email, password_hash);

  res.status(201).json({ id: info.lastInsertRowid, name, email, role: "super_admin" });
});

authRouter.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  // Always run a bcrypt compare, even for an unknown email — comparing against a fixed dummy
  // hash keeps the response time the same either way, so a timing difference can't be used to
  // enumerate which emails have accounts (an unknown email used to return near-instantly, since
  // `!user ||` short-circuited before bcrypt ever ran).
  const passwordOk = bcrypt.compareSync(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  // Checked only after the password is confirmed correct — telling someone who doesn't even know
  // the right password that the account exists but is deactivated would leak more than a plain
  // "Invalid email or password" does, and a check placed *before* the bcrypt compare above would
  // also reopen exactly the timing side-channel that comment is guarding against.
  if (!user.active) {
    return res.status(403).json({ error: "Denne kontoen er deaktivert. Kontakt en administrator." });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, client_id: user.client_id, company_id: user.company_id },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, client_id: user.client_id, company_id: user.company_id },
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
const STAFF_FIELDS = "id, name, email, role, phone, department_id, active, created_at";
// Same fields, plus which company each row belongs to — only meaningful for super_admin's
// cross-company view (an admin/manager's own rows are all their own company already).
const STAFF_LIST_FIELDS = "u.id, u.name, u.email, u.role, u.phone, u.department_id, u.active, u.created_at, u.company_id, c.name AS company_name";
// The roles this file is willing to create or move an account between — never 'customer'
// (client-scoped, invite-only) or 'super_admin' (Rentlogg's own operator account).
const STAFF_ROLES = ["admin", "manager", "cleaner"];

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
    .prepare(`SELECT ${STAFF_LIST_FIELDS} FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE ${conditions.join(" AND ")} ORDER BY u.name`)
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
  if (!name || !name.trim() || !email) return res.status(400).json({ error: "Navn og e-post er påkrevd." });
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: "Ugyldig rolle" });
  // 6, not the password reset's 8 — confirmed with Håkon 2026-09-18: OKV's standard starting
  // password for a new cleaner is 7 characters, and the accounts created before this endpoint
  // existed (via invite-accept, which has no minimum at all) already use it. An 8-char minimum
  // here would just push staff creation back out of the app again.
  if (!password || password.length < 6) return res.status(400).json({ error: "Passordet må være minst 6 tegn." });

  // Same shape as POST /invitations: a super_admin has no company of its own, so it has to say
  // which company the account lands in; for everyone else the body is never trusted for this.
  let companyId = req.user.company_id;
  if (req.user.role === "super_admin") {
    companyId = req.body.company_id;
    if (!companyId) return res.status(400).json({ error: "company_id er påkrevd når du oppretter som super_admin" });
    if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId)) {
      return res.status(400).json({ error: "Ukjent firma" });
    }
  }

  const departmentId = req.body.department_id ?? null;
  if (departmentId != null) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(departmentId);
    if (!department || department.company_id !== companyId) {
      return res.status(400).json({ error: "Ukjent avdeling" });
    }
  }

  if (db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    return res.status(409).json({ error: "En konto med denne e-posten finnes allerede" });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, company_id, department_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name.trim(), email, password_hash, role, companyId, departmentId);

  // Any invitation still pending for this address is now moot — the account it would have created
  // exists. Mirrors the "one valid link per email at a time" rule POST /invitations already keeps.
  db.prepare("UPDATE invitations SET status = 'revoked' WHERE email = ? AND status = 'pending'").run(email);

  // Same row shape GET /users returns (company_id/company_name included), so "Ansatte" can drop
  // the new account straight into the list it already has without a refetch — STAFF_FIELDS alone
  // would leave a super_admin's row with no company, and its department <select> empty.
  res.status(201).json(
    db
      .prepare(`SELECT ${STAFF_LIST_FIELDS} FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?`)
      .get(info.lastInsertRowid)
  );
});

// Shared by every /users/:id/* route below: same company (unless the requester is super_admin,
// who manages every company's staff and so is exempt from that check), and never a customer/
// super_admin target — a customer has no role hierarchy here, and a super_admin account is
// Rentlogg's own operator surface, not something even another super_admin edits from this staff
// list.
function getStaffTarget(id, requester) {
  const target = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(id);
  if (!target) return { status: 404, error: "Not found" };
  if (target.role === "customer" || target.role === "super_admin") return { status: 403, error: "Not allowed" };
  if (requester.role !== "super_admin" && target.company_id !== requester.company_id) {
    return { status: 403, error: "Not allowed" };
  }
  return { target };
}

// Assigns/clears which department a staff member belongs to — the one field "Ansatte" lets an
// admin/manager (or super_admin, across companies) edit inline from the list, everything else
// about a user (name, email, role) stays managed via the invite flow. Same allowlist-of-one shape
// as every other PATCH_FIELDS route in this app, just not worth naming a constant for a single
// field.
authRouter.patch("/users/:id", requireAuth, requireRole("admin", "manager", "super_admin"), (req, res) => {
  const { target, status, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (!("department_id" in req.body)) return res.status(400).json({ error: "No valid fields to update" });

  const departmentId = req.body.department_id;
  if (departmentId != null) {
    // Validated against the target user's own company, not the requester's — the two are always
    // the same for admin/manager (getStaffTarget already enforced that), but a super_admin has no
    // company of their own, so the department has to match whoever is actually being edited.
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(departmentId);
    if (!department || department.company_id !== target.company_id) {
      return res.status(400).json({ error: "Ukjent avdeling" });
    }
  }

  db.prepare("UPDATE users SET department_id = ? WHERE id = ?").run(departmentId ?? null, req.params.id);
  res.json(db.prepare(`SELECT ${STAFF_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
});

// Lets an admin (or super_admin, across companies) set a new password for a locked-out/forgotten-
// password staff member without routing them through the invite flow again (which would need a
// fresh email invite + link click — impractical for a cleaner who's just standing there on
// shift). Deliberately admin-only (not manager, unlike the rest of this file) and deliberately
// can't target another admin — this stays a recovery tool for regular staff accounts, not a way
// to take over a co-admin's (or, for super_admin, any company's admin's) login. If Rentlogg
// support ever needs to unlock a company admin directly, that's a deliberately separate decision
// from this endpoint, not an accidental side effect of it.
authRouter.patch("/users/:id/password", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (!["cleaner", "manager"].includes(target.role)) {
    return res.status(403).json({ error: "Kan bare tilbakestille passord for renholdere og driftsledere." });
  }

  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Passordet må være minst 8 tegn." });
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
  const { target, status, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (target.id === req.user.id) return res.status(403).json({ error: "Du kan ikke endre din egen rolle." });

  const { role } = req.body;
  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: "Ugyldig rolle" });

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json(db.prepare(`SELECT ${STAFF_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
});

// Blocks/restores login without touching any of a user's existing history (visits, avvik, schedule
// assignments) — the reversible alternative to DELETE below. Admin-only (or super_admin, across
// every company); can't target yourself for the same lockout reason as the role endpoint above.
// Doesn't force out a session already issued before deactivation (no token-revocation in this app
// — see db.js's comment on the column) so this takes effect on that person's *next* login attempt,
// not necessarily immediately.
authRouter.patch("/users/:id/active", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (target.id === req.user.id) return res.status(403).json({ error: "Du kan ikke deaktivere din egen konto." });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "active må være true eller false" });

  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(req.body.active ? 1 : 0, req.params.id);
  res.json(db.prepare(`SELECT ${STAFF_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
});

// A real DELETE, not just deactivation — for the case that actually calls for it (a duplicate or
// test account with no real activity yet). Refuses once the user has any genuine history
// (checklist_runs.cleaner_id, room_runs.cleaner_id, deviations.reported_by, or invitations.
// invited_by all NOT NULL FKs — the delete would fail on any of them anyway with foreign_keys=ON,
// this just gives a clear reason instead of a raw SQLite constraint error) and points at
// deactivating instead, which is almost always the right call for a real former employee.
// site_schedules/room_schedules.assigned_cleaner_id are nullable scheduling metadata, not history
// — cleared automatically as part of the delete rather than also blocking on those. Admin-only
// (or super_admin, across every company).
authRouter.delete("/users/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { target, status, error } = getStaffTarget(req.params.id, req.user);
  if (error) return res.status(status).json({ error });
  if (target.id === req.user.id) return res.status(403).json({ error: "Du kan ikke slette din egen konto." });

  const counts = {
    besøk: db.prepare("SELECT COUNT(*) AS n FROM checklist_runs WHERE cleaner_id = ?").get(req.params.id).n,
    romvisitter: db.prepare("SELECT COUNT(*) AS n FROM room_runs WHERE cleaner_id = ?").get(req.params.id).n,
    avvik: db.prepare("SELECT COUNT(*) AS n FROM deviations WHERE reported_by = ?").get(req.params.id).n,
    invitasjoner: db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE invited_by = ?").get(req.params.id).n,
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
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  deleteUser(req.params.id);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, client_id, company_id, avatar_url, phone, created_at FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

authRouter.patch("/me", requireAuth, (req, res) => {
  const fields = ["name", "phone"].filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => req.body[f]);
  db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...values, req.user.id);

  const user = db
    .prepare("SELECT id, name, email, role, client_id, company_id, avatar_url, phone, created_at FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

authRouter.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'avatar')" });
  await normalizeImageOrientation(path.join(`${process.env.UPLOADS_DIR || "uploads"}/avatars`, req.file.filename));
  const avatar_url = `/uploads/avatars/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatar_url, req.user.id);
  res.json({ avatar_url });
});
