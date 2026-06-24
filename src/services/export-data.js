import { getDb } from "../db.js";
import { roundMoney, roundPercent, roundShares } from "../utils.js";
import { calculatePortfolio } from "./calculations.js";
import { convertAmount } from "./currency.js";

const PORTFOLIO_COLUMNS = [
  "row_type",
  "ticker",
  "name",
  "group",
  "currency",
  "quantity",
  "price",
  "market_value_aud",
  "cost_basis_aud",
  "unrealized_aud",
  "unrealized_pct",
  "day_change_aud",
  "day_change_pct",
  "weight_pct"
];

const HISTORY_COLUMNS = [
  "date",
  "type",
  "ticker",
  "name",
  "group",
  "account",
  "currency",
  "quantity",
  "price",
  "cashflow_aud",
  "cost_basis_aud",
  "proceeds_aud",
  "gain_loss_aud",
  "gain_loss_pct",
  "note"
];

const TRIGGERED_ALERT_COLUMNS = [
  "ticker",
  "company_name",
  "group",
  "scope",
  "direction",
  "threshold_price",
  "currency",
  "label",
  "last_triggered_price",
  "triggered_at",
  "priority",
  "alert_type",
  "strategy_group",
  "status",
  "note"
];

function csvValue(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function toCsv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvValue(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}

function cleanNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return Number(Number(value).toFixed(digits));
}

function downloadResult(filename, columns, rows) {
  return {
    __download: true,
    filename,
    contentType: "text/csv; charset=utf-8",
    body: toCsv(columns, rows)
  };
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function filename(prefix) {
  return `${prefix}_${dateStamp()}.csv`;
}

function weight(valueBase, totalValueBase) {
  const value = Number(valueBase);
  const total = Number(totalValueBase);
  if (!Number.isFinite(value) || !Number.isFinite(total) || total === 0) return "";
  return cleanNumber((value / total) * 100, 4);
}

async function toAud(amount, currency, fallback = null) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return fallback;
  const from = String(currency || "AUD").toUpperCase();
  if (from === "AUD") return roundMoney(numeric);
  try {
    const converted = await convertAmount(numeric, from, "AUD");
    return converted?.amount == null ? fallback : roundMoney(converted.amount);
  } catch {
    return fallback;
  }
}

function accountFrom(source, note, fallback = "Netwealth") {
  const sourceText = String(source || "").trim();
  const noteText = String(note || "").trim();
  if (sourceText.toLowerCase() === "external" && noteText) return noteText;
  if (sourceText && sourceText.toLowerCase() !== "manual") return sourceText;
  return noteText || fallback;
}

function alertStatus(alert) {
  if (alert.archived_at) return "archived";
  if (alert.triggered && !alert.acknowledged_at) return "triggered";
  if (alert.acknowledged_at) return "reviewed";
  if (alert.active) return "active";
  return "paused";
}

export async function exportPortfolioSnapshotCsv(userId) {
  const dashboard = await calculatePortfolio(userId);
  const totalValueBase = Number(dashboard.summary?.totalValueBase) || 0;
  const holdingRows = (dashboard.positions || [])
    .filter((position) => !position.closed && Number(position.quantity) > 0)
    .sort((a, b) => (Number(b.currentValueBase) || 0) - (Number(a.currentValueBase) || 0) || String(a.ticker).localeCompare(String(b.ticker)))
    .map((position) => ({
      row_type: "HOLDING",
      ticker: position.ticker,
      name: position.name || "",
      group: position.categoryName || "",
      currency: position.price?.currency || position.lots?.[0]?.purchaseCurrency || "AUD",
      quantity: cleanNumber(position.quantity, 6),
      price: cleanNumber(position.price?.price, 6),
      market_value_aud: cleanNumber(position.currentValueBase),
      cost_basis_aud: cleanNumber(position.costBasisBase),
      unrealized_aud: cleanNumber(position.unrealizedBase),
      unrealized_pct: cleanNumber(position.unrealizedPercent, 4),
      day_change_aud: cleanNumber(position.dayChangeBase),
      day_change_pct: cleanNumber(position.dayChangePercent, 4),
      weight_pct: weight(position.currentValueBase, totalValueBase)
    }));

  const cashRows = (dashboard.cashBalances || [])
    .slice()
    .sort((a, b) => (Number(b.amountBase) || 0) - (Number(a.amountBase) || 0) || String(a.currency).localeCompare(String(b.currency)))
    .map((cash) => ({
      row_type: "CASH",
      ticker: cash.currency,
      name: `Cash (${cash.currency})`,
      group: "Cash",
      currency: cash.currency,
      quantity: cleanNumber(cash.amount),
      price: "",
      market_value_aud: cleanNumber(cash.amountBase),
      cost_basis_aud: cleanNumber(cash.amountBase),
      unrealized_aud: 0,
      unrealized_pct: "",
      day_change_aud: "",
      day_change_pct: "",
      weight_pct: weight(cash.amountBase, totalValueBase)
    }));

  return downloadResult(filename("apexfolio-portfolio"), PORTFOLIO_COLUMNS, [...holdingRows, ...cashRows]);
}

async function buyRows(database, userId) {
  const lots = database.prepare(`
    SELECT l.*, e.name, c.name AS category_name
    FROM holding_lots l
    JOIN equities e ON e.ticker = l.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE l.user_id = ?
    ORDER BY l.purchase_date, l.created_at
  `).all(userId);

  const representedLotIds = new Set(lots.map((lot) => lot.id));
  const rows = [];
  for (const lot of lots) {
    const costBasisAud = await toAud(
      (Number(lot.original_quantity) || 0) * (Number(lot.purchase_price) || 0),
      lot.purchase_currency
    );
    rows.push({
      date: lot.purchase_date,
      type: "BUY",
      ticker: lot.ticker,
      name: lot.name || "",
      group: lot.category_name || "",
      account: accountFrom(lot.source, lot.notes),
      currency: lot.purchase_currency,
      quantity: cleanNumber(lot.original_quantity, 6),
      price: cleanNumber(lot.purchase_price, 6),
      cashflow_aud: costBasisAud == null ? "" : cleanNumber(-costBasisAud),
      cost_basis_aud: cleanNumber(costBasisAud),
      proceeds_aud: "",
      gain_loss_aud: "",
      gain_loss_pct: "",
      note: lot.notes || ""
    });
  }

  const missingBuys = database.prepare(`
    SELECT r.*, e.name, c.name AS category_name
    FROM realized_lots r
    LEFT JOIN equities e ON e.ticker = r.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE r.user_id = ?
      AND r.bought_at IS NOT NULL
      AND r.buy_price IS NOT NULL
      AND (r.lot_id IS NULL OR r.lot_id NOT IN (SELECT id FROM holding_lots WHERE user_id = ?))
    ORDER BY r.bought_at, r.created_at
  `).all(userId, userId);

  const seenSyntheticBuys = new Set();
  for (const sale of missingBuys) {
    const syntheticKey = sale.lot_id || `${sale.ticker}|${sale.bought_at}|${sale.buy_price}|${sale.quantity}|${sale.buy_currency}`;
    if (representedLotIds.has(syntheticKey) || seenSyntheticBuys.has(syntheticKey)) continue;
    seenSyntheticBuys.add(syntheticKey);
    const costBasisAud = await toAud(
      (Number(sale.quantity) || 0) * (Number(sale.buy_price) || 0),
      sale.buy_currency,
      sale.cost_basis_base
    );
    rows.push({
      date: sale.bought_at,
      type: "BUY",
      ticker: sale.ticker,
      name: sale.name || "",
      group: sale.category_name || "",
      account: accountFrom(sale.source, sale.notes),
      currency: sale.buy_currency || sale.sale_currency,
      quantity: cleanNumber(sale.quantity, 6),
      price: cleanNumber(sale.buy_price, 6),
      cashflow_aud: costBasisAud == null ? "" : cleanNumber(-costBasisAud),
      cost_basis_aud: cleanNumber(costBasisAud),
      proceeds_aud: "",
      gain_loss_aud: "",
      gain_loss_pct: "",
      note: sale.notes || "Synthetic buy reconstructed from realized sale"
    });
  }

  return rows;
}

function saleRows(database, userId) {
  return database.prepare(`
    SELECT r.*, e.name, c.name AS category_name
    FROM realized_lots r
    LEFT JOIN equities e ON e.ticker = r.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at, r.created_at
  `).all(userId).map((sale) => {
    const external = String(sale.source || "").toLowerCase() === "external" || !sale.lot_id;
    return {
      date: sale.sold_at,
      type: external ? "EXTERNAL_SELL" : "SELL",
      ticker: sale.ticker,
      name: sale.name || "",
      group: sale.category_name || "",
      account: external ? accountFrom("external", sale.notes) : accountFrom(sale.source, sale.notes),
      currency: sale.sale_currency,
      quantity: cleanNumber(sale.quantity, 6),
      price: cleanNumber(sale.sale_price, 6),
      cashflow_aud: cleanNumber(sale.proceeds_base),
      cost_basis_aud: cleanNumber(sale.cost_basis_base),
      proceeds_aud: cleanNumber(sale.proceeds_base),
      gain_loss_aud: cleanNumber(sale.gain_loss_base),
      gain_loss_pct: cleanNumber(sale.gain_loss_percent, 4),
      note: sale.notes || ""
    };
  });
}

function dividendRows(database, userId) {
  return database.prepare(`
    SELECT d.*, e.name, c.name AS category_name
    FROM dividend_payments d
    LEFT JOIN equities e ON e.ticker = d.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE d.user_id = ?
    ORDER BY COALESCE(d.pay_date, d.ex_date), d.created_at
  `).all(userId).map((dividend) => ({
    date: dividend.pay_date || dividend.ex_date,
    type: "DIVIDEND",
    ticker: dividend.ticker,
    name: dividend.name || "",
    group: dividend.category_name || "",
    account: accountFrom(dividend.source, "", "Netwealth"),
    currency: dividend.currency,
    quantity: cleanNumber(dividend.eligible_quantity, 6),
    price: cleanNumber(dividend.amount_per_share, 6),
    cashflow_aud: cleanNumber(dividend.gross_amount_base),
    cost_basis_aud: "",
    proceeds_aud: cleanNumber(dividend.gross_amount_base),
    gain_loss_aud: "",
    gain_loss_pct: "",
    note: "Dividend"
  }));
}

function historySortKey(row) {
  const typeOrder = { BUY: 1, SELL: 2, EXTERNAL_SELL: 3, DIVIDEND: 4 };
  return `${row.date || "9999-99-99"}|${String(typeOrder[row.type] || 9).padStart(2, "0")}|${row.ticker || ""}`;
}

export async function exportInvestmentHistoryCsv(userId) {
  const database = getDb();
  const rows = [
    ...await buyRows(database, userId),
    ...saleRows(database, userId),
    ...dividendRows(database, userId)
  ].sort((a, b) => historySortKey(a).localeCompare(historySortKey(b)));
  return downloadResult(filename("apexfolio-history"), HISTORY_COLUMNS, rows);
}

export function exportTriggeredAlertsCsv(userId, { includeReviewed = false } = {}) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT a.*, e.name AS equity_name, c.name AS category_name
    FROM price_alerts a
    LEFT JOIN equities e ON e.ticker = a.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE a.user_id = ?
    ORDER BY COALESCE(a.last_triggered_at, a.triggered_at, a.acknowledged_at, a.updated_at) DESC
  `).all(userId)
    .map((alert) => ({ ...alert, status: alertStatus(alert) }))
    .filter((alert) => alert.status === "triggered" || (includeReviewed && alert.status === "reviewed"))
    .map((alert) => ({
      ticker: alert.ticker,
      company_name: alert.company_name || alert.equity_name || "",
      group: alert.strategy_group || alert.category_name || "",
      scope: alert.scope,
      direction: alert.direction,
      threshold_price: cleanNumber(alert.threshold_price, 6),
      currency: alert.currency,
      label: alert.label || "",
      last_triggered_price: cleanNumber(alert.last_triggered_price, 6),
      triggered_at: alert.last_triggered_at || alert.triggered_at || alert.acknowledged_at || "",
      priority: alert.priority,
      alert_type: alert.alert_type,
      strategy_group: alert.strategy_group || "",
      status: alert.status,
      note: alert.note || ""
    }));
  return downloadResult(filename("apexfolio-alerts-triggered"), TRIGGERED_ALERT_COLUMNS, rows);
}

// Backward-compatible aliases for old buttons or cached URLs.
export const exportCurrentPortfolioCsv = exportPortfolioSnapshotCsv;
export const exportFullHistoryCsv = exportInvestmentHistoryCsv;
