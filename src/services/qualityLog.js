import { db } from "../db.js";

// Writes to quality_log (see schema.sql for why the table exists and what its columns mean).
//
// This function deliberately does NOT swallow its errors, which is the opposite of how the rest
// of the app treats side effects like sending mail or resizing an image. Those are conveniences;
// this is the record that a piece of documentation was changed or removed. A delete that cannot
// be logged must not happen, so every caller invokes this INSIDE the same transaction as the
// change it describes — a throw here rolls the change back, and the user gets an error instead of
// silently losing evidence nobody can account for afterwards.
//
// The most likely real failure is a full disk, which is exactly the situation where quietly
// dropping the log would be worst: uploads have started failing, somebody is deleting photos to
// free space, and that is the moment the trail would go dark.

const insertStmt = db.prepare(
  `INSERT INTO quality_log
     (company_id, subject_type, subject_id, site_id, room_id, occurred_at, offline,
      user_id, user_name, action, before_value, after_value, comment)
   VALUES
     (@companyId, @subjectType, @subjectId, @siteId, @roomId, @occurredAt, @offline,
      @userId, @userName, @action, @beforeValue, @afterValue, @comment)`
);

// An action the client says happened earlier than the server heard about it — a cleaner's phone
// replaying its offline queue. Anything further back than this is treated as a clock that cannot
// be trusted rather than a genuinely old action, and falls back to server time: a device whose
// date is set to 2019 must not be able to file today's work under 2019.
const MAX_OFFLINE_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

// Normalises a client-supplied occurredAt into the app's own storage format (SQLite's
// "YYYY-MM-DD HH:MM:SS" in UTC, matching datetime('now') everywhere else). Returns null when the
// client sent nothing usable, which means "the server's own clock is the best we have".
function normaliseOccurredAt(occurredAt) {
  if (!occurredAt) return null;
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.getTime())) return null;
  const drift = Date.now() - parsed.getTime();
  // A future timestamp is as untrustworthy as an ancient one; allow a minute of clock skew.
  if (drift < -60_000 || drift > MAX_OFFLINE_BACKDATE_MS) return null;
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

export function logQualityEvent({
  user,
  action,
  subjectType,
  subjectId,
  siteId = null,
  roomId = null,
  occurredAt = null,
  beforeValue = null,
  afterValue = null,
  comment = null,
}) {
  const clientTime = normaliseOccurredAt(occurredAt);
  insertStmt.run({
    companyId: user.company_id,
    subjectType,
    subjectId: Number(subjectId),
    siteId: siteId == null ? null : Number(siteId),
    roomId: roomId == null ? null : Number(roomId),
    // Falling back to the server's clock keeps occurred_at NOT NULL honest: it always holds the
    // best available answer to "when did this happen", and `offline` says which kind it is.
    occurredAt: clientTime || new Date().toISOString().slice(0, 19).replace("T", " "),
    offline: clientTime ? 1 : 0,
    userId: user.id,
    // Snapshot beside the id, same reason edited_by_initials and approved_by_name are: the log has
    // to still name who did this after the account is deleted.
    userName: user.name || null,
    action,
    beforeValue,
    afterValue,
    comment,
  });
}
