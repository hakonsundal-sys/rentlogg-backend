import { yesterdayInOslo } from "./schedule.js";
import { sendDailyReports } from "./dailyReportJob.js";
import { runBackup } from "./backup.js";

// 07:00 Europe/Oslo is the default for any site that hasn't set its own report_send_hour (e.g.
// a location whose report should land after its own opening routine instead) — see sites.js's
// report_send_hour field, editable alongside a site's report recipients.

// No cron library needed — a 60s interval comparing the current Oslo wall-clock time is simpler
// and avoids a new dependency. Runs the check every hour (not just at the 07:00 default) so a
// site with a custom hour actually gets picked up at its own time; lastRunKey guards against
// firing the same hour twice if the interval happens to land on :00 more than once (clock jitter).
let lastRunKey = null;

export function startDailyReportScheduler() {
  setInterval(async () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour").value);
    const minute = Number(parts.find((p) => p.type === "minute").value);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
    const runKey = `${today}-${hour}`;

    if (minute === 0 && lastRunKey !== runKey) {
      lastRunKey = runKey;
      const results = await sendDailyReports(yesterdayInOslo(), undefined, undefined, undefined, hour);
      if (results.sent || results.failed) {
        console.log(
          `Daglig rapport-utsending (kl ${String(hour).padStart(2, "0")}:00): ${results.sent} sendt, ${results.skipped} hoppet over, ${results.failed} feilet`
        );
      }
    }
  }, 60_000);
}

// Nattlig sikkerhetskopi. Samme mønster som over, og med vilje en egen intervall-løkke: en feil
// i backupen skal ikke kunne hindre dagsrapportene i å gå ut, og omvendt.
//
// 03:00 Europe/Oslo som standard. Tidspunktet er valgt fordi gårsdagen da er ferdig — siste
// renholder har levert og ingen holder på — og fordi 07:00 er opptatt av rapportutsendingen.
let lastBackupKey = null;

export function startBackupScheduler() {
  const hour = Number(process.env.BACKUP_HOUR ?? 3);

  setInterval(async () => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Oslo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const nowHour = Number(parts.find((p) => p.type === "hour").value);
    const minute = Number(parts.find((p) => p.type === "minute").value);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date());
    const runKey = `${today}-backup`;

    if (nowHour === hour && minute === 0 && lastBackupKey !== runKey) {
      lastBackupKey = runKey;
      // runBackup fanger sine egne feil og fører dem i backup_runs; den kaster ikke. Men en
      // uventet feil her ville blitt en unhandled rejection som tar ned prosessen, og en server
      // som dør klokka tre om natta er en dyrere feil enn en tapt sikkerhetskopi.
      try {
        await runBackup();
      } catch (err) {
        console.error("Backup-planleggeren feilet uventet:", err);
      }
    }
  }, 60_000);
}
