import jwt from "jsonwebtoken";
import { db } from "../db.js";
import { isModuleEnabled } from "../modules.js";

const TOKEN_LIFETIME = "12h";

// The one place a login token is minted. `tv` is the user's token_version at that moment; bumping
// the column later (a password change, a reset, a deactivation) makes every token carrying an older
// number stop working at once, instead of living out its 12 hours.
export function issueToken(user) {
  return jwt.sign(
    {
      id: user.id, name: user.name, role: user.role,
      client_id: user.client_id, company_id: user.company_id,
      tv: user.token_version ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

export const bumpTokenVersion = (userId) =>
  db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(userId);

const userStateStmt = db.prepare("SELECT role, client_id, company_id, active, token_version FROM users WHERE id = ?");

// A valid signature only says the token was once issued; this also asks whether the account still
// stands as the token claims. Without it a deactivated employee, a stolen phone or a demoted admin
// kept full access until the token expired. Role and tenant are taken from the database, not the
// token, so a demotion applies on the very next request. One indexed lookup per request.
//
// Tokens issued before this existed carry no `tv`, which counts as 0 — the column's default — so
// sessions already open at deploy time keep working until something actually revokes them.
function authenticate(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
  const row = userStateStmt.get(payload.id);
  if (!row || !row.active) return null;
  if ((payload.tv ?? 0) !== row.token_version) return null;
  return { ...payload, role: row.role, client_id: row.client_id, company_id: row.company_id };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: "missing_token", error: "Missing token" });

  const user = authenticate(token);
  if (!user) return res.status(401).json({ code: "invalid_token", error: "Invalid or expired token" });
  req.user = user;
  next();
}

// Same check as requireAuth, but also accepts the token as ?token=... — needed only for the
// authenticated /uploads route, since a plain <img src="..."> or an <a> the user opens in a new
// tab can't attach an Authorization header the way apiFetch's fetch() calls can.
export function requireAuthQueryOrHeader(req, res, next) {
  const header = req.headers.authorization || "";
  const token = (header.startsWith("Bearer ") ? header.slice(7) : null) || req.query.token;
  if (!token) return res.status(401).json({ code: "missing_token", error: "Missing token" });

  const user = authenticate(token);
  if (!user) return res.status(401).json({ code: "invalid_token", error: "Invalid or expired token" });
  req.user = user;
  next();
}

// Gates a whole add-on module's routes on the caller's company having it turned on (see
// src/modules.js). Applied at the mount in server.js rather than per route, so a module can never
// grow a route that forgot the check. Runs after requireAuth — it needs req.user.company_id.
export function requireModule(key) {
  return (req, res, next) => {
    if (!isModuleEnabled(req.user?.company_id, key)) {
      return res.status(403).json({ code: "module_not_enabled", error: "Denne modulen er ikke aktivert for firmaet." });
    }
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ code: "role_not_allowed", error: "Not allowed for this role" });
    }
    next();
  };
}
