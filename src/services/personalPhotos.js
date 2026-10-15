import { db } from "../db.js";

// "Mine bilder": photos a cleaner takes for her own sake, to document something only she and the
// administrators should see — a damaged piece of equipment, a conversation she wants a trace of, the state
// she found a room in before she touched it. They belong to a PERSON, not to a location or a visit, which
// is why they are not in `photos`: nothing here is ever shown to a customer, printed in a report, e-mailed
// in the daily digest or put in a site's ZIP, and none of the places that gather a site's photos can pick
// them up by accident, because they never look in this table.
//
// Created here rather than in schema.sql so the feature owns its own table; `IF NOT EXISTS` makes
// running this on every boot a no-op once it exists. The file_path index is for /uploads, which looks a
// file up by name to decide who may read it.
db.exec(`
  CREATE TABLE IF NOT EXISTS personal_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    file_path TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_personal_photos_user ON personal_photos(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_personal_photos_path ON personal_photos(file_path);
`);

const insertStmt = db.prepare("INSERT INTO personal_photos (company_id, user_id, file_path, note) VALUES (?, ?, ?, ?)");
const getStmt = db.prepare(
  `SELECT p.*, u.name AS user_name FROM personal_photos p JOIN users u ON u.id = p.user_id WHERE p.id = ?`
);
const listOwnStmt = db.prepare(
  `SELECT p.*, u.name AS user_name FROM personal_photos p JOIN users u ON u.id = p.user_id
   WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 500`
);
const listCompanyStmt = db.prepare(
  `SELECT p.*, u.name AS user_name FROM personal_photos p JOIN users u ON u.id = p.user_id
   WHERE p.company_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 500`
);
const listCompanyUserStmt = db.prepare(
  `SELECT p.*, u.name AS user_name FROM personal_photos p JOIN users u ON u.id = p.user_id
   WHERE p.company_id = ? AND p.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 500`
);
const deleteStmt = db.prepare("DELETE FROM personal_photos WHERE id = ?");
const countForUserStmt = db.prepare("SELECT COUNT(*) AS n FROM personal_photos WHERE user_id = ?");

export function addPersonalPhoto({ companyId, userId, filePath, note }) {
  const id = insertStmt.run(companyId, userId, filePath, note || null).lastInsertRowid;
  return getStmt.get(id);
}
export const getPersonalPhoto = (id) => getStmt.get(id);
export const listOwnPersonalPhotos = (userId) => listOwnStmt.all(userId);
export const listCompanyPersonalPhotos = (companyId, userId = null) =>
  userId ? listCompanyUserStmt.all(companyId, userId) : listCompanyStmt.all(companyId);
export const deletePersonalPhoto = (id) => deleteStmt.run(id);
export const countPersonalPhotosForUser = (userId) => countForUserStmt.get(userId).n;
