import "dotenv/config";
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

function upsertUser(name, email, password, role, client_id = null) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return existing.id;
  const password_hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, password_hash, role, client_id);
  return info.lastInsertRowid;
}

console.log("Seeding demo data...");

const templateIds = {};
for (const [name, items] of Object.entries(TEMPLATES)) {
  const existing = db.prepare("SELECT id FROM checklist_templates WHERE name = ?").get(name);
  const id = existing
    ? existing.id
    : db.prepare("INSERT INTO checklist_templates (name) VALUES (?)").run(name).lastInsertRowid;
  templateIds[name] = id;
  if (!existing) {
    const insertItem = db.prepare("INSERT INTO checklist_template_items (template_id, label, sort_order) VALUES (?, ?, ?)");
    items.forEach((label, i) => insertItem.run(id, label, i));
  }
}

const clientIds = CLIENT_NAMES.map((name) => {
  const existing = db.prepare("SELECT id FROM clients WHERE name = ?").get(name);
  return existing ? existing.id : db.prepare("INSERT INTO clients (name) VALUES (?)").run(name).lastInsertRowid;
});

const templateCycle = Object.values(templateIds);
clientIds.forEach((clientId, i) => {
  const existing = db.prepare("SELECT id FROM sites WHERE client_id = ?").get(clientId);
  if (existing) return;
  db.prepare(
    `INSERT INTO sites (name, client_id, checklist_template_id, qr_token, status)
     VALUES (?, ?, ?, ?, 'overdue')`
  ).run(`Lokasjon ${i + 1}`, clientId, templateCycle[i % templateCycle.length], newQrToken());
});

upsertUser("Admin", "admin@rentlogg.no", "admin1234", "admin");
upsertUser("Ola Driftsleder", "manager@rentlogg.no", "manager1234", "manager");
upsertUser("Kari Renholder", "cleaner@rentlogg.no", "cleaner1234", "cleaner");
upsertUser("Kunde Martens", "kunde@rentlogg.no", "kunde1234", "customer", clientIds[0]);

console.log("Done. Demo logins:");
console.log("  admin@rentlogg.no / admin1234");
console.log("  manager@rentlogg.no / manager1234");
console.log("  cleaner@rentlogg.no / cleaner1234");
console.log("  kunde@rentlogg.no / kunde1234 (Bakehuset Martens)");
