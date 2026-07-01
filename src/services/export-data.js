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

const APEX_COMPLETE_COLUMNS = [
  "section",
  "record_type",
  "date",
  "ticker",
  "name",
  "group",
  "watchlist",
  "status",
  "scope",
  "currency",
  "quantity",
  "price",
  "amount",
  "market_value_aud",
  "cost_basis_aud",
  "proceeds_aud",
  "realized_gain_loss_aud",
  "unrealized_gain_loss_aud",
  "gain_loss_pct",
  "target_pct",
  "actual_pct",
  "variance_pct",
  "threshold_price",
  "direction",
  "priority",
  "source",
  "account",
  "notes",
  "created_at",
  "updated_at"
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

function completeRow(section, recordType, values = {}) {
  return {
    section,
    record_type: recordType,
    date: "",
    ticker: "",
    name: "",
    group: "",
    watchlist: "",
    status: "",
    scope: "",
    currency: "",
    quantity: "",
    price: "",
    amount: "",
    market_value_aud: "",
    cost_basis_aud: "",
    proceeds_aud: "",
    realized_gain_loss_aud: "",
    unrealized_gain_loss_aud: "",
    gain_loss_pct: "",
    target_pct: "",
    actual_pct: "",
    variance_pct: "",
    threshold_price: "",
    direction: "",
    priority: "",
    source: "",
    account: "",
    notes: "",
    created_at: "",
    updated_at: "",
    ...values
  };
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

export async function exportTransactionJournalCsv(userId) {
  const database = getDb();
  const rows = [
    ...await buyRows(database, userId),
    ...saleRows(database, userId),
    ...dividendRows(database, userId)
  ].sort((a, b) => historySortKey(a).localeCompare(historySortKey(b)));
  return downloadResult(filename("apexfolio-history"), HISTORY_COLUMNS, rows);
}

function importBatchRows(database, userId) {
  return database.prepare(`
    SELECT id, kind, filename, total_rows AS totalRows, created_count AS createdCount,
      updated_count AS updatedCount, error_count AS errorCount, created_at AS createdAt
    FROM import_batches
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId).map((item) => completeRow("imports", "uploaded_file", {
    name: item.filename,
    status: item.errorCount ? "errors" : "ok",
    quantity: item.totalRows,
    amount: item.createdCount,
    source: item.kind,
    notes: `${item.createdCount} created, ${item.updatedCount} matched/updated, ${item.errorCount} errors`,
    created_at: item.createdAt
  }));
}

function lotRows(database, userId) {
  return database.prepare(`
    SELECT l.*, e.name, c.name AS category_name
    FROM holding_lots l
    LEFT JOIN equities e ON e.ticker = l.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE l.user_id = ?
    ORDER BY l.purchase_date, l.ticker, l.created_at
  `).all(userId).map((lot) => {
    const originalQuantity = Number(lot.original_quantity) || 0;
    const openQuantity = Number(lot.quantity) || 0;
    return completeRow("lots", openQuantity > 0 ? "open_lot" : "closed_lot", {
      date: lot.purchase_date,
      ticker: lot.ticker,
      name: lot.name || "",
      group: lot.category_name || "",
      status: openQuantity > 0 ? "open" : "closed",
      currency: lot.purchase_currency,
      quantity: cleanNumber(openQuantity, 6),
      price: cleanNumber(lot.purchase_price, 6),
      amount: cleanNumber(originalQuantity, 6),
      cost_basis_aud: "",
      source: lot.source,
      account: accountFrom(lot.source, lot.notes),
      notes: `${cleanNumber(originalQuantity, 6)} bought; ${cleanNumber(openQuantity, 6)} open${lot.closed_at ? `; closed ${lot.closed_at}` : ""}`,
      created_at: lot.created_at,
      updated_at: lot.updated_at
    });
  });
}

function realizedRows(database, userId) {
  return database.prepare(`
    SELECT r.*, e.name, c.name AS category_name
    FROM realized_lots r
    LEFT JOIN equities e ON e.ticker = r.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at, r.created_at
  `).all(userId).map((sale) => completeRow("realized_sales", sale.source === "external" ? "external_closed_position" : "portfolio_sale", {
    date: sale.sold_at,
    ticker: sale.ticker,
    name: sale.name || "",
    group: sale.category_name || "",
    status: sale.source === "external" ? "closed_other_broker" : "sold",
    currency: sale.sale_currency,
    quantity: cleanNumber(sale.quantity, 6),
    price: cleanNumber(sale.sale_price, 6),
    cost_basis_aud: cleanNumber(sale.cost_basis_base),
    proceeds_aud: cleanNumber(sale.proceeds_base),
    realized_gain_loss_aud: cleanNumber(sale.gain_loss_base),
    gain_loss_pct: cleanNumber(sale.gain_loss_percent, 4),
    source: sale.source,
    account: accountFrom(sale.source, sale.notes),
    notes: sale.notes || (sale.source === "external" ? "Closed position from other broker" : ""),
    created_at: sale.created_at
  }));
}

function completeDividendRows(database, userId) {
  return database.prepare(`
    SELECT d.*, e.name, c.name AS category_name
    FROM dividend_payments d
    LEFT JOIN equities e ON e.ticker = d.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE d.user_id = ?
    ORDER BY COALESCE(d.pay_date, d.ex_date), d.created_at
  `).all(userId).map((dividend) => completeRow("dividends", "dividend", {
    date: dividend.pay_date || dividend.ex_date,
    ticker: dividend.ticker,
    name: dividend.name || "",
    group: dividend.category_name || "",
    status: "paid",
    currency: dividend.currency,
    quantity: cleanNumber(dividend.eligible_quantity, 6),
    price: cleanNumber(dividend.amount_per_share, 6),
    amount: cleanNumber(dividend.gross_amount, 6),
    proceeds_aud: cleanNumber(dividend.gross_amount_base),
    source: dividend.source,
    account: accountFrom(dividend.source, "", "Netwealth"),
    notes: `Ex-date ${dividend.ex_date}${dividend.record_date ? `; record ${dividend.record_date}` : ""}`,
    created_at: dividend.created_at,
    updated_at: dividend.updated_at
  }));
}

function externalIncomeRows(database, userId) {
  return database.prepare(`
    SELECT *
    FROM external_income_events
    WHERE user_id = ?
    ORDER BY event_date, created_at
  `).all(userId).map((event) => completeRow("external_income", String(event.event_type || "").toLowerCase(), {
    date: event.event_date,
    name: event.source_description,
    group: event.category,
    status: event.add_to_cash ? "added_to_cash" : "tracked_only",
    currency: event.currency,
    amount: cleanNumber(event.net_amount),
    proceeds_aud: cleanNumber(event.converted_amount_base),
    source: event.property_account || "external",
    account: event.property_account || "",
    notes: [
      event.notes || "",
      event.fees_tax ? `Fees/tax ${cleanNumber(event.fees_tax)}` : "",
      event.conversion_error ? `FX error: ${event.conversion_error}` : ""
    ].filter(Boolean).join("; "),
    created_at: event.created_at,
    updated_at: event.updated_at
  }));
}

function completeAlertRows(database, userId) {
  return database.prepare(`
    SELECT a.*, e.name AS equity_name, c.name AS category_name, wl.name AS watchlist_name
    FROM price_alerts a
    LEFT JOIN equities e ON e.ticker = a.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    LEFT JOIN watchlist_items w ON w.id = a.watchlist_item_id
    LEFT JOIN watchlists wl ON wl.id = w.watchlist_id
    WHERE a.user_id = ?
    ORDER BY a.archived_at IS NOT NULL, a.triggered DESC, a.active DESC, a.created_at DESC
  `).all(userId).map((alert) => completeRow("alerts", alert.alert_type || "PRICE_ALERT", {
    date: alert.last_triggered_at || alert.triggered_at || alert.created_at,
    ticker: alert.ticker,
    name: alert.company_name || alert.equity_name || "",
    group: alert.strategy_group || alert.category_name || "",
    watchlist: alert.watchlist_name || "",
    status: alertStatus(alert),
    scope: alert.scope,
    currency: alert.currency,
    threshold_price: cleanNumber(alert.threshold_price, 6),
    direction: alert.direction,
    priority: alert.priority,
    source: alert.source,
    notes: alert.label || alert.note || "",
    created_at: alert.created_at,
    updated_at: alert.updated_at
  }));
}

function watchlistRows(database, userId) {
  const lists = database.prepare(`
    SELECT id, name, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt
    FROM watchlists
    WHERE user_id = ?
    ORDER BY sort_order, name
  `).all(userId).map((list) => completeRow("watchlists", "watchlist", {
    name: list.name,
    quantity: list.sortOrder,
    created_at: list.createdAt,
    updated_at: list.updatedAt
  }));

  const items = database.prepare(`
    SELECT w.*, wl.name AS watchlist_name, e.name AS equity_name, c.name AS category_name
    FROM watchlist_items w
    JOIN watchlists wl ON wl.id = w.watchlist_id
    JOIN equities e ON e.ticker = w.ticker
    LEFT JOIN categories c ON c.id = w.category_id
    WHERE w.user_id = ?
    ORDER BY wl.sort_order, wl.name, w.ticker
  `).all(userId).map((item) => completeRow("watchlists", "watchlist_item", {
    ticker: item.ticker,
    name: item.equity_name || "",
    group: item.category_name || "",
    watchlist: item.watchlist_name,
    currency: item.currency,
    price: cleanNumber(item.target_price, 6),
    threshold_price: cleanNumber(item.trim_price, 6),
    notes: [
      item.note || "",
      item.buy_zone_low || item.buy_zone_high ? `Buy ${item.buy_zone_low || ""}-${item.buy_zone_high || ""}` : "",
      item.add_zone_low || item.add_zone_high ? `Add ${item.add_zone_low || ""}-${item.add_zone_high || ""}` : "",
      item.fair_value ? `Fair ${item.fair_value}` : ""
    ].filter(Boolean).join("; "),
    created_at: item.created_at,
    updated_at: item.updated_at
  }));

  return [...lists, ...items];
}

function corporateEventRows(database, userId) {
  return database.prepare(`
    SELECT ticker, event_type AS eventType, event_date AS eventDate, title,
      details, source, notified_at AS notifiedAt, created_at AS createdAt
    FROM corporate_events
    WHERE user_id = ?
    ORDER BY event_date DESC, created_at DESC
    LIMIT 500
  `).all(userId).map((event) => completeRow("corporate_events", event.eventType, {
    date: event.eventDate,
    ticker: event.ticker,
    name: event.title,
    status: event.notifiedAt ? "notified" : "tracked",
    source: event.source,
    notes: event.details || "",
    created_at: event.createdAt
  }));
}

function notificationRows(database, userId) {
  return database.prepare(`
    SELECT kind, ticker, recipient, subject, status, provider, error, created_at AS createdAt, sent_at AS sentAt
    FROM notification_history
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 500
  `).all(userId).map((notification) => completeRow("notifications", notification.kind, {
    date: notification.sentAt || notification.createdAt,
    ticker: notification.ticker || "",
    name: notification.subject,
    status: notification.status,
    source: notification.provider || "email",
    account: notification.recipient,
    notes: notification.error || "",
    created_at: notification.createdAt
  }));
}

export async function exportApexCompleteCsv(userId) {
  const database = getDb();
  const dashboard = await calculatePortfolio(userId);
  const baseCurrency = dashboard.user?.baseCurrency || "AUD";
  const summary = dashboard.summary || {};
  const rows = [
    completeRow("summary", "portfolio_summary", {
      date: dateStamp(),
      name: "ApexFolio complete export",
      status: "current",
      currency: baseCurrency,
      market_value_aud: cleanNumber(summary.totalValueBase),
      cost_basis_aud: cleanNumber(summary.costBasisBase),
      realized_gain_loss_aud: cleanNumber(summary.realizedGainLossBase),
      unrealized_gain_loss_aud: cleanNumber(summary.unrealizedBase),
      amount: cleanNumber(summary.cashAvailableBase),
      notes: `${summary.holdingsCount || 0} holdings; ${summary.lotCount || 0} lots; ${summary.watchlistCount || 0} watchlist items; ${summary.activeAlerts || 0} active alerts; ${summary.triggeredAlerts || 0} triggered alerts`
    }),
    ...dashboard.allocation.map((group) => completeRow("groups_allocations", "allocation_group", {
      name: group.name,
      group: group.name,
      status: group.status,
      currency: baseCurrency,
      market_value_aud: cleanNumber(group.subtotalBase),
      target_pct: cleanNumber(group.targetPercent, 4),
      actual_pct: cleanNumber(group.actualPercent, 4),
      variance_pct: cleanNumber(group.variancePercent, 4),
      amount: cleanNumber(group.missingOrExcessBase),
      notes: group.id
    })),
    ...database.prepare(`
      SELECT id, name, target_percent AS targetPercent, sort_order AS sortOrder, color, active
      FROM categories
      ORDER BY sort_order, name
    `).all().map((group) => completeRow("groups_allocations", "group_setting", {
      name: group.name,
      group: group.name,
      status: group.active ? "active" : "inactive",
      target_pct: cleanNumber(group.targetPercent, 4),
      quantity: group.sortOrder,
      source: group.color,
      notes: group.id
    })),
    ...dashboard.positions.map((position) => completeRow("portfolio", position.closed ? "closed_position_summary" : "holding_summary", {
      ticker: position.ticker,
      name: position.name || "",
      group: position.categoryName || "",
      status: position.closed ? "closed" : "open",
      currency: position.price?.currency || position.lots?.[0]?.purchaseCurrency || "",
      quantity: cleanNumber(position.quantity, 6),
      price: cleanNumber(position.price?.price, 6),
      market_value_aud: cleanNumber(position.currentValueBase),
      cost_basis_aud: cleanNumber(position.costBasisBase),
      realized_gain_loss_aud: cleanNumber(position.realizedGainLossBase),
      unrealized_gain_loss_aud: cleanNumber(position.unrealizedBase),
      gain_loss_pct: cleanNumber(position.unrealizedPercent, 4),
      actual_pct: weight(position.currentValueBase, summary.totalValueBase),
      notes: position.riskNote || ""
    })),
    ...dashboard.cashBalances.map((cash) => completeRow("cash", "cash_balance", {
      ticker: cash.currency,
      name: `Cash ${cash.currency}`,
      group: "Cash",
      status: cash.currency === "GBP" ? "manual" : "tracked",
      currency: cash.currency,
      amount: cleanNumber(cash.amount, 6),
      market_value_aud: cleanNumber(cash.amountBase),
      actual_pct: weight(cash.amountBase, summary.totalValueBase),
      updated_at: cash.updatedAt || cash.updated_at || ""
    })),
    ...lotRows(database, userId),
    ...realizedRows(database, userId),
    ...completeDividendRows(database, userId),
    ...externalIncomeRows(database, userId),
    ...watchlistRows(database, userId),
    ...completeAlertRows(database, userId),
    ...corporateEventRows(database, userId),
    ...notificationRows(database, userId),
    ...importBatchRows(database, userId)
  ];

  return downloadResult(filename("apexfolio-complete"), APEX_COMPLETE_COLUMNS, rows);
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
export const exportFullHistoryCsv = exportApexCompleteCsv;
export const exportInvestmentHistoryCsv = exportApexCompleteCsv;
