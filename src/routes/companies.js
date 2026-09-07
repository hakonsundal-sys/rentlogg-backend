import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const companiesRouter = Router();

// super_admin-only: managing companies (tenants) is Rentlogg's own operator surface, not
// anything a company's own admin/manager touches.
companiesRouter.get("/", requireAuth, requireRole("super_admin"), (req, res) => {
  res.json(db.prepare("SELECT * FROM companies ORDER BY name").all());
});

companiesRouter.post("/", requireAuth, requireRole("super_admin"), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name er påkrevd" });
  const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run(name.trim());
  res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
});
