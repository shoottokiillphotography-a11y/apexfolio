import { getDb } from "../db.js";
import {
  fetchJson,
  InputError,
  normalizeTicker,
  roundMoney,
  roundPercent,
  safeJsonParse
} from "../utils.js";
import { convertAmount, getExchangeRate } from "./currency.js";
import { getFundamentals, getYahooProfile } from "./fundamentals.js";
import { getQuote } from "./market-data.js";

export const PERFORMANCE_RANGES = {
  "1d": { yahooRange: "1d", interval: "5m", label: "Day", maxPoints: 120 },
  "1mo": { yahooRange: "1mo", interval: "1d", label: "Month", maxPoints: 80 },
  "3mo": { yahooRange: "3mo", interval: "1d", label: "3M", maxPoints: 100 },
  "6mo": { yahooRange: "6mo", interval: "1d", label: "6M", maxPoints: 120 },
  ytd: { yahooRange: "ytd", interval: "1d", label: "YTD", maxPoints: 140 },
  "1y": { yahooRange: "1y", interval: "1d", label: "1Y", maxPoints: 170 },
  "3y": { yahooRange: "3y", interval: "1wk", label: "3Y", maxPoints: 180, windowDays: 1096 },
  "5y": { yahooRange: "5y", interval: "1wk", label: "5Y", maxPoints: 220 },
  all: { yahooRange: "max", interval: "1mo", label: "All", maxPoints: 260 }
};

const PORTFOLIO_HISTORY_CONCURRENCY = 8;
const PORTFOLIO_HISTORY_TIMEOUT_MS = 7000;

function assertRange(rangeInput) {
  const range = String(rangeInput || "1y").toLowerCase();
  if (!PERFORMANCE_RANGES[range]) {
    throw new InputError("Performance range must be 1d, 1mo, 3mo, 6mo, ytd, 1y, 3y, 5y, or all");
  }
  return range;
}

function normalizeQuoteCurrency(input, fallback = "USD") {
  const raw = String(input || fallback).trim();
  const upper = raw.toUpperCase();
  if (raw === "GBp" || upper === "GBX") return "GBP";
  return upper || fallback;
}

function yahooPriceScale(input) {
  const raw = String(input || "").trim();
  const upper = raw.toUpperCase();
  return raw === "GBp" || upper === "GBX" ? 0.01 : 1;
}

function toDateOnly(isoOrDate) {
  return String(isoOrDate || "").slice(0, 10);
}

function thinPoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const thinned = [];
  for (let index = 0; index < maxPoints; index += 1) {
    thinned.push(points[Math.round(index * step)]);
  }
  return thinned.filter((point, index, rows) => index === 0 || point.time !== rows[index - 1].time);
}

export async function fetchYahooPriceHistory(tickerInput, rangeInput = "1y") {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new InputError("Ticker is required");
  const range = assertRange(rangeInput);
  const settings = PERFORMANCE_RANGES[range];
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  if (settings.windowDays) {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - settings.windowDays * 24 * 60 * 60;
    url.searchParams.set("period1", String(period1));
    url.searchParams.set("period2", String(period2));
  } else {
    url.searchParams.set("range", settings.yahooRange);
  }
  url.searchParams.set("interval", settings.interval);
  url.searchParams.set("includePrePost", "false");
  const payload = await fetchJson(url, { timeoutMs: PORTFOLIO_HISTORY_TIMEOUT_MS });
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const meta = result?.meta || {};
  const scale = yahooPriceScale(meta.currency);
  const currency = normalizeQuoteCurrency(meta.currency, meta.currency || "USD");
  const points = timestamps.map((timestamp, index) => {
    const close = Number(closes[index]);
    if (!Number.isFinite(close) || close <= 0) return null;
    const time = new Date(timestamp * 1000).toISOString();
    return {
      time,
      date: time.slice(0, 10),
      value: roundMoney(close * scale)
    };
  }).filter(Boolean);
  if (!points.length) throw new Error(`Yahoo Finance returned no historical prices for ${ticker}`);
  return {
    ticker,
    range,
    currency,
    provider: "yahoo",
    points: thinPoints(points, settings.maxPoints)
  };
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

function performanceSummary(points) {
  const first = points.find((point) => point.value != null);
  const last = [...points].reverse().find((point) => point.value != null);
  const changeValue = first && last ? roundMoney(last.value - first.value) : null;
  const changePercent = first?.value ? roundPercent((changeValue / first.value) * 100) : null;
  return {
    startValue: first?.value ?? null,
    endValue: last?.value ?? null,
    changeValue,
    changePercent
  };
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

function quantityAtPoint(lot, salesByLot, pointDate) {
  if (pointDate < toDateOnly(lot.purchase_date)) return 0;
  let quantity = Number(lot.quantity) || 0;
  for (const sale of salesByLot.get(lot.id) || []) {
    if (toDateOnly(sale.sold_at) > pointDate) quantity += Number(sale.quantity) || 0;
  }
  return quantity;
}

function priceAtOrBefore(history, pointTime) {
  if (!history?.points?.length) return null;
  let latest = null;
  for (const point of history.points) {
    if (point.time <= pointTime) latest = point;
    else break;
  }
  // Different exchanges publish intraday bars in different time zones. If an
  // ASX/LSE/EU ticker has not printed a bar at the portfolio anchor time yet,
  // use its earliest available bar instead of dropping the position to zero.
  return latest?.value ?? history.points[0]?.value ?? null;
}

async function cashValueBase(database, userId, baseCurrency, fxCache) {
  const rows = database.prepare("SELECT currency, amount FROM cash_balances WHERE user_id = ?").all(userId);
  let value = 0;
  for (const row of rows) {
    const rate = await rateFor(row.currency, baseCurrency, fxCache);
    value += (Number(row.amount) || 0) * rate;
  }
  return value;
}

export async function portfolioPerformance(userId, rangeInput = "1y") {
  const range = assertRange(rangeInput);
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const baseCurrency = user.base_currency;
  const lots = database.prepare(`
    SELECT id, ticker, original_quantity, quantity, purchase_price, purchase_currency, purchase_date
    FROM holding_lots
    WHERE user_id = ? AND original_quantity > 0
    ORDER BY ticker, purchase_date
  `).all(userId);
  if (!lots.length) {
    return { range, currency: baseCurrency, points: [], ...performanceSummary([]), warnings: ["No lots found"] };
  }

  const salesByLot = new Map();
  database.prepare(`
    SELECT lot_id, quantity, sold_at
    FROM realized_lots
    WHERE user_id = ? AND lot_id IS NOT NULL
    ORDER BY sold_at
  `).all(userId).forEach((sale) => {
    if (!salesByLot.has(sale.lot_id)) salesByLot.set(sale.lot_id, []);
    salesByLot.get(sale.lot_id).push(sale);
  });

  const tickers = [...new Set(lots.map((lot) => lot.ticker))];
  const histories = new Map();
  const warnings = [];
  const historyResults = await mapWithConcurrency(tickers, PORTFOLIO_HISTORY_CONCURRENCY, async (ticker) => {
    try {
      return { ticker, history: await fetchYahooPriceHistory(ticker, range) };
    } catch (error) {
      return { ticker, warning: `${ticker}: ${error.message}` };
    }
  });
  for (const result of historyResults) {
    if (result?.history) histories.set(result.ticker, result.history);
    else if (result?.warning) warnings.push(result.warning);
  }

  const anchors = [...histories.values()].sort((a, b) => b.points.length - a.points.length);
  if (!anchors.length) {
    return { range, currency: baseCurrency, points: [], ...performanceSummary([]), warnings };
  }

  const fxCache = new Map();
  const cashBase = await cashValueBase(database, userId, baseCurrency, fxCache);
  const allAnchorPoints = anchors[0].points;
  const firstLotDate = lots.reduce((min, lot) => {
    const d = toDateOnly(lot.purchase_date);
    if (!d) return min;
    return !min || d < min ? d : min;
  }, null);
  const clampedAnchorPoints = firstLotDate
    ? allAnchorPoints.filter((point) => point.date >= firstLotDate)
    : allAnchorPoints;
  const anchorPoints = clampedAnchorPoints.length ? clampedAnchorPoints : allAnchorPoints;
  const firstDate = anchorPoints[0]?.date || null;
  const purchaseFlowsDuringRange = firstDate
    ? lots.filter((lot) => toDateOnly(lot.purchase_date) > firstDate).length
    : 0;
  const saleFlowsDuringRange = firstDate
    ? [...salesByLot.values()].flat().filter((sale) => toDateOnly(sale.sold_at) > firstDate).length
    : 0;
  const cashHistoryIncomplete = Math.abs(Number(cashBase) || 0) > 0.01;
  const performanceReliable = purchaseFlowsDuringRange === 0 && saleFlowsDuringRange === 0 && !cashHistoryIncomplete;
  if (!performanceReliable) {
    warnings.push("Portfolio chart is value history only because complete deposit/withdrawal cash-flow history is not available for this range");
  }
  const points = [];
  for (const anchor of anchorPoints) {
    let value = cashBase;
    for (const lot of lots) {
      const quantity = quantityAtPoint(lot, salesByLot, anchor.date);
      if (quantity <= 0) continue;
      const history = histories.get(lot.ticker);
      const price = priceAtOrBefore(history, anchor.time);
      if (price == null) continue;
      const rate = await rateFor(history.currency, baseCurrency, fxCache);
      value += price * quantity * rate;
    }
    points.push({
      time: anchor.time,
      date: anchor.date,
      value: roundMoney(value)
    });
  }

  const summary = performanceSummary(points);
  if (!performanceReliable) {
    summary.changeValue = null;
    summary.changePercent = null;
  }

  return {
    range,
    label: PERFORMANCE_RANGES[range].label,
    currency: baseCurrency,
    provider: "yahoo",
    points: thinPoints(points, PERFORMANCE_RANGES[range].maxPoints),
    ...summary,
    performanceReliable,
    cashFlowDiagnostics: {
      purchaseFlowsDuringRange,
      saleFlowsDuringRange,
      cashHistoryIncomplete
    },
    warnings
  };
}

export async function tickerPerformance(tickerInput, rangeInput = "1y") {
  const history = await fetchYahooPriceHistory(tickerInput, rangeInput);
  return {
    ...history,
    label: PERFORMANCE_RANGES[history.range].label,
    ...performanceSummary(history.points)
  };
}

function metricRowPayload(database, ticker) {
  return database.prepare("SELECT metric_json AS metricJson FROM fundamental_metrics WHERE ticker = ?").get(ticker);
}

function profileFromPayload(payload) {
  const result = payload?.quoteSummary?.result?.[0] || {};
  const profile = result.assetProfile || {};
  const price = result.price || {};
  return {
    summary: profile.longBusinessSummary || null,
    sector: profile.sector || null,
    industry: profile.industry || null,
    website: profile.website || null,
    country: profile.country || null,
    employees: profile.fullTimeEmployees || null,
    exchangeName: price.exchangeName || price.exchange || null,
    shortName: price.shortName || null,
    longName: price.longName || null
  };
}

function eventsForTicker(database, userId, ticker) {
  return database.prepare(`
    SELECT id, event_type AS eventType, event_date AS eventDate, title, details, source,
      source_event_id AS sourceEventId, notified_at AS notifiedAt
    FROM corporate_events
    WHERE user_id = ? AND ticker = ?
    ORDER BY event_date DESC
    LIMIT 12
  `).all(userId, ticker);
}

export async function stockDetail(userId, tickerInput, { refresh = false } = {}) {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new InputError("Ticker is required");
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const quote = await getQuote(ticker, { force: refresh });
  const fundamentals = await getFundamentals(ticker, { force: refresh });
  let profile = profileFromPayload(safeJsonParse(metricRowPayload(database, ticker)?.metricJson, {}));
  try {
    const profilePayload = await getYahooProfile(ticker);
    profile = { ...profile, ...profileFromPayload(profilePayload) };
  } catch {
    // Existing metric_json still gives the page useful context when Yahoo profile is unavailable.
  }

  const lots = database.prepare(`
    SELECT id, quantity, original_quantity AS originalQuantity, purchase_price AS purchasePrice,
      purchase_currency AS purchaseCurrency, purchase_date AS purchaseDate
    FROM holding_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY purchase_date, created_at
  `).all(userId, ticker);
  const openQuantity = lots.reduce((total, lot) => total + (Number(lot.quantity) || 0), 0);
  const costBasis = await Promise.all(lots.map((lot) => (
    convertAmount((Number(lot.quantity) || 0) * (Number(lot.purchasePrice) || 0), lot.purchaseCurrency, user.base_currency)
  )));
  const costBasisBase = roundMoney(costBasis.reduce((total, item) => total + (item?.amount || 0), 0));
  const currentValue = quote?.price && openQuantity
    ? await convertAmount(quote.price * openQuantity, quote.currency, user.base_currency)
    : null;
  const realizedRows = database.prepare(`
    SELECT r.quantity, r.sale_price AS salePrice, r.sale_currency AS saleCurrency,
      r.gain_loss_base AS storedGainLossBase, r.proceeds_base AS storedProceedsBase,
      r.buy_price AS manualBuyPrice, r.buy_currency AS manualBuyCurrency,
      l.purchase_price AS lotPurchasePrice, l.purchase_currency AS lotPurchaseCurrency
    FROM realized_lots r
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ? AND r.ticker = ?
  `).all(userId, ticker);
  let realizedGainLossBase = 0;
  let realizedProceedsBase = 0;
  for (const row of realizedRows) {
    const quantity = Number(row.quantity) || 0;
    const buyCurrency = row.lotPurchaseCurrency || row.manualBuyCurrency;
    const buyPrice = row.lotPurchaseCurrency ? row.lotPurchasePrice : row.manualBuyPrice;
    const costBasis = buyCurrency
      ? await convertAmount(quantity * (Number(buyPrice) || 0), buyCurrency, user.base_currency)
      : null;
    const proceeds = row.saleCurrency
      ? await convertAmount(quantity * (Number(row.salePrice) || 0), row.saleCurrency, user.base_currency)
      : null;
    const proceedsAmount = proceeds?.amount ?? (Number(row.storedProceedsBase) || 0);
    const gainLossAmount = costBasis?.amount != null && proceeds?.amount != null
      ? proceeds.amount - costBasis.amount
      : Number(row.storedGainLossBase) || 0;
    realizedProceedsBase += proceedsAmount;
    realizedGainLossBase += gainLossAmount;
  }
  const dividendRows = database.prepare(`
    SELECT gross_amount AS grossAmount, gross_amount_base AS storedGrossAmountBase, currency
    FROM dividend_payments
    WHERE user_id = ? AND ticker = ?
  `).all(userId, ticker);
  let dividendIncomeBase = 0;
  for (const row of dividendRows) {
    const converted = await convertAmount(row.grossAmount, row.currency, user.base_currency).catch(() => null);
    dividendIncomeBase += converted?.amount ?? (Number(row.storedGrossAmountBase) || 0);
  }

  return {
    ticker,
    name: profile.longName || profile.shortName || database.prepare("SELECT name FROM equities WHERE ticker = ?").get(ticker)?.name || null,
    quote,
    fundamentals,
    profile,
    position: {
      openQuantity,
      lotCount: lots.filter((lot) => lot.quantity > 0).length,
      costBasisBase,
      currentValueBase: currentValue?.amount == null ? null : roundMoney(currentValue.amount),
      realizedBase: roundMoney(realizedGainLossBase + dividendIncomeBase),
      realizedGainLossBase: roundMoney(realizedGainLossBase),
      dividendIncomeBase: roundMoney(dividendIncomeBase),
      realizedProceedsBase: roundMoney(realizedProceedsBase),
      baseCurrency: user.base_currency
    },
    lots,
    watchlistItems: database.prepare(`
      SELECT w.id, wl.name AS watchlistName, w.target_price AS targetPrice,
        w.buy_zone_low AS buyZoneLow, w.buy_zone_high AS buyZoneHigh,
        w.add_zone_low AS addZoneLow, w.add_zone_high AS addZoneHigh,
        w.fair_value AS fairValue, w.trim_price AS trimPrice, w.currency, w.note
      FROM watchlist_items w
      JOIN watchlists wl ON wl.id = w.watchlist_id
      WHERE w.user_id = ? AND w.ticker = ?
      ORDER BY wl.sort_order, wl.name
    `).all(userId, ticker),
    alerts: database.prepare(`
      SELECT id, direction, threshold_price AS thresholdPrice, currency, active, triggered, label
      FROM price_alerts
      WHERE user_id = ? AND ticker = ?
      ORDER BY active DESC, threshold_price
    `).all(userId, ticker),
    events: eventsForTicker(database, userId, ticker)
  };
}
