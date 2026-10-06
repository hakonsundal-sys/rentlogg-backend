import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureIndexes } from "./dbIndexes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE || "./data/rentlogg.db";
const dbDir = path.dirname(dbFile);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
// NORMAL is the recommended pairing with WAL: a commit no longer waits for an fsync of its own, only
// the WAL checkpoint does. Measured 0.69 ms -> 0.03 ms per commit locally, and every commit blocks
// the one thread all users share. Cost: on a power cut or OS crash (not an app crash) the last few
// transactions can be lost, never corrupted — and the nightly backup exists for exactly that case.
db.pragma("synchronous = NORMAL");
// A long-running reader can stop the WAL file from being reset; cap how big it is allowed to stay.
db.pragma("journal_size_limit = 67108864");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// A CHECK constraint can't be altered with ADD COLUMN, so an existing database (created before
// the super_admin role existed) needs a one-time table rebuild to accept it. Guarded by reading
// the table's own stored SQL rather than a version flag, so it's safe to run on every boot and
// a no-op on both fresh databases (schema.sql already includes super_admin) and already-migrated
// ones.
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || "";
if (!usersSql.includes("super_admin")) {
  // legacy_alter_table stops the RENAME below from rewriting every other table's stored FK text
  // (checklist_runs.cleaner_id, deviations.reported_by, site_schedules.assigned_cleaner_id, ...)
  // to point at "users_old" — without it, SQLite silently repoints them on rename, and then the
  // final DROP TABLE users_old fails with a foreign key violation because those tables still
  // reference it. With it off, every other table's "REFERENCES users(id)" is left untouched and
  // simply resolves correctly again once the new "users" table exists under the same name.
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    ALTER TABLE users RENAME TO users_old;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager', 'cleaner', 'customer')),
      client_id INTEGER REFERENCES clients(id),
      avatar_url TEXT,
      phone TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, name, email, password_hash, role, client_id, avatar_url, phone, created_at)
      SELECT id, name, email, password_hash, role, client_id, avatar_url, phone, created_at FROM users_old;
    DROP TABLE users_old;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

ensureColumn("clients", "contact_name", "contact_name TEXT");
ensureColumn("clients", "phone", "phone TEXT");
ensureColumn("clients", "address", "address TEXT");
ensureColumn("sites", "room_count", "room_count INTEGER DEFAULT 0");
ensureColumn("users", "avatar_url", "avatar_url TEXT");
ensureColumn("users", "phone", "phone TEXT");
// Preferred UI language ('no'/'en'/'lt'/'lv'/'ru' — see utils/languages.js). NULL means the
// account never chose one and gets Norwegian; kept distinct from an explicit 'no' so a future
// "pick your language" prompt can tell the two apart. No CHECK constraint, matching every other
// ensureColumn'd field here — validated in the route instead.
ensureColumn("users", "language", "language TEXT");
ensureColumn("deviations", "title", "title TEXT");
ensureColumn("photos", "room_run_id", "room_run_id INTEGER REFERENCES room_runs(id)");
ensureColumn("rooms", "monthly_weekday", "monthly_weekday INTEGER");
ensureColumn("rooms", "monthly_occurrence", "monthly_occurrence INTEGER");
// Which party is responsible for this room — 'company' (the cleaning company, e.g. OKV) or
// 'customer' (that site's own client, who fills out this room's checklist themselves). A site
// can mix both: a cleaner's live "Dagens plan" only ever shows 'company' rooms, and a customer
// can only fill out (not just view) rooms marked 'customer' for their own client. No CHECK
// constraint (matches every other ensureColumn'd field in this file) — validated in the route.
ensureColumn("rooms", "responsible", "responsible TEXT DEFAULT 'company'");
ensureColumn("checklist_runs", "signed_initials", "signed_initials TEXT");
ensureColumn("room_runs", "signed_initials", "signed_initials TEXT");
ensureColumn("deviations", "room_id", "room_id INTEGER REFERENCES rooms(id)");
ensureColumn("deviations", "room_task_label", "room_task_label TEXT");
ensureColumn("deviations", "reported_by_initials", "reported_by_initials TEXT");
ensureColumn("deviations", "reply_text", "reply_text TEXT");
ensureColumn("deviations", "replied_by_initials", "replied_by_initials TEXT");
ensureColumn("deviations", "replied_at", "replied_at TEXT");
ensureColumn("deviations", "assigned_to", "assigned_to TEXT");
ensureColumn("deviations", "customer_approved_at", "customer_approved_at TEXT");
ensureColumn("deviations", "customer_approved_by_initials", "customer_approved_by_initials TEXT");

// Avviksbehandling i fire steg.
//
// `reply_text` finnes fortsatt og er den uformelle dialogen på saken. Det disse feltene legger
// til er strukturen et tilsyn faktisk spør etter, og som en fritekstlinje ikke kan svare på:
//
//   1. meldt            — hva skjedde (description, bilde, prioritet — fantes fra før)
//   2. strakstiltak     — hva ble gjort umiddelbart for å gjøre det trygt
//   3. årsak            — hvorfor skjedde det
//   4. korrigerende     — hva hindrer at det skjer igjen, og en signatur på lukkingen
//
// Hvert steg bærer sitt eget tidspunkt og sine egne initialer. Et avvik der alle fire står
// utfylt med hver sin signatur er forskjellen på «vi fikset det» og dokumentasjon.
ensureColumn("deviations", "immediate_action", "immediate_action TEXT");
ensureColumn("deviations", "immediate_action_at", "immediate_action_at TEXT");
ensureColumn("deviations", "immediate_action_by", "immediate_action_by TEXT");
ensureColumn("deviations", "root_cause", "root_cause TEXT");
ensureColumn("deviations", "root_cause_at", "root_cause_at TEXT");
ensureColumn("deviations", "root_cause_by", "root_cause_by TEXT");
ensureColumn("deviations", "corrective_action", "corrective_action TEXT");
ensureColumn("deviations", "corrective_action_at", "corrective_action_at TEXT");
ensureColumn("deviations", "corrective_action_by", "corrective_action_by TEXT");
// Signaturen på lukkingen. Egen fra `resolved_at`, som bare er en statusendring noen kan ha
// gjort i forbifarten — dette er et navn noen har skrevet under med.
ensureColumn("deviations", "closed_signature", "closed_signature TEXT");
ensureColumn("deviations", "closed_at", "closed_at TEXT");

// Kategori og frist. De to feltene styresaken ber om som ikke fantes, og de som gjør
// trendanalyse mulig i det hele tatt: «gjentakende avvik» og «avvik per type» kan ikke regnes
// ut av fritekst.
//
// NULLBAR MED VILJE, og den skal ikke etterfylles maskinelt. Et avvik meldt før kategoriene
// fantes ble ikke kategorisert, og å gjette seg til en verdi i ettertid ville satt en påstand
// inn i dokumentasjonen som ingen har tatt stilling til. Blindsonen i statistikken er ekte, og
// den skal være synlig som «Ikke satt» heller enn skjult bak en antakelse.
ensureColumn("deviations", "category", "category TEXT");
// ISO-dato (YYYY-MM-DD), ikke tidsstempel: en frist på et avvik er en dag, ikke et klokkeslett.
ensureColumn("deviations", "due_date", "due_date TEXT");
ensureColumn("room_runs", "edited_at", "edited_at TEXT");
ensureColumn("room_runs", "edited_by_initials", "edited_by_initials TEXT");
ensureColumn("checklist_runs", "edited_at", "edited_at TEXT");
ensureColumn("checklist_runs", "edited_by_initials", "edited_by_initials TEXT");
ensureColumn("sites", "report_recipients", "report_recipients TEXT");
// Null = use the scheduler's default (07:00 Europe/Oslo) — only sites that need something else
// (e.g. a customer whose report should land after their own morning routine) set this.
ensureColumn("sites", "report_send_hour", "report_send_hour INTEGER");
ensureColumn("users", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("clients", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("sites", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("checklist_templates", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("invitations", "company_id", "company_id INTEGER REFERENCES companies(id)");
ensureColumn("sites", "department_id", "department_id INTEGER REFERENCES departments(id)");
ensureColumn("checklist_runs", "note", "note TEXT");
ensureColumn("room_runs", "note", "note TEXT");
// Per-item schedule override: null (the common case) means "due every time the room is
// cleaned" — same default as before this existed. Set only for a task that's less frequent
// than the room itself (e.g. a daily-cleaned room with one monthly task). Reuses the same
// "Nth weekday of month" shape as rooms.monthly_weekday/monthly_occurrence: both set together
// means "only the Nth occurrence of that weekday in the month" ("Månedlig" mode). The weekly
// mode (one or more specific weekdays, every week) used to be encoded here too as
// monthly_weekday set with monthly_occurrence null (2026-09-21) — superseded below by
// room_checklist_item_weekdays, which supports more than one day per item; monthly_weekday is
// now null whenever an item is in weekly mode.
ensureColumn("room_checklist_items", "monthly_weekday", "monthly_weekday INTEGER");
ensureColumn("room_checklist_items", "monthly_occurrence", "monthly_occurrence INTEGER");
// interval_days ("annenhver uke" etc): mutually exclusive with monthly_weekday/monthly_occurrence
// (routes/rooms.js's PATCH clears one when the other is set, same as rooms.interval_days already
// does for room-level schedules). Originally left unbuilt because items had no reliable per-item
// completion history to measure "days since last done" against — resolved by the
// room_run_items.room_checklist_item_id link added below, which this reuses.
ensureColumn("room_checklist_items", "interval_days", "interval_days INTEGER");

// Måleoppgaver ("ATP-prøve linje 3: maks 150 RLU", "skyllevann: minst 82 °C").
//
// Fram til nå kunne Rentlogg ikke registrere et tall i det hele tatt — en oppgave var gjort
// eller ikke gjort, eventuelt med et valgt alternativ (flervalg). De eneste REAL-kolonnene i
// hele skjemaet var GPS-koordinater. Det er nok for kontorvask, men ikke for et
// næringsmiddelanlegg, der selve dokumentasjonen ER måleverdien mot en grenseverdi.
//
// `measure_unit` er markøren: er den satt, er oppgaven en måling. Samme implisitte mønster som
// flervalg, der en rad i room_checklist_item_options gjør oppgaven til et flervalg — ingen ny
// enum, og ingen migrering av eksisterende rader.
//
// Begge grensene er valgfrie og dekker alle tre formene uten et retningsfelt:
//   bare max → verdien skal være under  (ATP, kimtall)
//   bare min → verdien skal være over   (temperatur på skyllevann)
//   begge    → verdien skal være mellom (pH, konsentrasjon)
ensureColumn("room_checklist_items", "measure_unit", "measure_unit TEXT");
ensureColumn("room_checklist_items", "measure_min", "measure_min REAL");
ensureColumn("room_checklist_items", "measure_max", "measure_max REAL");

// Hygienetrinn. Et næringsmiddelanlegg vaskes i en fast sekvens — fjerne rester, rengjøre,
// skylle, desinfisere, skylle, kontroll — og en dokumentasjon som bare sier «utført» svarer ikke
// på hvilket trinn som ble utført. `step_type` navngir trinnet; selve rekkefølgen ligger
// allerede i `sort_order`, som er der «fra høy til lav risiko» bor.
//
// Nullable, og null betyr «vanlig oppgave». Kontorbygg skal ikke plutselig få hygienetrinn.
// Kjente verdier: residue | clean | rinse | disinfect | control (se STEP_TYPES i routes/rooms.js).
ensureColumn("room_checklist_items", "step_type", "step_type TEXT");

// Kontakttid og konsentrasjon hører til desinfeksjonstrinnet: «2 %, 10 minutter kontakttid».
// Uten kontakttiden er desinfeksjonen ikke dokumentert — midlet må stå på flaten lenge nok, og
// det er nettopp den tiden et tilsyn spør om. `contact_seconds` håndheves (se
// room_run_items.contact_started_at under); `concentration` er fritekst fordi den skrives som
// «2 %», «1:100» og «500 ppm» om hverandre i praksis.
ensureColumn("room_checklist_items", "contact_seconds", "contact_seconds INTEGER");
ensureColumn("room_checklist_items", "concentration", "concentration TEXT");

// Stable link back to the template item a given day's room_run_item was snapshotted from —
// room_run_items previously only carried a copy of the label, with no way to reliably tell
// "was this specific monthly task done this month" from history (a renamed item would silently
// break a label-based match). Nullable since it's only populated going forward; old rows stay
// label-only.
ensureColumn("room_run_items", "room_checklist_item_id", "room_checklist_item_id INTEGER REFERENCES room_checklist_items(id)");
// Set when a checklist_runs row was created after the fact (vaskeplan grid's "Sjekk inn i
// etterkant" on a day nobody actually scanned the site QR for) rather than by a real check-in —
// started_at is backdated to the day it represents either way, so this is the only way to tell
// the two apart later (report/log views surface it as a visible "entered late" notice).
ensureColumn("checklist_runs", "backdated", "backdated INTEGER DEFAULT 0");
// Which region/department a staff member belongs to — same company-wide tags (Vest/Sør/Øst/Midt)
// sites already use, assignable from the "Ansatte" admin page. Nullable/optional like sites'
// own department_id; a customer user has no use for this (departments are staff-only).
ensureColumn("users", "department_id", "department_id INTEGER REFERENCES departments(id)");
// Deactivating a user (from "Ansatte") blocks future logins without deleting them — keeps their
// name attached to their existing history (visits, avvik) intact, unlike a hard delete. A session
// already open is ended too: middleware/auth.js reads this flag on every request.
ensureColumn("users", "active", "active INTEGER NOT NULL DEFAULT 1");
// Which generation of login tokens is still honoured for this user. Every token carries the number
// it was issued under; a password change, an admin reset or a deactivation adds one, which makes
// all earlier tokens for that person invalid immediately (see issueToken/authenticate in
// middleware/auth.js). Existing rows start at 0, which is also what a token issued before this
// column existed counts as, so nobody is logged out by the migration itself.
ensureColumn("users", "token_version", "token_version INTEGER NOT NULL DEFAULT 0");

// Customer approval gate: a room can be flagged so a customer-side user must approve the
// cleaner's checklist before the room counts as complete (distinct from rooms.responsible, where
// the customer does the cleaning themselves — here OKV still cleans, the customer just signs off
// on it afterward). See room_runs'/room_run_items' own comments below for how the gate works.
ensureColumn("rooms", "requires_approval", "requires_approval INTEGER DEFAULT 0");
// Which part of the site a room belongs to — the source renholdsplan's own "Område" ("Fjøs",
// "Slakt storfe ren"). Purely a grouping label, never a schedule or a permission: a cleaner's
// day view splits a long room list into chapters by it, each with its own bulk-complete, which is
// what makes a 60-room site workable as one shared checklist. Null = the room is in no chapter
// and is listed on its own, so nothing changes for the sites that never set it.
ensureColumn("rooms", "area", "area TEXT");
// Set when a cleaner finishes a requires_approval room instead of completed_at (which stays
// unset until the customer actually approves — every existing completed_at reader in the app,
// reports/vaskeplan/history/dashboard, keeps meaning exactly what it always has: "genuinely
// done"). signed_initials is reused for the cleaner's own name at this point, same column as a
// non-gated room's completion already uses.
ensureColumn("room_runs", "ready_for_approval_at", "ready_for_approval_at TEXT");
ensureColumn("room_runs", "approved_at", "approved_at TEXT");
ensureColumn("room_runs", "approved_by_initials", "approved_by_initials TEXT");
// Parallel to room_run_items.done — the customer approver's own per-item sign-off, checked while
// reviewing the exact same list the cleaner just went through.
ensureColumn("room_run_items", "approved", "approved INTEGER DEFAULT 0");

// ── Etterkontroll: OKVs EGEN kontroll av eget arbeid ────────────────────────────────────────
//
// Dette er et SEPARAT spor fra kundegodkjenningen over, og det er hele poenget. `approved` er
// kundens signatur på at leveransen er akseptert. Dette er teamlederens kontroll av at den
// holder — gjort før kunden ser den, og av en annen grunn.
//
// Å slå dem sammen ville ødelagt begge: en revisor som spør «hvem kontrollerte dette?» skal
// ikke få «kunden godkjente det» til svar, og en kunde som godkjenner skal ikke dermed ha
// utført OKVs internkontroll. Produktet heter «Dokumentert etterkontroll» etter nettopp dette
// steget, og fram til nå fantes det bare som en nødutgang for en kunde man ikke fikk tak i.
//
// Tre tilstander, ikke to (styresakens krav): godkjent, mangler, kritisk avvik. Forskjellen
// mellom de to siste er alvorlighet, ikke relevans — derfor ikke samme sett som «Sjekk det»
// sitt ok/deviation/na, selv om formen er den samme. NULL betyr «ikke kontrollert ennå», som er
// en ekte og vanlig tilstand og ikke en feil.
ensureColumn("room_run_items", "control_status", "control_status TEXT");
// Påkrevd når statusen ikke er 'ok'. En mangel uten en setning om hva som manglet er ikke
// dokumentasjon, den er en påstand — samme regel som avvik i «Sjekk det».
ensureColumn("room_run_items", "control_comment", "control_comment TEXT");
ensureColumn("room_run_items", "control_at", "control_at TEXT");
ensureColumn("room_run_items", "control_by", "control_by INTEGER REFERENCES users(id)");
// Navnet skrives av, ikke slås opp. Samme konvensjon som signed_initials og de fire
// avvikstrinnene: dokumentasjonen skal vise hvem som sto for kontrollen den dagen, også etter
// at vedkommende har sluttet og brukeren er deaktivert.
ensureColumn("room_run_items", "control_by_name", "control_by_name TEXT");

// Selve signaturen på at hele rommet er etterkontrollert. Punktene over er vurderingene; dette
// er at noen setter navnet sitt under at kontrollen er gjennomført.
ensureColumn("room_runs", "controlled_at", "controlled_at TEXT");
ensureColumn("room_runs", "controlled_by", "controlled_by INTEGER REFERENCES users(id)");
ensureColumn("room_runs", "controlled_by_name", "controlled_by_name TEXT");

// Selve måleverdien, pluss en kopi av grensene som gjaldt da den ble tatt.
//
// Kopien er poenget, ikke duplisering av latskap: endrer noen grenseverdien på oppgaven i
// morgen, skal ikke gårsdagens godkjente prøve plutselig lyse rødt i en revisjon — den ble
// dømt mot 150 RLU, og det er 150 RLU den skal fortsette å bli vurdert mot. Samme grunn som
// `label` allerede ligger denormalisert på run-itemet.
ensureColumn("room_run_items", "measured_value", "measured_value REAL");
ensureColumn("room_run_items", "measured_at", "measured_at TEXT");
ensureColumn("room_run_items", "measure_unit", "measure_unit TEXT");
ensureColumn("room_run_items", "measure_min", "measure_min REAL");
ensureColumn("room_run_items", "measure_max", "measure_max REAL");

// Trinn, kontakttid og konsentrasjon kopieres ned på besøket av samme grunn som grensene over:
// endrer noen prosedyren i morgen, skal gårsdagens dokumentasjon fortsatt vise hva som faktisk
// gjaldt da — hvilket middel i hvilken styrke, og hvor lenge det skulle stå.
ensureColumn("room_run_items", "step_type", "step_type TEXT");
ensureColumn("room_run_items", "contact_seconds", "contact_seconds INTEGER");
ensureColumn("room_run_items", "concentration", "concentration TEXT");

// Når renholderen startet kontakttiden. Dette er det som gjør kontakttiden til dokumentasjon og
// ikke en påstand: oppgaven kan ikke kvitteres ut før det har gått `contact_seconds` siden dette
// tidspunktet, og tidspunktet ligger igjen i loggen. Klokka går på serveren, ikke på telefonen —
// en telefonklokke kan stilles.
ensureColumn("room_run_items", "contact_started_at", "contact_started_at TEXT");

// Et flervalg-alternativ kan peke på en rad i kjemikalieregisteret (se chemicals i schema.sql).
// Nullable: et alternativ som ikke er et kjemikalie — «mopp», «klut», «damp» — er fortsatt bare
// en tekst, og skal ikke tvinges inn i registeret.
ensureColumn("room_checklist_item_options", "chemical_id", "chemical_id INTEGER REFERENCES chemicals(id)");

// Og kopien som følger med ned på besøket, av samme grunn som alt annet her: byttes såpa eller
// endres doseringen neste år, skal fjorårets dokumentasjon fortsatt vise hva som faktisk ble
// brukt den dagen, i hvilken styrke.
ensureColumn("room_run_item_options", "chemical_name", "chemical_name TEXT");
ensureColumn("room_run_item_options", "chemical_strength", "chemical_strength TEXT");
ensureColumn("room_run_item_options", "chemical_safety_note", "chemical_safety_note TEXT");
// Lenken til sikkerhetsdatabladet følger med ned på samme måte. Forskrift om utførelse av arbeid
// § 2-4 krever at databladet er tilgjengelig «på det enkelte arbeidssted» — for en renholder er
// det telefonen hennes i bygget, ikke en fane i adminflata. Snapshotes som resten: byttes
// leverandørens lenke senere, skal fjorårets besøk fortsatt peke på det som gjaldt den dagen.
//
// NB: dette er en lenke, ikke databladet. Er dekningen borte, er databladet borte. Skal det
// virkelig holde, må PDF-en lagres — se kjemikalieregisteret i routes/chemicals.js.
ensureColumn("room_run_item_options", "chemical_sds_url", "chemical_sds_url TEXT");

// Bildespeilingens tall i samme rad som databasekopien. Egne kolonner og ikke en ny tabell:
// det er én nattlig kjøring, og to tabeller ville gjort «gikk det bra i natt?» til en join.
ensureColumn("backup_runs", "files_uploaded", "files_uploaded INTEGER");
ensureColumn("backup_runs", "files_remaining", "files_remaining INTEGER");

// Departments started out (2026-09-07) as a per-client sub-grouping with a NOT NULL client_id,
// before it turned out the actual need was an internal, company-wide region tag (Vest/Sør/Øst/
// Midt) independent of client — see schema.sql's comment on the table. A database created
// during that short window has the old client_id column; rebuild it away here. Guarded by
// reading the table's own stored SQL, so this is a no-op on both a fresh database (schema.sql
// already has the new shape) and one already migrated. Same legacy_alter_table dance as the
// users-role rebuild above, needed because sites/invitations still hold a plain
// "REFERENCES departments(id)" column that a RENAME would otherwise silently repoint.
const departmentsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'departments'").get()?.sql || "";
if (departmentsSql.includes("client_id")) {
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    ALTER TABLE departments RENAME TO departments_old;
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company_id INTEGER REFERENCES companies(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO departments (id, name, company_id, created_at)
      SELECT id, name, company_id, created_at FROM departments_old;
    DROP TABLE departments_old;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

// One-time backfill: any pre-existing database has real data with no company yet. Give it a
// home ("OKV Gruppen", the only company Rentlogg had before this became multi-tenant) rather
// than leaving it ownerless — a null company_id would otherwise make it invisible everywhere
// once every route starts filtering by company_id, as if the data had vanished.
if (db.prepare("SELECT COUNT(*) AS n FROM companies").get().n === 0) {
  const existingData = db.prepare("SELECT COUNT(*) AS n FROM sites").get().n;
  if (existingData > 0) {
    const info = db.prepare("INSERT INTO companies (name) VALUES (?)").run("OKV Gruppen");
    const companyId = info.lastInsertRowid;
    db.prepare("UPDATE users SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE clients SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE sites SET company_id = ? WHERE company_id IS NULL").run(companyId);
    db.prepare("UPDATE checklist_templates SET company_id = ? WHERE company_id IS NULL").run(companyId);
  }
}

// One-time: items using the old single-day "weekly" mode (monthly_weekday set, monthly_occurrence
// null — see room_checklist_items.monthly_weekday's comment above) move that one day into the new
// room_checklist_item_weekdays table, freeing monthly_weekday to mean only the true "Nth weekday of
// month" mode from here on. Naturally idempotent: once migrated, monthly_weekday is null, so the
// SELECT below finds nothing on later boots.
const oldWeeklyItems = db
  .prepare("SELECT id, monthly_weekday FROM room_checklist_items WHERE monthly_weekday IS NOT NULL AND monthly_occurrence IS NULL")
  .all();
if (oldWeeklyItems.length > 0) {
  const insertItemWeekday = db.prepare("INSERT OR IGNORE INTO room_checklist_item_weekdays (item_id, weekday) VALUES (?, ?)");
  const clearMonthlyWeekday = db.prepare("UPDATE room_checklist_items SET monthly_weekday = NULL WHERE id = ?");
  db.transaction(() => {
    for (const item of oldWeeklyItems) {
      insertItemWeekday.run(item.id, item.monthly_weekday);
      clearMonthlyWeekday.run(item.id);
    }
  })();
}

// Timeregistrering, per site. How a stamped shift at this location turns into payable hours:
// 'actual' (the default, and what every existing site gets by omission) counts the clock between
// stamp-in and stamp-out; 'fixed' pays the site's own rammetimetall instead, however long the
// person was actually there. time_fixed_minutes is that frame, in minutes — minutes rather than
// hours because half-hour frames are ordinary ("1,5 t") and storing 1.5 as a float would make the
// sums drift. Both are snapshotted onto each time_entry when it closes, so editing them later
// never rewrites an already-exported period. No CHECK constraint, matching the rest of this file.
ensureColumn("sites", "time_billing_mode", "time_billing_mode TEXT DEFAULT 'actual'");
ensureColumn("sites", "time_fixed_minutes", "time_fixed_minutes INTEGER");

// A drawn signature on top of the typed name, per course — see schema.sql's own comment on why it
// exists. Both tables already exist in every running database, so schema.sql alone would never add
// these: CREATE TABLE IF NOT EXISTS is a no-op once the table is there. Default 0 means every
// course that already exists keeps asking only for a name.
ensureColumn("training_courses", "requires_drawn_signature", "requires_drawn_signature INTEGER NOT NULL DEFAULT 0");
ensureColumn("training_records", "signature_path", "signature_path TEXT");
// A course can be a YouTube video instead of slides — the link on the course, and on the record the
// moment the player said it reached the end. Same reason as the two above: both tables exist
// already, so schema.sql alone would never add these.
ensureColumn("training_courses", "video_url", "video_url TEXT");
ensureColumn("training_records", "video_completed_at", "video_completed_at TEXT");

// The unpaid break she reports when stamping out. Deducted from the clock on an `actual` site;
// on a `fixed` site the rammetimetall is unchanged and this is recorded beside it.
ensureColumn("time_entries", "pause_minutes", "pause_minutes INTEGER NOT NULL DEFAULT 0");

// Godkjenning: a driftsleder confirming somebody's shift before it goes anywhere near payroll.
// Deliberately NOT the same thing as locking a period — approval is per shift and says "I have
// looked at this", the lock is per period and says "this has been exported, nobody touches it".
// The chain is: renholder stamps → driftsleder approves → admin locks and exports.
// approved_by_name is a snapshot beside the id for the same reason edited_by_initials is: the
// export has to still say who approved it after that person leaves the company.
ensureColumn("time_entries", "approved_at", "approved_at TEXT");
ensureColumn("time_entries", "approved_by", "approved_by INTEGER REFERENCES users(id)");
ensureColumn("time_entries", "approved_by_name", "approved_by_name TEXT");

// One-time: every stamping that closed before lønnsarter existed has no line, and would therefore
// vanish from the payroll export's line-level rows. Backfilled lazily by the module itself rather
// than here — see backfillMissingLines in services/timeEntries.js, which runs on the first listing
// per company and needs that company's default art to exist first. Nothing to do at boot.

// Prosjekt/ordre (see schema.sql). A site now hangs under an order, and a time entry carries the
// order it was booked on — inherited from the site when stamped, chosen by hand for internal time
// and absence, which have no building to stand in. Both nullable: every site and every entry that
// existed before orders did keeps working untouched until it is filed under one.
ensureColumn("sites", "order_id", "order_id INTEGER REFERENCES orders(id)");
ensureColumn("time_entries", "order_id", "order_id INTEGER REFERENCES orders(id)");
// A stamping normally has a site. An entry on an internal or absence order has none, so this is
// the column that had to become optional for "Før timer" to be possible at all.
ensureColumn("time_entries", "rejected_at", "rejected_at TEXT");
ensureColumn("time_entries", "rejected_by", "rejected_by INTEGER REFERENCES users(id)");
ensureColumn("time_entries", "rejected_by_name", "rejected_by_name TEXT");
ensureColumn("time_entries", "rejection_comment", "rejection_comment TEXT");
// Which bucket a lønnsart belongs in: 'arbeid' (counts toward "sum arbeidede timer"), 'fravær'
// (ferie, sykefravær — paid by payroll, but never worked hours) or 'tillegg'. Mobile Worker calls
// this "Timeart kategori"; without it, holiday silently lands in the same total as a night shift.
ensureColumn("time_types", "category", "category TEXT");
// Tillegg carry a rate in Mobile Worker ("Sats"), alongside the count. Informational here — no
// kroner are computed anywhere in Rentlogg — but it travels with the line to payroll.
ensureColumn("time_types", "rate", "rate REAL");
ensureColumn("time_entry_lines", "rate", "rate REAL");

// time_entries.site_id started life NOT NULL, back when every stamping was a QR scan at a building.
// Orders changed that: internal time, driving and absence are booked on an order with no site at
// all, and SQLite cannot drop a NOT NULL with ALTER TABLE. Same legacy_alter_table rebuild as the
// users-role and departments migrations above, with one difference — the new table is built from
// the OLD table's own stored SQL with the constraint edited out, rather than from a literal CREATE.
// That way every column added by ensureColumn since (order_id, approved_at, rejected_at, …) comes
// across automatically, and this migration cannot drift out of date as more are added.
const timeEntriesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'time_entries'").get()?.sql || "";
if (/site_id\s+INTEGER\s+NOT\s+NULL/i.test(timeEntriesSql)) {
  const rebuiltSql = timeEntriesSql.replace(/site_id\s+INTEGER\s+NOT\s+NULL/i, "site_id INTEGER");
  const columns = db
    .prepare("PRAGMA table_info(time_entries)")
    .all()
    .map((c) => `"${c.name}"`)
    .join(", ");

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    ALTER TABLE time_entries RENAME TO time_entries_old;
    ${rebuiltSql};
    INSERT INTO time_entries (${columns}) SELECT ${columns} FROM time_entries_old;
    DROP TABLE time_entries_old;
  `);
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

// Ansattnummer: the id payroll knows a person by. Unimicro matches employees on a number, not on a
// name, so an export without it cannot actually be imported — see the Timeregistrering module's CSV.
// Free text rather than an integer: OKV's numbers come out of the payroll system, and a leading
// zero or a letter prefix has to survive the round trip. Uniqueness is enforced per company in the
// route, not here, since a null must stay repeatable.
ensureColumn("users", "employee_number", "employee_number TEXT");

// Which team and which staff group a person belongs to — the two filters Mobile Worker's timesheet
// offers alongside Avdeling, which Rentlogg already had. Nullable: a company that never sets them
// up simply never sees the filters.
ensureColumn("users", "team_id", "team_id INTEGER REFERENCES teams(id)");
ensureColumn("users", "employee_group_id", "employee_group_id INTEGER REFERENCES employee_groups(id)");

// Hvem utførte dette, egentlig. signed_initials is free text the client types into the request
// body — nothing binds it to the account that made the call, so the name on a signed-off room is
// whatever was typed. For a checklist that was fine; for documentation an auditor leans on, the
// signature has to be attributable. signed_by/approved_by are that binding, taken from req.user
// and never from the body. signed_initials stays exactly as it is: it is the cleaner's own
// record of what they confirmed on the day, and rewriting history is the thing this whole line
// of work exists to prevent.
ensureColumn("room_runs", "signed_by", "signed_by INTEGER REFERENCES users(id)");
ensureColumn("checklist_runs", "signed_by", "signed_by INTEGER REFERENCES users(id)");
ensureColumn("room_runs", "approved_by", "approved_by INTEGER REFERENCES users(id)");
// Which side actually closed the approval gate. POST /rooms/runs/:id/approve lets an admin or
// manager approve in the customer's place when the customer is unreachable, and until now the
// stored record could not tell that apart from the customer approving themselves — so a report
// saying "Godkjent av Toril" might have been typed by an OKV admin. Confirmed 2026-09-24 that
// this does not happen in practice, which makes recording it a precision fix rather than a
// change of anybody's workflow, and makes the count meaningful: if it starts rising, the
// customer's own sign-off step has stopped working and we want to find that ourselves.
ensureColumn("room_runs", "approved_by_role", "approved_by_role TEXT");
// Why the emergency exit was used. Not yet required by the route — the frontend has to ask for it
// first, or an admin approval would start failing in production — but recorded whenever sent.
ensureColumn("room_runs", "approval_override_reason", "approval_override_reason TEXT");

// «Kun sjekkliste»: firmaet er ikke et renholdsfirma, og skal bare se Sjekklister-modulen — ingen
// kunder, lokasjoner, vaskeplan eller renholdsavvik. Rent visningsvalg i frontend; dataene og
// rutene er de samme, og et firma uten rom har uansett ingenting å vise der. Se src/modules.js.
ensureColumn("companies", "checklist_only", "checklist_only INTEGER NOT NULL DEFAULT 0");

// Sjekk det: målepunkter. Samme form som room_checklist_items (se måleoppgavene): measure_unit satt
// = punktet er en måling, grensene er valgfrie hver for seg. Grensene og enheten kopieres ned på
// svaret ved oppstart, så en grense som endres senere aldri flytter dommen over en gammel måling.
ensureColumn("simple_checklist_items", "measure_unit", "measure_unit TEXT");
ensureColumn("simple_checklist_items", "measure_min", "measure_min REAL");
ensureColumn("simple_checklist_items", "measure_max", "measure_max REAL");
ensureColumn("simple_checklist_answers", "measure_unit", "measure_unit TEXT");
ensureColumn("simple_checklist_answers", "measure_min", "measure_min REAL");
ensureColumn("simple_checklist_answers", "measure_max", "measure_max REAL");
ensureColumn("simple_checklist_answers", "measured_value", "measured_value REAL");
// Oppfølging av et avvik: hva lederen gjorde med det, og hvem. Skrives én gang og låses — en
// oppfølging som kan skrives om i etterkant er ikke dokumentasjon på at noe ble gjort.
ensureColumn("simple_checklist_answers", "followup_action", "followup_action TEXT");
ensureColumn("simple_checklist_answers", "followup_by", "followup_by INTEGER REFERENCES users(id)");
ensureColumn("simple_checklist_answers", "followup_by_name", "followup_by_name TEXT");
ensureColumn("simple_checklist_answers", "followup_at", "followup_at TEXT");

// Sjekk det, runde 3. Frist og antall per dag på lista: «innen kl. 09:00», «2 ganger daglig»
// (temperatur morgen og kveld). due_time er "HH:MM" i Europe/Oslo; times_per_day NULL betyr 1.
ensureColumn("simple_checklists", "due_time", "due_time TEXT");
ensureColumn("simple_checklists", "times_per_day", "times_per_day INTEGER");
// QR-kode per liste, laget første gang noen ber om den. Unik indeks her og ikke i schema.sql:
// schema.sql kjøres før ensureColumn, og på en eksisterende base finnes ikke kolonnen ennå da.
ensureColumn("simple_checklists", "qr_token", "qr_token TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_simple_checklists_qr ON simple_checklists(qr_token)");
// Punkt som ikke kan sendes inn uten bilde. Kopieres ned på svaret som resten av oppsettet.
ensureColumn("simple_checklist_items", "requires_photo", "requires_photo INTEGER NOT NULL DEFAULT 0");
ensureColumn("simple_checklist_answers", "requires_photo", "requires_photo INTEGER NOT NULL DEFAULT 0");

// Sjekk det, månedlige planer (se services/checklistSchedule.js). schedule_mode NULL = ukedager som
// før, så eksisterende lister er uendret. month_day: 1–31, eller -1 for siste dag i måneden.
ensureColumn("simple_checklists", "schedule_mode", "schedule_mode TEXT");
ensureColumn("simple_checklists", "month_day", "month_day INTEGER");

// Sjekk det, offline: en utfylling startet uten nett sendes inn i én forespørsel når telefonen får
// dekning (POST /simple-checklists/:id/submit-complete). client_key er telefonens egen nøkkel for
// utfyllingen; offline-køen kan sende samme forespørsel to ganger (svaret kom aldri fram), og
// nøkkelen er det som gjør at den andre bare får tilbake den første i stedet for et duplikat.
// client_completed_at er når den ble fylt ut på telefonen; submitted_at er når serveren fikk den.
ensureColumn("simple_checklist_submissions", "client_key", "client_key TEXT");
ensureColumn("simple_checklist_submissions", "completed_offline", "completed_offline INTEGER NOT NULL DEFAULT 0");
ensureColumn("simple_checklist_submissions", "client_completed_at", "client_completed_at TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_simple_checklist_submissions_client_key ON simple_checklist_submissions(company_id, client_key)");

// Lookup indexes for the hot read paths. Last, because several cover columns added by ensureColumn
// above — see the note at the top of dbIndexes.js.
ensureIndexes(db);
