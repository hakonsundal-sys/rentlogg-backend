import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { newQrToken } from "../utils/qrcode.js";

export const invitationsRouter = Router();

const VALID_ROLES = ["admin", "manager", "cleaner", "customer"];

invitationsRouter.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { email, role, client_id } = req.body;
  if (!email || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "email and a valid role are required" });
  }
  if (role === "customer" && !client_id) {
    return res.status(400).json({ error: "client_id is required for customer invitations" });
  }

  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingUser) return res.status(409).json({ error: "En konto med denne e-posten finnes allerede" });

  // One valid link per email at a time, so there's never ambiguity about which link works.
  db.prepare("UPDATE invitations SET status = 'revoked' WHERE email = ? AND status = 'pending'").run(email);

  const token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO invitations (email, role, client_id, token, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+14 days'))`
    )
    .run(email, role, role === "customer" ? client_id : null, token, req.user.id);

  const invitation = db.prepare("SELECT * FROM invitations WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(invitation);
});

function withComputedStatus(invitation) {
  const isExpired = invitation.status === "pending" && invitation.expires_at <= new Date().toISOString().replace("T", " ").slice(0, 19);
  return { ...invitation, status: isExpired ? "expired" : invitation.status };
}

invitationsRouter.get("/", requireAuth, requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS client_name FROM invitations i
       LEFT JOIN clients c ON c.id = i.client_id
       ORDER BY i.created_at DESC`
    )
    .all()
    .map(withComputedStatus);

  res.json({
    active: rows.filter((r) => r.status === "pending"),
    history: rows.filter((r) => r.status !== "pending"),
  });
});

invitationsRouter.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const invitation = db.prepare("SELECT * FROM invitations WHERE id = ?").get(req.params.id);
  if (!invitation) return res.status(404).json({ error: "Not found" });
  if (invitation.status !== "pending") return res.status(409).json({ error: "Invitation already used or revoked" });

  db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

function findValidInvitation(token) {
  const invitation = db.prepare("SELECT * FROM invitations WHERE token = ?").get(token);
  if (!invitation) return { error: "not_found" };
  if (invitation.status !== "pending") return { error: "already_used" };
  if (invitation.expires_at <= new Date().toISOString().replace("T", " ").slice(0, 19)) return { error: "expired" };
  return { invitation };
}

// Public: no auth, this is what the invite-accept page validates against before showing a form.
invitationsRouter.get("/:token", (req, res) => {
  const { invitation, error } = findValidInvitation(req.params.token);
  if (error) return res.status(error === "not_found" ? 404 : 410).json({ valid: false, reason: error });
  res.json({ valid: true, email: invitation.email, role: invitation.role });
});

// Public: no auth, creates the account and logs the new user in immediately.
invitationsRouter.post("/:token/accept", (req, res) => {
  const { invitation, error } = findValidInvitation(req.params.token);
  if (error) return res.status(error === "not_found" ? 404 : 410).json({ error: "Invitasjonen er ikke gyldig" });

  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: "name and password are required" });

  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(invitation.email);
  if (existingUser) return res.status(409).json({ error: "En konto med denne e-posten finnes allerede" });

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, invitation.email, password_hash, invitation.role, invitation.client_id);

  db.prepare("UPDATE invitations SET status = 'used' WHERE id = ?").run(invitation.id);

  const user = { id: info.lastInsertRowid, name, role: invitation.role, client_id: invitation.client_id };
  const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "12h" });
  res.status(201).json({ token, user });
});
