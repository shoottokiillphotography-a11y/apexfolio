import fs from "node:fs";
import { getDb } from "../db.js";
import { nowIso } from "../utils.js";
import { createAlert } from "./alerts.js";

const strategyAlertsPath = new URL("../../data/strategy-alerts.json", import.meta.url);

export function loadStrategyAlerts() {
  return JSON.parse(fs.readFileSync(strategyAlertsPath, "utf8"));
}

function alertLabel(alert) {
  const target = alert.displayTargetPrice ?? alert.targetPrice;
  const currency = alert.displayCurrency || alert.currency;
  return `${alert.alertType} ${target} ${currency}`;
}

function existingStrategyAlert(database, userId, alert) {
  return database.prepare(`
    SELECT id, archived_at AS archivedAt
    FROM price_alerts
    WHERE user_id = ?
      AND source = 'manual-strategy'
      AND ticker = ?
      AND alert_type = ?
      AND direction = ?
      AND ABS(threshold_price - ?) < 0.000001
    LIMIT 1
  `).get(userId, alert.ticker, alert.alertType, alert.triggerDirection, alert.targetPrice);
}

export function seedStrategyAlerts(userId) {
  const database = getDb();
  const rows = loadStrategyAlerts();
  let created = 0;
  let updated = 0;
  const now = nowIso();

  for (const alert of rows) {
    const existing = existingStrategyAlert(database, userId, alert);
    const active = alert.active === false ? 0 : 1;
    if (existing) {
      database.prepare(`
        UPDATE price_alerts
        SET currency = ?,
          label = ?,
          company_name = ?,
          exchange = ?,
          strategy_group = ?,
          priority = ?,
          note = ?,
          active = CASE WHEN archived_at IS NULL THEN ? ELSE active END,
          updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        alert.currency,
        alertLabel(alert),
        alert.companyName,
        alert.exchange,
        alert.group,
        alert.priority,
        alert.note,
        active,
        now,
        existing.id,
        userId
      );
      updated += 1;
      continue;
    }

    createAlert(userId, {
      ticker: alert.ticker,
      companyName: alert.companyName,
      exchange: alert.exchange,
      group: alert.group,
      scope: "EQUITY",
      direction: alert.triggerDirection,
      thresholdPrice: alert.targetPrice,
      currency: alert.currency,
      label: alertLabel(alert),
      alertType: alert.alertType,
      priority: alert.priority,
      note: alert.note,
      active: alert.active,
      source: alert.source || "manual-strategy"
    });
    created += 1;
  }

  return {
    total: rows.length,
    created,
    updated
  };
}
