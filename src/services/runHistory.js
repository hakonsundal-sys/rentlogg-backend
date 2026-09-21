// A visit's timeline, assembled from the timestamps the app already keeps rather than from a
// dedicated audit log: check-in, each room being opened/finished/approved, photos, avvik and
// their replies. That means it works on every visit ever recorded, including ones from long
// before this view existed — but also that its resolution is only as fine as those columns.
// What it deliberately cannot show (and what a real append-only event log would add later):
// individual task ticks, un-ticks, note edits, and any edit other than the most recent one,
// since room_runs/checklist_runs keep a single edited_at/edited_by_initials pair rather than a
// history of them.
//
// Events carry a `type` plus already-resolved names, never rendered text — the surfaces showing
// this are translated (see the frontend's i18n), so the wording belongs there, not here.

// Every timestamp in the database is UTC (SQLite's datetime('now'), or the noon-UTC stamp a
// backdated run gets) but is stored without a zone marker, so it has to be labelled as UTC on
// the way out — otherwise a browser formatting it in Europe/Oslo would shift it another hour or
// two and quietly report the wrong time of day.
function toIsoUtc(timestamp) {
  return timestamp ? `${timestamp.replace(" ", "T")}Z` : null;
}

export function buildRunHistory(detail) {
  const events = [];
  const add = (at, type, extra = {}) => {
    if (at) events.push({ at: toIsoUtc(at), type, ...extra });
  };

  if (detail.id) {
    add(detail.started_at, detail.backdated ? "visit_started_late" : "visit_started", { actor: detail.cleaner_name });
    add(detail.completed_at, "visit_completed", { actor: detail.signed_initials });
    add(detail.edited_at, "visit_edited", { actor: detail.edited_by_initials });
  }
  (detail.photos || []).forEach((photo) => add(photo.created_at, "photo_added"));

  (detail.rooms || []).forEach((room) => {
    add(room.started_at, "room_started", { room: room.name, actor: room.cleaner_name });
    add(room.ready_for_approval_at, "room_ready_for_approval", { room: room.name, actor: room.signed_initials });
    // On a gated room the customer's approval is what sets completed_at, so the two would land in
    // the same second and read as the room being finished twice — the cleaner's own sign-off is
    // already covered by the ready_for_approval event above.
    if (!(room.approved_at && room.requires_approval)) {
      add(room.completed_at, "room_completed", { room: room.name, actor: room.signed_initials });
    }
    add(room.approved_at, "room_approved", { room: room.name, actor: room.approved_by_initials });
    add(room.edited_at, "room_edited", { room: room.name, actor: room.edited_by_initials });
    (room.photos || []).forEach((photo) => add(photo.created_at, "photo_added", { room: room.name }));
  });

  (detail.deviations || []).forEach((deviation) => {
    add(deviation.created_at, "deviation_reported", {
      room: deviation.room_name,
      actor: deviation.reported_by_initials,
      detail: deviation.title || deviation.description,
    });
    add(deviation.replied_at, "deviation_replied", { room: deviation.room_name, actor: deviation.replied_by_initials });
    add(deviation.customer_approved_at, "deviation_approved", {
      room: deviation.room_name,
      actor: deviation.customer_approved_by_initials,
    });
    add(deviation.resolved_at, "deviation_resolved", { room: deviation.room_name });
  });

  // ISO strings in the same zone sort correctly as plain text.
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
