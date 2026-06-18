import { getDb } from "../db.js";
import {
  assertFxCurrency,
  id,
  InputError,
  portfolioGroupIdForTicker,
  normalizeTicker,
  nowIso,
  roundMoney,
  roundPercent,
  toNumber
} from "../utils.js";
import { calculatePortfolio } from "./calculations.js";
import { convertAmount } from "./currency.js";
import { getQuote } from "./market-data.js";
import {
  createAndSendNotification,
  renderPriceAlertEmail
} from "./notifications.js";

const ALERT_TYPES = new Set([
  "PRICE_ALERT",
  "BUY_STARTER",
  "BUY_ADD",
  "BUY_STRONG",
  "SPECULATIVE_STARTER",
  "SPECULATIVE_ADD",
  "SPECULATIVE_STRONG",
  "REVIEW_TRIM",
  "REVIEW_REDUCE",
  "RISK_REVIEW",
  "DELETE_OR_IGNORE",
  "REVIEW_ONLY"
]);

const BUY_SIGNAL_TYPES = new Set([
  "BUY_STARTER",
  "BUY_ADD",
  "BUY_STRONG",
  "SPECULATIVE_STARTER",
  "SPECULATIVE_ADD",
  "SPECULATIVE_STRONG"
]);

const PRIORITIES = new Set(["low", "medium", "high"]);

function normalizeDirection(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (raw === "ABOVE" || raw === "UP" || raw === "GREATER_THAN") return "ABOVE";
  if (raw === "BELOW" || raw === "DOWN" || raw === "LESS_THAN" || raw === "CROSS") return "BELOW";
  throw new InputError("Direction must be ABOVE or BELOW");
}

function normalizeAlertType(input) {
  const type = String(input || "PRICE_ALERT").trim().toUpperCase();
  return ALERT_TYPES.has(type) ? type : "PRICE_ALERT";
}

function normalizePriority(input) {
  const priority = String(input || "medium").trim().toLowerCase();
  return PRIORITIES.has(priority) ? priority : "medium";
}

function shouldTrigger(alert, currentPrice) {
  if (currentPrice == null) return false;
  if (alert.direction === "ABOVE") return currentPrice >= alert.threshold_price;
  return currentPrice <= alert.threshold_price;
}

function movedAwayFromTarget(alert, currentPrice) {
  if (currentPrice == null || !alert.last_triggered_at) return false;
  if (alert.direction === "ABOVE") return currentPrice <= alert.threshold_price * 0.97;
  return currentPrice >= alert.threshold_price * 1.03;
}

function cooldownActive(alert) {
  if (!alert.last_triggered_at || alert.last_reset_price != null) return false;
  const elapsedMs = Date.now() - new Date(alert.last_triggered_at).getTime();
  return elapsedMs < alert.cooldown_minutes * 60 * 1000;
}

function snoozeActive(alert) {
  if (!alert.snoozed_until) return false;
  return new Date(alert.snoozed_until).getTime() > Date.now();
}

function validateScope(input) {
  const scope = String(input.scope || "EQUITY").toUpperCase();
  if (!["EQUITY", "LOT", "WATCHLIST"].includes(scope)) {
    throw new InputError("Alert scope must be EQUITY, LOT, or WATCHLIST");
  }
  return scope;
}

function exchangeForAlert(alert) {
  const ticker = String(alert.ticker || "").toUpperCase();
  const exchange = String(alert.exchange || "").toUpperCase();
  if (ticker.endsWith(".AX") || exchange.includes("ASX")) return "ASX";
  if (ticker.endsWith(".L") || exchange.includes("LONDON") || exchange === "LSE") return "LSE";
  if (ticker.endsWith(".CO") || exchange.includes("COPENHAGEN") || exchange.includes("EURONEXT") || exchange.includes("NASDAQ NORDIC")) return "EUROPE";
  if (ticker.endsWith(".HK") || exchange.includes("HONG KONG") || exchange === "HKEX") return "HKEX";
  if (exchange.includes("OTC")) return "US";
  if (exchange.includes("NASDAQ") || exchange.includes("NYSE") || /^[A-Z.-]+$/.test(ticker)) return "US";
  return "US";
}

function weekdayUtc(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function minutesUtc(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function marketLikelyOpen(alert, now = new Date()) {
  if (!weekdayUtc(now)) return false;
  const minute = minutesUtc(now);
  const exchange = exchangeForAlert(alert);
  if (exchange === "ASX") return minute >= 0 && minute <= 370;
  if (exchange === "LSE" || exchange === "EUROPE") return minute >= 420 && minute <= 940;
  if (exchange === "HKEX") return minute >= 90 && minute <= 480;
  return minute >= 810 && minute <= 1205;
}

function staleDuringMarketHours(alert, quote) {
  if (!quote?.asOf || !marketLikelyOpen(alert)) return false;
  const ageMinutes = (Date.now() - new Date(quote.asOf).getTime()) / 60000;
  return Number.isFinite(ageMinutes) && ageMinutes > 15;
}

function suggestedActionFor(alertType, safety = {}) {
  const type = safety.effectiveAlertType || alertType;
  const actions = {
    BUY_STARTER: "Review for a first small tranche only. Check news, market tone, and thesis before acting.",
    BUY_ADD: "Review a possible add only if the thesis, fundamentals, and valuation remain intact.",
    BUY_STRONG: "Deep buy-zone review. Verify thesis, earnings, guidance, margins, and balance sheet first.",
    SPECULATIVE_STARTER: "Tiny speculative starter only. Do not build a large position from this alert.",
    SPECULATIVE_ADD: "Speculative add only if current position is tiny and the thesis is still intact.",
    SPECULATIVE_STRONG: "High-risk review level. Full thesis check required before any action.",
    REVIEW_TRIM: "Review position size, valuation, and concentration. Consider trimming or rebalancing.",
    REVIEW_REDUCE: "Review reducing exposure if risk, valuation, or thesis quality has worsened.",
    RISK_REVIEW: "Risk review only. Check news, earnings, guidance, regulation, balance sheet, and thesis.",
    DELETE_OR_IGNORE: "Not aligned with the strategy. Do not suggest buying.",
    REVIEW_ONLY: "Review only. Buying is blocked by portfolio-weight safety until deliberately overridden.",
    PRICE_ALERT: "Review the position or watchlist idea before taking any action."
  };
  const warnings = safety.warnings?.length ? ` ${safety.warnings.join(" ")}` : "";
  return `${actions[type] || actions.PRICE_ALERT}${warnings}`;
}

function portfolioSafety(alert, portfolio) {
  const position = portfolio?.positions?.find((item) => item.ticker === alert.ticker);
  const totalValue = Number(portfolio?.summary?.totalValueBase) || 0;
  const value = Number(position?.currentValueBase) || 0;
  const weightPercent = totalValue ? roundPercent((value / totalValue) * 100) : 0;
  const note = String(alert.note || alert.label || "").toLowerCase();
  const maxBuyWeight = position?.maxBuyWeightPercent == null ? null : Number(position.maxBuyWeightPercent);
  const savedBuyBlocked = Boolean(position?.buyBlocked) && value > 0;
  const savedLimitReached = Number.isFinite(maxBuyWeight) && maxBuyWeight >= 0 && value > 0 && weightPercent >= maxBuyWeight;
  const markedOverweight = savedBuyBlocked
    || savedLimitReached
    || note.includes("overweight")
    || note.includes("oversized");
  const warnings = [];

  if (BUY_SIGNAL_TYPES.has(alert.alert_type) && (weightPercent >= 10 || markedOverweight)) {
    warnings.push("Check current portfolio weight before buying.");
  }
  if (markedOverweight) {
    warnings.push(position?.riskNote || "Overweight position — do not add unless deliberately overriding.");
  }

  const addBlocked = BUY_SIGNAL_TYPES.has(alert.alert_type) && (markedOverweight || weightPercent >= 15);
  return {
    positionWeightPercent: weightPercent,
    markedOverweight,
    addBlocked,
    effectiveAlertType: addBlocked ? "REVIEW_ONLY" : alert.alert_type,
    warnings
  };
}

function alertViewPatch(database, alertId, values) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  database.prepare(`UPDATE price_alerts SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((key) => values[key]), nowIso(), alertId);
}

export function createAlert(userId, input) {
  const ticker = normalizeTicker(input.ticker);
  const direction = normalizeDirection(input.direction ?? input.triggerDirection);
  const threshold = toNumber(input.thresholdPrice ?? input.threshold_price ?? input.targetPrice, null);
  const currency = assertFxCurrency(input.currency || "USD");
  const scope = validateScope(input);
  if (!ticker) throw new InputError("Ticker is required");
  if (threshold == null || threshold < 0) throw new InputError("Threshold price must be zero or greater");

  const database = getDb();
  const now = nowIso();
  const existingEquity = database.prepare("SELECT category_id AS categoryId FROM equities WHERE ticker = ?").get(ticker);
  const categoryId = existingEquity?.categoryId || portfolioGroupIdForTicker(ticker);
  database.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(equities.name, excluded.name),
      currency = COALESCE(excluded.currency, equities.currency),
      updated_at = excluded.updated_at
  `).run(ticker, input.companyName || input.company_name || null, currency, categoryId, now, now);

  let lotId = input.lotId || input.lot_id || null;
  let watchlistItemId = input.watchlistItemId || input.watchlist_item_id || null;
  if (scope === "LOT") {
    const lot = database.prepare("SELECT id FROM holding_lots WHERE id = ? AND user_id = ? AND ticker = ?")
      .get(lotId, userId, ticker);
    if (!lot) throw new InputError("Lot alert requires a matching lot", 400);
    watchlistItemId = null;
  } else if (scope === "WATCHLIST") {
    const item = database.prepare("SELECT id FROM watchlist_items WHERE id = ? AND user_id = ? AND ticker = ?")
      .get(watchlistItemId, userId, ticker);
    if (!item) throw new InputError("Watchlist alert requires a matching watchlist item", 400);
    lotId = null;
  } else {
    lotId = null;
    watchlistItemId = null;
  }

  const alertId = id("alert");
  const alertType = normalizeAlertType(input.alertType ?? input.alert_type);
  const active = input.active == null ? (alertType === "DELETE_OR_IGNORE" ? 0 : 1) : (input.active ? 1 : 0);
  const priority = normalizePriority(input.priority);
  const label = input.label || input.note || alertType;
  database.prepare(`
    INSERT INTO price_alerts (
      id, user_id, ticker, scope, lot_id, watchlist_item_id, direction,
      threshold_price, currency, label, company_name, exchange, strategy_group,
      alert_type, priority, note, source, active, triggered, cooldown_minutes,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    alertId,
    userId,
    ticker,
    scope,
    lotId,
    watchlistItemId,
    direction,
    threshold,
    currency,
    label || null,
    input.companyName || input.company_name || null,
    input.exchange || null,
    input.group || input.strategyGroup || input.strategy_group || null,
    alertType,
    priority,
    input.note || null,
    input.source || "manual",
    active,
    Number.parseInt(input.cooldownMinutes ?? input.cooldown_minutes ?? 1440, 10),
    input.createdAt || input.created_at || now,
    now
  );
  return alertId;
}

export function updateAlert(userId, alertId, input) {
  const database = getDb();
  const alert = database.prepare("SELECT * FROM price_alerts WHERE id = ? AND user_id = ?").get(alertId, userId);
  if (!alert) throw new InputError("Alert not found", 404);
  const values = {};
  if (input.active != null) values.active = input.active ? 1 : 0;
  if (input.triggered != null) {
    values.triggered = input.triggered ? 1 : 0;
    if (!input.triggered) {
      values.triggered_at = null;
      values.acknowledged_at = null;
      values.snoozed_until = null;
      values.last_triggered_at = null;
      values.last_reset_price = null;
    }
  }
  if (input.label != null) values.label = input.label;
  if (input.note != null) values.note = input.note;
  if (input.priority != null) values.priority = normalizePriority(input.priority);
  if (input.alertType != null || input.alert_type != null) values.alert_type = normalizeAlertType(input.alertType ?? input.alert_type);
  if (input.direction != null) values.direction = normalizeDirection(input.direction);
  if (input.thresholdPrice != null || input.threshold_price != null || input.targetPrice != null) {
    const threshold = toNumber(input.thresholdPrice ?? input.threshold_price ?? input.targetPrice, null);
    if (threshold != null && threshold > 0) values.threshold_price = threshold;
  }
  if (input.currency != null) {
    const currency = String(input.currency).trim().toUpperCase();
    if (currency) values.currency = currency;
  }
  alertViewPatch(database, alertId, values);
}

export function markAlertReviewed(userId, alertId) {
  const database = getDb();
  const alert = database.prepare("SELECT id FROM price_alerts WHERE id = ? AND user_id = ?").get(alertId, userId);
  if (!alert) throw new InputError("Alert not found", 404);
  alertViewPatch(database, alertId, { acknowledged_at: nowIso() });
}

export function snoozeAlert(userId, alertId, hours = 24) {
  const database = getDb();
  const alert = database.prepare("SELECT id FROM price_alerts WHERE id = ? AND user_id = ?").get(alertId, userId);
  if (!alert) throw new InputError("Alert not found", 404);
  const until = new Date(Date.now() + Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();
  alertViewPatch(database, alertId, { snoozed_until: until, acknowledged_at: nowIso() });
}

export function archiveAlert(userId, alertId) {
  const database = getDb();
  const alert = database.prepare("SELECT id FROM price_alerts WHERE id = ? AND user_id = ?").get(alertId, userId);
  if (!alert) throw new InputError("Alert not found", 404);
  alertViewPatch(database, alertId, { active: 0, archived_at: nowIso() });
}

export function reactivateAlert(userId, alertId) {
  const database = getDb();
  const alert = database.prepare("SELECT id FROM price_alerts WHERE id = ? AND user_id = ?").get(alertId, userId);
  if (!alert) throw new InputError("Alert not found", 404);
  alertViewPatch(database, alertId, {
    active: 1,
    triggered: 0,
    triggered_at: null,
    acknowledged_at: null,
    archived_at: null,
    snoozed_until: null,
    last_triggered_at: null,
    last_triggered_price: null,
    last_reset_price: null
  });
}

export function deleteAlert(userId, alertId) {
  const database = getDb();
  // notification_history.alert_id references price_alerts(id); clear it first so a
  // triggered/notified alert can be deleted without a FOREIGN KEY constraint error.
  database.prepare("UPDATE notification_history SET alert_id = NULL WHERE alert_id = ?").run(alertId);
  const result = database.prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ?").run(alertId, userId);
  if (!result.changes) throw new InputError("Alert not found", 404);
}

async function quotePriceInAlertCurrency(quote, alert) {
  if (quote?.price == null) return null;
  if (quote.currency === alert.currency) return { amount: quote.price, rate: 1, stale: false };
  return convertAmount(quote.price, quote.currency, alert.currency);
}

export async function evaluateAlerts(userId, { forceQuotes = false } = {}) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const alerts = database.prepare(`
    SELECT * FROM price_alerts
    WHERE user_id = ? AND active = 1 AND archived_at IS NULL
    ORDER BY created_at
  `).all(userId);
  const portfolio = await calculatePortfolio(userId);
  const results = [];

  for (const alert of alerts) {
    if (snoozeActive(alert)) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "SNOOZED" });
      continue;
    }

    const quote = await getQuote(alert.ticker, { force: forceQuotes });
    if (!quote?.price) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "NO_PRICE", error: quote?.error });
      continue;
    }
    if (staleDuringMarketHours(alert, quote)) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "STALE_PRICE", asOf: quote.asOf });
      continue;
    }

    const converted = await quotePriceInAlertCurrency(quote, alert);
    const currentPrice = converted?.amount == null ? null : roundMoney(converted.amount);
    const crossing = shouldTrigger(alert, currentPrice);

    if (!crossing) {
      if (movedAwayFromTarget(alert, currentPrice) && alert.acknowledged_at) {
        database.prepare(`
          UPDATE price_alerts
          SET triggered = 0, last_reset_price = ?, updated_at = ?
          WHERE id = ?
        `).run(currentPrice, nowIso(), alert.id);
        results.push({ alertId: alert.id, ticker: alert.ticker, status: "RESET_AFTER_AWAY_MOVE", currentPrice });
      } else {
        results.push({ alertId: alert.id, ticker: alert.ticker, status: "NOT_TRIGGERED", currentPrice });
      }
      continue;
    }

    if (alert.triggered && !alert.acknowledged_at) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "ALREADY_TRIGGERED", currentPrice });
      continue;
    }
    if (alert.triggered && alert.acknowledged_at) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "ACKNOWLEDGED_WAITING_FOR_RESET", currentPrice });
      continue;
    }
    if (cooldownActive(alert)) {
      results.push({ alertId: alert.id, ticker: alert.ticker, status: "COOLDOWN", currentPrice });
      continue;
    }

    const lot = alert.lot_id
      ? database.prepare("SELECT * FROM holding_lots WHERE id = ?").get(alert.lot_id)
      : null;
    const safety = portfolioSafety(alert, portfolio);
    const effectiveAlert = {
      ...alert,
      effective_alert_type: safety.effectiveAlertType,
      suggested_action: suggestedActionFor(alert.alert_type, safety),
      safety_warning: safety.warnings.join(" "),
      position_weight_percent: safety.positionWeightPercent
    };
    const email = renderPriceAlertEmail({
      alert: effectiveAlert,
      quote,
      currentPrice,
      userCurrency: alert.currency,
      lot
    });
    const sendResult = await createAndSendNotification({
      userId,
      kind: "PRICE_ALERT",
      ticker: alert.ticker,
      alertId: alert.id,
      recipient: user.email,
      subject: email.subject,
      body: email.body
    });
    const triggeredAt = nowIso();
    database.prepare(`
      UPDATE price_alerts
      SET triggered = 1,
        triggered_at = ?,
        acknowledged_at = NULL,
        snoozed_until = NULL,
        last_triggered_at = ?,
        last_triggered_price = ?,
        last_reset_price = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(triggeredAt, triggeredAt, currentPrice, triggeredAt, alert.id);
    results.push({
      alertId: alert.id,
      ticker: alert.ticker,
      status: safety.addBlocked ? "TRIGGERED_REVIEW_ONLY" : "TRIGGERED",
      currentPrice,
      alertType: safety.effectiveAlertType,
      suggestedAction: effectiveAlert.suggested_action,
      notification: sendResult
    });
  }

  return results;
}
