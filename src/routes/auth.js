import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const authRouter = Router();

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: `${process.env.UPLOADS_DIR || "uploads"}/avatars`,
    filename: (req, file, cb) => cb(null, `${req.user.id}-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Registration is admin-only in a real deployment; kept open here for prototype seeding.
authRouter.post("/register", (req, res) => {
  const { name, email, password, role, client_id } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role are required" });
  }
  if (role === "customer" && !client_id) {
    return res.status(400).json({ error: "client_id is required for customer accounts" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, password_hash, role, client_id || null);

  res.status(201).json({ id: info.lastInsertRowid, name, email, role });
});

authRouter.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, client_id: user.client_id },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, user: { id: user.id, name: user.name, role: user.role, client_id: user.client_id } });
});

// Lightweight staff directory for pickers (e.g. assigning a cleaner to a site's schedule).
authRouter.get("/users", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { role } = req.query;
  const rows = role
    ? db.prepare("SELECT id, name, email, role FROM users WHERE role = ? ORDER BY name").all(role)
    : db.prepare("SELECT id, name, email, role FROM users ORDER BY name").all();
  res.json(rows);
});

authRouter.get("/me", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, client_id, avatar_url, phone, created_at FROM users WHERE id = ?")
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
    .prepare("SELECT id, name, email, role, client_id, avatar_url, phone, created_at FROM users WHERE id = ?")
    .get(req.user.id);
  res.json(user);
});

authRouter.post("/me/avatar", requireAuth, avatarUpload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'avatar')" });
  const avatar_url = `/uploads/avatars/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatar_url, req.user.id);
  res.json({ avatar_url });
});
