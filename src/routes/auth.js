import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeOriginalName } from "../utils/uploads.js";

export const authRouter = Router();

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: `${process.env.UPLOADS_DIR || "uploads"}/avatars`,
    filename: (req, file, cb) => cb(null, `${req.user.id}-${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

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

authRouter.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, client_id: user.client_id, department_id: user.department_id, company_id: user.company_id },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, client_id: user.client_id, department_id: user.department_id, company_id: user.company_id },
  });
});

// Lightweight staff directory for pickers (e.g. assigning a cleaner to a site's schedule).
// Scoped to the caller's own company — company_id is null for a request with none (shouldn't
// happen here since this route isn't reachable by super_admin's own UI, but WHERE company_id = ?
// against NULL naturally matches nothing rather than leaking every company's staff).
authRouter.get("/users", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare("SELECT id, name, email, role FROM users WHERE role = ? AND company_id = ? ORDER BY name").all(role, req.user.company_id)
    : db.prepare("SELECT id, name, email, role FROM users WHERE company_id = ? ORDER BY name").all(req.user.company_id);
  res.json(rows);
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, client_id, department_id, company_id, avatar_url, phone, created_at FROM users WHERE id = ?")
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
    .prepare("SELECT id, name, email, role, client_id, department_id, company_id, avatar_url, phone, created_at FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

authRouter.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'avatar')" });
  const avatar_url = `/uploads/avatars/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatar_url, req.user.id);
  res.json({ avatar_url });
});
