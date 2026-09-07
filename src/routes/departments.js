import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const departmentsRouter = Router();

// Internal, company-wide region tags (Vest/Sør/Øst/Midt) for grouping sites across clients —
// staff-only, customers have no visibility into or use for this.
departmentsRouter.get("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const departments = db.prepare("SELECT * FROM departments WHERE company_id = ? ORDER BY name").all(req.user.company_id);
  res.json(departments);
});

departmentsRouter.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const info = db
    .prepare("INSERT INTO departments (name, company_id) VALUES (?, ?)")
    .run(name, req.user.company_id);

  res.status(201).json({ id: info.lastInsertRowid, name, company_id: req.user.company_id });
});

departmentsRouter.patch("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const department = db.prepare("SELECT id, company_id FROM departments WHERE id = ?").get(req.params.id);
  if (!department) return res.status(404).json({ error: "Not found" });
  if (department.company_id !== req.user.company_id) return res.status(403).json({ error: "Not allowed" });

  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  db.prepare("UPDATE departments SET name = ? WHERE id = ?").run(name, req.params.id);
  res.json(db.prepare("SELECT * FROM departments WHERE id = ?").get(req.params.id));
});

departmentsRouter.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const department = db.prepare("SELECT id, company_id FROM departments WHERE id = ?").get(req.params.id);
  if (!department) return res.status(404).json({ error: "Not found" });
  if (department.company_id !== req.user.company_id) return res.status(403).json({ error: "Not allowed" });

  const siteCount = db.prepare("SELECT COUNT(*) AS n FROM sites WHERE department_id = ?").get(req.params.id).n;
  if (siteCount > 0) {
    return res.status(409).json({
      error: `Department has ${siteCount} site(s); remove or reassign them before deleting.`,
      siteCount,
    });
  }

  db.prepare("DELETE FROM departments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
