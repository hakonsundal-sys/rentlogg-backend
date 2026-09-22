// Transforms a parse_renholdsplan.ps1 output into the rooms[] shape the app's
// POST /sites/:siteId/rooms/import-confirm endpoint expects:
//   [{ name, tasks: [string], schedule: {weekdays:[0-6]} | null }]
//
// Policy (documented for the human review pass, not just this file):
// - A `lokale` name is disambiguated with " (<sheet>)" only when it repeats across sheets in the
//   same source file (real distinct rooms that happen to share a name, e.g. three separate
//   "Driftskontor" offices).
// - The app's schema only supports ONE schedule per room (weekday set, monthly, or interval),
//   not per checklist item (except a monthly override, which import-confirm doesn't set either).
//   Since a room's individual tasks often carry different frequencies in the source plan (most
//   5x/week, a couple 1x/week on a specific day, one 1x/month), the room's own schedule is set to
//   whichever weekday-set covers the MOST tasks in that room (the "default" cleaning pattern), and
//   every task whose own frequency differs from that gets a short suffix on its label instead
//   (e.g. "Garderobeskap (kun tirsdag)", "Reoler (1x/mnd)") so the information isn't silently
//   dropped, even though it isn't separately schedulable yet.
// - A room with no weekly-frequency tasks at all gets schedule: null (no automatic "due today"
//   flag - every task in it becomes an unscheduled label-only checklist item).

// ESM, not CommonJS: this repo's package.json sets "type": "module".
import fs from "node:fs";

const DAY_NAMES = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const DAY_ABBR = ["ma", "ti", "on", "to", "fr", "lø", "sø"];

// Everything in this file works in the SOURCE EXCEL's own column-position space throughout
// (0=mandag..6=søndag, matching the M/T/O/T/F/L/S grid's left-to-right order) - that's what
// DAY_ABBR/weekdaySetKey/labelSuffix etc. all assume, and it's correct for THAT purpose.
// The app's own `room_schedules.weekday` column is NOT the same convention: it's JS
// `Date#getDay()` (0=søndag..6=lørdag - see rentlogg-frontend's LokasjonerPage.jsx `WEEKDAYS`
// array, `{value:1,label:"Man"}...{value:0,label:"Søn"}`, and the backend's own `weekdayOf()`).
// Converting only at this one boundary - right before writing the final `schedule.weekdays`
// output - keeps every internal comparison/label function correct in its own space and avoids
// threading two different weekday conventions through the rest of this file.
// Found via a real bug 2026-09-18: every room imported before this fix got its weekday set
// shifted by this exact mapping (Sinkaberg's intended "mandag-fredag" landed as "søndag-torsdag"
// in production) - see feedback_hidden_sheets_not_active-adjacent memory / this session's history
// for the correction pass across every previously-imported customer.
function toAppWeekday(sourcePosition) {
  return (sourcePosition + 1) % 7;
}

// Printed after every run: how many rooms and tasks each sheet of the workbook actually produced.
// A plan whose office or second production sheet was never read shows up here as a sheet that is
// simply absent from the list — which is exactly what nobody noticed on Domstein Sjømat Bergen,
// where the site was built from one-page PDFs instead of this workbook and its whole "kontor (1)"
// sheet (18 rooms) was missing from production for ten months. Read this list against the sheet
// tabs in the workbook before importing.
function countBySheet(rooms) {
  const per = {};
  for (const r of rooms) {
    const sheet = r.sheet.trim();
    per[sheet] ||= { rooms: 0, tasks: 0 };
    per[sheet].rooms++;
    per[sheet].tasks += r.tasks.length;
  }
  return per;
}

// The source plan's responsibility flag column, one past the weekday grid: "x" for a daily/weekly
// task, "p" for a periodic one, both meaning the customer does it themselves. Anything else -
// including a file parsed before the parser captured this column at all - counts as ours, which
// is the safe default: it shows up on a checklist for review rather than silently vanishing.
function isCustomerTask(task) {
  const flag = (task.flag || "").trim().toLowerCase();
  return flag === "x" || flag === "p";
}

function weekdaySetKey(weekdays) {
  return [...weekdays].sort((a, b) => a - b).join(",");
}

function weekdayLabel(weekdays) {
  if (weekdays.length === 5 && weekdaySetKey(weekdays) === "0,1,2,3,4") return "hverdager";
  return weekdays.map((d) => DAY_ABBR[d]).join("+");
}

function classify(task) {
  if (task.weekdays.length > 0) return { kind: "weekly", weekdays: task.weekdays };
  const unit = (task.freqUnit || "").trim();
  const countRaw = (task.freqCount || "").trim();
  const count = parseFloat(countRaw.replace(",", "."));
  // "0 / u" (0 times a week) with no weekday marks means the source plan itself says this task
  // isn't currently done at all - not a real frequency to surface as a "(0)" suffix, so treat it
  // the same as no frequency info at all (bare label, no hint).
  if (count === 0) return { kind: "adhoc", note: null };
  if (unit === "m" && !isNaN(count) && count > 0) return { kind: "monthly", count };
  if (unit === "år" && !isNaN(count) && count > 0) return { kind: "yearly", count };
  if (unit === "u" && !isNaN(count) && count > 0) {
    // "N/u" with no day marks at all - shouldn't normally happen, but treat as adhoc rather than
    // guessing which weekdays.
    return { kind: "adhoc", note: `${countRaw}/u` };
  }
  if (countRaw) return { kind: "adhoc", note: countRaw };
  return { kind: "adhoc", note: null };
}

function labelSuffix(cls, roomWeekdaySet) {
  if (cls.kind === "weekly") {
    const key = weekdaySetKey(cls.weekdays);
    if (key === roomWeekdaySet) return "";
    return ` (kun ${weekdayLabel(cls.weekdays)})`;
  }
  if (cls.kind === "monthly") return cls.count === 1 ? " (1x/mnd)" : ` (${cls.count}x/mnd)`;
  if (cls.kind === "yearly") return cls.count === 1 ? " (1x/år)" : ` (${cls.count}x/år)`;
  if (cls.kind === "adhoc") return cls.note ? ` (${cls.note})` : "";
  return "";
}

function transform(parsed) {
  // Disambiguate names that repeat across sheets
  const nameCount = {};
  for (const room of parsed.rooms) {
    nameCount[room.lokale] = (nameCount[room.lokale] || 0) + 1;
  }

  const outRooms = [];
  // Tasks the source plan marks as the customer's own, kept out of the import and reported back
  // instead. They are NOT ours to put on a cleaner's checklist (see tools/README).
  const customerTasks = [];
  const customerOnlyRooms = [];
  for (const room of parsed.rooms) {
    const name = nameCount[room.lokale] > 1 ? `${room.lokale} (${room.sheet.trim()})` : room.lokale;

    const ours = room.tasks.filter((t) => !isCustomerTask(t));
    for (const t of room.tasks) {
      if (isCustomerTask(t)) customerTasks.push({ room: name, task: t.task, flag: t.flag });
    }
    // Every task in this Lokale belongs to the customer, so there is no room for us to create.
    if (ours.length === 0) {
      customerOnlyRooms.push(name);
      continue;
    }

    // Only our own tasks feed the majority-weekday calculation below - a room's schedule should
    // describe when WE are there, not when the customer cleans.
    const classified = ours.map((t) => ({ ...t, cls: classify(t) }));
    // The room is due on every day any of its tasks is due: the UNION of the weekly tasks' days.
    // This used to be the most common weekday-set instead, which broke rooms with a mixed rhythm —
    // Goman Trondheim's "Bakeri" has 9 Saturday-only tasks and 6 daily ones, so the room landed on
    // Saturday alone and never appeared in a cleaner's Dagens plan Monday to Friday, even though it
    // is cleaned six days a week. Tasks whose own days differ from the room's still say so in their
    // label (see labelSuffix), so the finer rhythm is not lost by widening the room.
    const unionDays = new Set();
    for (const t of classified) {
      if (t.cls.kind === "weekly") t.cls.weekdays.forEach((d) => unionDays.add(d));
    }
    const roomWeekdaySet = unionDays.size > 0 ? weekdaySetKey([...unionDays]) : null;

    const tasks = classified.map((t) => {
      const suffix = labelSuffix(t.cls, roomWeekdaySet);
      return `${t.task}${suffix}`;
    });

    const schedule = roomWeekdaySet
      ? { weekdays: roomWeekdaySet.split(",").map(Number).map(toAppWeekday) }
      : null;

    outRooms.push({ name, tasks, schedule });
  }

  return {
    rooms: outRooms,
    customerTasks,
    customerOnlyRooms,
    skipped: parsed.skipped,
    perSheet: countBySheet(parsed.rooms),
  };
}

const inPath = process.argv[2];
const outPath = process.argv[3];
const raw = fs.readFileSync(inPath, "utf8").replace(/^﻿/, "");
const parsed = JSON.parse(raw);
const result = transform(parsed);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
console.log(`${inPath}: ${result.rooms.length} rooms, ${result.skipped.length} sheets skipped`);
for (const [sheet, n] of Object.entries(result.perSheet)) {
  console.log(`  sheet "${sheet}": ${n.rooms} rooms, ${n.tasks} tasks`);
}
if (result.customerTasks.length > 0) {
  console.log(`${result.customerTasks.length} task(s) left out as the customer's own:`);
  for (const t of result.customerTasks) console.log(`  [${t.flag}] ${t.room} / ${t.task}`);
}
if (result.customerOnlyRooms.length > 0) {
  console.log(`No room created for (every task is the customer's): ${result.customerOnlyRooms.join(', ')}`);
}
