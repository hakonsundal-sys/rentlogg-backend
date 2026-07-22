import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const clientsRouter = Router();

clientsRouter.get("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all();
  res.json(clients);
});

clientsRouter.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, contact_email, contact_name, phone, address } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const info = db
    .prepare("INSERT INTO clients (name, contact_email, contact_name, phone, address) VALUES (?, ?, ?, ?, ?)")
    .run(name, contact_email || null, contact_name || null, phone || null, address || null);
  res.status(201).json({ id: info.lastInsertRowid, name, contact_email, contact_name, phone, address });
});

clientsRouter.get("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "Not found" });
  res.json(client);
});

const CLIENT_PATCH_FIELDS = ["name", "contact_email", "contact_name", "phone", "address"];

clientsRouter.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const fields = CLIENT_PATCH_FIELDS.filter((f) => f in req.body);
  if (fields.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => req.body[f]);
  const info = db.prepare(`UPDATE clients SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Not found" });

  res.json(db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id));
});

clientsRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const client = db.prepare("SELECT id FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "Not found" });

  const siteCount = db.prepare("SELECT COUNT(*) AS n FROM sites WHERE client_id = ?").get(req.params.id).n;
  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE client_id = ?").get(req.params.id).n;
  if (siteCount > 0 || userCount > 0) {
    return res.status(409).json({
      error: `Client has ${siteCount} site(s) and ${userCount} user(s); remove or reassign them before deleting.`,
      siteCount,
      userCount,
    });
  }

  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
