import { getDb } from "../db.js";
import { nowIso, roundMoney, roundPercent } from "../utils.js";
import { calculatePortfolio } from "./calculations.js";

const EXPORT_COLUMNS = [
  "section",
  "id",
  "ticker",
  "name",
  "watchlist",
  "group",
  "currency",
  "quantity",
  "price",
  "amount",
  "value_base",
  "cost_basis_base",
  "proceeds_base",
  "gain_loss_base",
  "gain_loss_percent",
  "unrealized_base",
  "unrealized_percent",
  "realized_base",
  "dividend_income_base",
  "date",
  "secondary_date",
  "direction",
  "threshold_price",
  "alert_type",
  "priority",
  "status",
  "source",
  "note",
  "details",
  "json"
];

function csvValue(value) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function toCsv(rows) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((column) => csvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function cleanNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return Number(Number(value).toFixed(digits));
}

function row(section, values = {}, raw = null) {
  const result = Object.fromEntries(EXPORT_COLUMNS.map((column) => [column, ""]));
  result.section = section;
  Object.assign(result, values);
  if (raw) result.json = JSON.stringify(raw);
  return result;
}

function exportFilename(prefix) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}

function downloadResult(filename, rows) {
  return {
    __download: true,
    filename,
    contentType: "text/csv; charset=utf-8",
    body: toCsv(rows)
  };
}

function alertStatus(alert) {
  if (alert.archived_at) return "archived";
  if (alert.triggered && !alert.acknowledged_at) return "triggered";
  if (alert.acknowledged_at) return "reviewed";
  if (alert.active) return "active";
  return "paused";
}

function baseMetadataRows(user, dashboard, exportType) {
  return [
    row("metadata", {
      id: user.id,
      currency: user.base_currency,
      amount: dashboard.summary?.totalValueBase,
      date: nowIso(),
      status: exportType,
      details: `ApexFolio ${exportType} export. Amount is total portfolio value in base currency.`
    }, {
      user: {
        id: user.id,
        email: user.email,
        baseCurrency: user.base_currency
      },
      summary: dashboard.summary
    })
  ];
}

function positionRows(dashboard, { currentOnly = false } = {}) {
  const baseCurrency = dashboard.user?.baseCurrency || dashboard.summary?.baseCurrency || "AUD";
  return (dashboard.positions || [])
    .filter((position) => !currentOnly || (!position.closed && Number(position.quantity) > 0))
    .map((position) => row(currentOnly ? "current_position" : position.closed ? "closed_or_realized_position" : "position", {
      ticker: position.ticker,
      name: position.name,
      group: position.categoryName,
      currency: position.price?.currency || baseCurrency,
      quantity: cleanNumber(position.quantity, 6),
      price: cleanNumber(position.price?.price),
      value_base: cleanNumber(position.currentValueBase),
      cost_basis_base: cleanNumber(position.costBasisBase),
      unrealized_base: cleanNumber(position.unrealizedBase),
      unrealized_percent: cleanNumber(position.unrealizedPercent),
      realized_base: cleanNumber(position.realizedBase),
      dividend_income_base: cleanNumber(position.dividendIncomeBase),
      status: position.closed ? "closed" : "open",
      details: `${position.lotCount || 0} lots. Average cost ${cleanNumber(position.averagePurchasePriceBase)} ${baseCurrency}.`
    }, position));
}

function lotRows(dashboard, { currentOnly = false } = {}) {
  const rows = [];
  for (const position of dashboard.positions || []) {
    for (const lot of position.lots || []) {
      if (currentOnly && Number(lot.quantity) <= 0) continue;
      rows.push(row(currentOnly ? "open_lot" : "lot", {
        id: lot.id,
        ticker: position.ticker,
        name: position.name,
        group: position.categoryName,
        currency: lot.purchaseCurrency,
        quantity: cleanNumber(lot.quantity, 6),
        price: cleanNumber(lot.purchasePrice),
        cost_basis_base: cleanNumber(lot.costBasisBase),
        date: lot.purchaseDate,
        status: Number(lot.quantity) > 0 ? "open" : "closed",
        source: lot.source,
        note: lot.notes,
        details: `Original quantity ${cleanNumber(lot.originalQuantity, 6)}. Sold quantity ${cleanNumber(lot.soldQuantity, 6)}.`
      }, lot));
      for (const sale of lot.sales || []) {
        rows.push(row("lot_sale_history", {
          id: sale.id,
          ticker: position.ticker,
          name: position.name,
          group: position.categoryName,
          currency: sale.saleCurrency,
          quantity: cleanNumber(sale.quantity, 6),
          price: cleanNumber(sale.salePrice),
          cost_basis_base: cleanNumber(sale.costBasisBase),
          proceeds_base: cleanNumber(sale.proceedsBase),
          gain_loss_base: cleanNumber(sale.gainLossBase),
          gain_loss_percent: cleanNumber(sale.gainLossPercent),
          date: sale.soldAt,
          source: sale.source,
          note: sale.notes
        }, sale));
      }
    }
  }
  return rows;
}

function cashRows(dashboard) {
  return (dashboard.cashBalances || []).map((cash) => row("cash_balance", {
    id: cash.id,
    currency: cash.currency,
    amount: cleanNumber(cash.amount),
    value_base: cleanNumber(cash.amountBase),
    date: cash.updatedAt || cash.updated_at,
    status: "current"
  }, cash));
}

function realizedRows(database, userId) {
  return database.prepare(`
    SELECT r.*, e.name, l.purchase_date AS lot_purchase_date, l.purchase_price AS lot_purchase_price,
      l.purchase_currency AS lot_purchase_currency, c.name AS category_name
    FROM realized_lots r
    LEFT JOIN equities e ON e.ticker = r.ticker
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at DESC, r.created_at DESC
  `).all(userId).map((sale) => {
    const external = !sale.lot_id || String(sale.source || "").toLowerCase().includes("external");
    return row(external ? "external_closed_trade" : "realized_sale", {
      id: sale.id,
      ticker: sale.ticker,
      name: sale.name,
      group: sale.category_name,
      currency: sale.sale_currency,
      quantity: cleanNumber(sale.quantity, 6),
      price: cleanNumber(sale.sale_price),
      cost_basis_base: cleanNumber(sale.cost_basis_base),
      proceeds_base: cleanNumber(sale.proceeds_base),
      gain_loss_base: cleanNumber(sale.gain_loss_base),
      gain_loss_percent: cleanNumber(sale.gain_loss_percent),
      date: sale.sold_at,
      secondary_date: sale.bought_at || sale.lot_purchase_date,
      source: sale.source,
      note: sale.notes,
      details: `Buy ${cleanNumber(sale.buy_price ?? sale.lot_purchase_price)} ${sale.buy_currency || sale.lot_purchase_currency || ""}`.trim()
    }, sale);
  });
}

function dividendRows(database, userId) {
  return database.prepare(`
    SELECT d.*, e.name, c.name AS category_name
    FROM dividend_payments d
    LEFT JOIN equities e ON e.ticker = d.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE d.user_id = ?
    ORDER BY d.ex_date DESC, d.created_at DESC
  `).all(userId).map((dividend) => row("dividend", {
    id: dividend.id,
    ticker: dividend.ticker,
    name: dividend.name,
    group: dividend.category_name,
    currency: dividend.currency,
    quantity: cleanNumber(dividend.eligible_quantity, 6),
    price: cleanNumber(dividend.amount_per_share, 6),
    amount: cleanNumber(dividend.gross_amount),
    value_base: cleanNumber(dividend.gross_amount_base),
    date: dividend.ex_date,
    secondary_date: dividend.pay_date || dividend.record_date,
    source: dividend.source,
    details: `Record ${dividend.record_date || ""}`.trim()
  }, dividend));
}

function watchlistRows(database, userId) {
  const listRows = database.prepare(`
    SELECT wl.*, COUNT(w.id) AS item_count
    FROM watchlists wl
    LEFT JOIN watchlist_items w ON w.watchlist_id = wl.id AND w.user_id = wl.user_id
    WHERE wl.user_id = ?
    GROUP BY wl.id
    ORDER BY wl.sort_order, wl.name
  `).all(userId).map((list) => row("watchlist", {
    id: list.id,
    watchlist: list.name,
    quantity: list.item_count,
    date: list.created_at,
    secondary_date: list.updated_at,
    status: "active",
    details: `Sort order ${list.sort_order}`
  }, list));

  const itemRows = database.prepare(`
    SELECT w.*, wl.name AS watchlist_name, e.name, c.name AS category_name
    FROM watchlist_items w
    JOIN watchlists wl ON wl.id = w.watchlist_id
    LEFT JOIN equities e ON e.ticker = w.ticker
    LEFT JOIN categories c ON c.id = w.category_id
    WHERE w.user_id = ?
    ORDER BY wl.sort_order, wl.name, w.ticker
  `).all(userId).map((item) => row("watchlist_item", {
    id: item.id,
    ticker: item.ticker,
    name: item.name,
    watchlist: item.watchlist_name,
    group: item.category_name,
    currency: item.currency,
    price: cleanNumber(item.target_price),
    date: item.created_at,
    secondary_date: item.updated_at,
    note: item.note,
    details: `Buy ${item.buy_zone_low || ""}-${item.buy_zone_high || ""}; Add ${item.add_zone_low || ""}-${item.add_zone_high || ""}; Fair ${item.fair_value || ""}; Trim ${item.trim_price || ""}`
  }, item));

  return [...listRows, ...itemRows];
}

function alertRows(database, userId) {
  return database.prepare(`
    SELECT a.*, e.name, wl.name AS watchlist_name, c.name AS category_name
    FROM price_alerts a
    LEFT JOIN equities e ON e.ticker = a.ticker
    LEFT JOIN watchlist_items w ON w.id = a.watchlist_item_id
    LEFT JOIN watchlists wl ON wl.id = w.watchlist_id
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `).all(userId).map((alert) => row("alert", {
    id: alert.id,
    ticker: alert.ticker,
    name: alert.company_name || alert.name,
    watchlist: alert.watchlist_name,
    group: alert.strategy_group || alert.category_name,
    currency: alert.currency,
    direction: alert.direction,
    threshold_price: cleanNumber(alert.threshold_price),
    alert_type: alert.alert_type,
    priority: alert.priority,
    status: alertStatus(alert),
    source: alert.source,
    note: alert.note || alert.label,
    date: alert.created_at,
    secondary_date: alert.last_triggered_at || alert.triggered_at || alert.acknowledged_at || alert.archived_at
  }, alert));
}

function eventRows(database, userId) {
  return database.prepare(`
    SELECT *
    FROM corporate_events
    WHERE user_id = ?
    ORDER BY event_date DESC, created_at DESC
  `).all(userId).map((event) => row("corporate_event", {
    id: event.id,
    ticker: event.ticker,
    date: event.event_date,
    secondary_date: event.notified_at,
    alert_type: event.event_type,
    status: event.notified_at ? "notified" : "tracked",
    source: event.source,
    note: event.title,
    details: event.details
  }, event));
}

function notificationRows(database, userId) {
  return database.prepare(`
    SELECT *
    FROM notification_history
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId).map((notification) => row("notification_history", {
    id: notification.id,
    ticker: notification.ticker,
    date: notification.created_at,
    secondary_date: notification.sent_at,
    alert_type: notification.kind,
    status: notification.status,
    source: notification.provider,
    note: notification.subject,
    details: notification.error || notification.recipient
  }, notification));
}

function importRows(database, userId) {
  return database.prepare(`
    SELECT *
    FROM import_batches
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId).map((batch) => row("import_batch", {
    id: batch.id,
    date: batch.created_at,
    alert_type: batch.kind,
    status: `${batch.created_count} created, ${batch.updated_count} updated, ${batch.error_count} errors`,
    source: batch.filename,
    quantity: batch.total_rows,
    details: batch.errors_json
  }, batch));
}

function marketPulseRows(database, userId) {
  return database.prepare(`
    SELECT *
    FROM market_pulse_items
    WHERE user_id = ?
    ORDER BY sort_order, display_name
  `).all(userId).map((item) => row("market_pulse_item", {
    id: item.id,
    ticker: item.symbol,
    name: item.display_name,
    group: item.category,
    status: item.active ? "active" : "inactive",
    date: item.created_at,
    secondary_date: item.updated_at,
    details: `Sort order ${item.sort_order}`
  }, item));
}

export async function exportFullHistoryCsv(userId) {
  const database = getDb();
  const user = database.prepare("SELECT id, email, base_currency FROM users WHERE id = ?").get(userId);
  const dashboard = await calculatePortfolio(userId);
  const rows = [
    ...baseMetadataRows(user, dashboard, "full_history"),
    ...positionRows(dashboard),
    ...lotRows(dashboard),
    ...realizedRows(database, userId),
    ...dividendRows(database, userId),
    ...cashRows(dashboard),
    ...watchlistRows(database, userId),
    ...alertRows(database, userId),
    ...eventRows(database, userId),
    ...notificationRows(database, userId),
    ...importRows(database, userId),
    ...marketPulseRows(database, userId)
  ];
  return downloadResult(exportFilename("apexfolio-full-history"), rows);
}

export async function exportCurrentPortfolioCsv(userId) {
  const database = getDb();
  const user = database.prepare("SELECT id, email, base_currency FROM users WHERE id = ?").get(userId);
  const dashboard = await calculatePortfolio(userId);
  const rows = [
    ...baseMetadataRows(user, dashboard, "current_portfolio"),
    ...positionRows(dashboard, { currentOnly: true }),
    ...lotRows(dashboard, { currentOnly: true }),
    ...cashRows(dashboard)
  ];
  return downloadResult(exportFilename("apexfolio-current-portfolio"), rows);
}
