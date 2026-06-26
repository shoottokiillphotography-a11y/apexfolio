import { getDb } from "../db.js";
import { id, InputError, nowIso, roundMoney, roundPercent, roundShares, toNumber } from "../utils.js";
import { calculatePortfolio } from "./calculations.js";
import { convertAmount, getExchangeRate } from "./currency.js";

const OPENING_BALANCE_KEY = "portfolio_wealth_opening_balance";
const RANGE_FILTERS = new Set(["1d", "month", "1mo", "ytd", "1y", "3y", "5y", "all"]);
const SNAPSHOT_SOURCE_AUTO = "auto";
const SNAPSHOT_SOURCE_MANUAL = "manual";

function toDateOnly(value) {
  return String(value || "").slice(0, 10);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeRange(input) {
  const range = String(input || "all").toLowerCase();
  if (range === "1m") return "month";
  return RANGE_FILTERS.has(range) ? range : "all";
}

function rangeStart(range, firstInvestmentDate) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const today = isoDate(now);
  if (range === "all") return firstInvestmentDate || today;
  if (range === "1d") {
    now.setUTCDate(now.getUTCDate() - 1);
  } else if (range === "month" || range === "1mo") {
    now.setUTCMonth(now.getUTCMonth() - 1);
  } else if (range === "ytd") {
    now.setUTCMonth(0, 1);
  } else {
    const years = range === "1y" ? 1 : range === "3y" ? 3 : range === "5y" ? 5 : 0;
    now.setUTCFullYear(now.getUTCFullYear() - years);
  }
  const start = isoDate(now);
  return firstInvestmentDate && start < firstInvestmentDate ? firstInvestmentDate : start;
}

function assertDate(value, field = "Date") {
  const date = toDateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InputError(`${field} must be YYYY-MM-DD`);
  return date;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}

async function convertToBase(amount, currency, baseCurrency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  const from = String(currency || baseCurrency).toUpperCase();
  const to = String(baseCurrency || from).toUpperCase();
  if (from === to) return roundMoney(numeric);
  const converted = await convertAmount(numeric, from, to);
  return converted?.amount == null ? null : roundMoney(converted.amount);
}

async function rateFor(fromCurrency, toCurrency, cache) {
  const from = String(fromCurrency || toCurrency).toUpperCase();
  const to = String(toCurrency || from).toUpperCase();
  if (from === to) return 1;
  const key = `${from}_${to}`;
  if (!cache.has(key)) {
    const fx = await getExchangeRate(from, to);
    cache.set(key, fx.rate);
  }
  return cache.get(key);
}

function getSetting(database, userId, key) {
  const row = database.prepare("SELECT value_json FROM app_settings WHERE user_id = ? AND key = ?").get(userId, key);
  if (!row?.value_json) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function saveSetting(database, userId, key, value) {
  database.prepare(`
    INSERT INTO app_settings (user_id, key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(userId, key, JSON.stringify(value), nowIso());
}

function parseOpeningBalance(database, userId, baseCurrency, firstInvestmentDate) {
  const saved = getSetting(database, userId, OPENING_BALANCE_KEY) || {};
  const amountBase = Number(saved.amountBase);
  return {
    date: toDateOnly(saved.date || firstInvestmentDate),
    amount: Number(saved.amount) || (Number.isFinite(amountBase) ? amountBase : 0),
    currency: saved.currency || baseCurrency,
    amountBase: Number.isFinite(amountBase) ? amountBase : 0,
    notes: saved.notes || "",
    configured: Number.isFinite(amountBase) && Math.abs(amountBase) > 0
  };
}

function loadLots(database, userId) {
  return database.prepare(`
    SELECT l.*, e.name, e.currency AS equity_currency, c.name AS category_name
    FROM holding_lots l
    JOIN equities e ON e.ticker = l.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE l.user_id = ? AND l.original_quantity > 0
    ORDER BY l.purchase_date, l.created_at
  `).all(userId).map((lot) => ({
    id: lot.id,
    ticker: lot.ticker,
    name: lot.name,
    categoryName: lot.category_name,
    originalQuantity: Number(lot.original_quantity) || 0,
    quantity: Number(lot.quantity) || 0,
    purchasePrice: Number(lot.purchase_price) || 0,
    purchaseCurrency: lot.purchase_currency,
    purchaseDate: toDateOnly(lot.purchase_date),
    equityCurrency: lot.equity_currency,
    source: lot.source,
    notes: lot.notes
  }));
}

function loadSales(database, userId) {
  return database.prepare(`
    SELECT r.*, e.name, e.currency AS equity_currency, c.name AS category_name,
      l.purchase_price AS lot_purchase_price, l.purchase_currency AS lot_purchase_currency,
      l.purchase_date AS lot_purchase_date
    FROM realized_lots r
    LEFT JOIN equities e ON e.ticker = r.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at, r.created_at
  `).all(userId).map((row) => ({
    id: row.id,
    ticker: row.ticker,
    name: row.name,
    categoryName: row.category_name,
    lotId: row.lot_id || null,
    syntheticLotId: row.lot_id || `external_${row.id}`,
    quantity: Number(row.quantity) || 0,
    salePrice: Number(row.sale_price) || 0,
    saleCurrency: row.sale_currency,
    soldAt: toDateOnly(row.sold_at),
    costBasisBase: Number(row.cost_basis_base) || 0,
    proceedsBase: Number(row.proceeds_base) || 0,
    gainLossBase: Number(row.gain_loss_base) || 0,
    gainLossPercent: Number(row.gain_loss_percent),
    source: row.source,
    notes: row.notes,
    buyPrice: Number(row.buy_price ?? row.lot_purchase_price) || 0,
    buyCurrency: row.buy_currency || row.lot_purchase_currency || row.sale_currency,
    boughtAt: toDateOnly(row.bought_at || row.lot_purchase_date),
    equityCurrency: row.equity_currency
  }));
}

function syntheticLotsFromSales(sales, existingLotIds) {
  const seen = new Set();
  const lots = [];
  for (const sale of sales) {
    if (sale.lotId && existingLotIds.has(sale.lotId)) continue;
    if (!sale.boughtAt || !sale.buyPrice || !sale.quantity) continue;
    if (seen.has(sale.syntheticLotId)) continue;
    seen.add(sale.syntheticLotId);
    lots.push({
      id: sale.syntheticLotId,
      ticker: sale.ticker,
      name: sale.name,
      categoryName: sale.categoryName,
      originalQuantity: sale.quantity,
      quantity: 0,
      purchasePrice: sale.buyPrice,
      purchaseCurrency: sale.buyCurrency,
      purchaseDate: sale.boughtAt,
      equityCurrency: sale.equityCurrency,
      source: sale.source || "external",
      notes: sale.notes
    });
  }
  return lots;
}

function salesByLot(sales) {
  const map = new Map();
  for (const sale of sales) {
    const lotId = sale.lotId || sale.syntheticLotId;
    if (!lotId) continue;
    if (!map.has(lotId)) map.set(lotId, []);
    map.get(lotId).push(sale);
  }
  return map;
}

function quantityHeldAtDate(lot, saleMap, date) {
  if (!lot.purchaseDate || date < lot.purchaseDate) return 0;
  let quantity = Number(lot.originalQuantity) || 0;
  for (const sale of saleMap.get(lot.id) || []) {
    if (sale.soldAt && sale.soldAt <= date) quantity -= Number(sale.quantity) || 0;
  }
  return Math.max(0, quantity);
}

function loadDividends(database, userId) {
  return database.prepare(`
    SELECT d.*, e.name, c.name AS category_name
    FROM dividend_payments d
    LEFT JOIN equities e ON e.ticker = d.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE d.user_id = ?
    ORDER BY COALESCE(d.pay_date, d.ex_date), d.created_at
  `).all(userId).map((row) => ({
    id: row.id,
    date: toDateOnly(row.pay_date || row.ex_date),
    type: "dividend",
    ticker: row.ticker,
    source: row.ticker,
    amountBase: Number(row.gross_amount_base) || 0,
    amountOriginal: Number(row.gross_amount) || 0,
    currency: row.currency,
    details: {
      name: row.name,
      categoryName: row.category_name,
      eligibleQuantity: roundShares(row.eligible_quantity),
      amountPerShare: row.amount_per_share,
      exDate: row.ex_date,
      payDate: row.pay_date,
      source: row.source
    }
  })).filter((event) => event.date);
}

async function loadExternalEvents(database, userId, baseCurrency) {
  const rows = database.prepare(`
    SELECT *
    FROM external_income_events
    WHERE user_id = ?
    ORDER BY event_date, created_at
  `).all(userId);
  const events = [];
  for (const row of rows) {
    const amountBase = row.converted_amount_base != null
      ? Number(row.converted_amount_base)
      : await convertToBase(row.net_amount, row.currency, baseCurrency);
    const type = row.event_type === "EXPENSE" || Number(row.net_amount) < 0 ? "external_expense" : "external_income";
    const signedAmountBase = amountBase == null
      ? null
      : type === "external_expense"
        ? -Math.abs(Number(amountBase))
        : Number(amountBase);
    const signedOriginalAmount = type === "external_expense"
      ? -Math.abs(Number(row.net_amount) || 0)
      : Number(row.net_amount) || 0;
    events.push({
      id: row.id,
      date: toDateOnly(row.event_date),
      type,
      source: row.source_description,
      amountBase: signedAmountBase == null ? null : roundMoney(signedAmountBase),
      amountOriginal: signedOriginalAmount,
      currency: row.currency,
      affectsCash: Boolean(row.add_to_cash),
      affectsInvestmentReturn: false,
      details: {
        category: row.category,
        description: row.source_description,
        grossAmount: row.gross_amount,
        feesTax: row.fees_tax,
        netAmount: row.net_amount,
        propertyAccount: row.property_account,
        addToCash: Boolean(row.add_to_cash),
        notes: row.notes
      }
    });
  }
  return events.filter((event) => event.date);
}

async function lotCostBase(lot, quantity, baseCurrency, fxCache) {
  const rate = await rateFor(lot.purchaseCurrency, baseCurrency, fxCache);
  return (Number(quantity) || 0) * (Number(lot.purchasePrice) || 0) * rate;
}

function saleRealizedEvent(sale) {
  return {
    id: sale.id,
    date: sale.soldAt,
    type: "share_sale",
    transactionType: "share_sale",
    ticker: sale.ticker,
    source: sale.source === "external" ? "External closed trade" : sale.ticker,
    amountBase: roundMoney(sale.gainLossBase || 0),
    amountOriginal: roundMoney(sale.gainLossBase || 0),
    currency: null,
    details: {
      quantity: roundShares(sale.quantity),
      salePrice: sale.salePrice,
      saleCurrency: sale.saleCurrency,
      costBasisBase: roundMoney(sale.costBasisBase),
      proceedsBase: roundMoney(sale.proceedsBase),
      gainLossBase: roundMoney(sale.gainLossBase),
      gainLossPercent: Number.isFinite(sale.gainLossPercent) ? roundPercent(sale.gainLossPercent) : null,
      lotId: sale.lotId || sale.syntheticLotId,
      source: sale.source,
      notes: sale.notes
    }
  };
}

function saleCashEvent(sale) {
  return {
    id: sale.id,
    date: sale.soldAt,
    type: "share_sale",
    ticker: sale.ticker,
    source: sale.ticker,
    amountBase: roundMoney(sale.proceedsBase || 0),
    realizedGainLossBase: roundMoney(sale.gainLossBase || 0),
    affectsCash: true,
    affectsInvestmentReturn: true,
    details: {
      quantity: roundShares(sale.quantity),
      salePrice: sale.salePrice,
      saleCurrency: sale.saleCurrency,
      proceedsBase: roundMoney(sale.proceedsBase),
      costBasisBase: roundMoney(sale.costBasisBase),
      gainLossBase: roundMoney(sale.gainLossBase),
      lotId: sale.lotId || sale.syntheticLotId,
      notes: sale.notes
    }
  };
}

function dividendRealizedEvent(dividend) {
  return {
    ...dividend,
    transactionType: "dividend",
    amountBase: roundMoney(dividend.amountBase || 0)
  };
}

function externalRealizedEvent(event) {
  return {
    ...event,
    transactionType: event.type,
    amountBase: event.amountBase == null ? null : roundMoney(event.amountBase)
  };
}

function buyCashEvent(lot, amountBase) {
  return {
    id: `buy_${lot.id}`,
    date: lot.purchaseDate,
    type: "buy",
    ticker: lot.ticker,
    source: lot.ticker,
    amountBase: -roundMoney(amountBase || 0),
    affectsCash: true,
    affectsInvestmentReturn: false,
    details: {
      quantity: roundShares(lot.originalQuantity),
      price: lot.purchasePrice,
      currency: lot.purchaseCurrency,
      note: lot.notes
    }
  };
}

function pointSummary(points, key) {
  const first = points.find((point) => point[key] != null);
  const last = [...points].reverse().find((point) => point[key] != null);
  const change = first && last ? roundMoney(Number(last[key]) - Number(first[key])) : null;
  return {
    startValue: first?.[key] ?? null,
    endValue: last?.[key] ?? null,
    changeValue: change,
    changePercent: first?.[key] ? roundPercent((change / first[key]) * 100) : null
  };
}

function thinDates(dates, maxPoints = 280) {
  const sorted = [...new Set(dates)].filter(Boolean).sort();
  if (sorted.length <= maxPoints) return sorted;
  const step = (sorted.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => sorted[Math.round(index * step)])
    .filter((date, index, rows) => index === 0 || date !== rows[index - 1]);
}

function groupEventsByDate(events) {
  const map = new Map();
  for (const event of events) {
    if (!event.date) continue;
    if (!map.has(event.date)) map.set(event.date, []);
    map.get(event.date).push(event);
  }
  return map;
}

function buildRealizedGrowth(events, range, firstTransactionDate, baseCurrency) {
  const startDate = rangeStart(range, firstTransactionDate);
  const usableEvents = events
    .filter((event) => event.date && event.date >= startDate && event.amountBase != null)
    .sort((a, b) => `${a.date}|${a.type}|${a.id}`.localeCompare(`${b.date}|${b.type}|${b.id}`));
  const firstDate = range === "all" ? (firstTransactionDate || usableEvents[0]?.date || isoDate(new Date())) : startDate;
  const points = [{
    date: firstDate,
    time: `${firstDate}T00:00:00.000Z`,
    cumulativeRealizedBase: 0,
    eventAmountBase: 0,
    events: [],
    baseCurrency
  }];
  let running = 0;
  for (const [date, dateEvents] of groupEventsByDate(usableEvents)) {
    const eventAmountBase = roundMoney(sum(dateEvents.map((event) => event.amountBase)));
    running = roundMoney(running + eventAmountBase);
    points.push({
      date,
      time: `${date}T00:00:00.000Z`,
      cumulativeRealizedBase: running,
      eventAmountBase,
      events: dateEvents,
      baseCurrency
    });
  }
  return {
    points,
    events: usableEvents,
    summary: pointSummary(points, "cumulativeRealizedBase")
  };
}

async function buildBookValue({ lots, sales, saleMap, dividends, externalEvents, openingBalance, dashboard, range, firstInvestmentDate, baseCurrency }) {
  const fxCache = new Map();
  const today = isoDate(new Date());
  const startDate = rangeStart(range, firstInvestmentDate);
  const buyEvents = [];
  for (const lot of lots) {
    buyEvents.push(buyCashEvent(lot, await lotCostBase(lot, lot.originalQuantity, baseCurrency, fxCache)));
  }
  const openingEvent = {
    id: "opening_balance",
    date: openingBalance.date || firstInvestmentDate,
    type: "opening_balance",
    source: "Opening Portfolio Balance",
    amountBase: roundMoney(openingBalance.amountBase || 0),
    affectsCash: true,
    affectsInvestmentReturn: false,
    details: {
      currency: openingBalance.currency,
      amount: openingBalance.amount,
      notes: openingBalance.notes
    }
  };
  const cashEvents = [
    openingEvent,
    ...buyEvents,
    ...sales.map(saleCashEvent),
    ...dividends.map((event) => ({ ...event, amountBase: roundMoney(event.amountBase || 0), affectsCash: true })),
    ...externalEvents.filter((event) => event.affectsCash)
  ].filter((event) => event.date && Number.isFinite(Number(event.amountBase)));

  const reconstructedCashToday = roundMoney(cashEvents
    .filter((event) => event.date <= today)
    .reduce((total, event) => total + Number(event.amountBase || 0), 0));
  const dashboardCashBase = roundMoney(Number(dashboard.summary?.cashAvailableBase) || 0);
  const cashReconciliationBase = roundMoney(dashboardCashBase - reconstructedCashToday);
  let reconciliationEvent = null;
  if (Math.abs(cashReconciliationBase) >= 0.01) {
    reconciliationEvent = {
      id: "cash_reconciliation",
      date: today,
      type: cashReconciliationBase >= 0 ? "deposit" : "withdrawal",
      source: cashReconciliationBase >= 0 ? "Unrecorded deposit / cash reconciliation" : "Unrecorded withdrawal / cash reconciliation",
      amountBase: cashReconciliationBase,
      affectsCash: true,
      affectsInvestmentReturn: false,
      estimated: true,
      details: {
        notes: "Reconciles reconstructed cash to the current Dashboard cash balance. It is capital movement, not profit."
      }
    };
    cashEvents.push(reconciliationEvent);
  }

  const dateSet = new Set([startDate, today]);
  for (const lot of lots) if (lot.purchaseDate >= startDate) dateSet.add(lot.purchaseDate);
  for (const event of cashEvents) if (event.date >= startDate && event.date <= today) dateSet.add(event.date);
  const dates = thinDates([...dateSet], 280);
  const cashByDate = groupEventsByDate(cashEvents);
  const points = [];
  for (const date of dates) {
    let remainingCostBasisBase = 0;
    for (const lot of lots) {
      const quantity = quantityHeldAtDate(lot, saleMap, date);
      if (quantity <= 0) continue;
      remainingCostBasisBase += await lotCostBase(lot, quantity, baseCurrency, fxCache);
    }
    const eventsToDate = cashEvents.filter((event) => event.date <= date);
    const cashValueBase = roundMoney(sum(eventsToDate.map((event) => event.amountBase)));
    const netCapitalContributedBase = roundMoney(eventsToDate
      .filter((event) => ["opening_balance", "deposit", "withdrawal"].includes(event.type))
      .reduce((total, event) => total + Number(event.amountBase || 0), 0));
    points.push({
      date,
      time: `${date}T00:00:00.000Z`,
      remainingCostBasisBase: roundMoney(remainingCostBasisBase),
      cashValueBase,
      bookValueBase: roundMoney(remainingCostBasisBase + cashValueBase),
      netCapitalContributedBase,
      events: cashByDate.get(date) || [],
      estimated: Boolean(date === today && reconciliationEvent)
    });
  }
  const total = pointSummary(points, "bookValueBase");
  return {
    points,
    events: cashEvents.filter((event) => event.date >= startDate && event.date <= today),
    summary: {
      ...total,
      currentOpenCostBasisBase: roundMoney(Number(dashboard.summary?.costBasisBase) || 0),
      currentCashBase: dashboardCashBase,
      netCapitalContributedBase: points.at(-1)?.netCapitalContributedBase || 0,
      cashReconciliationBase,
      reconstructedCashToday
    },
    label: "Book value - does not include historical unrealized market gains."
  };
}

function snapshotFromRow(row) {
  let fxRates = {};
  try {
    fxRates = row.fx_rates_json ? JSON.parse(row.fx_rates_json) : {};
  } catch {
    fxRates = {};
  }
  return {
    id: row.id,
    date: row.snapshot_date,
    time: row.snapshot_time,
    holdingsValueBase: roundMoney(row.holdings_value_base),
    cashValueBase: roundMoney(row.cash_value_base),
    totalValueBase: roundMoney(row.total_value_base),
    currency: row.currency,
    fxRates,
    dataCoveragePercent: row.data_coverage_percent == null ? null : roundPercent(row.data_coverage_percent),
    provider: row.provider,
    source: row.source,
    sourceType: row.source_type,
    manual: row.source_type === SNAPSHOT_SOURCE_MANUAL,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadSnapshots(database, userId, startDate) {
  return database.prepare(`
    SELECT *
    FROM portfolio_snapshots
    WHERE user_id = ?
      AND snapshot_date >= ?
    ORDER BY snapshot_date, snapshot_time, source_type
  `).all(userId, startDate).map(snapshotFromRow);
}

function snapshotSummary(points) {
  return {
    ...pointSummary(points, "totalValueBase"),
    snapshotCount: points.length,
    manualSnapshotCount: points.filter((point) => point.manual).length,
    automaticSnapshotCount: points.filter((point) => !point.manual).length
  };
}

function buildActualPortfolioValue(database, userId, range, firstInvestmentDate) {
  const startDate = rangeStart(range, firstInvestmentDate);
  const snapshots = loadSnapshots(database, userId, startDate);
  const points = snapshots.map((snapshot) => ({
    ...snapshot,
    time: snapshot.time,
    chartKind: "snapshot",
    sourceLabel: snapshot.manual ? "Manual broker snapshot" : "Automatic app snapshot"
  }));
  return {
    points,
    snapshots,
    summary: snapshotSummary(points),
    dataQuality: {
      interpolation: "none; only saved market-value snapshots are plotted",
      noFakeHistoricalPrices: true,
      hasSnapshots: points.length > 0
    }
  };
}

function currentUser(database, userId) {
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new InputError("User not found", 404);
  return user;
}

function firstTransactionDate(lots, sales, dividends, externalEvents) {
  return [
    ...lots.map((lot) => lot.purchaseDate),
    ...sales.map((sale) => sale.boughtAt || sale.soldAt),
    ...dividends.map((dividend) => dividend.date),
    ...externalEvents.map((event) => event.date)
  ].filter(Boolean).sort()[0] || isoDate(new Date());
}

function realizedSummary(realizedEvents) {
  const shareSales = realizedEvents.filter((event) => event.type === "share_sale");
  const dividends = realizedEvents.filter((event) => event.type === "dividend");
  const externalIncome = realizedEvents.filter((event) => event.type === "external_income");
  const externalExpenses = realizedEvents.filter((event) => event.type === "external_expense");
  const netRealizedPnlBase = roundMoney(sum(shareSales.map((event) => event.amountBase)));
  const dividendsBase = roundMoney(sum(dividends.map((event) => event.amountBase)));
  const externalIncomeBase = roundMoney(sum(externalIncome.map((event) => event.amountBase)));
  const externalExpensesBase = roundMoney(sum(externalExpenses.map((event) => event.amountBase)));
  return {
    netRealizedPnlBase,
    dividendsBase,
    externalIncomeBase,
    externalExpensesBase,
    realizedGrowthTotalBase: roundMoney(netRealizedPnlBase + dividendsBase + externalIncomeBase + externalExpensesBase)
  };
}

function buildWealthBridge({ summary, bookValue, dashboard }) {
  const baseCurrency = dashboard?.user?.baseCurrency || dashboard?.user?.base_currency || null;
  const currentPortfolioMarketValueBase = roundMoney(Number(summary.currentPortfolioMarketValueBase) || 0);
  const netCapitalContributedBase = roundMoney(Number(summary.netCapitalContributedBase) || 0);
  const netRealizedPnlBase = roundMoney(Number(summary.netRealizedPnlBase) || 0);
  const dividendsBase = roundMoney(Number(summary.dividendsBase) || 0);
  const cashExternalEvents = (bookValue?.events || [])
    .filter((event) => ["external_income", "external_expense"].includes(event.type));
  const externalCashBase = roundMoney(sum(cashExternalEvents.map((event) => event.amountBase)));
  const unrealizedPnlBase = roundMoney(Number(dashboard?.summary?.unrealizedBase) || 0);
  const explainedBase = roundMoney(
    netCapitalContributedBase +
    netRealizedPnlBase +
    dividendsBase +
    externalCashBase +
    unrealizedPnlBase
  );
  const reconciliationBase = roundMoney(currentPortfolioMarketValueBase - explainedBase);
  const items = [
    {
      key: "net_capital",
      label: "Net capital contributed",
      amountBase: netCapitalContributedBase,
      kind: "capital",
      description: "Opening balance, deposits, withdrawals and cash reconciliation movements."
    },
    {
      key: "realized_pnl",
      label: "Realized share P&L",
      amountBase: netRealizedPnlBase,
      kind: "investment",
      description: "Confirmed gains and losses from sold shares."
    },
    {
      key: "dividends",
      label: "Dividends",
      amountBase: dividendsBase,
      kind: "income",
      description: "CSV/imported dividend income."
    },
    {
      key: "external_cash",
      label: "External cash items",
      amountBase: externalCashBase,
      kind: "external",
      description: "Only external income or expenses marked Add to cash."
    },
    {
      key: "unrealized_pnl",
      label: "Unrealized P&L",
      amountBase: unrealizedPnlBase,
      kind: "investment",
      description: "Current market value of open holdings minus open-lot cost basis."
    },
    {
      key: "reconciliation",
      label: "Unreconciled / FX / fees",
      amountBase: reconciliationBase,
      kind: "reconciliation",
      description: "Difference needed to reconcile the bridge to the Dashboard total."
    }
  ];
  return {
    baseCurrency,
    items,
    explainedBase,
    reconciliationBase,
    currentPortfolioMarketValueBase,
    formula: "current value = net capital + realized P&L + dividends + external cash items + unrealized P&L + reconciliation"
  };
}

export async function saveOpeningPortfolioBalance(userId, input = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const amount = toNumber(input.amount, null);
  if (amount == null || amount < 0) throw new InputError("Opening balance amount is required");
  const currency = String(input.currency || user.base_currency).trim().toUpperCase();
  const amountBase = await convertToBase(amount, currency, user.base_currency);
  if (amountBase == null) throw new InputError(`FX unavailable for ${currency}/${user.base_currency}`);
  const date = input.date ? assertDate(input.date, "Opening balance date") : "";
  const payload = {
    amount,
    currency,
    amountBase,
    date,
    notes: String(input.notes || "").trim(),
    updatedAt: nowIso()
  };
  saveSetting(database, userId, OPENING_BALANCE_KEY, payload);
  return { openingBalance: payload };
}

export function saveAutomaticPortfolioSnapshot(userId, dashboard) {
  const database = getDb();
  const user = currentUser(database, userId);
  const payload = dashboard || null;
  if (!payload?.summary) return null;
  const date = isoDate(new Date());
  const time = nowIso();
  const openPositions = (payload.positions || []).filter((position) => !position.closed && Number(position.quantity) > 0);
  const coveredPositions = openPositions.filter((position) => Number(position.price?.price) > 0);
  const coverage = openPositions.length ? roundPercent((coveredPositions.length / openPositions.length) * 100) : 100;
  const providers = [...new Set(openPositions.map((position) => position.price?.provider).filter(Boolean))];
  const holdingsValueBase = roundMoney((Number(payload.summary.totalValueBase) || 0) - (Number(payload.summary.cashAvailableBase) || 0));
  const cashValueBase = roundMoney(Number(payload.summary.cashAvailableBase) || 0);
  const totalValueBase = roundMoney(Number(payload.summary.totalValueBase) || holdingsValueBase + cashValueBase);
  const existing = database.prepare(`
    SELECT *
    FROM portfolio_snapshots
    WHERE user_id = ? AND snapshot_date = ? AND source_type = ?
  `).get(userId, date, SNAPSHOT_SOURCE_AUTO);
  if (existing && Number(existing.data_coverage_percent || 0) > coverage) return snapshotFromRow(existing);
  const snapshotId = existing?.id || id("snap");
  database.prepare(`
    INSERT INTO portfolio_snapshots (
      id, user_id, snapshot_date, snapshot_time, holdings_value_base, cash_value_base,
      total_value_base, currency, fx_rates_json, data_coverage_percent, provider,
      source, source_type, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, snapshot_date, source_type) DO UPDATE SET
      snapshot_time = excluded.snapshot_time,
      holdings_value_base = excluded.holdings_value_base,
      cash_value_base = excluded.cash_value_base,
      total_value_base = excluded.total_value_base,
      currency = excluded.currency,
      fx_rates_json = excluded.fx_rates_json,
      data_coverage_percent = excluded.data_coverage_percent,
      provider = excluded.provider,
      source = excluded.source,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    snapshotId,
    userId,
    date,
    time,
    holdingsValueBase,
    cashValueBase,
    totalValueBase,
    user.base_currency,
    JSON.stringify({ baseCurrency: user.base_currency }),
    coverage,
    providers.join(" + ") || "dashboard",
    "Automatic app snapshot",
    SNAPSHOT_SOURCE_AUTO,
    `${coveredPositions.length}/${openPositions.length} open positions had saved prices`,
    existing?.created_at || time,
    time
  );
  return snapshotFromRow(database.prepare("SELECT * FROM portfolio_snapshots WHERE id = ?").get(snapshotId));
}

async function manualSnapshotPayload(user, input = {}) {
  const date = assertDate(input.date || input.snapshotDate, "Snapshot date");
  const currency = String(input.currency || user.base_currency).trim().toUpperCase();
  const holdingsValue = toNumber(input.holdingsValue ?? input.holdings_value ?? input.holdingsValueBase, null);
  const cashValue = toNumber(input.cashValue ?? input.cash_value ?? input.cashValueBase, null);
  if (holdingsValue == null || holdingsValue < 0) throw new InputError("Holdings value is required");
  if (cashValue == null || cashValue < 0) throw new InputError("Cash value is required");
  const holdingsValueBase = await convertToBase(holdingsValue, currency, user.base_currency);
  const cashValueBase = await convertToBase(cashValue, currency, user.base_currency);
  if (holdingsValueBase == null || cashValueBase == null) throw new InputError(`FX unavailable for ${currency}/${user.base_currency}`);
  return {
    date,
    time: `${date}T12:00:00.000Z`,
    holdingsValueBase,
    cashValueBase,
    totalValueBase: roundMoney(holdingsValueBase + cashValueBase),
    currency,
    provider: "manual",
    source: String(input.source || input.brokerSource || "Manual broker snapshot").trim() || "Manual broker snapshot",
    notes: String(input.notes || "").trim(),
    coverage: 100
  };
}

export async function createManualPortfolioSnapshot(userId, input = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const payload = await manualSnapshotPayload(user, input);
  const snapshotId = id("snap");
  const now = nowIso();
  database.prepare(`
    INSERT INTO portfolio_snapshots (
      id, user_id, snapshot_date, snapshot_time, holdings_value_base, cash_value_base,
      total_value_base, currency, fx_rates_json, data_coverage_percent, provider,
      source, source_type, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, snapshot_date, source_type) DO UPDATE SET
      snapshot_time = excluded.snapshot_time,
      holdings_value_base = excluded.holdings_value_base,
      cash_value_base = excluded.cash_value_base,
      total_value_base = excluded.total_value_base,
      currency = excluded.currency,
      fx_rates_json = excluded.fx_rates_json,
      data_coverage_percent = excluded.data_coverage_percent,
      provider = excluded.provider,
      source = excluded.source,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    snapshotId,
    userId,
    payload.date,
    payload.time,
    payload.holdingsValueBase,
    payload.cashValueBase,
    payload.totalValueBase,
    payload.currency,
    JSON.stringify({ enteredCurrency: payload.currency, baseCurrency: user.base_currency }),
    payload.coverage,
    payload.provider,
    payload.source,
    SNAPSHOT_SOURCE_MANUAL,
    payload.notes,
    now,
    now
  );
  return { snapshot: snapshotFromRow(database.prepare(`
    SELECT *
    FROM portfolio_snapshots
    WHERE user_id = ? AND snapshot_date = ? AND source_type = ?
  `).get(userId, payload.date, SNAPSHOT_SOURCE_MANUAL)) };
}

export async function updateManualPortfolioSnapshot(userId, snapshotId, input = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const existing = database.prepare(`
    SELECT *
    FROM portfolio_snapshots
    WHERE id = ? AND user_id = ? AND source_type = ?
  `).get(snapshotId, userId, SNAPSHOT_SOURCE_MANUAL);
  if (!existing) throw new InputError("Manual portfolio snapshot not found", 404);
  const payload = await manualSnapshotPayload(user, input);
  database.prepare(`
    UPDATE portfolio_snapshots
    SET snapshot_date = ?, snapshot_time = ?, holdings_value_base = ?, cash_value_base = ?,
      total_value_base = ?, currency = ?, fx_rates_json = ?, data_coverage_percent = ?,
      provider = ?, source = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND source_type = ?
  `).run(
    payload.date,
    payload.time,
    payload.holdingsValueBase,
    payload.cashValueBase,
    payload.totalValueBase,
    payload.currency,
    JSON.stringify({ enteredCurrency: payload.currency, baseCurrency: user.base_currency }),
    payload.coverage,
    payload.provider,
    payload.source,
    payload.notes,
    nowIso(),
    snapshotId,
    userId,
    SNAPSHOT_SOURCE_MANUAL
  );
  return { snapshot: snapshotFromRow(database.prepare("SELECT * FROM portfolio_snapshots WHERE id = ?").get(snapshotId)) };
}

export function deletePortfolioSnapshot(userId, snapshotId) {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM portfolio_snapshots
    WHERE id = ? AND user_id = ? AND source_type = ?
  `).run(snapshotId, userId, SNAPSHOT_SOURCE_MANUAL);
  if (!result.changes) throw new InputError("Manual portfolio snapshot not found", 404);
  return { ok: true };
}

export async function portfolioWealthTimeline(userId, options = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const baseCurrency = user.base_currency;
  const range = normalizeRange(options.range);
  const dashboard = await calculatePortfolio(userId);
  const rawLots = loadLots(database, userId);
  const rawSales = loadSales(database, userId);
  const existingLotIds = new Set(rawLots.map((lot) => lot.id));
  const lots = [...rawLots, ...syntheticLotsFromSales(rawSales, existingLotIds)];
  const sales = rawSales.map((sale) => ({
    ...sale,
    syntheticLotId: sale.lotId && existingLotIds.has(sale.lotId) ? sale.lotId : sale.syntheticLotId
  }));
  const saleMap = salesByLot(sales);
  const dividends = loadDividends(database, userId);
  const externalEvents = await loadExternalEvents(database, userId, baseCurrency);
  const firstInvestmentDate = firstTransactionDate(lots, sales, dividends, externalEvents);
  const startDate = rangeStart(range, firstInvestmentDate);
  const openingBalance = parseOpeningBalance(database, userId, baseCurrency, firstInvestmentDate);
  const realizedEvents = [
    ...sales.map(saleRealizedEvent),
    ...dividends.map(dividendRealizedEvent),
    ...externalEvents.map(externalRealizedEvent)
  ].filter((event) => event.date && event.amountBase != null)
    .sort((a, b) => `${a.date}|${a.type}|${a.id}`.localeCompare(`${b.date}|${b.type}|${b.id}`));
  const realized = buildRealizedGrowth(realizedEvents, range, firstInvestmentDate, baseCurrency);
  const bookValue = await buildBookValue({
    lots,
    sales,
    saleMap,
    dividends,
    externalEvents,
    openingBalance,
    dashboard,
    range,
    firstInvestmentDate,
    baseCurrency
  });
  const actualPortfolioValue = buildActualPortfolioValue(database, userId, range, firstInvestmentDate);
  const realizedTotals = realizedSummary(realizedEvents);
  const currentOpenCostBasisBase = roundMoney(Number(dashboard.summary?.costBasisBase) || 0);
  const currentCashBase = roundMoney(Number(dashboard.summary?.cashAvailableBase) || 0);
  const currentPortfolioMarketValueBase = roundMoney(Number(dashboard.summary?.totalValueBase) || 0);
  const summary = {
    netCapitalContributedBase: bookValue.summary.netCapitalContributedBase,
    currentOpenCostBasisBase,
    netRealizedPnlBase: realizedTotals.netRealizedPnlBase,
    dividendsBase: realizedTotals.dividendsBase,
    externalIncomeBase: realizedTotals.externalIncomeBase,
    externalExpensesBase: realizedTotals.externalExpensesBase,
    realizedGrowthTotalBase: realizedTotals.realizedGrowthTotalBase,
    currentCashBase,
    currentPortfolioMarketValueBase,
    currentBookValueBase: roundMoney(currentOpenCostBasisBase + currentCashBase),
    snapshotCount: actualPortfolioValue.summary.snapshotCount,
    manualSnapshotCount: actualPortfolioValue.summary.manualSnapshotCount,
    automaticSnapshotCount: actualPortfolioValue.summary.automaticSnapshotCount
  };
  const wealthBridge = buildWealthBridge({ summary, bookValue, dashboard });
  const recommendedMode = actualPortfolioValue.points.length ? "portfolio_value" : "realized_growth";
  const warnings = [];
  if (!openingBalance.configured) warnings.push("Opening Portfolio Balance is not set. Historical cash before the first purchase may be incomplete.");
  if (!actualPortfolioValue.points.length) warnings.push("Historical market prices are incomplete. Showing transaction-based results.");
  if (Math.abs(bookValue.summary.cashReconciliationBase || 0) >= 0.01) warnings.push("Current cash includes an estimated reconciliation adjustment because deposits/withdrawals are not fully stored yet.");
  return {
    range,
    baseCurrency,
    startDate,
    firstInvestmentDate,
    openingBalance,
    recommendedMode,
    realizedGrowth: realized,
    bookValue,
    actualPortfolioValue,
    wealthBridge,
    snapshots: actualPortfolioValue.snapshots,
    summary,
    dataQuality: {
      usesHistoricalCloses: false,
      noFakeHistoricalPrices: true,
      interpolation: "none; realized and book-value views use confirmed transactions only, and market value uses saved snapshots only",
      warnings: [...new Set(warnings)].slice(0, 30)
    },
    // Backward-compatible fields for older UI paths.
    points: actualPortfolioValue.points,
    events: realized.events
  };
}
