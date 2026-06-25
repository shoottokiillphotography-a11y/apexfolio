import { getDb } from "../db.js";
import { InputError, nowIso, roundMoney, roundPercent, toNumber } from "../utils.js";
import { calculatePortfolio } from "./calculations.js";
import { convertAmount, getExchangeRate } from "./currency.js";
import { fetchPriceHistory, PERFORMANCE_RANGES } from "./performance.js";

const OPENING_BALANCE_KEY = "portfolio_wealth_opening_balance";
const RANGE_FILTERS = new Set(["month", "ytd", "1y", "3y", "5y", "all"]);
const HISTORY_CONCURRENCY = 5;

function toDateOnly(value) {
  return String(value || "").slice(0, 10);
}

function dateAtUtc(dateText) {
  const [year, month, day] = String(dateText || "").slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate({ months = 0, years = 0 } = {}) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  if (years) date.setUTCFullYear(date.getUTCFullYear() - years);
  if (months) date.setUTCMonth(date.getUTCMonth() - months);
  return isoDate(date);
}

function normalizeRange(input) {
  const range = String(input || "all").toLowerCase();
  return RANGE_FILTERS.has(range) ? range : "all";
}

function performanceRange(range) {
  return range === "month" ? "1mo" : range;
}

function startDateForRange(range, firstInvestmentDate) {
  const today = isoDate(new Date());
  if (range === "all") return firstInvestmentDate || today;
  let start = firstInvestmentDate || today;
  if (range === "month") start = shiftDate({ months: 1 });
  if (range === "ytd") start = `${new Date().getUTCFullYear()}-01-01`;
  if (range === "1y") start = shiftDate({ years: 1 });
  if (range === "3y") start = shiftDate({ years: 3 });
  if (range === "5y") start = shiftDate({ years: 5 });
  return firstInvestmentDate && start < firstInvestmentDate ? firstInvestmentDate : start;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
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

async function convertToBase(amount, currency, baseCurrency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  const from = String(currency || baseCurrency).toUpperCase();
  if (from === baseCurrency) return roundMoney(numeric);
  const converted = await convertAmount(numeric, from, baseCurrency);
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

function priceAtOrBefore(history, pointDate, fallback = null) {
  if (!history?.points?.length) return fallback;
  let latest = null;
  for (const point of history.points) {
    if (point.date <= pointDate) latest = point;
    else break;
  }
  return latest?.value ?? (history.points[0]?.date >= pointDate ? history.points[0]?.value : fallback);
}

function thinDates(dates, maxPoints) {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length <= maxPoints) return sorted;
  const step = (sorted.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => sorted[Math.round(index * step)])
    .filter((date, index, rows) => index === 0 || date !== rows[index - 1]);
}

function eventKey(event) {
  return `${event.date}|${event.type}|${event.id}`;
}

function eventOnOrBefore(event, date) {
  return event.date && event.date <= date;
}

function currentPriceRows(database) {
  return new Map(database.prepare("SELECT * FROM market_prices").all().map((row) => [
    row.ticker,
    { price: row.price, currency: row.currency, provider: row.provider }
  ]));
}

function loadLots(database, userId) {
  const lots = database.prepare(`
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
    original_quantity: Number(lot.original_quantity) || 0,
    quantity: Number(lot.quantity) || 0,
    purchase_price: Number(lot.purchase_price) || 0,
    purchase_currency: lot.purchase_currency,
    purchase_date: toDateOnly(lot.purchase_date),
    equityCurrency: lot.equity_currency,
    source: lot.source,
    notes: lot.notes,
    synthetic: false
  }));
  return lots;
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
    lotId: row.lot_id,
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
  const lots = [];
  const seen = new Set();
  for (const sale of sales) {
    if (sale.lotId && existingLotIds.has(sale.lotId)) continue;
    if (!sale.boughtAt || !sale.buyPrice || !sale.quantity) continue;
    const key = sale.syntheticLotId;
    if (seen.has(key)) continue;
    seen.add(key);
    lots.push({
      id: key,
      ticker: sale.ticker,
      name: sale.name,
      categoryName: sale.categoryName,
      original_quantity: sale.quantity,
      quantity: 0,
      purchase_price: sale.buyPrice,
      purchase_currency: sale.buyCurrency,
      purchase_date: sale.boughtAt,
      equityCurrency: sale.equityCurrency,
      source: sale.source || "external",
      notes: sale.notes,
      synthetic: true
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
  if (!lot.purchase_date || date < lot.purchase_date) return 0;
  let quantity = Number(lot.original_quantity) || 0;
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
      eligibleQuantity: row.eligible_quantity,
      amountPerShare: row.amount_per_share,
      exDate: row.ex_date,
      payDate: row.pay_date,
      source: row.source
    }
  })).filter((event) => event.date);
}

async function loadExternalCashEvents(database, userId, baseCurrency) {
  const rows = database.prepare(`
    SELECT *
    FROM external_income_events
    WHERE user_id = ? AND add_to_cash = 1
    ORDER BY event_date, created_at
  `).all(userId);
  const events = [];
  for (const row of rows) {
    const cashAmountBase = row.converted_amount_base != null
      ? Number(row.converted_amount_base)
      : await convertToBase(row.cash_applied_amount || row.net_amount, row.cash_applied_currency || row.currency, baseCurrency);
    events.push({
      id: row.id,
      date: toDateOnly(row.event_date),
      type: row.event_type === "EXPENSE" || Number(row.net_amount) < 0 ? "external_expense" : "external_income",
      source: row.source_description,
      amountBase: roundMoney(cashAmountBase || 0),
      amountOriginal: Number(row.net_amount) || 0,
      currency: row.currency,
      affectsCash: true,
      affectsInvestmentReturn: false,
      details: {
        category: row.category,
        description: row.source_description,
        grossAmount: row.gross_amount,
        feesTax: row.fees_tax,
        netAmount: row.net_amount,
        propertyAccount: row.property_account,
        notes: row.notes
      }
    });
  }
  return events.filter((event) => event.date);
}

function cashEventFromBuy(lot, amountBase) {
  return {
    id: `buy_${lot.id}`,
    date: lot.purchase_date,
    type: "buy",
    ticker: lot.ticker,
    source: lot.ticker,
    amountBase: -roundMoney(amountBase || 0),
    affectsCash: true,
    affectsInvestmentReturn: false,
    details: {
      quantity: lot.original_quantity,
      price: lot.purchase_price,
      currency: lot.purchase_currency,
      note: lot.notes
    }
  };
}

function cashEventFromSale(sale) {
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
      quantity: sale.quantity,
      salePrice: sale.salePrice,
      saleCurrency: sale.saleCurrency,
      costBasisBase: sale.costBasisBase,
      proceedsBase: sale.proceedsBase,
      gainLossBase: sale.gainLossBase,
      gainLossPercent: Number.isFinite(sale.gainLossPercent) ? sale.gainLossPercent : null,
      lotId: sale.lotId || sale.syntheticLotId,
      notes: sale.notes,
      source: sale.source
    }
  };
}

function cashEventFromDividend(dividend) {
  return {
    ...dividend,
    amountBase: roundMoney(dividend.amountBase || 0),
    affectsCash: true,
    affectsInvestmentReturn: true
  };
}

async function buyCostBase(lot, baseCurrency, fxCache) {
  const rate = await rateFor(lot.purchase_currency, baseCurrency, fxCache);
  return (Number(lot.original_quantity) || 0) * (Number(lot.purchase_price) || 0) * rate;
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

function rangeMaxPoints(range) {
  return range === "month" ? 80 : PERFORMANCE_RANGES[performanceRange(range)]?.maxPoints || 280;
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

export async function saveOpeningPortfolioBalance(userId, input = {}) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new InputError("User not found", 404);
  const amount = toNumber(input.amount, null);
  if (amount == null || amount < 0) throw new InputError("Opening balance amount is required");
  const currency = String(input.currency || user.base_currency).trim().toUpperCase();
  const amountBase = await convertToBase(amount, currency, user.base_currency);
  if (amountBase == null) throw new InputError(`FX unavailable for ${currency}/${user.base_currency}`);
  const date = input.date ? toDateOnly(input.date) : "";
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InputError("Opening balance date must be YYYY-MM-DD");
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

export async function portfolioWealthTimeline(userId, options = {}) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new InputError("User not found", 404);
  const baseCurrency = user.base_currency;
  const range = normalizeRange(options.range);
  const dashboard = await calculatePortfolio(userId);
  const today = isoDate(new Date());
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
  const externalCashEvents = await loadExternalCashEvents(database, userId, baseCurrency);
  const fxCache = new Map();
  const firstInvestmentDate = [
    ...lots.map((lot) => lot.purchase_date),
    ...sales.map((sale) => sale.boughtAt)
  ].filter(Boolean).sort()[0] || today;
  const startDate = startDateForRange(range, firstInvestmentDate);
  const openingBalance = parseOpeningBalance(database, userId, baseCurrency, firstInvestmentDate);

  const warnings = [];
  if (!openingBalance.configured) {
    warnings.push("Opening Portfolio Balance is not set. Historical cash before the first purchase may be incomplete.");
  }
  warnings.push("Fees and taxes are included only where a transaction row stores them.");

  const currentQuotes = currentPriceRows(database);
  const tickers = [...new Set(lots.map((lot) => lot.ticker))];
  const histories = new Map();
  const historyResults = await mapWithConcurrency(tickers, HISTORY_CONCURRENCY, async (ticker) => {
    const matchingLot = lots.find((lot) => lot.ticker === ticker);
    try {
      return {
        ticker,
        history: await fetchPriceHistory(ticker, performanceRange(range), {
          fromDate: startDate,
          toDate: today,
          firstHoldingDate: firstInvestmentDate,
          currency: currentQuotes.get(ticker)?.currency || matchingLot?.equityCurrency || matchingLot?.purchase_currency || "AUD",
          lots,
          realizedRows: sales.map((sale) => ({
            ticker: sale.ticker,
            soldAt: sale.soldAt,
            salePrice: sale.salePrice
          })),
          currentQuote: currentQuotes.get(ticker)
        })
      };
    } catch (error) {
      return { ticker, warning: `${ticker}: ${error.message}` };
    }
  });
  for (const result of historyResults) {
    if (result?.history) {
      histories.set(result.ticker, result.history);
      if (result.history.synthetic) warnings.push(`${result.ticker}: estimated from broker transaction prices`);
    } else if (result?.warning) {
      warnings.push(result.warning);
    }
  }

  const buyEvents = [];
  for (const lot of lots) {
    const amountBase = await buyCostBase(lot, baseCurrency, fxCache);
    buyEvents.push(cashEventFromBuy(lot, amountBase));
  }
  const saleEvents = sales.map(cashEventFromSale);
  const dividendEvents = dividends.map(cashEventFromDividend);
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
    ...saleEvents,
    ...dividendEvents,
    ...externalCashEvents
  ].filter((event) => event.date && Number.isFinite(Number(event.amountBase)));

  const dateSet = new Set([startDate, today]);
  if (firstInvestmentDate >= startDate) dateSet.add(firstInvestmentDate);
  for (const history of histories.values()) {
    for (const point of history.points || []) {
      if (point.date >= startDate && point.date <= today) dateSet.add(point.date);
    }
  }
  for (const event of cashEvents) {
    if (event.date >= startDate && event.date <= today) dateSet.add(event.date);
  }
  let anchorDates = thinDates([...dateSet], rangeMaxPoints(range));
  if (!anchorDates.includes(today)) anchorDates.push(today);
  anchorDates = [...new Set(anchorDates)].sort();

  const cashReconstructionEvents = cashEvents.filter((event) => eventOnOrBefore(event, today));
  const reconstructedCashToday = roundMoney(cashReconstructionEvents.reduce((total, event) => total + Number(event.amountBase || 0), 0));
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
        notes: "This reconciles the reconstructed cash ledger to today's actual Dashboard cash balance because deposits/withdrawals are not yet fully persisted."
      }
    };
    cashEvents.push(reconciliationEvent);
    warnings.push("Current cash needed a reconciliation adjustment because deposits/withdrawals are not fully stored yet.");
  }

  const points = [];
  const eventDetailsByDate = new Map();
  for (const event of cashEvents) {
    if (!event.date) continue;
    if (!eventDetailsByDate.has(event.date)) eventDetailsByDate.set(event.date, []);
    eventDetailsByDate.get(event.date).push(event);
  }

  for (const date of anchorDates) {
    let holdingsValueBase = 0;
    let partial = false;
    const missingTickers = [];
    for (const lot of lots) {
      const quantity = quantityHeldAtDate(lot, saleMap, date);
      if (quantity <= 0) continue;
      const history = histories.get(lot.ticker);
      const price = priceAtOrBefore(history, date, lot.purchase_price);
      if (price == null) {
        partial = true;
        missingTickers.push(lot.ticker);
        continue;
      }
      const rate = await rateFor(history?.currency || lot.equityCurrency || lot.purchase_currency, baseCurrency, fxCache);
      holdingsValueBase += price * quantity * rate;
      if (history?.synthetic) partial = true;
    }

    const eventsToDate = cashEvents.filter((event) => eventOnOrBefore(event, date));
    const cashValueBase = roundMoney(eventsToDate.reduce((total, event) => total + Number(event.amountBase || 0), 0));
    const netCapitalContributedBase = roundMoney(eventsToDate
      .filter((event) => !event.affectsInvestmentReturn && ["opening_balance", "deposit", "withdrawal", "external_income", "external_expense"].includes(event.type))
      .reduce((total, event) => total + Number(event.amountBase || 0), 0));
    const realizedGainLossBase = roundMoney(eventsToDate
      .filter((event) => event.type === "share_sale")
      .reduce((total, event) => total + Number(event.realizedGainLossBase || 0), 0));
    const dividendsBase = roundMoney(eventsToDate
      .filter((event) => event.type === "dividend")
      .reduce((total, event) => total + Number(event.amountBase || 0), 0));
    const externalCashBase = roundMoney(eventsToDate
      .filter((event) => event.type === "external_income" || event.type === "external_expense")
      .reduce((total, event) => total + Number(event.amountBase || 0), 0));
    let totalValueBase = roundMoney(holdingsValueBase + cashValueBase);
    let pointCashBase = cashValueBase;
    let pointHoldingsBase = roundMoney(holdingsValueBase);
    let reconciledToDashboard = false;
    if (date === today) {
      totalValueBase = roundMoney(Number(dashboard.summary?.totalValueBase) || totalValueBase);
      pointCashBase = dashboardCashBase;
      pointHoldingsBase = roundMoney(totalValueBase - pointCashBase);
      reconciledToDashboard = true;
    }
    points.push({
      date,
      time: `${date}T00:00:00.000Z`,
      totalValueBase,
      value: totalValueBase,
      holdingsValueBase: pointHoldingsBase,
      cashValueBase: pointCashBase,
      netCapitalContributedBase,
      investmentGrowthBase: roundMoney(totalValueBase - netCapitalContributedBase),
      realizedGainLossBase,
      dividendsBase,
      externalCashBase,
      partial,
      estimated: partial || date === today && Boolean(reconciliationEvent),
      reconciledToDashboard,
      missingTickers: [...new Set(missingTickers)],
      events: eventDetailsByDate.get(date) || []
    });
  }

  const total = pointSummary(points, "totalValueBase");
  const growth = pointSummary(points, "investmentGrowthBase");
  const finalPoint = points[points.length - 1] || null;
  const reconciliationDiff = finalPoint
    ? roundMoney(Number(finalPoint.totalValueBase || 0) - Number(dashboard.summary?.totalValueBase || 0))
    : null;

  return {
    range,
    baseCurrency,
    startDate,
    firstInvestmentDate,
    openingBalance,
    points,
    events: cashEvents
      .filter((event) => event.date >= startDate && event.date <= today)
      .sort((a, b) => eventKey(a).localeCompare(eventKey(b))),
    summary: {
      ...total,
      startGrowthValue: growth.startValue,
      endGrowthValue: growth.endValue,
      investmentGrowthChangeValue: growth.changeValue,
      investmentGrowthChangePercent: growth.changePercent,
      currentDashboardTotalBase: roundMoney(Number(dashboard.summary?.totalValueBase) || 0),
      currentDashboardCashBase: dashboardCashBase,
      currentDashboardHoldingsBase: roundMoney((Number(dashboard.summary?.totalValueBase) || 0) - dashboardCashBase),
      finalReconciliationDiff: reconciliationDiff,
      cashReconciliationBase,
      reconstructedCashToday,
      eventCount: cashEvents.length,
      partialPointCount: points.filter((point) => point.partial).length
    },
    dataQuality: {
      usesHistoricalCloses: true,
      interpolation: "none; latest known close at or before each anchor date is used",
      finalPointReconciles: reconciliationDiff != null && Math.abs(reconciliationDiff) < 0.02,
      warnings: [...new Set(warnings)].slice(0, 30)
    }
  };
}
