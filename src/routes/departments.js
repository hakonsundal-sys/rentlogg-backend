import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const departmentsRouter = Router();

// Staff (admin/manager) see their company's departments, optionally filtered to one client (used
// by the department picker on the site/invite forms). A customer always sees their own client's
// departments regardless of whether they're scoped to one department or the whole client —
// department names aren't sensitive, only site/run/deviation data is scoped further than that.
departmentsRouter.get("/", requireAuth, (req, res) => {
  if (req.user.role === "customer") {
    const departments = db.prepare("SELECT * FROM departments WHERE client_id = ? ORDER BY name").all(req.user.client_id);
    return res.json(departments);
  }

  const { client_id } = req.query;
  const departments = client_id
    ? db.prepare("SELECT * FROM departments WHERE company_id = ? AND client_id = ? ORDER BY name").all(req.user.company_id, client_id)
    : db.prepare("SELECT * FROM departments WHERE company_id = ? ORDER BY name").all(req.user.company_id);
  res.json(departments);
});

// A whole-client-scoped customer (department_id null) can create departments for their own
// client self-service; a department-scoped customer cannot (no visibility into siblings). Staff
// pick the client explicitly, same as sites.js's POST / does for client_id.
departmentsRouter.post("/", requireAuth, requireRole("admin", "manager", "customer"), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  let clientId;
  if (req.user.role === "customer") {
    if (req.user.department_id) {
      return res.status(403).json({ error: "Du har ikke tilgang til å opprette avdelinger" });
    }
    clientId = req.user.client_id;
  } else {
    clientId = req.body.client_id;
    if (!clientId) return res.status(400).json({ error: "client_id is required" });
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(clientId);
    if (!client || client.company_id !== req.user.company_id) {
      return res.status(400).json({ error: "Ukjent kunde" });
    }
  }

  const info = db
    .prepare("INSERT INTO departments (name, client_id, company_id) VALUES (?, ?, ?)")
    .run(name, clientId, req.user.company_id);

  res.status(201).json({ id: info.lastInsertRowid, name, client_id: clientId, company_id: req.user.company_id });
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
  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE department_id = ?").get(req.params.id).n;
  if (siteCount > 0 || userCount > 0) {
    return res.status(409).json({
      error: `Department has ${siteCount} site(s) and ${userCount} user(s); remove or reassign them before deleting.`,
      siteCount,
      userCount,
    });
  }

  db.prepare("DELETE FROM departments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
