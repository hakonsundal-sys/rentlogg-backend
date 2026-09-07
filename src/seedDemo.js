// Resets and reseeds a self-contained demo company ("Rent-A-Clean AS") with realistic,
// presentable data — three clients with room-based checklists, a completed visit from
// yesterday (with a photo and signature) so "Vis rapport" has something to show immediately,
// an open avvik with a photo, a document, and report_recipients wired up for a live daily-
// digest demo. Safe to re-run before every sales call: it wipes only this one company's own
// data first, so it always starts from the exact same clean state, and never touches any other
// company (OKV Gruppen or otherwise).
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { newQrToken } from "./utils/qrcode.js";

const COMPANY_NAME = "Rent-A-Clean AS";
const DEMO_PASSWORD = "Demo1234!";
const REPORT_RECIPIENT_EMAIL = "hakon.sundal@gmail.com";
const UPLOADS_DIR = process.env.UPLOADS_DIR || "uploads";

// A tiny valid 1x1 PNG — placeholder demo "photo" content. Real files on disk (not just DB
// rows) so photo/report rendering never shows a broken image during a live demo.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function writeDemoPhoto(filename) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), PLACEHOLDER_PNG);
  return path.join("uploads", filename);
}

console.log(`Resetting demo data for "${COMPANY_NAME}"...`);

let company = db.prepare("SELECT * FROM companies WHERE name = ?").get(COMPANY_NAME);
if (!company) {
  const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run(COMPANY_NAME);
  company = { id: info.lastInsertRowid, name: COMPANY_NAME };
}
const companyId = company.id;

const wipe = db.transaction(() => {
  // Detach any existing demo customer login from its old client_id first — clients get deleted
  // below, and a dangling users.client_id FK would otherwise block that delete on every re-run.
  db.prepare("UPDATE users SET client_id = NULL WHERE company_id = ? AND role = 'customer'").run(companyId);

  const siteIds = db.prepare("SELECT id FROM sites WHERE company_id = ?").all(companyId).map((s) => s.id);
  const filesToDelete = [];

  if (siteIds.length) {
    const sitePh = siteIds.map(() => "?").join(",");
    const runIds = db.prepare(`SELECT id FROM checklist_runs WHERE site_id IN (${sitePh})`).all(...siteIds).map((r) => r.id);
    const roomIds = db.prepare(`SELECT id FROM rooms WHERE site_id IN (${sitePh})`).all(...siteIds).map((r) => r.id);
    const deviationIds = db.prepare(`SELECT id FROM deviations WHERE site_id IN (${sitePh})`).all(...siteIds).map((d) => d.id);
    let roomRunIds = [];
    if (roomIds.length) {
      const roomPh = roomIds.map(() => "?").join(",");
      roomRunIds = db.prepare(`SELECT id FROM room_runs WHERE room_id IN (${roomPh})`).all(...roomIds).map((r) => r.id);
    }

    if (runIds.length) {
      const ph = runIds.map(() => "?").join(",");
      filesToDelete.push(...db.prepare(`SELECT file_path FROM photos WHERE run_id IN (${ph})`).all(...runIds));
      db.prepare(`DELETE FROM photos WHERE run_id IN (${ph})`).run(...runIds);
      db.prepare(`DELETE FROM checklist_run_items WHERE run_id IN (${ph})`).run(...runIds);
    }
    if (roomRunIds.length) {
      const ph = roomRunIds.map(() => "?").join(",");
      filesToDelete.push(...db.prepare(`SELECT file_path FROM photos WHERE room_run_id IN (${ph})`).all(...roomRunIds));
      db.prepare(`DELETE FROM photos WHERE room_run_id IN (${ph})`).run(...roomRunIds);
      db.prepare(`DELETE FROM room_run_items WHERE room_run_id IN (${ph})`).run(...roomRunIds);
    }
    if (deviationIds.length) {
      const ph = deviationIds.map(() => "?").join(",");
      filesToDelete.push(...db.prepare(`SELECT file_path FROM photos WHERE deviation_id IN (${ph})`).all(...deviationIds));
      db.prepare(`DELETE FROM photos WHERE deviation_id IN (${ph})`).run(...deviationIds);
    }
    filesToDelete.push(...db.prepare(`SELECT file_path FROM site_documents WHERE site_id IN (${sitePh})`).all(...siteIds));

    db.prepare(`DELETE FROM deviations WHERE site_id IN (${sitePh})`).run(...siteIds);
    db.prepare(`DELETE FROM checklist_runs WHERE site_id IN (${sitePh})`).run(...siteIds);
    db.prepare(`DELETE FROM site_schedules WHERE site_id IN (${sitePh})`).run(...siteIds);
    db.prepare(`DELETE FROM site_documents WHERE site_id IN (${sitePh})`).run(...siteIds);
    if (roomIds.length) {
      const ph = roomIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM room_runs WHERE room_id IN (${ph})`).run(...roomIds);
      db.prepare(`DELETE FROM room_schedules WHERE room_id IN (${ph})`).run(...roomIds);
      db.prepare(`DELETE FROM room_checklist_items WHERE room_id IN (${ph})`).run(...roomIds);
    }
    db.prepare(`DELETE FROM rooms WHERE site_id IN (${sitePh})`).run(...siteIds);
    db.prepare(`DELETE FROM sites WHERE id IN (${sitePh})`).run(...siteIds);
  }

  db.prepare("DELETE FROM clients WHERE company_id = ?").run(companyId);
  db.prepare(
    "DELETE FROM checklist_template_items WHERE template_id IN (SELECT id FROM checklist_templates WHERE company_id = ?)"
  ).run(companyId);
  db.prepare("DELETE FROM checklist_templates WHERE company_id = ?").run(companyId);

  for (const f of filesToDelete) {
    if (f?.file_path) fs.rmSync(path.join(UPLOADS_DIR, path.basename(f.file_path)), { force: true });
  }
});
wipe();

function upsertUser(name, email, role, clientId = null) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE users SET name = ?, role = ?, client_id = ?, company_id = ? WHERE id = ?")
      .run(name, role, clientId, companyId, existing.id);
    return existing.id;
  }
  const password_hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash, role, client_id, company_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(name, email, password_hash, role, clientId, companyId);
  return info.lastInsertRowid;
}

const adminId = upsertUser("Demo Admin", "demo.admin@rentlogg.no", "admin");
const managerId = upsertUser("Demo Driftsleder", "demo.leder@rentlogg.no", "manager");
const cleanerId = upsertUser("Demo Renholder", "demo.renholder@rentlogg.no", "cleaner");
void managerId;
void adminId;

const DEMO_SITES = [
  {
    client: "Nordbris Kjøpesenter",
    address: "Torggata 12, 5014 Bergen",
    rooms: [
      { name: "Fellesarealer 1. etg", tasks: ["Vaske gulv", "Tømme søppelkasser", "Pusse glassdører"] },
      { name: "Fellesarealer 2. etg", tasks: ["Vaske gulv", "Tømme søppelkasser"] },
      { name: "Kundetoaletter", tasks: ["Vaske og desinfisere", "Fylle på papir/såpe", "Tømme søppel"] },
      { name: "Parkeringskjeller", tasks: ["Feie gulv", "Tømme søppel"] },
    ],
  },
  {
    client: "Fjordhotellet",
    address: "Strandgaten 45, 5004 Bergen",
    rooms: [
      { name: "Lobby og resepsjon", tasks: ["Støvsuge gulv", "Pusse overflater", "Vaske vinduer"] },
      { name: "Frokostrestaurant", tasks: ["Vaske bord og stoler", "Vaske gulv", "Tømme søppel"] },
      { name: "Korridorer 2. etasje", tasks: ["Støvsuge gulv", "Tørke av gelender"] },
      { name: "Fellestoaletter", tasks: ["Vaske og desinfisere", "Fylle på forbruksmateriell"] },
    ],
  },
  {
    client: "Vestkant Legesenter",
    address: "Vestre Torggate 3, 5015 Bergen",
    rooms: [
      { name: "Venterom", tasks: ["Desinfisere kontaktpunkter", "Støvsuge gulv", "Tømme søppel"] },
      { name: "Undersøkelsesrom 1", tasks: ["Desinfisere benk", "Vaske gulv"] },
      { name: "Undersøkelsesrom 2", tasks: ["Desinfisere benk", "Vaske gulv"] },
      { name: "Personalkjøkken", tasks: ["Vaske overflater", "Tømme oppvaskmaskin"] },
    ],
  },
];

const createdSites = DEMO_SITES.map((spec) => {
  const clientInfo = db
    .prepare("INSERT INTO clients (name, address, company_id) VALUES (?, ?, ?)")
    .run(spec.client, spec.address, companyId);
  const clientId = clientInfo.lastInsertRowid;

  const siteInfo = db
    .prepare(
      `INSERT INTO sites (name, client_id, company_id, address, qr_token, gps_radius_meters, status, room_count)
       VALUES (?, ?, ?, ?, ?, 150, 'ok', ?)`
    )
    .run(spec.client, clientId, companyId, spec.address, newQrToken(), spec.rooms.length);
  const siteId = siteInfo.lastInsertRowid;

  const rooms = spec.rooms.map((room, i) => {
    const roomInfo = db
      .prepare("INSERT INTO rooms (site_id, name, sort_order, interval_days) VALUES (?, ?, ?, 1)")
      .run(siteId, room.name, i);
    const roomId = roomInfo.lastInsertRowid;
    room.tasks.forEach((label, j) => {
      db.prepare("INSERT INTO room_checklist_items (room_id, label, sort_order) VALUES (?, ?, ?)").run(roomId, label, j);
    });
    return { id: roomId, name: room.name };
  });

  return { id: siteId, clientId, clientName: spec.client, name: spec.client, rooms };
});

const customerId = upsertUser("Demo Kunde", "demo.kunde@rentlogg.no", "customer", createdSites[0].clientId);
void customerId;

// Yesterday's completed visit on site 0 — every room checked off and signed, one photo, so
// "Vis rapport" / "Last ned PDF" has real content the moment the demo starts.
const site0 = createdSites[0];
db.prepare(
  `INSERT INTO checklist_runs (site_id, cleaner_id, started_at, completed_at, gps_verified, signed_initials)
   VALUES (?, ?, datetime('now','-1 day','-2 hours'), datetime('now','-1 day'), 1, 'Demo Renholder')`
).run(site0.id, cleanerId);

site0.rooms.forEach((room, i) => {
  const items = db.prepare("SELECT * FROM room_checklist_items WHERE room_id = ? ORDER BY sort_order").all(room.id);
  const roomRunInfo = db
    .prepare(
      `INSERT INTO room_runs (room_id, cleaner_id, started_at, completed_at, signed_initials)
       VALUES (?, ?, datetime('now','-1 day','-2 hours'), datetime('now','-1 day'), 'Demo Renholder')`
    )
    .run(room.id, cleanerId);
  const roomRunId = roomRunInfo.lastInsertRowid;
  items.forEach((item, j) => {
    db.prepare("INSERT INTO room_run_items (room_run_id, label, done, sort_order) VALUES (?, ?, 1, ?)").run(roomRunId, item.label, j);
  });
  if (i === 0) {
    const filePath = writeDemoPhoto(`demo-${Date.now()}-${roomRunId}.png`);
    db.prepare("INSERT INTO photos (room_run_id, file_path, kind) VALUES (?, ?, 'general')").run(roomRunId, filePath);
  }
});

db.prepare("UPDATE sites SET last_cleaned_at = datetime('now','-1 day'), report_recipients = ? WHERE id = ?").run(
  REPORT_RECIPIENT_EMAIL,
  site0.id
);

// An open, high-priority avvik with a photo on site 1, so the avvik workflow (report, reply,
// resolve) has something real to click through too.
const site1 = createdSites[1];
const avvikRoom = site1.rooms[0];
const devInfo = db
  .prepare(
    `INSERT INTO deviations (site_id, room_id, room_task_label, reported_by, reported_by_initials, description, priority, status, created_at)
     VALUES (?, ?, ?, ?, 'Demo Renholder', ?, 'high', 'open', datetime('now','-3 hours'))`
  )
  .run(site1.id, avvikRoom.id, avvikRoom.name, cleanerId, "Knust vindu i lobbyen — trenger reparasjon før i morgen.");
const devPhotoPath = writeDemoPhoto(`demo-${Date.now()}-avvik.png`);
db.prepare("INSERT INTO photos (deviation_id, file_path, kind) VALUES (?, ?, 'general')").run(devInfo.lastInsertRowid, devPhotoPath);
db.prepare("UPDATE sites SET status = 'deviation' WHERE id = ?").run(site1.id);

// A document on site 0 (visible to both staff and customer), to show off the document library.
const docPath = writeDemoPhoto(`demo-${Date.now()}-kart.png`);
db.prepare("INSERT INTO site_documents (site_id, name, file_path, visibility) VALUES (?, ?, ?, 'both')").run(
  site0.id,
  "Kart over lokalene",
  docPath
);

console.log(`\nDemo-data klar for "${COMPANY_NAME}"!\n`);
console.log(`Innlogginger (passord: ${DEMO_PASSWORD}):`);
console.log("  demo.admin@rentlogg.no       (admin)");
console.log("  demo.leder@rentlogg.no       (driftsleder)");
console.log("  demo.renholder@rentlogg.no   (renholder)");
console.log(`  demo.kunde@rentlogg.no       (kunde — ${site0.clientName})`);
console.log("\nKunder/lokasjoner:");
createdSites.forEach((s) => console.log(`  ${s.clientName} (${s.rooms.length} rom)`));
console.log(`\n${site0.name}: fullført besøk i går med bilde og signatur — klart for "Vis rapport"/"Last ned PDF".`);
console.log(`${site0.name}: har et dokument ("Kart over lokalene") og rapport-mottakere satt til ${REPORT_RECIPIENT_EMAIL}.`);
console.log(`${site1.name}: har et åpent, høyt prioritert avvik med bilde.`);
console.log(`${createdSites[2].name}: helt fersk lokasjon, ingenting gjort ennå — god for å vise selve renholder-flyten live.`);
