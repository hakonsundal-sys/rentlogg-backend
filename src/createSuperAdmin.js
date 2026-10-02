// Creates a super_admin (Rentlogg's own operator account, no company) from a shell.
//
//   npm run superadmin -- "Navn Navnesen" navn@example.no
//
// The password comes from SUPERADMIN_PASSWORD, or is generated and printed once. It replaces the
// old open POST /auth/register, which anyone could call while no super_admin existed — this needs
// a shell on the machine that holds the database, not just its URL.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { db } from "./db.js";

const [name, rawEmail] = process.argv.slice(2);
const email = String(rawEmail || "").trim().toLowerCase();
if (!name || !email.includes("@")) {
  console.error('Bruk: npm run superadmin -- "Navn" e-post');
  process.exit(1);
}

if (db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
  console.error(`Det finnes allerede en bruker med ${email}. Ingenting er endret.`);
  process.exit(1);
}

const generated = !process.env.SUPERADMIN_PASSWORD;
const password = process.env.SUPERADMIN_PASSWORD || randomBytes(12).toString("base64url");
if (password.length < 12) {
  console.error("Passordet må være minst 12 tegn.");
  process.exit(1);
}

const info = db
  .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, 'super_admin', NULL, NULL)")
  .run(name, email, bcrypt.hashSync(password, 10));

console.log(`Superadmin opprettet: id ${info.lastInsertRowid}, ${email}`);
if (generated) console.log(`Passord (vises bare nå): ${password}`);
