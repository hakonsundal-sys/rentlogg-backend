// Sjekk det: når en liste er planlagt. Delt av routes/simpleChecklists.js (I dag, ukeoversikten)
// og services/checklistDigest.js (morgen-e-posten), så de tre aldri kan være uenige om hva som
// manglet i går.
//
// Fire planformer:
//   weekly       — faste ukedager (simple_checklists.weekdays). Ingen ukedager = «ved behov».
//   monthly_day  — én dag i måneden (month_day 1–31, eller -1 = siste dag). En dag som ikke finnes
//                  i måneden (den 31. i april) flyttes til månedens siste dag, ikke hoppet over.
//   monthly_any  — én gang i måneden, hvilken dag som helst. Mangler først når måneden er over.
//   (ved behov)  — weekly uten ukedager. Regnes aldri som manglende.
//
// Ukedager følger Date#getDay() (0 = søndag) som resten av appen.

export function weekdaysFromColumn(text) {
  if (!text) return [];
  return String(text).split(",").filter((s) => s !== "").map(Number);
}

export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

export function scheduleMode(list) {
  return list.schedule_mode === "monthly_day" || list.schedule_mode === "monthly_any" ? list.schedule_mode : "weekly";
}

export function isOnDemand(list) {
  return scheduleMode(list) === "weekly" && weekdaysFromColumn(list.weekdays).length === 0;
}

function daysInMonth(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function isLastDayOfMonth(dateStr) {
  return Number(dateStr.slice(8, 10)) === daysInMonth(dateStr);
}

export function monthStart(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

export function monthEnd(dateStr) {
  return `${dateStr.slice(0, 7)}-${String(daysInMonth(dateStr)).padStart(2, "0")}`;
}

// Planlagt akkurat denne dagen? monthly_any er aldri planlagt på en bestemt dag — den har en
// måned, ikke en dag (se dayState).
export function isDueOn(list, dateStr) {
  if (dateStr < String(list.created_at).slice(0, 10)) return false; // fantes ikke ennå
  const mode = scheduleMode(list);
  if (mode === "monthly_day") {
    const last = daysInMonth(dateStr);
    const target = list.month_day === -1 ? last : Math.min(Number(list.month_day) || 1, last);
    return Number(dateStr.slice(8, 10)) === target;
  }
  if (mode === "monthly_any") return false;
  return weekdaysFromColumn(list.weekdays).includes(weekdayOf(dateStr));
}

// Én liste, én dag:
//   done / deviation — nok utfyllinger (deviation hvis noen av dem hadde avvik)
//   missing — planlagt, perioden er over, for få utfyllinger
//   late    — planlagt i dag, fristen er passert, for få utfyllinger
//   partial — i gang i dag (1 av 2), fristen ikke passert
//   due     — planlagt, ingenting gjort ennå
//   none    — ikke planlagt (og ingenting gjort)
// `monthCount` brukes bare av monthly_any: antall utfyllinger i datoens måned (til og med i dag).
// `nowHHMM` er Oslo-klokka nå, sendt inn så funksjonen er ren og kan testes.
export function dayState(list, dateStr, today, count, deviations, { monthCount = 0, nowHHMM = "00:00" } = {}) {
  if (deviations > 0 && count > 0) return "deviation";
  const mode = scheduleMode(list);

  if (mode === "monthly_any") {
    if (count > 0) return "done";
    if (monthCount > 0) return "none";
    if (dateStr < String(list.created_at).slice(0, 10)) return "none";
    // Måneden er over uten en eneste utfylling: markeres på månedens siste dag.
    if (isLastDayOfMonth(dateStr) && dateStr < today) return "missing";
    if (dateStr === today) return "due";
    return "none";
  }

  const times = mode === "weekly" ? Math.max(1, Number(list.times_per_day) || 1) : 1;
  if (count >= times && count > 0) return "done";
  if (!isDueOn(list, dateStr)) return count > 0 ? "done" : "none";
  if (dateStr < today) return "missing";
  if (dateStr === today && list.due_time && nowHHMM > list.due_time) return "late";
  return count > 0 ? "partial" : "due";
}

// Hvordan planen leses for et menneske (oversikt, e-post).
export function scheduleLabel(list) {
  const mode = scheduleMode(list);
  if (mode === "monthly_day") return list.month_day === -1 ? "månedlig, siste dag" : `månedlig, den ${list.month_day}.`;
  if (mode === "monthly_any") return "én gang i måneden";
  return isOnDemand(list) ? "ved behov" : "";
}
