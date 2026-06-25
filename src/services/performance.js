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

function priceAtOrBefore(history, pointDate, fallback = null) {
  if (!history?.points?.length) return null;
  let latest = null;
  for (const point of history.points) {
    if (point.date <= pointDate) latest = point;
    else break;
  }
  return latest?.value ?? (history.points[0]?.date >= pointDate ? history.points[0]?.value : null) ?? fallback;
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
  for (const history of histories.values()) {
    for (const point of history.points || []) {
      if (point.date >= startDate && point.date <= endDate) dates.add(point.date);
    }
  }
  if (dates.size < 3) {
    const start = dateAtUtc(startDate);
    const end = dateAtUtc(endDate);
    const totalDays = Math.max(1, Math.round((end - start) / 86_400_000));
    const step = totalDays > 900 ? 7 : 1;
    for (let offset = 0; offset <= totalDays; offset += step) dates.add(addDays(startDate, offset));
  }
  return thinPoints([...dates].sort().map((date) => ({ date, time: `${date}T00:00:00.000Z` })), maxPoints)
    .map((point) => point.date);
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
  const allLots = database.prepare(`
    SELECT id, ticker, original_quantity, quantity, purchase_price, purchase_currency, purchase_date
    FROM holding_lots
    WHERE user_id = ? AND original_quantity > 0
    ORDER BY ticker, purchase_date
  `).all(userId);
  if (!allLots.length) {
    return { range, currency: baseCurrency, points: [], ...performanceSummary([]), warnings: ["No lots found"] };
  }
  const currentOnly = range !== "all";
  const lots = currentOnly ? allLots.filter((lot) => Number(lot.quantity) > 0) : allLots;
  if (!lots.length) {
    return { range, currency: baseCurrency, points: [], ...performanceSummary([]), warnings: ["No open holdings found"] };
  }

  const salesByLot = new Map();
  const realizedSourceRows = database.prepare(`
    SELECT r.ticker, r.quantity, r.sale_price AS salePrice, r.sale_currency AS saleCurrency,
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
  realizedSourceRows.forEach((sale) => {
    if (!sale.lotId) return;
    if (!salesByLot.has(sale.lotId)) salesByLot.set(sale.lotId, []);
    salesByLot.get(sale.lotId).push({ quantity: sale.quantity, sold_at: sale.soldAt });
  });

  const dividendRows = database.prepare(`
    SELECT ticker, pay_date AS payDate, ex_date AS exDate, gross_amount AS grossAmount,
      gross_amount_base AS storedGrossAmountBase, currency
    FROM dividend_payments
    WHERE user_id = ?
    ORDER BY COALESCE(pay_date, ex_date)
  `).all(userId);

  const firstHoldingDate = [
    ...allLots.map((lot) => toDateOnly(lot.purchase_date)),
    ...realizedSourceRows.map((row) => toDateOnly(row.manualBoughtAt || row.lotPurchaseDate))
  ].filter(Boolean).sort()[0];
  const startDate = startDateForRange(range, firstHoldingDate);
  const endDate = isoDate(new Date());
  const fxCache = new Map();
  const cashBase = await cashValueBase(database, userId, baseCurrency, fxCache);
  if (range === "1d") {
    return oneDayPortfolioPerformance(lots, baseCurrency, cashBase, fxCache);
  }

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
          lots: allLots,
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
      histories.set(result.ticker, result.history);
    }
    else if (result?.warning) warnings.push(result.warning);
  }
  if (!histories.size) {
    warnings.unshift("No reliable historical market prices are loaded for this range. Broker transaction fallback was disabled because it can overstate portfolio value.");
    return {
      range,
      label: PERFORMANCE_RANGES[range].label,
      currency: baseCurrency,
      provider: "historical prices required",
      points: [],
      ...performanceSummary([]),
      performanceReliable: false,
      baselineDate: startDate,
      includesRealized: !currentOnly,
      cashFlowDiagnostics: {
        currentOnly,
        cashIncludedBase: roundMoney(cashBase),
        realizedRowsIncluded: currentOnly ? 0 : realizedSourceRows.length,
        dividendRowsIncluded: currentOnly ? 0 : dividendRows.length
      },
      warnings: [...new Set(warnings)].slice(0, 20)
    };
  }

  const anchorDates = buildAnchorDates(histories, startDate, endDate, PERFORMANCE_RANGES[range].maxPoints);
  const realizedCache = new Map();
  const dividendCache = new Map();
  const points = [];

  for (const date of anchorDates) {
    let activeValueBase = cashBase;
    let activeCostBase = 0;
    let realizedGainBase = 0;
    let realizedCostBasisBase = 0;
    let dividendIncomeBase = 0;

    for (const lot of lots) {
      const quantity = quantityHeldAtDate(lot, salesByLot, date, currentOnly);
      if (quantity <= 0) continue;
      const history = histories.get(lot.ticker);
      const price = priceAtOrBefore(history, date, Number(lot.purchase_price) || null);
      if (price == null) {
        warnings.push(`${lot.ticker}: missing price around ${date}`);
        continue;
      }
      const rate = await rateFor(history?.currency || lot.purchase_currency, baseCurrency, fxCache);
      activeValueBase += price * quantity * rate;
      activeCostBase += await baseCostForLot(lot, quantity, baseCurrency, fxCache);
    }

    if (!currentOnly) {
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
    }

    const adjustedValue = activeValueBase - cashBase - activeCostBase + realizedGainBase + dividendIncomeBase;
    const rawValue = activeValueBase + (currentOnly ? 0 : realizedGainBase + dividendIncomeBase);
    const investedCapital = activeCostBase + realizedCostBasisBase;
    points.push({
      date,
      time: `${date}T00:00:00.000Z`,
      value: roundMoney(rawValue),
      rawValue: roundMoney(rawValue),
      adjustedValue: roundMoney(adjustedValue),
      investedCapital: roundMoney(investedCapital),
      realizedValue: roundMoney(realizedGainBase),
      dividendValue: roundMoney(dividendIncomeBase),
      returnPercent: investedCapital ? roundPercent((adjustedValue / investedCapital) * 100) : null
    });
  }

  if (range === "all" && points.length) {
    points[0].adjustedValue = 0;
    points[0].realizedValue = 0;
    points[0].dividendValue = 0;
    points[0].returnPercent = 0;
  }

  const raw = performanceSummary(points, "rawValue");
  const adjusted = performanceSummary(points, "adjustedValue");
  const providers = [...new Set([...histories.values()].map((history) => history.provider))].slice(0, 4).join(" + ");
  return {
    range,
    label: PERFORMANCE_RANGES[range].label,
    currency: baseCurrency,
    provider: providers || "cached historical prices",
    points,
    ...raw,
    startAdjustedValue: adjusted.startValue,
    endAdjustedValue: adjusted.endValue,
    adjustedChangeValue: adjusted.changeValue,
    adjustedChangePercent: adjusted.changePercent,
    performanceReliable: true,
    baselineDate: startDate,
    includesRealized: !currentOnly,
    chartModes: {
      withCash: "Raw portfolio value including capital additions",
      withoutCash: currentOnly
        ? "Open-holding investment P&L excluding added capital"
        : "Total cumulative P&L including realized gains and dividends"
    },
    cashFlowDiagnostics: {
      currentOnly,
      cashIncludedBase: roundMoney(cashBase),
      realizedRowsIncluded: currentOnly ? 0 : realizedSourceRows.length,
      dividendRowsIncluded: currentOnly ? 0 : dividendRows.length
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
