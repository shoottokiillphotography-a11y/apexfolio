import { config } from "../config.js";
import { getPrimaryUser } from "../db.js";
import { evaluateAlerts } from "./alerts.js";
import { refreshCorporateEvents, notifyNewCorporateEvents } from "./events.js";
import { refreshTrackedFundamentals } from "./fundamentals.js";
import { refreshTrackedQuotes } from "./market-data.js";
import { sendPendingNotifications } from "./notifications.js";
import { syncDividends } from "./dividends.js";

function every(seconds, label, task) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`[scheduler:${label}]`, error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, seconds * 1000);
  run();
  return timer;
}

export function startScheduler() {
  const user = getPrimaryUser();
  const timers = [
    every(config.holdingsPollIntervalSeconds, "holdings", async () => {
      await refreshTrackedQuotes({ force: true, scope: "fast" });
    }),
    every(config.alertsPollIntervalSeconds, "alerts", async () => {
      await refreshTrackedQuotes({ force: true, scope: "alerts" });
      await evaluateAlerts(user.id, { forceQuotes: false });
    }),
    every(config.watchlistPollIntervalSeconds, "watchlist-quotes", async () => {
      await refreshTrackedQuotes({ force: true, scope: "watchlist" });
    }),
    every(config.corporateEventPollIntervalSeconds, "corporate-events", async () => {
      await refreshCorporateEvents(user.id);
      await notifyNewCorporateEvents(user.id);
      await syncDividends(user.id);
    }),
    every(config.fundamentalPollIntervalSeconds, "fundamentals", async () => {
      await refreshTrackedFundamentals({ force: false });
    }),
    every(config.notificationRetryIntervalSeconds, "notifications", async () => {
      await sendPendingNotifications();
    })
  ];
  return () => timers.forEach((timer) => clearInterval(timer));
}
