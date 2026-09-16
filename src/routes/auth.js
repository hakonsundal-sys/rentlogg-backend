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
// department, and signup date. Scoped to the caller's own company — company_id is null for a
// request with none (shouldn't happen here since this route isn't reachable by super_admin's own
// UI, but WHERE company_id = ? against NULL naturally matches nothing rather than leaking every
// company's staff). No explicit ?role filter defaults to every non-customer role — a customer
// account isn't "staff" and has no department, and the one existing caller of the unfiltered form
// doesn't exist (the only current caller always passes ?role=cleaner), so this default was always
// somewhat accidental; tightened here since "Ansatte" is the first real user of it.
authRouter.get("/users", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare("SELECT id, name, email, role, phone, department_id, created_at FROM users WHERE role = ? AND company_id = ? ORDER BY name").all(role, req.user.company_id)
    : db.prepare("SELECT id, name, email, role, phone, department_id, created_at FROM users WHERE role != 'customer' AND company_id = ? ORDER BY name").all(req.user.company_id);
  res.json(rows);
});

// Assigns/clears which department a staff member belongs to — the one field "Ansatte" lets an
// admin/manager edit inline from the list, everything else about a user (name, email, role)
// stays managed via the invite flow. Same allowlist-of-one shape as every other PATCH_FIELDS
// route in this app, just not worth naming a constant for a single field.
authRouter.patch("/users/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const target = db.prepare("SELECT id, company_id FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });
  if (target.company_id !== req.user.company_id) return res.status(403).json({ error: "Not allowed" });
  if (!("department_id" in req.body)) return res.status(400).json({ error: "No valid fields to update" });

  const departmentId = req.body.department_id;
  if (departmentId != null) {
    const department = db.prepare("SELECT company_id FROM departments WHERE id = ?").get(departmentId);
    if (!department || department.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent avdeling" });
    }
  }

  db.prepare("UPDATE users SET department_id = ? WHERE id = ?").run(departmentId ?? null, req.params.id);
  res.json(db.prepare("SELECT id, name, email, role, phone, department_id, created_at FROM users WHERE id = ?").get(req.params.id));
});

// Lets an admin set a new password for a locked-out/forgotten-password staff member without
// routing them through the invite flow again (which would need a fresh email invite + link
// click — impractical for a cleaner who's just standing there on shift). Deliberately admin-only
// (not manager, unlike the rest of this file) and deliberately can't target another admin or a
// super_admin: this is a recovery tool for regular staff accounts, not a way for one company
// admin to take over another admin's login, or reach outside the company at all (the company-scope
// check below already blocks cross-company, but role is checked too since "same company" alone
// doesn't rule out a same-company admin resetting a co-admin's password).
authRouter.patch("/users/:id/password", requireAuth, requireRole("admin"), (req, res) => {
  const target = db.prepare("SELECT id, company_id, role FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Not found" });
  if (target.company_id !== req.user.company_id) return res.status(403).json({ error: "Not allowed" });
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
