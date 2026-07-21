import { Router } from "express";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const clientsRouter = Router();

clientsRouter.get("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const clients = db.prepare("SELECT * FROM clients ORDER BY name").all();
  res.json(clients);
});

clientsRouter.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, contact_email } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const info = db.prepare("INSERT INTO clients (name, contact_email) VALUES (?, ?)").run(name, contact_email || null);
  res.status(201).json({ id: info.lastInsertRowid, name, contact_email });
});

clientsRouter.get("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "Not found" });
  res.json(client);
});
