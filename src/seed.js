import "dotenv/config";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { newQrToken } from "./utils/qrcode.js";

const CLIENT_NAMES = [
  "Bakehuset Martens", "Kaffebrenneriet Sentrum", "Bergen Tannklinikk",
  "Nordnes Barnehage", "Fjordkontor AS", "Sandviken Legesenter",
];

const TEMPLATES = {
  Kontor: ["Støvsuge gulv", "Tørke av overflater", "Tømme søppel", "Vaske toalett", "Fylle på papir/såpe"],
  Produksjon: ["Vaske gulv", "Desinfisere arbeidsflater", "Kontrollere avløp", "Tømme søppel", "Sjekke ventilasjon"],
  Helse: ["Desinfisere kontaktpunkter", "Vaske gulv", "Skifte håndklær", "Tømme søppel", "Kontrollere hånddesinfeksjon"],
};

// Multi-tenancy (2026-09-07) added company_id everywhere — this seed predates that, so every
// row it creates needs to land in a real company or it's invisible to everyone (WHERE
// company_id = ? never matches NULL). OKV Gruppen is the one company this original seed data
// has always belonged to; find-or-create it the same way seedDemo.js does for its own company.
const COMPANY_NAME = "OKV Gruppen";
let company = db.prepare("SELECT * FROM companies WHERE name = ?").get(COMPANY_NAME);
if (!company) {
  const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run(COMPANY_NAME);
  company = { id: info.lastInsertRowid, name: COMPANY_NAME };
}
const companyId = company.id;

// Seed passwords used to be literals here (and in the README), which meant any deployment that
// ran `npm run seed` shipped with publicly known admin credentials. They now come from the
// environment, and anything unset gets a random one printed once below — so a fresh seed is never
// guessable, and nothing worth knowing lives in the repo.
const generatedPasswords = [];
function seedPassword(envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const generated = randomBytes(12).toString("base64url");
  generatedPasswords.push([envVar, generated]);
  return generated;
}

function upsertUser(name, email, password, role, client_id = null) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return existing.id;
  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, email, password_hash, role, client_id, companyId);
  return info.lastInsertRowid;
}

console.log("Seeding demo data...");

const templateIds = {};
for (const [name, items] of Object.entries(TEMPLATES)) {
  const existing = db.prepare("SELECT id FROM checklist_templates WHERE name = ? AND company_id = ?").get(name, companyId);
  const id = existing
    ? existing.id
    : db.prepare("INSERT INTO checklist_templates (name, company_id) VALUES (?, ?)").run(name, companyId).lastInsertRowid;
  templateIds[name] = id;
  if (!existing) {
    const insertItem = db.prepare("INSERT INTO checklist_template_items (template_id, label, sort_order) VALUES (?, ?, ?)");
    items.forEach((label, i) => insertItem.run(id, label, i));
  }
}

const clientIds = CLIENT_NAMES.map((name) => {
  const existing = db.prepare("SELECT id FROM clients WHERE name = ? AND company_id = ?").get(name, companyId);
  return existing ? existing.id : db.prepare("INSERT INTO clients (name, company_id) VALUES (?, ?)").run(name, companyId).lastInsertRowid;
});

const templateCycle = Object.values(templateIds);
clientIds.forEach((clientId, i) => {
  const existing = db.prepare("SELECT id FROM sites WHERE client_id = ?").get(clientId);
  if (existing) return;
  db.prepare(
    `INSERT INTO sites (name, client_id, company_id, checklist_template_id, qr_token, status)
     VALUES (?, ?, ?, ?, ?, 'overdue')`
  ).run(`Lokasjon ${i + 1}`, clientId, companyId, templateCycle[i % templateCycle.length], newQrToken());
});

upsertUser("Admin", "admin@rentlogg.no", seedPassword("SEED_ADMIN_PASSWORD"), "admin");
upsertUser("Ola Driftsleder", "manager@rentlogg.no", seedPassword("SEED_MANAGER_PASSWORD"), "manager");
upsertUser("Kari Renholder", "cleaner@rentlogg.no", seedPassword("SEED_CLEANER_PASSWORD"), "cleaner");
upsertUser("Kunde Martens", "kunde@rentlogg.no", seedPassword("SEED_CUSTOMER_PASSWORD"), "customer", clientIds[0]);

console.log("Done. Demo logins:");
console.log("  admin@rentlogg.no    (admin)");
console.log("  manager@rentlogg.no  (driftsleder)");
console.log("  cleaner@rentlogg.no  (renholder)");
console.log("  kunde@rentlogg.no    (kunde — Bakehuset Martens)");
if (generatedPasswords.length) {
  // upsertUser is a no-op for an account that already exists, so a password printed here is only
  // real for a user this run actually created — re-seeding an existing database prints fresh
  // strings that were never stored. Write them down now; they can't be recovered afterwards.
  console.log("\nGenerated passwords (stored nowhere else — set the matching env var to choose your own):");
  for (const [envVar, value] of generatedPasswords) console.log(`  ${envVar}=${value}`);
}
