import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";

// Who a request counts against. A verified user id when the caller sends a valid bearer token, the
// IP otherwise. Keyed on the user first because a whole office or a shift of cleaners can share one
// public IP, and an IP-only bucket would let one busy site starve the rest. A forged or expired
// token simply falls back to the IP bucket — it never buys a fresh allowance.
function callerKey(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    try {
      const user = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
      if (user?.id != null) return `user:${user.id}`;
    } catch {
      // Falls through to the IP key.
    }
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function limiter({ windowMs, limit, code, error }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: callerKey,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code, error },
  });
}

// A ceiling on everything behind the API, far above what a person can do by hand in a shift: a
// cleaner ticking tasks, opening rooms and taking photos stays well under it, a script hammering
// the API does not. It exists to bound abuse and accidents, not to ration normal use — so it is
// generous on purpose, and the routes that cost money below get their own, much tighter, limits.
export const apiLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 2000,
  code: "too_many_requests",
  error: "For mange forespørsler. Prøv igjen om litt.",
});

// Each call to the AI translation endpoint is a paid Anthropic request.
export const translationLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  code: "too_many_requests",
  error: "For mange oversettelser. Prøv igjen senere.",
});

// An AI PDF import is the most expensive call in the app, and an admin does it a handful of times
// when a site is set up, not repeatedly.
export const pdfImportLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  code: "too_many_requests",
  error: "For mange PDF-importer. Prøv igjen senere.",
});

// Sends real e-mail, with photos, to whatever addresses the request names.
export const digestRunLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  code: "too_many_requests",
  error: "For mange utsendinger. Prøv igjen senere.",
});

// Changing your own password checks the old one with bcrypt, which is deliberately slow. Without a
// limit of its own, the general ceiling (2000 per 15 minutes) let one logged-in user keep the server
// busy with it, and it also let a stolen session guess the current password at that rate.
export const passwordChangeLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  code: "too_many_requests",
  error: "For mange forsøk. Prøv igjen om litt.",
});

// Anonymous by nature, so it is bound by IP. Accepting an invitation is something a person does
// once; anyone guessing tokens does it many times.
export const invitationAcceptLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  code: "too_many_requests",
  error: "For mange forsøk. Prøv igjen om litt.",
});
