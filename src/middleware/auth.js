import jwt from "jsonwebtoken";
import { isModuleEnabled } from "../modules.js";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: "missing_token", error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch {
    res.status(401).json({ code: "invalid_token", error: "Invalid or expired token" });
  }
}

// Same check as requireAuth, but also accepts the token as ?token=... — needed only for the
// authenticated /uploads route, since a plain <img src="..."> or an <a> the user opens in a new
// tab can't attach an Authorization header the way apiFetch's fetch() calls can.
export function requireAuthQueryOrHeader(req, res, next) {
  const header = req.headers.authorization || "";
  const token = (header.startsWith("Bearer ") ? header.slice(7) : null) || req.query.token;
  if (!token) return res.status(401).json({ code: "missing_token", error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch {
    res.status(401).json({ code: "invalid_token", error: "Invalid or expired token" });
  }
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
