import { getDb } from "../db.js";
import { config } from "../config.js";
import {
  fetchJson,
  InputError,
  normalizeTicker,
  nowIso,
  roundMoney,
  roundPercent,
  roundShares,
  safeJsonParse
} from "../utils.js";
import { convertAmount, getExchangeRate } from "./currency.js";
import { getFundamentals, getYahooProfile } from "./fundamentals.js";
import { getQuote } from "./market-data.js";

export const PERFORMANCE_RANGES = {
  "1d": { label: "1D", maxPoints: 2, days: 1 },
  "1mo": { label: "1M", maxPoints: 32, months: 1 },
  ytd: { label: "YTD", maxPoints: 140, ytd: true },
  "1y": { label: "1Y", maxPoints: 170, years: 1 },
  "3y": { label: "3Y", maxPoints: 190, years: 3 },
  "5y": { label: "5Y", maxPoints: 230, years: 5 },
  all: { label: "ALL", maxPoints: 280, all: true }
};

const PORTFOLIO_HISTORY_CONCURRENCY = 6;
const PORTFOLIO_HISTORY_TIMEOUT_MS = 12000;

function assertRange(rangeInput) {
  const range = String(rangeInput || "1y").toLowerCase();
  if (!PERFORMANCE_RANGES[range]) {
    throw new InputError("Performance range must be 1d, 1mo, ytd, 1y, 3y, 5y, or all");
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

function dateAtUtc(dateText) {
  const [year, month, day] = String(dateText || "").slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = dateAtUtc(dateText);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function shiftDate({ months = 0, years = 0, days = 0 } = {}) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  if (years) date.setUTCFullYear(date.getUTCFullYear() - years);
  if (months) date.setUTCMonth(date.getUTCMonth() - months);
  if (days) date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

function startDateForRange(range, firstHoldingDate) {
  const today = isoDate(new Date());
  const settings = PERFORMANCE_RANGES[range];
  let start = firstHoldingDate || today;
  if (settings.ytd) start = `${new Date().getUTCFullYear()}-01-01`;
  else if (settings.months) start = shiftDate({ months: settings.months });
  else if (settings.years) start = shiftDate({ years: settings.years });
  else if (settings.days) start = shiftDate({ days: settings.days });
  else if (settings.all) start = firstHoldingDate || today;
  return firstHoldingDate && start < firstHoldingDate ? firstHoldingDate : start;
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

function yyyymmdd(dateText) {
  return String(dateText || "").replaceAll("-", "");
}

function stooqSymbolCandidates(ticker) {
  const symbol = normalizeTicker(ticker);
  const [rawRoot, rawSuffix] = symbol.split(".");
  const root = (rawRoot || symbol).toLowerCase();
  const noDash = root.replaceAll("-", "");
  const suffix = rawSuffix?.toUpperCase();
  const map = {
    AX: ["au"],
    L: ["uk"],
    CO: ["dk"],
    HK: ["hk"],
    DE: ["de"],
    PA: ["fr"],
    AS: ["nl"],
    MI: ["it"],
    SW: ["ch"],
    ST: ["se"],
    OL: ["no"],
    TO: ["ca"],
    T: ["jp"]
  };
  const markets = suffix ? (map[suffix] || []) : ["us"];
  return [...new Set(markets.flatMap((market) => [root, noDash].map((candidate) => `${candidate}.${market}`)))];
}

function eodhdSymbolCandidates(ticker) {
  const symbol = normalizeTicker(ticker);
  const match = symbol.match(/^(.+)\.([A-Z0-9-]+)$/);
  if (!match) return [`${symbol}.US`];
  const [, root, suffix] = match;
  const map = {
    AX: ["AU"],
    L: ["LSE"],
    CO: ["CO"],
    HK: ["HK"],
    DE: ["XETRA", "F"],
    PA: ["PA"],
    AS: ["AS"],
    MI: ["MI"],
    SW: ["SW"],
    ST: ["ST"],
    OL: ["OL"],
    TO: ["TO"],
    T: ["T"]
  };
  return [...new Set((map[suffix] || []).map((exchange) => `${root}.${exchange}`))];
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || PORTFOLIO_HISTORY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 ApexFolio/1.0",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStooqHistoryCsv(text) {
  const rows = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];
  const headers = rows[0].split(",").map((item) => item.trim());
  const dateIndex = headers.indexOf("Date");
  const closeIndex = headers.indexOf("Close");
  if (dateIndex < 0 || closeIndex < 0) return [];
  return rows.slice(1).map((line) => {
    const values = line.split(",").map((item) => item.trim());
    const close = Number(values[closeIndex]);
    const date = values[dateIndex];
    if (!date || !Number.isFinite(close) || close <= 0) return null;
    return { date, time: `${date}T00:00:00.000Z`, value: close };
  }).filter(Boolean);
}

async function fetchStooqPriceHistory(ticker, fromDate, toDate, fallbackCurrency = "USD") {
  let lastError = null;
  for (const symbol of stooqSymbolCandidates(ticker)) {
    try {
      const url = new URL("https://stooq.com/q/d/l/");
      url.searchParams.set("s", symbol);
      url.searchParams.set("i", "d");
      url.searchParams.set("d1", yyyymmdd(fromDate));
      url.searchParams.set("d2", yyyymmdd(toDate));
      const text = await fetchText(url);
      const rawPoints = parseStooqHistoryCsv(text);
      if (!rawPoints.length) {
        lastError = new Error(`Stooq returned no history for ${symbol}`);
        continue;
      }
      const scale = ticker.endsWith(".L") && rawPoints.some((point) => point.value > 100) ? 0.01 : 1;
      return {
        ticker,
        currency: fallbackCurrency,
        provider: "stooq",
        points: rawPoints.map((point) => ({ ...point, value: roundMoney(point.value * scale) }))
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Stooq returned no history for ${ticker}`);
}

async function fetchEodhdPriceHistory(ticker, fromDate, toDate, fallbackCurrency = "USD") {
  if (!config.eodhdApiKey || !config.eodhdHistoryEnabled) throw new Error("EODHD historical prices are not enabled");
  let lastError = null;
  for (const symbol of eodhdSymbolCandidates(ticker)) {
    try {
      const url = new URL(`https://eodhd.com/api/eod/${encodeURIComponent(symbol)}`);
      url.searchParams.set("from", fromDate);
      url.searchParams.set("to", toDate);
      url.searchParams.set("period", "d");
      url.searchParams.set("fmt", "json");
      url.searchParams.set("api_token", config.eodhdApiKey);
      const payload = await fetchJson(url, { timeoutMs: PORTFOLIO_HISTORY_TIMEOUT_MS });
      const rows = Array.isArray(payload) ? payload : [];
      const points = rows.map((row) => {
        const date = row.date || row.price_date;
        const close = Number(row.adjusted_close ?? row.close);
        if (!date || !Number.isFinite(close) || close <= 0) return null;
        return { date, time: `${date}T00:00:00.000Z`, value: roundMoney(close) };
      }).filter(Boolean);
      if (!points.length) {
        lastError = new Error(`EODHD returned no history for ${symbol}`);
        continue;
      }
      return { ticker, currency: fallbackCurrency, provider: "eodhd", points };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`EODHD returned no history for ${ticker}`);
}

function cachedHistory(database, ticker, fromDate, toDate) {
  const rows = database.prepare(`
    SELECT price_date AS date, close AS value, currency, provider, updated_at AS updatedAt
    FROM historical_prices
    WHERE ticker = ? AND price_date >= ? AND price_date <= ?
    ORDER BY price_date
  `).all(ticker, fromDate, toDate);
  if (!rows.length) return null;
  const latestUpdate = rows.reduce((max, row) => (!max || row.updatedAt > max ? row.updatedAt : max), "");
  const fresh = latestUpdate && Date.now() - new Date(latestUpdate).getTime() < config.performanceHistoryCacheHours * 60 * 60 * 1000;
  return {
    ticker,
    currency: rows[0].currency,
    provider: fresh ? `cached ${rows[0].provider}` : `stale cached ${rows[0].provider}`,
    fresh,
    points: rows.map((row) => ({
      date: row.date,
      time: `${row.date}T00:00:00.000Z`,
      value: Number(row.value)
    })).filter((point) => Number.isFinite(point.value) && point.value > 0)
  };
}

function saveHistory(database, history) {
  if (!history?.points?.length) return;
  const insert = database.prepare(`
    INSERT INTO historical_prices (ticker, price_date, close, currency, provider, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, price_date) DO UPDATE SET
      close = excluded.close,
      currency = excluded.currency,
      provider = excluded.provider,
      updated_at = excluded.updated_at
  `);
  const updatedAt = nowIso();
  for (const point of history.points) {
    insert.run(history.ticker, point.date, point.value, history.currency, history.provider, updatedAt);
  }
}

function syntheticHistoryForTicker(ticker, lots, realizedRows, currentQuote, fallbackCurrency, fromDate, toDate) {
  const points = [];
  for (const lot of lots.filter((row) => row.ticker === ticker)) {
    const date = toDateOnly(lot.purchase_date);
    if (date && date >= fromDate && date <= toDate) {
      points.push({ date, time: `${date}T00:00:00.000Z`, value: Number(lot.purchase_price) || null });
    }
  }
  for (const row of realizedRows.filter((item) => item.ticker === ticker)) {
    const date = toDateOnly(row.soldAt);
    if (date && date >= fromDate && date <= toDate) {
      points.push({ date, time: `${date}T00:00:00.000Z`, value: Number(row.salePrice) || null });
    }
  }
  if (currentQuote?.price) points.push({ date: toDate, time: `${toDate}T23:59:59.000Z`, value: Number(currentQuote.price) });
  const deduped = new Map();
  for (const point of points) {
    if (Number.isFinite(point.value) && point.value > 0) deduped.set(point.date, point);
  }
  return {
    ticker,
    currency: currentQuote?.currency || fallbackCurrency,
    provider: "broker fallback",
    synthetic: true,
    points: [...deduped.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

export async function fetchPriceHistory(tickerInput, rangeInput = "1y", options = {}) {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new InputError("Ticker is required");
  const range = assertRange(rangeInput);
  const database = getDb();
  const fromDate = options.fromDate || startDateForRange(range, options.firstHoldingDate);
  const toDate = options.toDate || isoDate(new Date());
  const fallbackCurrency = normalizeQuoteCurrency(options.currency, "USD");
  const cached = cachedHistory(database, ticker, fromDate, toDate);
  if (cached?.fresh && cached.points.length >= 2) return cached;
  const providers = [fetchStooqPriceHistory, fetchEodhdPriceHistory];
  let lastError = null;
  for (const provider of providers) {
    try {
      const history = await provider(ticker, fromDate, toDate, fallbackCurrency);
      if (history.points.length) {
        saveHistory(database, history);
        return history;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (cached?.points?.length) return cached;
  const synthetic = syntheticHistoryForTicker(
    ticker,
    options.lots || [],
    options.realizedRows || [],
    options.currentQuote || null,
    fallbackCurrency,
    fromDate,
    toDate
  );
  if (synthetic.points.length) return synthetic;
  throw lastError || new Error(`No historical prices available for ${ticker}`);
}

export async function fetchYahooPriceHistory(tickerInput, rangeInput = "1y") {
  return fetchPriceHistory(tickerInput, rangeInput);
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

function performanceSummary(points, key = "value") {
  const first = points.find((point) => point[key] != null);
  const last = [...points].reverse().find((point) => point[key] != null);
  const changeValue = first && last ? roundMoney(last[key] - first[key]) : null;
  const changePercent = first?.[key] ? roundPercent((changeValue / first[key]) * 100) : null;
  return {
    startValue: first?.[key] ?? null,
    endValue: last?.[key] ?? null,
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

function quantityHeldAtDate(lot, salesByLot, pointDate, currentOnly = false) {
  if (pointDate < toDateOnly(lot.purchase_date)) return 0;
  if (currentOnly) return Number(lot.quantity) || 0;
  let quantity = Number(lot.original_quantity) || 0;
  for (const sale of salesByLot.get(lot.id) || []) {
    if (toDateOnly(sale.sold_at) <= pointDate) quantity -= Number(sale.quantity) || 0;
  }
  return Math.max(0, quantity);
}

function priceAtOrBefore(history, pointDate) {
  if (!history?.points?.length) return null;
  let latest = null;
  for (const point of history.points) {
    if (point.date <= pointDate) latest = point;
    else break;
  }
  return latest?.value ?? null;
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

function buildAnchorDates(histories, startDate, endDate, maxPoints) {
  const dates = new Set([startDate, endDate]);
  const start = dateAtUtc(startDate);
  const end = dateAtUtc(endDate);
  const totalDays = Math.max(1, Math.round((end - start) / 86_400_000));
  if (totalDays + 1 <= maxPoints) {
    for (let offset = 0; offset <= totalDays; offset += 1) dates.add(addDays(startDate, offset));
    return [...dates].sort();
  }
  for (const history of histories.values()) {
    for (const point of history.points || []) {
      if (point.date >= startDate && point.date <= endDate) dates.add(point.date);
    }
  }
  if (dates.size < 3) {
    const step = totalDays > 900 ? 7 : 1;
    for (let offset = 0; offset <= totalDays; offset += step) dates.add(addDays(startDate, offset));
  }
  return thinPoints([...dates].sort().map((date) => ({ date, time: `${date}T00:00:00.000Z` })), maxPoints)
    .map((point) => point.date);
}

function daysBetween(startDate, endDate) {
  return Math.max(0, Math.round((dateAtUtc(endDate) - dateAtUtc(startDate)) / 86_400_000));
}

async function baseCostForLot(lot, quantity, baseCurrency, fxCache) {
  const rate = await rateFor(lot.purchase_currency, baseCurrency, fxCache);
  return (Number(quantity) || 0) * (Number(lot.purchase_price) || 0) * rate;
}

async function realizedMath(row, baseCurrency, fxCache) {
  const quantity = Number(row.quantity) || 0;
  const buyCurrency = row.lotPurchaseCurrency || row.manualBuyCurrency;
  const buyPrice = row.lotPurchaseCurrency ? row.lotPurchasePrice : row.manualBuyPrice;
  const costBasisBase = buyCurrency
    ? quantity * (Number(buyPrice) || 0) * await rateFor(buyCurrency, baseCurrency, fxCache)
    : Number(row.storedCostBasisBase) || 0;
  const proceedsBase = row.saleCurrency
    ? quantity * (Number(row.salePrice) || 0) * await rateFor(row.saleCurrency, baseCurrency, fxCache)
    : Number(row.storedProceedsBase) || 0;
  return { costBasisBase, proceedsBase, gainLossBase: proceedsBase - costBasisBase };
}

async function dividendBase(row, baseCurrency, fxCache) {
  const rate = await rateFor(row.currency, baseCurrency, fxCache);
  return (Number(row.grossAmount) || 0) * rate;
}

async function externalCashEvents(database, userId, baseCurrency) {
  const rows = database.prepare(`
    SELECT id, event_type AS eventType, event_date AS eventDate, source_description AS sourceDescription,
      net_amount AS netAmount, converted_amount_base AS convertedAmountBase, currency, add_to_cash AS addToCash
    FROM external_income_events
    WHERE user_id = ? AND add_to_cash = 1
    ORDER BY event_date, created_at
  `).all(userId);
  const events = [];
  for (const row of rows) {
    const stored = Number(row.convertedAmountBase);
    const amountBase = Number.isFinite(stored)
      ? stored
      : (await convertAmount(row.netAmount, row.currency, baseCurrency).catch(() => null))?.amount;
    if (!Number.isFinite(Number(amountBase))) continue;
    const isExpense = row.eventType === "EXPENSE" || Number(row.netAmount) < 0;
    events.push({
      id: row.id,
      date: toDateOnly(row.eventDate),
      type: isExpense ? "withdrawal" : "deposit",
      source: row.sourceDescription || (isExpense ? "External expense" : "External income"),
      amountBase: roundMoney(isExpense ? -Math.abs(amountBase) : Math.abs(amountBase)),
      externalFlow: true,
      estimated: false
    });
  }
  return events.filter((event) => event.date);
}

function cashAtDate(events, date) {
  return events
    .filter((event) => event.date <= date)
    .reduce((total, event) => total + Number(event.amountBase || 0), 0);
}

function externalFlowOnDate(events, date) {
  return events
    .filter((event) => event.date === date && event.externalFlow)
    .reduce((total, event) => total + Number(event.amountBase || 0), 0);
}

async function buildCashEvents({
  database,
  userId,
  lots,
  realizedRows,
  dividendRows,
  currentCashBase,
  firstHoldingDate,
  baseCurrency,
  fxCache
}) {
  const today = isoDate(new Date());
  const events = [];
  for (const lot of lots) {
    const costBase = await baseCostForLot(lot, lot.original_quantity, baseCurrency, fxCache);
    if (!lot.purchase_date || !Number.isFinite(costBase)) continue;
    events.push({
      id: `buy_${lot.id}`,
      date: toDateOnly(lot.purchase_date),
      type: "buy",
      ticker: lot.ticker,
      source: lot.ticker,
      amountBase: -roundMoney(costBase),
      externalFlow: false
    });
  }
  for (const row of realizedRows) {
    const math = await realizedMath(row, baseCurrency, fxCache);
    if (!row.soldAt || !Number.isFinite(math.proceedsBase)) continue;
    events.push({
      id: `sale_${row.id || row.lotId || `${row.ticker}_${row.soldAt}`}`,
      date: toDateOnly(row.soldAt),
      type: "sale",
      ticker: row.ticker,
      source: row.ticker,
      amountBase: roundMoney(math.proceedsBase),
      realizedGainBase: roundMoney(math.gainLossBase),
      externalFlow: false
    });
  }
  for (const row of dividendRows) {
    const date = toDateOnly(row.payDate || row.exDate);
    const amountBase = await dividendBase(row, baseCurrency, fxCache);
    if (!date || !Number.isFinite(amountBase)) continue;
    events.push({
      id: `dividend_${row.id || `${row.ticker}_${date}`}`,
      date,
      type: "dividend",
      ticker: row.ticker,
      source: row.ticker,
      amountBase: roundMoney(amountBase),
      externalFlow: false
    });
  }
  events.push(...await externalCashEvents(database, userId, baseCurrency));

  const currentEventTotal = events
    .filter((event) => event.date <= today)
    .reduce((total, event) => total + Number(event.amountBase || 0), 0);
  const openingAmount = roundMoney(currentCashBase - currentEventTotal);
  const openingDate = firstHoldingDate || today;
  events.unshift({
    id: "cash_opening_reconciliation",
    date: openingDate,
    type: "opening_cash",
    source: "Opening / reconciled cash balance",
    amountBase: openingAmount,
    externalFlow: false,
    estimated: true
  });
  return events
    .filter((event) => event.date && Number.isFinite(Number(event.amountBase)))
    .sort((a, b) => `${a.date}|${a.type}|${a.id}`.localeCompare(`${b.date}|${b.type}|${b.id}`));
}

function syntheticLotFromSale(row, index) {
  if (row.lotId || !row.manualBoughtAt || !row.manualBuyPrice || !row.quantity) return null;
  return {
    id: `external_${row.id || index}`,
    ticker: row.ticker,
    original_quantity: Number(row.quantity) || 0,
    quantity: 0,
    purchase_price: Number(row.manualBuyPrice) || 0,
    purchase_currency: row.manualBuyCurrency || row.saleCurrency,
    purchase_date: toDateOnly(row.manualBoughtAt),
    synthetic: true
  };
}

function appendLiveQuote(history, quote, endDate) {
  const price = Number(quote?.price);
  if (!Number.isFinite(price) || price <= 0) return history;
  const points = [...(history.points || [])].filter((point) => point.date !== endDate);
  points.push({ date: endDate, time: `${endDate}T23:59:59.000Z`, value: price });
  points.sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...history,
    currency: history.currency || quote.currency,
    provider: `${history.provider || "historical prices"} + live quote`,
    points
  };
}

function applyUnitizedReturns(points) {
  if (!points.length) return points;
  const firstValue = Number(points[0].rawValue) || 0;
  let cumulativeReturn = 0;
  let previousValue = firstValue;
  return points.map((point, index) => {
    if (index === 0 || previousValue <= 0) {
      previousValue = Number(point.rawValue) || previousValue;
      return {
        ...point,
        adjustedValue: roundMoney(firstValue),
        returnPercent: 0,
        periodReturnPercent: 0
      };
    }
    const externalFlow = Number(point.externalCashFlowBase) || 0;
    const endValue = Number(point.rawValue) || previousValue;
    const periodReturn = (endValue - externalFlow - previousValue) / previousValue;
    if (Number.isFinite(periodReturn)) {
      cumulativeReturn = ((1 + cumulativeReturn) * (1 + periodReturn)) - 1;
    }
    previousValue = endValue;
    return {
      ...point,
      adjustedValue: roundMoney(firstValue * (1 + cumulativeReturn)),
      returnPercent: roundPercent(cumulativeReturn * 100),
      periodReturnPercent: Number.isFinite(periodReturn) ? roundPercent(periodReturn * 100) : null
    };
  });
}

async function oneDayPortfolioPerformance(lots, baseCurrency, cashBase, fxCache) {
  const tickers = [...new Set(lots.map((lot) => lot.ticker))];
  const quotes = new Map();
  await mapWithConcurrency(tickers, PORTFOLIO_HISTORY_CONCURRENCY, async (ticker) => {
    quotes.set(ticker, await getQuote(ticker).catch(() => null));
  });
  let startRaw = cashBase;
  let endRaw = cashBase;
  let startCost = 0;
  let endCost = 0;
  const warnings = [];
  for (const lot of lots) {
    const quote = quotes.get(lot.ticker);
    const rate = await rateFor(quote?.currency || lot.purchase_currency, baseCurrency, fxCache);
    const qty = Number(lot.quantity) || 0;
    const endPrice = Number(quote?.price);
    const startPrice = Number(quote?.previousClose ?? quote?.regularMarketPrice ?? quote?.price);
    const cost = await baseCostForLot(lot, qty, baseCurrency, fxCache);
    startCost += cost;
    endCost += cost;
    if (Number.isFinite(startPrice) && startPrice > 0) startRaw += startPrice * qty * rate;
    else warnings.push(`${lot.ticker}: previous close unavailable`);
    if (Number.isFinite(endPrice) && endPrice > 0) endRaw += endPrice * qty * rate;
    else warnings.push(`${lot.ticker}: live quote unavailable`);
  }
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const points = [
    {
      date: isoDate(yesterday),
      time: yesterday.toISOString(),
      value: roundMoney(startRaw),
      rawValue: roundMoney(startRaw),
      adjustedValue: roundMoney(startRaw - startCost),
      investedCapital: roundMoney(startCost),
      realizedValue: 0,
      dividendValue: 0,
      returnPercent: startCost ? roundPercent(((startRaw - startCost) / startCost) * 100) : null
    },
    {
      date: isoDate(now),
      time: now.toISOString(),
      value: roundMoney(endRaw),
      rawValue: roundMoney(endRaw),
      adjustedValue: roundMoney(endRaw - endCost),
      investedCapital: roundMoney(endCost),
      realizedValue: 0,
      dividendValue: 0,
      returnPercent: endCost ? roundPercent(((endRaw - endCost) / endCost) * 100) : null
    }
  ];
  const raw = performanceSummary(points, "rawValue");
  const adjusted = performanceSummary(points, "adjustedValue");
  return {
    range: "1d",
    label: PERFORMANCE_RANGES["1d"].label,
    currency: baseCurrency,
    provider: "live quotes + previous close",
    points,
    ...raw,
    startAdjustedValue: adjusted.startValue,
    endAdjustedValue: adjusted.endValue,
    adjustedChangeValue: adjusted.changeValue,
    adjustedChangePercent: adjusted.changePercent,
    performanceReliable: true,
    baselineDate: points[0].date,
    includesRealized: false,
    warnings
  };
}

export async function portfolioPerformance(userId, rangeInput = "1y") {
  const range = assertRange(rangeInput);
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const baseCurrency = user.base_currency;
  const allLotsRaw = database.prepare(`
    SELECT id, ticker, original_quantity, quantity, purchase_price, purchase_currency, purchase_date
    FROM holding_lots
    WHERE user_id = ? AND original_quantity > 0
    ORDER BY ticker, purchase_date
  `).all(userId);

  const salesByLot = new Map();
  const realizedSourceRows = database.prepare(`
    SELECT r.id, r.source, r.ticker, r.quantity, r.sale_price AS salePrice, r.sale_currency AS saleCurrency,
      r.sold_at AS soldAt, r.cost_basis_base AS storedCostBasisBase,
      r.proceeds_base AS storedProceedsBase, r.gain_loss_base AS storedGainLossBase,
      r.buy_price AS manualBuyPrice, r.buy_currency AS manualBuyCurrency,
      r.bought_at AS manualBoughtAt, l.purchase_price AS lotPurchasePrice,
      l.purchase_currency AS lotPurchaseCurrency, l.purchase_date AS lotPurchaseDate,
      r.lot_id AS lotId
    FROM realized_lots r
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at
  `).all(userId);

  const syntheticLots = realizedSourceRows
    .map((row, index) => syntheticLotFromSale(row, index))
    .filter(Boolean);
  syntheticLots.forEach((lot) => {
    const sourceSale = realizedSourceRows.find((row) => `external_${row.id}` === lot.id);
    if (sourceSale) sourceSale.syntheticLotId = lot.id;
  });
  const lots = [...allLotsRaw, ...syntheticLots];
  if (!lots.length) {
    return { range, currency: baseCurrency, points: [], ...performanceSummary([]), warnings: ["No lots or closed transactions found"] };
  }
  realizedSourceRows.forEach((sale) => {
    const saleLotId = sale.lotId || sale.syntheticLotId;
    if (!saleLotId) return;
    if (!salesByLot.has(saleLotId)) salesByLot.set(saleLotId, []);
    salesByLot.get(saleLotId).push({ quantity: sale.quantity, sold_at: sale.soldAt });
  });

  const dividendRows = database.prepare(`
    SELECT id, ticker, pay_date AS payDate, ex_date AS exDate, gross_amount AS grossAmount,
      gross_amount_base AS storedGrossAmountBase, currency
    FROM dividend_payments
    WHERE user_id = ?
    ORDER BY COALESCE(pay_date, ex_date)
  `).all(userId);

  const firstHoldingDate = [
    ...lots.map((lot) => toDateOnly(lot.purchase_date)),
    ...realizedSourceRows.map((row) => toDateOnly(row.manualBoughtAt || row.lotPurchaseDate))
  ].filter(Boolean).sort()[0];
  const startDate = startDateForRange(range, firstHoldingDate);
  const endDate = isoDate(new Date());
  const fxCache = new Map();
  const cashBase = await cashValueBase(database, userId, baseCurrency, fxCache);
  if (range === "1d") {
    return oneDayPortfolioPerformance(allLotsRaw.filter((lot) => Number(lot.quantity) > 0), baseCurrency, cashBase, fxCache);
  }
  const cashEvents = await buildCashEvents({
    database,
    userId,
    lots,
    realizedRows: realizedSourceRows,
    dividendRows,
    currentCashBase: cashBase,
    firstHoldingDate,
    baseCurrency,
    fxCache
  });

  const tickers = [...new Set(lots.map((lot) => lot.ticker))];
  const currentQuotes = new Map();
  for (const row of database.prepare("SELECT * FROM market_prices").all()) {
    currentQuotes.set(row.ticker, { price: row.price, currency: row.currency, provider: row.provider });
  }
  const histories = new Map();
  const warnings = [];
  const historyResults = await mapWithConcurrency(tickers, PORTFOLIO_HISTORY_CONCURRENCY, async (ticker) => {
    const equityCurrency = database.prepare("SELECT currency FROM equities WHERE ticker = ?").get(ticker)?.currency;
    try {
      return {
        ticker,
        history: await fetchPriceHistory(ticker, range, {
          fromDate: startDate,
          toDate: endDate,
          currency: currentQuotes.get(ticker)?.currency || equityCurrency,
          lots,
          realizedRows: realizedSourceRows,
          currentQuote: currentQuotes.get(ticker)
        })
      };
    } catch (error) {
      return { ticker, warning: `${ticker}: ${error.message}` };
    }
  });
  for (const result of historyResults) {
    if (result?.history) {
      if (result.history.synthetic) {
        warnings.push(`${result.ticker}: broker transaction fallback skipped for portfolio chart; real historical prices are required`);
        continue;
      }
      histories.set(result.ticker, appendLiveQuote(result.history, currentQuotes.get(result.ticker), endDate));
    }
    else if (result?.warning) warnings.push(result.warning);
  }
  if (!histories.size) {
    warnings.unshift("No reliable historical market prices are loaded for this range. Broker transaction fallback was disabled because it can overstate portfolio value.");
    warnings.unshift("Showing transaction-based book value instead. This is not historical market value.");
    const fallbackDates = buildAnchorDates(new Map(), startDate, endDate, PERFORMANCE_RANGES[range].maxPoints);
    const fallbackPoints = [];
    const realizedCache = new Map();
    const dividendCache = new Map();
    for (const date of fallbackDates) {
      let remainingCostBasisBase = 0;
      let realizedGainBase = 0;
      let realizedCostBasisBase = 0;
      let dividendIncomeBase = 0;
      for (const lot of lots) {
        const quantity = quantityHeldAtDate(lot, salesByLot, date, false);
        if (quantity <= 0) continue;
        remainingCostBasisBase += await baseCostForLot(lot, quantity, baseCurrency, fxCache);
      }
      for (const row of realizedSourceRows) {
        if (toDateOnly(row.soldAt) > date) continue;
        if (!realizedCache.has(row)) realizedCache.set(row, await realizedMath(row, baseCurrency, fxCache));
        const item = realizedCache.get(row);
        realizedGainBase += item.gainLossBase;
        realizedCostBasisBase += item.costBasisBase;
      }
      for (const row of dividendRows) {
        const eventDate = toDateOnly(row.payDate || row.exDate);
        if (!eventDate || eventDate > date) continue;
        if (!dividendCache.has(row)) dividendCache.set(row, await dividendBase(row, baseCurrency, fxCache));
        dividendIncomeBase += dividendCache.get(row);
      }
      const cashValue = cashAtDate(cashEvents, date);
      const rawValue = remainingCostBasisBase + cashValue;
      fallbackPoints.push({
        date,
        time: `${date}T00:00:00.000Z`,
        value: roundMoney(rawValue),
        rawValue: roundMoney(rawValue),
        adjustedValue: roundMoney(rawValue),
        holdingsMarketValueBase: null,
        remainingCostBasisBase: roundMoney(remainingCostBasisBase),
        cashValueBase: roundMoney(cashValue),
        externalCashFlowBase: roundMoney(externalFlowOnDate(cashEvents, date)),
        investedCapital: roundMoney(remainingCostBasisBase + realizedCostBasisBase),
        realizedValue: roundMoney(realizedGainBase),
        dividendValue: roundMoney(dividendIncomeBase),
        unrealizedValue: null,
        dataCoveragePercent: 0,
        dataQualityStatus: "book_value_fallback",
        returnPercent: null
      });
    }
    const finalFallbackPoints = applyUnitizedReturns(fallbackPoints);
    const raw = performanceSummary(finalFallbackPoints, "rawValue");
    const adjusted = performanceSummary(finalFallbackPoints, "adjustedValue");
    return {
      range,
      label: PERFORMANCE_RANGES[range].label,
      currency: baseCurrency,
      provider: "transaction book value fallback",
      points: finalFallbackPoints,
      ...raw,
      startAdjustedValue: adjusted.startValue,
      endAdjustedValue: adjusted.endValue,
      adjustedChangeValue: adjusted.changeValue,
      adjustedChangePercent: adjusted.changePercent,
      performanceReliable: false,
      baselineDate: startDate,
      includesRealized: true,
      chartModes: {
        withCash: "Book Value fallback: open cost basis plus transaction-aware cash",
        withoutCash: "Unitized book-value change; deposits and withdrawals neutralized"
      },
      cashFlowDiagnostics: {
        cashIncludedBase: roundMoney(cashBase),
        currentCashBase: roundMoney(cashBase),
        openingCashReconciliationBase: roundMoney(cashEvents.find((event) => event.id === "cash_opening_reconciliation")?.amountBase || 0),
        reconstructedCashTodayBase: roundMoney(cashAtDate(cashEvents, endDate)),
        realizedRowsIncluded: realizedSourceRows.length,
        dividendRowsIncluded: dividendRows.length,
        saleProceedsIncludedBase: roundMoney(cashEvents.filter((event) => event.type === "sale").reduce((total, event) => total + Number(event.amountBase || 0), 0)),
        externalCashFlowBase: roundMoney(cashEvents.filter((event) => event.externalFlow).reduce((total, event) => total + Number(event.amountBase || 0), 0))
      },
      dataQuality: {
        startDate,
        endDate,
        expectedPointCount: Math.min(daysBetween(startDate, endDate) + 1, PERFORMANCE_RANGES[range].maxPoints),
        pointCount: finalFallbackPoints.length,
        averageCoveragePercent: 0,
        missingTickers: tickers.sort(),
        cashReconciled: Math.abs(roundMoney(cashAtDate(cashEvents, endDate) - cashBase)) < 0.01,
        noSyntheticBrokerPrices: true,
        fallback: "book_value"
      },
      warnings: [...new Set(warnings)].slice(0, 20)
    };
  }

  const anchorDates = buildAnchorDates(histories, startDate, endDate, PERFORMANCE_RANGES[range].maxPoints);
  const realizedCache = new Map();
  const dividendCache = new Map();
  const points = [];
  const missingTickers = new Set();
  let coverageTotal = 0;
  let coverageValued = 0;

  for (const date of anchorDates) {
    let holdingsMarketValueBase = 0;
    let activeCostBase = 0;
    let realizedGainBase = 0;
    let realizedCostBasisBase = 0;
    let dividendIncomeBase = 0;
    let holdingsRequired = 0;
    let holdingsValued = 0;

    for (const lot of lots) {
      const quantity = quantityHeldAtDate(lot, salesByLot, date, false);
      if (quantity <= 0) continue;
      holdingsRequired += 1;
      const history = histories.get(lot.ticker);
      const price = priceAtOrBefore(history, date);
      if (price == null) {
        warnings.push(`${lot.ticker}: missing price around ${date}`);
        missingTickers.add(lot.ticker);
        continue;
      }
      const rate = await rateFor(history?.currency || lot.purchase_currency, baseCurrency, fxCache);
      holdingsMarketValueBase += price * quantity * rate;
      activeCostBase += await baseCostForLot(lot, quantity, baseCurrency, fxCache);
      holdingsValued += 1;
    }
    coverageTotal += holdingsRequired;
    coverageValued += holdingsValued;

    for (const row of realizedSourceRows) {
      if (toDateOnly(row.soldAt) > date) continue;
      if (!realizedCache.has(row)) realizedCache.set(row, await realizedMath(row, baseCurrency, fxCache));
      const item = realizedCache.get(row);
      realizedGainBase += item.gainLossBase;
      realizedCostBasisBase += item.costBasisBase;
    }
    for (const row of dividendRows) {
      const eventDate = toDateOnly(row.payDate || row.exDate);
      if (!eventDate || eventDate > date) continue;
      if (!dividendCache.has(row)) dividendCache.set(row, await dividendBase(row, baseCurrency, fxCache));
      dividendIncomeBase += dividendCache.get(row);
    }

    const cashValueBase = cashAtDate(cashEvents, date);
    const rawValue = holdingsMarketValueBase + cashValueBase;
    const investedCapital = activeCostBase + realizedCostBasisBase;
    points.push({
      date,
      time: `${date}T00:00:00.000Z`,
      value: roundMoney(rawValue),
      rawValue: roundMoney(rawValue),
      adjustedValue: roundMoney(rawValue),
      holdingsMarketValueBase: roundMoney(holdingsMarketValueBase),
      cashValueBase: roundMoney(cashValueBase),
      externalCashFlowBase: roundMoney(externalFlowOnDate(cashEvents, date)),
      investedCapital: roundMoney(investedCapital),
      realizedValue: roundMoney(realizedGainBase),
      dividendValue: roundMoney(dividendIncomeBase),
      unrealizedValue: roundMoney(holdingsMarketValueBase - activeCostBase),
      dataCoveragePercent: holdingsRequired ? roundPercent((holdingsValued / holdingsRequired) * 100) : 100,
      dataQualityStatus: holdingsRequired === holdingsValued ? "complete" : holdingsValued ? "partial" : "missing",
      returnPercent: null
    });
  }

  const finalPoints = applyUnitizedReturns(points);
  const averageCoverage = coverageTotal ? roundPercent((coverageValued / coverageTotal) * 100) : 100;
  const expectedPointCount = Math.min(daysBetween(startDate, endDate) + 1, PERFORMANCE_RANGES[range].maxPoints);
  if (range === "1mo" && finalPoints.length < Math.max(2, expectedPointCount - 3)) {
    warnings.unshift(`Insufficient historical daily points for 1M chart - expected about ${expectedPointCount}, got ${finalPoints.length}.`);
  }
  if (averageCoverage < 95) {
    warnings.unshift(`Historical price coverage is partial (${averageCoverage}%). Missing tickers: ${[...missingTickers].slice(0, 8).join(", ") || "unknown"}.`);
  }

  const raw = performanceSummary(finalPoints, "rawValue");
  const adjusted = performanceSummary(finalPoints, "adjustedValue");
  if (range === "1mo" && raw.changePercent != null && Math.abs(raw.changePercent) > 20) {
    warnings.unshift("Large performance move detected - verify cash flows, sales, FX, and historical price coverage before trusting this 1M result.");
  }
  if (range === "1d" && raw.changePercent != null && Math.abs(raw.changePercent) > 10) {
    warnings.unshift("Large 1D performance move detected - verify quote coverage and cash reconciliation.");
  }
  const providers = [...new Set([...histories.values()].map((history) => history.provider))].slice(0, 4).join(" + ");
  return {
    range,
    label: PERFORMANCE_RANGES[range].label,
    currency: baseCurrency,
    provider: providers || "cached historical prices",
    points: finalPoints,
    ...raw,
    startAdjustedValue: adjusted.startValue,
    endAdjustedValue: adjusted.endValue,
    adjustedChangeValue: adjusted.changeValue,
    adjustedChangePercent: adjusted.changePercent,
    performanceReliable: averageCoverage >= 95 && !warnings.some((warning) => /Large performance move|Insufficient historical daily points/i.test(warning)),
    baselineDate: startDate,
    includesRealized: true,
    chartModes: {
      withCash: "Total Portfolio Value: holdings plus transaction-aware cash",
      withoutCash: "Investment Performance: unitized return, neutralizing external deposits and withdrawals"
    },
    cashFlowDiagnostics: {
      currentCashBase: roundMoney(cashBase),
      cashIncludedBase: roundMoney(cashBase),
      openingCashReconciliationBase: roundMoney(cashEvents.find((event) => event.id === "cash_opening_reconciliation")?.amountBase || 0),
      reconstructedCashTodayBase: roundMoney(cashAtDate(cashEvents, endDate)),
      realizedRowsIncluded: realizedSourceRows.length,
      dividendRowsIncluded: dividendRows.length,
      saleProceedsIncludedBase: roundMoney(cashEvents.filter((event) => event.type === "sale").reduce((total, event) => total + Number(event.amountBase || 0), 0)),
      externalCashFlowBase: roundMoney(cashEvents.filter((event) => event.externalFlow).reduce((total, event) => total + Number(event.amountBase || 0), 0))
    },
    dataQuality: {
      startDate,
      endDate,
      expectedPointCount,
      pointCount: finalPoints.length,
      averageCoveragePercent: averageCoverage,
      missingTickers: [...missingTickers].sort(),
      cashReconciled: Math.abs(roundMoney(cashAtDate(cashEvents, endDate) - cashBase)) < 0.01,
      noSyntheticBrokerPrices: true
    },
    warnings: [...new Set(warnings)].slice(0, 20)
  };
}

export async function tickerPerformance(tickerInput, rangeInput = "1y") {
  const range = assertRange(rangeInput);
  const ticker = normalizeTicker(tickerInput);
  const database = getDb();
  const quote = database.prepare("SELECT currency FROM market_prices WHERE ticker = ?").get(ticker);
  const equity = database.prepare("SELECT currency FROM equities WHERE ticker = ?").get(ticker);
  const history = await fetchPriceHistory(ticker, range, {
    currency: quote?.currency || equity?.currency || "USD"
  });
  return {
    ...history,
    range,
    label: PERFORMANCE_RANGES[range].label,
    points: thinPoints(history.points, PERFORMANCE_RANGES[range].maxPoints),
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

  const rawLots = database.prepare(`
    SELECT id, quantity, original_quantity AS originalQuantity, purchase_price AS purchasePrice,
      purchase_currency AS purchaseCurrency, purchase_date AS purchaseDate
    FROM holding_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY purchase_date, created_at
  `).all(userId, ticker);
  const realizedRows = database.prepare(`
    SELECT r.id, r.lot_id AS lotId, r.quantity, r.sale_price AS salePrice,
      r.sale_currency AS saleCurrency, r.sold_at AS soldAt,
      r.cost_basis_base AS storedCostBasisBase, r.proceeds_base AS storedProceedsBase,
      r.gain_loss_base AS storedGainLossBase, r.gain_loss_percent AS storedGainLossPercent,
      r.buy_price AS manualBuyPrice, r.buy_currency AS manualBuyCurrency,
      r.source, r.notes, r.created_at AS createdAt,
      l.purchase_price AS lotPurchasePrice, l.purchase_currency AS lotPurchaseCurrency
    FROM realized_lots r
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ? AND r.ticker = ?
    ORDER BY r.sold_at, r.created_at
  `).all(userId, ticker);
  const salesByLot = new Map();
  for (const row of realizedRows) {
    const quantity = Number(row.quantity) || 0;
    const buyCurrency = row.lotPurchaseCurrency || row.manualBuyCurrency;
    const buyPrice = row.lotPurchaseCurrency ? row.lotPurchasePrice : row.manualBuyPrice;
    const saleCurrency = row.saleCurrency;
    const costBasis = buyCurrency
      ? await convertAmount(quantity * (Number(buyPrice) || 0), buyCurrency, user.base_currency).catch(() => null)
      : null;
    const proceeds = saleCurrency
      ? await convertAmount(quantity * (Number(row.salePrice) || 0), saleCurrency, user.base_currency).catch(() => null)
      : null;
    const costBasisBase = roundMoney(costBasis?.amount ?? (Number(row.storedCostBasisBase) || 0));
    const proceedsBase = roundMoney(proceeds?.amount ?? (Number(row.storedProceedsBase) || 0));
    const gainLossBase = costBasis?.amount != null && proceeds?.amount != null
      ? roundMoney(proceeds.amount - costBasis.amount)
      : roundMoney(Number(row.storedGainLossBase) || 0);
    if (row.lotId) {
      const lotSales = salesByLot.get(row.lotId) || [];
      lotSales.push({
        id: row.id,
        lotId: row.lotId,
        quantity: roundShares(quantity),
        salePrice: Number(row.salePrice) || 0,
        saleCurrency,
        soldAt: row.soldAt,
        costBasisBase,
        proceedsBase,
        gainLossBase,
        gainLossPercent: costBasisBase ? roundPercent((gainLossBase / costBasisBase) * 100) : row.storedGainLossPercent,
        source: row.source,
        notes: row.notes,
        createdAt: row.createdAt
      });
      salesByLot.set(row.lotId, lotSales);
    }
  }
  const lots = [];
  for (const lot of rawLots) {
    const lotCostBasis = await convertAmount(
      (Number(lot.quantity) || 0) * (Number(lot.purchasePrice) || 0),
      lot.purchaseCurrency,
      user.base_currency
    ).catch(() => null);
    lots.push({
      ...lot,
      soldQuantity: roundShares(Math.max(0, Number(lot.originalQuantity || 0) - Number(lot.quantity || 0))),
      costBasisBase: roundMoney(lotCostBasis?.amount || 0),
      sales: salesByLot.get(lot.id) || []
    });
  }
  const openQuantity = lots.reduce((total, lot) => total + (Number(lot.quantity) || 0), 0);
  const costBasisBase = roundMoney(lots.reduce((total, lot) => total + (Number(lot.costBasisBase) || 0), 0));
  const currentValue = quote?.price && openQuantity
    ? await convertAmount(quote.price * openQuantity, quote.currency, user.base_currency)
    : null;
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
