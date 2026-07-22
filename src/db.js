import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = process.env.DB_FILE || "./data/rentlogg.db";
const dbDir = path.dirname(dbFile);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn("clients", "contact_name", "contact_name TEXT");
ensureColumn("clients", "phone", "phone TEXT");
ensureColumn("sites", "room_count", "room_count INTEGER DEFAULT 0");
ensureColumn("users", "avatar_url", "avatar_url TEXT");
ensureColumn("users", "phone", "phone TEXT");
ensureColumn("deviations", "title", "title TEXT");
ensureColumn("photos", "room_run_id", "room_run_id INTEGER REFERENCES room_runs(id)");
