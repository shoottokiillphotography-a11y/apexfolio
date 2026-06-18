import { getDb } from "../db.js";
import { config } from "../config.js";
import {
  fetchJson,
  normalizeTicker,
  nowIso,
  RateLimiter,
  roundMoney,
  roundPercent
} from "../utils.js";
import { trackedTickers } from "./market-data.js";

const limiter = new RateLimiter(config.finnhubMinIntervalMs);
let trackedRefreshInFlight = null;
let yahooAuthCache = null;

function cacheFresh(row) {
  return row?.as_of && Date.now() - new Date(row.as_of).getTime() < config.fundamentalCacheSeconds * 1000;
}

function metricNumber(metric, keys) {
  for (const key of keys) {
    const value = Number(metric?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function rawNumber(value) {
  const raw = value && typeof value === "object" && "raw" in value ? value.raw : value;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function yahooNumber(sections, keys) {
  for (const key of keys) {
    for (const section of sections) {
      const value = rawNumber(section?.[key]);
      if (value != null) return value;
    }
  }
  return null;
}

function yahooPercent(value) {
  if (value == null) return null;
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return roundPercent(percent);
}

function isCryptoTicker(ticker) {
  return /-(USD|AUD|GBP|EUR|USDT|USDC)$/i.test(ticker);
}

function percentMetric(metric, keys) {
  const value = metricNumber(metric, keys);
  return value == null ? null : roundPercent(value);
}

function fcfYield(metric) {
  const direct = metricNumber(metric, ["freeCashFlowYieldTTM", "fcfYieldTTM"]);
  if (direct != null) return roundPercent(direct);
  const pfcf = metricNumber(metric, [
    "priceToFreeCashFlowsRatioTTM",
    "priceToFreeCashFlowsRatioAnnual",
    "pfcfShareTTM"
  ]);
  return pfcf && pfcf !== 0 ? roundPercent(100 / pfcf) : null;
}

function normalizeFundamentals(ticker, payload) {
  const metric = payload?.metric || {};
  const peRatio = metricNumber(metric, ["peBasicExclExtraTTM", "peNormalizedAnnual", "peExclExtraTTM"]);
  const forwardPe = metricNumber(metric, ["forwardPE", "peForwardAnnual"]);
  const evEbitda = metricNumber(metric, ["evToEbitdaTTM", "evToEbitdaAnnual"]);
  const priceSales = metricNumber(metric, ["psTTM", "priceToSalesRatioTTM", "psAnnual"]);
  const peg = metricNumber(metric, ["pegRatio", "pegRatioTTM"]);
  const marketCap = metricNumber(metric, ["marketCapitalization"]);

  return {
    ticker,
    peRatio: peRatio == null ? null : roundMoney(peRatio),
    forwardPe: forwardPe == null ? null : roundMoney(forwardPe),
    evEbitda: evEbitda == null ? null : roundMoney(evEbitda),
    priceSales: priceSales == null ? null : roundMoney(priceSales),
    fcfYield: fcfYield(metric),
    peg: peg == null ? null : roundMoney(peg),
    revenueGrowth: percentMetric(metric, ["revenueGrowthTTMYoy", "revenueGrowth3Y", "revenueGrowth5Y"]),
    epsGrowth: percentMetric(metric, ["epsGrowthTTMYoy", "epsGrowth3Y", "epsGrowth5Y"]),
    beta: metricNumber(metric, ["beta"]),
    marketCap: marketCap == null ? null : roundMoney(marketCap),
    grossMargin: percentMetric(metric, ["grossMarginTTM", "grossMarginAnnual"]),
    operatingMargin: percentMetric(metric, ["operatingMarginTTM", "operatingMarginAnnual"]),
    debtEquity: metricNumber(metric, ["totalDebt/totalEquityAnnual", "totalDebt/totalEquityTTM"]),
    provider: "finnhub",
    status: Object.keys(metric).length ? "LIVE" : "DATA_GAP",
    asOf: nowIso(),
    error: Object.keys(metric).length ? null : "Finnhub returned no fundamental metrics",
    metricJson: JSON.stringify(payload || {})
  };
}

function emptyFundamentals(ticker, error) {
  return {
    ticker,
    peRatio: null,
    forwardPe: null,
    evEbitda: null,
    priceSales: null,
    fcfYield: null,
    peg: null,
    revenueGrowth: null,
    epsGrowth: null,
    beta: null,
    marketCap: null,
    grossMargin: null,
    operatingMargin: null,
    debtEquity: null,
    provider: config.finnhubApiKey ? "finnhub" : "none",
    status: config.finnhubApiKey ? "DATA_GAP" : "UNAVAILABLE",
    asOf: nowIso(),
    error,
    metricJson: "{}"
  };
}

function notApplicableFundamentals(ticker, reason = "Fundamental equity metrics are not applicable for this instrument") {
  return {
    ...emptyFundamentals(ticker, reason),
    provider: "none",
    status: "NOT_APPLICABLE",
    error: reason
  };
}

function saveFundamentals(database, item) {
  // fundamental_metrics.ticker references equities(ticker). Alert-only or
  // watchlist-only tickers may not have an equities row yet, which made the
  // fundamentals scheduler throw "FOREIGN KEY constraint failed" every cycle.
  // Guarantee the row exists first.
  const ensuredAt = nowIso();
  database.prepare(`
    INSERT OR IGNORE INTO equities (ticker, currency, status, created_at, updated_at)
    VALUES (?, 'USD', 'ACTIVE', ?, ?)
  `).run(item.ticker, ensuredAt, ensuredAt);
  database.prepare(`
    INSERT INTO fundamental_metrics (
      ticker, pe_ratio, forward_pe, ev_ebitda, price_sales, fcf_yield,
      peg, revenue_growth, eps_growth, beta, market_cap, gross_margin,
      operating_margin, debt_equity, provider, status, as_of, error, metric_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      pe_ratio = excluded.pe_ratio,
      forward_pe = excluded.forward_pe,
      ev_ebitda = excluded.ev_ebitda,
      price_sales = excluded.price_sales,
      fcf_yield = excluded.fcf_yield,
      peg = excluded.peg,
      revenue_growth = excluded.revenue_growth,
      eps_growth = excluded.eps_growth,
      beta = excluded.beta,
      market_cap = excluded.market_cap,
      gross_margin = excluded.gross_margin,
      operating_margin = excluded.operating_margin,
      debt_equity = excluded.debt_equity,
      provider = excluded.provider,
      status = excluded.status,
      as_of = excluded.as_of,
      error = excluded.error,
      metric_json = excluded.metric_json
  `).run(
    item.ticker,
    item.peRatio,
    item.forwardPe,
    item.evEbitda,
    item.priceSales,
    item.fcfYield,
    item.peg,
    item.revenueGrowth,
    item.epsGrowth,
    item.beta,
    item.marketCap,
    item.grossMargin,
    item.operatingMargin,
    item.debtEquity,
    item.provider,
    item.status,
    item.asOf,
    item.error || null,
    item.metricJson
  );
}

function rowToFundamentals(row) {
  if (!row) return null;
  return {
    ticker: row.ticker,
    peRatio: row.pe_ratio,
    forwardPe: row.forward_pe,
    evEbitda: row.ev_ebitda,
    priceSales: row.price_sales,
    fcfYield: row.fcf_yield,
    peg: row.peg,
    revenueGrowth: row.revenue_growth,
    epsGrowth: row.eps_growth,
    beta: row.beta,
    marketCap: row.market_cap,
    grossMargin: row.gross_margin,
    operatingMargin: row.operating_margin,
    debtEquity: row.debt_equity,
    provider: row.provider,
    status: row.status,
    asOf: row.as_of,
    error: row.error
  };
}

async function fetchFinnhubFundamentals(ticker) {
  if (!config.finnhubApiKey) throw new Error("FINNHUB_API_KEY is not configured");
  const url = new URL("https://finnhub.io/api/v1/stock/metric");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("metric", "all");
  url.searchParams.set("token", config.finnhubApiKey);
  const payload = await limiter.enqueue(() => fetchJson(url));
  return normalizeFundamentals(ticker, payload);
}

async function yahooAuth() {
  if (yahooAuthCache && Date.now() - yahooAuthCache.createdAt < 60 * 60 * 1000) {
    return yahooAuthCache;
  }
  const headers = { "User-Agent": "Mozilla/5.0" };
  const cookieResponse = await fetch("https://fc.yahoo.com", {
    headers,
    redirect: "manual"
  });
  const cookies = typeof cookieResponse.headers.getSetCookie === "function"
    ? cookieResponse.headers.getSetCookie()
    : [cookieResponse.headers.get("set-cookie")].filter(Boolean);
  const cookie = cookies.map((value) => value.split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Yahoo Finance did not return an auth cookie");

  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...headers, Cookie: cookie }
  });
  const crumb = (await crumbResponse.text()).trim();
  if (!crumbResponse.ok || !crumb) {
    throw new Error(`Yahoo Finance crumb unavailable: ${crumbResponse.status} ${crumbResponse.statusText}`);
  }
  yahooAuthCache = {
    cookie,
    crumb,
    createdAt: Date.now()
  };
  return yahooAuthCache;
}

function normalizeYahooFundamentals(ticker, payload) {
  const result = payload?.quoteSummary?.result?.[0] || {};
  const sections = [
    result.defaultKeyStatistics || {},
    result.financialData || {},
    result.summaryDetail || {},
    result.price || {},
    result.assetProfile || {}
  ];
  const peRatio = yahooNumber(sections, ["trailingPE", "peRatio"]);
  let forwardPe = yahooNumber(sections, ["forwardPE", "forwardPe"]);
  if (forwardPe != null && forwardPe > 500 && peRatio != null && peRatio < 100) {
    forwardPe /= 100;
  }
  const evEbitda = yahooNumber(sections, ["enterpriseToEbitda"]);
  const priceSales = yahooNumber(sections, ["priceToSalesTrailing12Months"]);
  const peg = yahooNumber(sections, ["pegRatio"]);
  const marketCap = yahooNumber(sections, ["marketCap"]);
  const freeCashflow = yahooNumber(sections, ["freeCashflow", "freeCashFlow"]);
  const fcfYieldValue = freeCashflow != null && marketCap ? (freeCashflow / marketCap) * 100 : null;
  const metrics = [
    peRatio,
    forwardPe,
    evEbitda,
    priceSales,
    peg,
    marketCap,
    fcfYieldValue,
    yahooNumber(sections, ["revenueGrowth"]),
    yahooNumber(sections, ["grossMargins"]),
    yahooNumber(sections, ["operatingMargins"])
  ].filter((value) => value != null);
  const hasMetrics = metrics.length > 0;

  return {
    ticker,
    peRatio: peRatio == null ? null : roundMoney(peRatio),
    forwardPe: forwardPe == null ? null : roundMoney(forwardPe),
    evEbitda: evEbitda == null ? null : roundMoney(evEbitda),
    priceSales: priceSales == null ? null : roundMoney(priceSales),
    fcfYield: fcfYieldValue == null ? null : roundPercent(fcfYieldValue),
    peg: peg == null ? null : roundMoney(peg),
    revenueGrowth: yahooPercent(yahooNumber(sections, ["revenueGrowth"])),
    epsGrowth: yahooPercent(yahooNumber(sections, ["earningsQuarterlyGrowth", "earningsGrowth"])),
    beta: yahooNumber(sections, ["beta"]),
    marketCap: marketCap == null ? null : roundMoney(marketCap),
    grossMargin: yahooPercent(yahooNumber(sections, ["grossMargins"])),
    operatingMargin: yahooPercent(yahooNumber(sections, ["operatingMargins"])),
    debtEquity: yahooNumber(sections, ["debtToEquity"]),
    provider: "yahoo",
    status: hasMetrics ? "LIVE" : "DATA_GAP",
    asOf: nowIso(),
    error: hasMetrics ? null : "Yahoo Finance returned no fundamental metrics",
    metricJson: JSON.stringify(payload || {})
  };
}

async function fetchYahooFundamentals(ticker) {
  const auth = await yahooAuth();
  const url = new URL(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`);
  url.searchParams.set("modules", [
    "assetProfile",
    "defaultKeyStatistics",
    "financialData",
    "summaryDetail",
    "price"
  ].join(","));
  url.searchParams.set("crumb", auth.crumb);
  const payload = await fetchJson(url, {
    timeoutMs: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Cookie: auth.cookie
    }
  });
  return normalizeYahooFundamentals(ticker, payload);
}

export async function getYahooProfile(tickerInput) {
  const ticker = normalizeTicker(tickerInput);
  if (!ticker) throw new Error("Ticker is required");
  const auth = await yahooAuth();
  const url = new URL(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`);
  url.searchParams.set("modules", "assetProfile,price");
  url.searchParams.set("crumb", auth.crumb);
  return fetchJson(url, {
    timeoutMs: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Cookie: auth.cookie
    }
  });
}

const FUNDAMENTAL_METRIC_FIELDS = [
  "peRatio", "forwardPe", "evEbitda", "priceSales", "fcfYield", "peg",
  "revenueGrowth", "epsGrowth", "beta", "marketCap", "grossMargin",
  "operatingMargin", "debtEquity"
];

function fundamentalGaps(item) {
  return FUNDAMENTAL_METRIC_FIELDS.filter((field) => item[field] == null);
}

async function enrichWithYahoo(ticker, base) {
  const gaps = fundamentalGaps(base);
  if (!gaps.length) return base;
  try {
    const yahoo = await fetchYahooFundamentals(ticker);
    const merged = { ...base };
    let filled = 0;
    for (const field of gaps) {
      if (yahoo[field] != null) {
        merged[field] = yahoo[field];
        filled += 1;
      }
    }
    if (filled > 0 && base.provider === "finnhub") {
      merged.provider = "finnhub + yahoo";
    }
    return merged;
  } catch (error) {
    return base;
  }
}

export async function getFundamentals(tickerInput, { force = false } = {}) {
  const ticker = normalizeTicker(tickerInput);
  const database = getDb();
  const cached = database.prepare("SELECT * FROM fundamental_metrics WHERE ticker = ?").get(ticker);
  if (!force && cacheFresh(cached)) return rowToFundamentals(cached);
  if (isCryptoTicker(ticker)) {
    const item = notApplicableFundamentals(ticker, "Crypto assets do not have equity fundamentals");
    saveFundamentals(database, item);
    return item;
  }

  let firstError = null;
  try {
    const item = await fetchFinnhubFundamentals(ticker);
    if (item.status === "LIVE") {
      const enriched = await enrichWithYahoo(ticker, item);
      saveFundamentals(database, enriched);
      return enriched;
    }
    firstError = item.error;
  } catch (error) {
    firstError = error.message;
  }

  try {
    const item = await fetchYahooFundamentals(ticker);
    if (item.status !== "LIVE" && firstError) {
      item.error = `${firstError}; ${item.error}`;
    }
    saveFundamentals(database, item);
    return item;
  } catch (error) {
    const message = [firstError, error.message].filter(Boolean).join("; ");
    if (cached) return { ...rowToFundamentals(cached), error: message, stale: true };
    const empty = emptyFundamentals(ticker, message);
    saveFundamentals(database, empty);
    return empty;
  }
}

export async function refreshTrackedFundamentals({ force = true } = {}) {
  if (trackedRefreshInFlight) return trackedRefreshInFlight;
  trackedRefreshInFlight = (async () => {
    const results = [];
    for (const ticker of trackedTickers()) {
      results.push(await getFundamentals(ticker, { force }));
    }
    return results;
  })();
  try {
    return await trackedRefreshInFlight;
  } finally {
    trackedRefreshInFlight = null;
  }
}

export function fundamentalsFromRows(database = getDb()) {
  return new Map(database.prepare("SELECT * FROM fundamental_metrics").all()
    .map((row) => [row.ticker, rowToFundamentals(row)]));
}
