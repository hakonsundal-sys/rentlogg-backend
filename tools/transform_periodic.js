// Transforms a parse_periodic.ps1 output into a flat list of periodic tasks ready to attach to
// EXISTING rooms:
//   [{ room, task, months: [1-12] }]
//
// Unlike transform.js, this does NOT feed POST /sites/:siteId/rooms/import-confirm — a periodic
// task belongs inside the same room its weekday-scheduled siblings already live in (e.g.
// "Bløgging"), not a separate "(periodisk)" room. The actual import is two calls per task against
// an existing room: POST /rooms/:id/items {label}, then PATCH /rooms/:id/items/:itemId {months}
// (see tools/README.md).
//
// Month numbers need no source-vs-app conversion the way weekdays did (transform.js's
// toAppWeekday) - a calendar month is the same number everywhere, no column-position mapping
// involved.

// ESM, not CommonJS: this repo's package.json sets "type": "module".
import fs from "node:fs";

// Same convention as transform.js: "x" (daily/weekly) or "p" (periodic) both mean the customer
// does this one themselves.
function isCustomerTask(task) {
  const flag = (task.flag || "").trim().toLowerCase();
  return flag === "x" || flag === "p";
}

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

function transform(parsed) {
  const outTasks = [];
  const customerTasks = [];
  // A task whose stated Frek. doesn't match how many months are actually marked - seen once
  // already (Lerøy Fossen's "Adm kontor", Frek. 1/u against 5 marked weekday cells mixing two
  // different tick symbols). Reported instead of guessed, same policy as that case.
  const freqMismatches = [];

  for (const room of parsed.rooms) {
    for (const t of room.tasks) {
      if (isCustomerTask(t)) {
        customerTasks.push({ room: room.lokale, task: t.task, flag: t.flag });
        continue;
      }
      if (t.months.length === 0) continue; // nothing marked at all - not a periodic task, skip silently like adhoc/0 cases elsewhere

      const statedCount = parseFloat((t.freqCount || "").trim().replace(",", "."));
      if (!isNaN(statedCount) && statedCount !== t.months.length) {
        freqMismatches.push({
          room: room.lokale, task: t.task,
          stated: `${t.freqCount} / ${t.freqUnit}`, markedMonths: t.months.length,
        });
      }

      outTasks.push({ room: room.lokale, task: t.task, months: t.months });
    }
  }

  return {
    tasks: outTasks,
    customerTasks,
    freqMismatches,
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
console.log(`${inPath}: ${result.tasks.length} periodic tasks, ${result.skipped.length} sheets skipped`);
for (const [sheet, n] of Object.entries(result.perSheet)) {
  console.log(`  sheet "${sheet}": ${n.rooms} rooms, ${n.tasks} tasks`);
}
if (result.customerTasks.length > 0) {
  console.log(`${result.customerTasks.length} task(s) left out as the customer's own:`);
  for (const t of result.customerTasks) console.log(`  [${t.flag}] ${t.room} / ${t.task}`);
}
if (result.freqMismatches.length > 0) {
  console.log(`${result.freqMismatches.length} task(s) whose Frek. doesn't match the marked month count - check by hand:`);
  for (const m of result.freqMismatches) console.log(`  ${m.room} / ${m.task}: stated ${m.stated}, ${m.markedMonths} months marked`);
}
