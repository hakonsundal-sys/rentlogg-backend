import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db.js";

export const authRouter = Router();

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
