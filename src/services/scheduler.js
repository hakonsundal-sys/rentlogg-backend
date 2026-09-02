import { yesterdayInOslo } from "./schedule.js";
import { sendDailyReports } from "./dailyReportJob.js";

const SEND_HOUR = 7; // 07:00 Europe/Oslo

// No cron library needed for a single daily trigger — a 60s interval comparing the current
// Oslo wall-clock time is simpler and avoids a new dependency. lastRunDate guards against firing
// twice if the interval happens to land on :00 more than once (clock jitter).
let lastRunDate = null;

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

    if (hour === SEND_HOUR && minute === 0 && lastRunDate !== today) {
      lastRunDate = today;
      const results = await sendDailyReports(yesterdayInOslo());
      console.log(
        `Daglig rapport-utsending: ${results.sent} sendt, ${results.skipped} hoppet over, ${results.failed} feilet`
      );
    }
  }, 60_000);
}
