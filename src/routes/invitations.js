import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { requireAuth, requireRole, issueToken } from "../middleware/auth.js";
import { invitationAcceptLimiter } from "../middleware/rateLimits.js";
import { newQrToken } from "../utils/qrcode.js";

export const invitationsRouter = Router();

const VALID_ROLES = ["admin", "manager", "cleaner", "customer"];

// A super_admin has no company of their own — inviting into one is how a new company actually
// gets its first admin (super_admin creates the company via POST /companies, then invites that
// company's admin here). A regular admin/manager can only ever invite into their own company;
// company_id from the request body is never trusted for them, only for super_admin.
invitationsRouter.post("/", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const { role, client_id } = req.body;
  // Lower-cased and trimmed like every other place an address is stored (login matches it that way).
  // Without this, inviting "Anna@x.no" while "anna@x.no" existed passed the duplicate check — the
  // column's UNIQUE is case-sensitive — and the accepted account could never log in, because login
  // finds the older row first.
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ code: "email_and_role_required", error: "email and a valid role are required" });
  }
  if (role === "customer" && !client_id) {
    return res.status(400).json({ code: "client_id_required", error: "client_id is required for customer invitations" });
  }

  let companyId = req.user.company_id;
  if (req.user.role === "super_admin") {
    companyId = req.body.company_id;
    if (!companyId) return res.status(400).json({ code: "company_id_required", error: "company_id er påkrevd når du inviterer som super_admin" });
    if (!db.prepare("SELECT 1 FROM companies WHERE id = ?").get(companyId)) {
      return res.status(400).json({ code: "unknown_company", error: "Ukjent firma" });
    }
  }

  // client_id must belong to the company this invitation is actually landing in — never trust
  // it as-is, the same way sites.js validates client_id against company_id on site create/patch.
  // Without this, an admin/super_admin could invite a customer whose client_id belongs to a
  // different company, handing that account cross-tenant access once accepted (every
  // customer-scoping check in the app keys off client_id, not company_id).
  if (role === "customer") {
    const client = db.prepare("SELECT company_id FROM clients WHERE id = ?").get(client_id);
    if (!client || client.company_id !== companyId) {
      return res.status(400).json({ code: "unknown_client", error: "Ukjent kunde" });
    }
  }

  const existingUser = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
  if (existingUser) return res.status(409).json({ code: "email_taken", error: "En konto med denne e-posten finnes allerede" });

  // One valid link per email at a time, so there's never ambiguity about which link works. Only
  // this company's own earlier invitation: the query used to revoke every company's pending invite
  // for the address, so inviting someone another firm had already invited silently cancelled theirs.
  db.prepare("UPDATE invitations SET status = 'revoked' WHERE email = ? COLLATE NOCASE AND company_id = ? AND status = 'pending'").run(email, companyId);

  const token = newQrToken();
  const info = db
    .prepare(
      `INSERT INTO invitations (email, role, client_id, company_id, token, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+14 days'))`
    )
    .run(email, role, role === "customer" ? client_id : null, companyId, token, req.user.id);

  const invitation = db.prepare("SELECT * FROM invitations WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(invitation);
});

function withComputedStatus(invitation) {
  const isExpired = invitation.status === "pending" && invitation.expires_at <= new Date().toISOString().replace("T", " ").slice(0, 19);
  return { ...invitation, status: isExpired ? "expired" : invitation.status };
}

// A super_admin has no company of their own, and `WHERE company_id = NULL` matches nothing in
// SQL — so this list came back empty for them no matter how many invitations existed, including
// the one they had just made. Inviting a new company's first admin is a super_admin-only job
// (SelskaperPage sends you here to do it), so the one role that needs this list was the one role
// that could never see it. They now see every company's, with the company named per row; everyone
// else still sees only their own.
invitationsRouter.get("/", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const seesAllCompanies = req.user.role === "super_admin";
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS client_name, co.name AS company_name FROM invitations i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN companies co ON co.id = i.company_id
       WHERE (? OR i.company_id = ?)
       ORDER BY i.created_at DESC`
    )
    .all(seesAllCompanies ? 1 : 0, req.user.company_id)
    .map(withComputedStatus);

  res.json({
    active: rows.filter((r) => r.status === "pending"),
    history: rows.filter((r) => r.status !== "pending"),
  });
});

invitationsRouter.delete("/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const invitation = db.prepare("SELECT * FROM invitations WHERE id = ?").get(req.params.id);
  if (!invitation) return res.status(404).json({ code: "not_found", error: "Not found" });
  // A super_admin administers every tenant, so the company check is theirs to skip — the same
  // split POST / already makes. For anyone else it is the tenant boundary and still applies.
  if (req.user.role !== "super_admin" && invitation.company_id !== req.user.company_id) {
    return res.status(403).json({ code: "not_allowed", error: "Not allowed" });
  }
  if (invitation.status !== "pending") return res.status(409).json({ code: "invitation_used", error: "Invitation already used or revoked" });

  db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

function findValidInvitation(token) {
  const invitation = db.prepare("SELECT * FROM invitations WHERE token = ?").get(token);
  if (!invitation) return { code: "not_found", error: "not_found" };
  if (invitation.status !== "pending") return { code: "invitation_used", error: "already_used" };
  if (invitation.expires_at <= new Date().toISOString().replace("T", " ").slice(0, 19)) return { code: "invitation_expired", error: "expired" };
  return { invitation };
}

// Public: no auth, this is what the invite-accept page validates against before showing a form.
invitationsRouter.get("/:token", (req, res) => {
  const { invitation, error } = findValidInvitation(req.params.token);
  if (error) return res.status(error === "not_found" ? 404 : 410).json({ valid: false, reason: error });
  res.json({ valid: true, email: invitation.email, role: invitation.role });
});

// Public: no auth, creates the account and logs the new user in immediately.
invitationsRouter.post("/:token/accept", invitationAcceptLimiter, async (req, res) => {
  const { invitation, error } = findValidInvitation(req.params.token);
  if (error) return res.status(error === "not_found" ? 404 : 410).json({ code: "invitation_invalid", error: "Invitasjonen er ikke gyldig" });

  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ code: "name_and_password_required", error: "name and password are required" });

  const email = String(invitation.email).trim().toLowerCase();
  const existingUser = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
  if (existingUser) return res.status(409).json({ code: "email_taken", error: "En konto med denne e-posten finnes allerede" });

  // Async for the same reason as the login compare: hashSync holds the shared thread for ~70 ms.
  const password_hash = await bcrypt.hash(String(password), 10);
  // Re-checked after the await: the request that arrived while this one was hashing may have taken
  // the address (or used the same invitation link).
  if (db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    return res.status(409).json({ code: "email_taken", error: "En konto med denne e-posten finnes allerede" });
  }
  if (db.prepare("SELECT status FROM invitations WHERE id = ?").get(invitation.id)?.status !== "pending") {
    return res.status(410).json({ code: "invitation_invalid", error: "Invitasjonen er ikke gyldig" });
  }
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, email, password_hash, invitation.role, invitation.client_id, invitation.company_id);

  db.prepare("UPDATE invitations SET status = 'used' WHERE id = ?").run(invitation.id);

  const user = {
    id: info.lastInsertRowid, name, role: invitation.role,
    client_id: invitation.client_id, company_id: invitation.company_id,
  };
  res.status(201).json({ token: issueToken(user), user });
});
