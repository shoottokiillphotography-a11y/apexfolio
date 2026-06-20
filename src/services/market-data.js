import { getDb } from "../db.js";
import { config } from "../config.js";
import {
  fetchJson,
  normalizeCurrency,
  normalizeTicker,
  nowIso,
  RateLimiter,
  roundPercent,
  SUPPORTED_FX_CURRENCIES
} from "../utils.js";

const finnhubLimiter = new RateLimiter(config.finnhubMinIntervalMs);
const alphaLimiter = new RateLimiter(config.alphaVantageMinIntervalMs);
const stooqLimiter = new RateLimiter(500);
const trackedRefreshInFlight = new Map();

// Yahoo throttles bursts hard (HTTP 429) and, when an IP keeps poking after that,
// escalates to a connection-level block where the socket never opens (surfaces as
// "fetch failed"). Every Yahoo call is serialized through one limiter; on failure we
// open a circuit breaker so we STOP hammering (which is what keeps the IP penalised)
// and fall back to Finnhub/cache until it cools off.
//
// There are TWO independent breakers: the v7 quote endpoint (US batched quotes) and
// the v8 chart endpoint (international tickers). Keeping them separate means a v7
// rate-limit storm can't freeze the international chart path, and vice-versa.
const YAHOO_MIN_INTERVAL_MS = 1000;
const yahooLimiter = new RateLimiter(YAHOO_MIN_INTERVAL_MS);
const YAHOO_BREAKER_THRESHOLD = 3;
// Escalating cooldowns: if Yahoo keeps rejecting us, back off for progressively
// longer instead of poking every minute - which only keeps the penalty alive.
const YAHOO_BREAKER_COOLDOWNS_MS = [60_000, 180_000, 600_000, 1_800_000]; // 1m, 3m, 10m, 30m

function makeYahooBreaker() {
  return { until: 0, streak: 0, trips: 0 };
}
const yahooV7Breaker = makeYahooBreaker();    // v7 /finance/quote  (US batched)
const yahooChartBreaker = makeYahooBreaker(); // v8 /finance/chart  (international)

function breakerState(breaker) {
  return {
    open: Date.now() < breaker.until,
    cooldownMsRemaining: Math.max(0, breaker.until - Date.now()),
    streak: breaker.streak,
    consecutiveTrips: breaker.trips
  };
}

export function yahooBreakerState() {
  return breakerState(yahooV7Breaker);
}

export function yahooChartBreakerState() {
  return breakerState(yahooChartBreaker);
}

// International tickers (.AX/.L/.CO ...) are Yahoo-only (Finnhub's free tier doesn't
// cover those exchanges) and ride the same IP Yahoo rate-limits. They also trade on
// exchanges with NO extended-hours session - one close per day - so refreshing them
// constantly buys no freshness while keeping the IP on Yahoo's radar. So we fetch
// them at most a few times a day: the frequent background refresh skips them, and
// only the ~6h timer elapsing or an explicit "Refresh International" press hits Yahoo.
const INTL_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // ~4 international fetches/day
const INTL_MANUAL_FLOOR_MS = 2 * 60 * 1000;      // min spacing for the manual button
let lastIntlRefreshAt = 0;
function intlRefreshDue(scope) {
  const elapsed = Date.now() - lastIntlRefreshAt;
  if (scope === "intl") return elapsed > INTL_MANUAL_FLOOR_MS; // manual button: near-immediate
  return elapsed > INTL_MIN_INTERVAL_MS;
}

async function yahooFetch(url, { retries = 4, timeoutMs = 12000, headers = {}, ignoreBreaker = false, breaker = yahooV7Breaker } = {}) {
  if (!ignoreBreaker && Date.now() < breaker.until) {
    throw new Error("Yahoo paused (rate-limit cooldown active)");
  }
  // Cooldown just expired: give Yahoo a clean slate. Without this the streak stays at
  // its tripped value, so the very next failure re-opens the breaker immediately and
  // it never recovers.
  if (breaker.until && Date.now() >= breaker.until) {
    breaker.until = 0;
    breaker.streak = 0;
  }
  let attempt = 0;
  for (;;) {
    try {
      const result = await yahooLimiter.enqueue(() => fetchJson(url, {
        timeoutMs,
        headers: { "User-Agent": YAHOO_UA, ...headers }
      }));
      // Success - Yahoo is happy again. Clear the streak AND the escalation level.
      breaker.streak = 0;
      breaker.trips = 0;
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      const rateLimited = message.includes("429") || /too many requests/i.test(message);
      // A hard IP block does NOT return 429 - the socket never opens, surfacing as
      // "fetch failed" / a connect timeout. The old breaker only counted 429s, so it
      // never backed off during a hard block and kept poking the blocked IP (exactly
      // the failure that froze international tickers). Count connection-level failures
      // too, so the breaker trips and lets the block cool down and recover.
      const connectionFailed = /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|und_err|terminated|aborted|socket hang up/i.test(message);
      if (rateLimited || connectionFailed) {
        breaker.streak += 1;
        if (breaker.streak >= YAHOO_BREAKER_THRESHOLD) {
          const idx = Math.min(breaker.trips, YAHOO_BREAKER_COOLDOWNS_MS.length - 1);
          breaker.until = Date.now() + YAHOO_BREAKER_COOLDOWNS_MS[idx];
          breaker.trips += 1;
        }
        // Do NOT retry a rate-limited OR connection-blocked request: retrying just
        // sends Yahoo more traffic and deepens the IP penalty. Fail now and let the
        // breaker (with its escalating cooldown) hold us off until Yahoo resets.
        throw error;
      }
      // Unexpected/transient error (e.g. a malformed response): retry with backoff.
      if (attempt >= retries) throw error;
      attempt += 1;
      const backoff = 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 350);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}


const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
let yahooSession = null; // { cookie, crumb, fetchedAt }

async function getYahooSession(force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.fetchedAt < 30 * 60 * 1000) {
    return yahooSession;
  }
  let cookie = "";
  for (const primeUrl of ["https://fc.yahoo.com/", "https://finance.yahoo.com/"]) {
    if (cookie) break;
    try {
      const res = await fetch(primeUrl, {
        headers: { "User-Agent": YAHOO_UA, "Accept": "text/html,*/*" },
        redirect: "manual"
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      await res.text().catch(() => {});
    } catch {
      // ignore and try the next priming URL
    }
  }
  let crumb = "";
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    if (crumb) break;
    try {
      const res = await fetch(`https://${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": YAHOO_UA, "Accept": "text/plain,*/*", ...(cookie ? { Cookie: cookie } : {}) }
      });
      const text = (await res.text()).trim();
      if (text && text.length <= 24 && !/[<{}]/.test(text)) crumb = text;
    } catch {
      // ignore and try the next host
    }
  }
  yahooSession = { cookie, crumb, fetchedAt: Date.now() };
  return yahooSession;
}

function cacheFresh(priceRow) {
  return priceRow?.as_of && Date.now() - new Date(priceRow.as_of).getTime() < config.quoteCacheSeconds * 1000;
}

function savePrice(database, quote) {
  database.prepare(`
    INSERT INTO market_prices (
      ticker, price, currency, previous_close, change_amount, change_percent,
      pre_market_price, pre_market_time, post_market_price, post_market_time,
      regular_market_price, day_low, day_high, fifty_two_week_low,
      fifty_two_week_high, market_cap, volume, average_volume,
      fifty_day_average, two_hundred_day_average, market_state, exchange_name,
      provider, status, as_of, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      price = excluded.price,
      currency = excluded.currency,
      previous_close = excluded.previous_close,
      change_amount = excluded.change_amount,
      change_percent = excluded.change_percent,
      pre_market_price = COALESCE(excluded.pre_market_price, market_prices.pre_market_price),
      pre_market_time = COALESCE(excluded.pre_market_time, market_prices.pre_market_time),
      post_market_price = COALESCE(excluded.post_market_price, market_prices.post_market_price),
      post_market_time = COALESCE(excluded.post_market_time, market_prices.post_market_time),
      regular_market_price = excluded.regular_market_price,
      day_low = excluded.day_low,
      day_high = excluded.day_high,
      fifty_two_week_low = COALESCE(excluded.fifty_two_week_low, market_prices.fifty_two_week_low),
      fifty_two_week_high = COALESCE(excluded.fifty_two_week_high, market_prices.fifty_two_week_high),
      market_cap = COALESCE(excluded.market_cap, market_prices.market_cap),
      volume = excluded.volume,
      average_volume = COALESCE(excluded.average_volume, market_prices.average_volume),
      fifty_day_average = COALESCE(excluded.fifty_day_average, market_prices.fifty_day_average),
      two_hundred_day_average = COALESCE(excluded.two_hundred_day_average, market_prices.two_hundred_day_average),
      market_state = excluded.market_state,
      exchange_name = COALESCE(excluded.exchange_name, market_prices.exchange_name),
      provider = excluded.provider,
      status = excluded.status,
      as_of = excluded.as_of,
      error = excluded.error
  `).run(
    quote.ticker,
    quote.price,
    quote.currency,
    quote.previousClose,
    quote.changeAmount,
    quote.changePercent,
    quote.preMarketPrice ?? null,
    quote.preMarketTime ?? null,
    quote.postMarketPrice ?? null,
    quote.postMarketTime ?? null,
    quote.regularMarketPrice ?? quote.price ?? null,
    quote.dayLow ?? null,
    quote.dayHigh ?? null,
    quote.fiftyTwoWeekLow ?? null,
    quote.fiftyTwoWeekHigh ?? null,
    quote.marketCap ?? null,
    quote.volume ?? null,
    quote.averageVolume ?? null,
    quote.fiftyDayAverage ?? null,
    quote.twoHundredDayAverage ?? null,
    quote.marketState ?? null,
    quote.exchangeName ?? null,
    quote.provider,
    quote.status,
    quote.asOf,
    quote.error || null
  );
}

function quoteFromRow(row, stale = false) {
  if (!row) return null;
  return {
    ticker: row.ticker,
    price: row.price,
    currency: row.currency,
    previousClose: row.previous_close,
    changeAmount: row.change_amount,
    changePercent: row.change_percent,
    preMarketPrice: row.pre_market_price,
    preMarketTime: row.pre_market_time,
    postMarketPrice: row.post_market_price,
    postMarketTime: row.post_market_time,
    regularMarketPrice: row.regular_market_price,
    dayLow: row.day_low,
    dayHigh: row.day_high,
    fiftyTwoWeekLow: row.fifty_two_week_low,
    fiftyTwoWeekHigh: row.fifty_two_week_high,
    marketCap: row.market_cap,
    volume: row.volume,
    averageVolume: row.average_volume,
    fiftyDayAverage: row.fifty_day_average,
    twoHundredDayAverage: row.two_hundred_day_average,
    marketState: row.market_state,
    exchangeName: row.exchange_name,
    provider: row.provider,
    status: row.status,
    asOf: row.as_of,
    error: row.error,
    stale
  };
}

function normalizeQuoteCurrency(input, fallback = "USD") {
  const raw = String(input || fallback).trim();
  const upper = raw.toUpperCase();
  if (raw === "GBp" || upper === "GBX") return "GBP";
  return SUPPORTED_FX_CURRENCIES.includes(upper) ? upper : normalizeCurrency(upper, fallback);
}

function yahooPriceScale(input) {
  const raw = String(input || "").trim();
  const upper = raw.toUpperCase();
  return raw === "GBp" || upper === "GBX" ? 0.01 : 1;
}

function stooqPriceScale(ticker, price) {
  // Stooq commonly returns London prices in pence while the app stores GBP.
  return ticker.endsWith(".L") && price > 100 ? 0.01 : 1;
}

function scaledPositiveNumber(value, scale = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric * scale : null;
}

function scaledNumber(value, scale = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * scale : null;
}

function yahooTime(value, fallback = null) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : fallback;
}

function yahooFirstTicker(ticker) {
  return /\.[A-Z0-9-]+$/i.test(ticker) || /-(USD|AUD|GBP|EUR|USDT|USDC)$/i.test(ticker);
}

async function finnhubQuote(ticker, fallbackCurrency = "USD", needsProfile = false) {
  if (!config.finnhubApiKey) throw new Error("FINNHUB_API_KEY is not configured");
  const quoteUrl = new URL("https://finnhub.io/api/v1/quote");
  quoteUrl.searchParams.set("symbol", ticker);
  quoteUrl.searchParams.set("token", config.finnhubApiKey);
  const payload = await finnhubLimiter.enqueue(() => fetchJson(quoteUrl));

  let profile = {};
  if (needsProfile) {
    const profileUrl = new URL("https://finnhub.io/api/v1/stock/profile2");
    profileUrl.searchParams.set("symbol", ticker);
    profileUrl.searchParams.set("token", config.finnhubApiKey);
    profile = await finnhubLimiter.enqueue(() => fetchJson(profileUrl));
  }

  const price = Number(payload?.c);
  const previousClose = Number(payload?.pc);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ticker,
      price: null,
      currency: normalizeQuoteCurrency(profile?.currency, fallbackCurrency),
      previousClose: Number.isFinite(previousClose) ? previousClose : null,
      changeAmount: null,
      changePercent: null,
      provider: "finnhub",
      status: "DATA_GAP",
      asOf: nowIso(),
      error: "Finnhub returned no live price"
    };
  }

  const finnhubNum = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  };
  return {
    ticker,
    price,
    currency: normalizeQuoteCurrency(profile?.currency, fallbackCurrency),
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    changeAmount: Number.isFinite(previousClose) ? price - previousClose : null,
    changePercent: Number.isFinite(previousClose) && previousClose !== 0
      ? roundPercent(((price - previousClose) / previousClose) * 100)
      : null,
    dayLow: finnhubNum(payload?.l),
    dayHigh: finnhubNum(payload?.h),
    provider: "finnhub",
    status: "LIVE",
    asOf: nowIso(),
    error: null,
    name: profile?.name || null
  };
}

async function alphaVantageQuote(ticker, fallbackCurrency = "USD") {
  if (!config.alphaVantageApiKey) throw new Error("ALPHA_VANTAGE_API_KEY is not configured");
  return alphaLimiter.enqueue(async () => {
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "GLOBAL_QUOTE");
    url.searchParams.set("symbol", alphaVantageSymbol(ticker));
    url.searchParams.set("apikey", config.alphaVantageApiKey);
    const payload = await fetchJson(url);
    const quote = payload?.["Global Quote"] || {};
    const price = Number(quote["05. price"]);
    const previousClose = Number(quote["08. previous close"]);
    if (!Number.isFinite(price) || price <= 0) {
      return {
        ticker,
        price: null,
        currency: fallbackCurrency,
        previousClose: Number.isFinite(previousClose) ? previousClose : null,
        changeAmount: null,
        changePercent: null,
        provider: "alpha_vantage",
        status: "DATA_GAP",
        asOf: nowIso(),
        error: "Alpha Vantage returned no live price"
      };
    }
    return {
      ticker,
      price,
      currency: fallbackCurrency,
      previousClose: Number.isFinite(previousClose) ? previousClose : null,
      changeAmount: Number.isFinite(previousClose) ? price - previousClose : null,
      changePercent: Number.isFinite(previousClose) && previousClose !== 0
        ? roundPercent(((price - previousClose) / previousClose) * 100)
        : null,
      provider: "alpha_vantage",
      status: "LIVE",
      asOf: nowIso(),
      error: null
    };
  });
}

function alphaVantageSymbol(ticker) {
  const symbol = normalizeTicker(ticker);
  const match = symbol.match(/^(.+)\.([A-Z0-9-]+)$/);
  if (!match) return symbol;
  const [, root, suffix] = match;
  const map = {
    AX: "AUS",
    L: "LON",
    CO: "CPH",
    DE: "DEX",
    PA: "PAR",
    AS: "AMS",
    MI: "MIL",
    MC: "MAD",
    BR: "BRU",
    SW: "SWX",
    ST: "STO",
    OL: "OSL",
    HK: "HKG",
    TO: "TRT",
    V: "TRV",
    T: "TYO"
  };
  return map[suffix] ? `${root}.${map[suffix]}` : symbol;
}

function stooqSymbolCandidates(ticker) {
  const s = normalizeTicker(ticker);
  const [rawRoot, suffix] = s.split(".");
  if (!rawRoot || !suffix) return [];
  const root = rawRoot.toLowerCase();
  const noDash = root.replaceAll("-", "");
  const map = {
    AX: ["au"],
    L: ["uk"],
    CO: ["dk"],
    DE: ["de"],
    PA: ["fr"],
    AS: ["nl"],
    MI: ["it"],
    SW: ["ch"],
    ST: ["se"],
    OL: ["no"],
    HK: ["hk"],
    TO: ["ca"],
    V: ["ca"],
    T: ["jp"]
  };
  const markets = map[suffix.toUpperCase()] || [];
  const roots = [...new Set([root, noDash])];
  return markets.flatMap((market) => roots.map((candidate) => `${candidate}.${market}`));
}

function parseStooqCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split(",").map((item) => item.trim());
  const values = lines[1].split(",").map((item) => item.trim());
  const row = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
  if (!row.Symbol || row.Close === "N/D" || row.Date === "N/D") return null;
  return row;
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": YAHOO_UA,
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

async function stooqQuote(ticker, fallbackCurrency = "USD") {
  const candidates = stooqSymbolCandidates(ticker);
  if (!candidates.length) throw new Error("Stooq does not support this ticker format");
  let lastError = null;
  for (const symbol of candidates) {
    try {
      const url = new URL("https://stooq.com/q/l/");
      url.searchParams.set("s", symbol);
      url.searchParams.set("f", "sd2t2ohlcv");
      url.searchParams.set("h", "");
      url.searchParams.set("e", "csv");
      const text = await stooqLimiter.enqueue(() => fetchText(url, { timeoutMs: 10000 }));
      const row = parseStooqCsv(text);
      const rawClose = Number(row?.Close);
      if (!row || !Number.isFinite(rawClose) || rawClose <= 0) {
        lastError = new Error(`Stooq returned no price for ${symbol}`);
        continue;
      }
      const scale = stooqPriceScale(ticker, rawClose);
      const price = rawClose * scale;
      const low = Number(row.Low);
      const high = Number(row.High);
      const volume = Number(row.Volume);
      const asOf = row.Date && row.Time && row.Time !== "N/D"
        ? new Date(`${row.Date}T${row.Time}Z`).toISOString()
        : nowIso();
      return {
        ticker,
        price,
        currency: fallbackCurrency,
        previousClose: null,
        changeAmount: null,
        changePercent: null,
        regularMarketPrice: price,
        dayLow: Number.isFinite(low) && low > 0 ? low * scale : null,
        dayHigh: Number.isFinite(high) && high > 0 ? high * scale : null,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
        marketState: "CLOSED",
        exchangeName: "Stooq",
        provider: "stooq",
        status: "LIVE",
        asOf,
        error: null
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Stooq returned no live price");
}

function asxNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function asxQuote(ticker, fallbackCurrency = "AUD") {
  const symbol = normalizeTicker(ticker);
  if (!symbol.endsWith(".AX")) throw new Error("ASX provider only supports .AX tickers");
  const code = symbol.replace(/\.AX$/, "");
  const url = new URL(`https://www.asx.com.au/asx/1/share/${encodeURIComponent(code)}`);
  const payload = await stooqLimiter.enqueue(() => fetchJson(url, {
    timeoutMs: 10000,
    headers: {
      "User-Agent": YAHOO_UA,
      "Accept": "application/json,text/plain,*/*",
      "Referer": `https://www.asx.com.au/markets/company/${code}`
    }
  }));
  const price = asxNumber(payload?.last_price ?? payload?.lastPrice ?? payload?.price);
  const previousClose = asxNumber(payload?.previous_close_price ?? payload?.previousClose);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`ASX returned no price for ${code}`);
  }
  const changeAmount = asxNumber(payload?.change_price ?? payload?.changePrice);
  const changePercent = asxNumber(payload?.change_in_percent ?? payload?.changePercent);
  return {
    ticker: symbol,
    price,
    currency: normalizeQuoteCurrency(payload?.currency, fallbackCurrency),
    previousClose,
    changeAmount: changeAmount ?? (previousClose ? price - previousClose : null),
    changePercent: changePercent ?? (previousClose ? roundPercent(((price - previousClose) / previousClose) * 100) : null),
    regularMarketPrice: price,
    dayLow: asxNumber(payload?.day_low_price ?? payload?.dayLow),
    dayHigh: asxNumber(payload?.day_high_price ?? payload?.dayHigh),
    fiftyTwoWeekLow: asxNumber(payload?.year_low_price ?? payload?.yearLow),
    fiftyTwoWeekHigh: asxNumber(payload?.year_high_price ?? payload?.yearHigh),
    marketCap: asxNumber(payload?.market_cap ?? payload?.marketCap),
    volume: asxNumber(payload?.volume),
    marketState: "CLOSED",
    exchangeName: "ASX",
    provider: "asx",
    status: "LIVE",
    asOf: nowIso(),
    error: null,
    name: payload?.desc_full || payload?.name || null
  };
}

function yahooQuoteFromFields(ticker, fields, fallbackCurrency = "USD", provider = "yahoo") {
  const scale = yahooPriceScale(fields.currency);
  const price = scaledPositiveNumber(fields.regularMarketPrice ?? fields.chartPreviousClose, scale);
  const regularMarketPrice = scaledPositiveNumber(fields.regularMarketPrice ?? fields.chartPreviousClose, scale) ?? price;
  const previousClose = scaledPositiveNumber(fields.regularMarketPreviousClose ?? fields.chartPreviousClose ?? fields.previousClose, scale);
  const preMarketPrice = scaledPositiveNumber(fields.preMarketPrice, scale);
  const postMarketPrice = scaledPositiveNumber(fields.postMarketPrice, scale);
  const dayLow = scaledPositiveNumber(fields.regularMarketDayLow, scale);
  const dayHigh = scaledPositiveNumber(fields.regularMarketDayHigh, scale);
  const fiftyTwoWeekLow = scaledPositiveNumber(fields.fiftyTwoWeekLow, scale);
  const fiftyTwoWeekHigh = scaledPositiveNumber(fields.fiftyTwoWeekHigh, scale);
  const currency = normalizeQuoteCurrency(fields.currency, fallbackCurrency);
  const fetchedAt = nowIso();

  if (!Number.isFinite(price) || price <= 0) {
    return {
      ticker,
      price: null,
      currency,
      previousClose,
      changeAmount: null,
      changePercent: null,
      provider,
      status: "DATA_GAP",
      asOf: fetchedAt,
      error: "Yahoo Finance returned no regular-market close"
    };
  }

  return {
    ticker,
    price,
    currency,
    previousClose,
    changeAmount: Number.isFinite(previousClose) ? price - previousClose : null,
    changePercent: Number.isFinite(previousClose) && previousClose !== 0
      ? roundPercent(((price - previousClose) / previousClose) * 100)
      : null,
    preMarketPrice,
    preMarketTime: preMarketPrice != null ? yahooTime(fields.preMarketTime, fetchedAt) : null,
    postMarketPrice,
    postMarketTime: postMarketPrice != null ? yahooTime(fields.postMarketTime, fetchedAt) : null,
    regularMarketPrice,
    dayLow,
    dayHigh,
    fiftyTwoWeekLow,
    fiftyTwoWeekHigh,
    marketCap: scaledNumber(fields.marketCap),
    volume: scaledNumber(fields.regularMarketVolume),
    averageVolume: scaledNumber(fields.averageDailyVolume3Month ?? fields.averageVolume),
    fiftyDayAverage: scaledPositiveNumber(fields.fiftyDayAverage, scale),
    twoHundredDayAverage: scaledPositiveNumber(fields.twoHundredDayAverage, scale),
    marketState: fields.marketState || null,
    exchangeName: fields.fullExchangeName || fields.exchange || null,
    provider,
    status: "LIVE",
    asOf: yahooTime(fields.regularMarketTime, fetchedAt),
    error: null,
    name: fields.shortName || fields.longName || fields.displayName || null
  };
}

// Fetch many tickers in a SINGLE Yahoo v7 request. The endpoint's `symbols` param
// accepts a comma-separated list, so this replaces one-request-per-ticker polling
// with ~1 batched request. NOTE: this is now only called with US/crypto symbols -
// international names go through the lighter, isolated v8 chart path instead.
// Returns a Map of normalised symbol -> quote (LIVE quotes only). Chunks that fail
// (e.g. breaker open) are skipped so those tickers fall back to the per-ticker chain.
async function yahooBatchQuotes(tickers, chunkSize = 50) {
  const out = new Map();
  const unique = [...new Set((tickers || []).map((t) => normalizeTicker(t)).filter(Boolean))];
  if (!unique.length) return out;
  const buildUrl = (symbols, crumb) => {
    const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
    url.searchParams.set("symbols", symbols.join(","));
    // No `fields` filter - the crumb'd v7 endpoint returns a partial record when
    // filtered, so request the full quote object.
    if (crumb) url.searchParams.set("crumb", crumb);
    return url;
  };
  const requestWith = async (symbols, session) => {
    const headers = { "Accept": "application/json" };
    if (session.cookie) headers.Cookie = session.cookie;
    return yahooFetch(buildUrl(symbols, session.crumb), { timeoutMs: 15000, headers, breaker: yahooV7Breaker });
  };
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    let payload = null;
    try {
      try {
        payload = await requestWith(chunk, await getYahooSession());
      } catch {
        // Crumb/cookie may be stale - refresh once and retry this chunk.
        payload = await requestWith(chunk, await getYahooSession(true));
      }
    } catch {
      payload = null; // chunk failed (breaker open / throttled) - tickers fall back
    }
    const results = payload?.quoteResponse?.result || [];
    for (const item of results) {
      const symbol = normalizeTicker(item?.symbol || "");
      if (!symbol) continue;
      const quote = yahooQuoteFromFields(symbol, item, exchangeCurrencyGuess(symbol) || "USD", "yahoo");
      if (quote && quote.status === "LIVE") out.set(symbol, quote);
    }
  }
  return out;
}

async function yahooQuoteEndpoint(ticker, fallbackCurrency = "USD") {
  const buildUrl = (crumb) => {
    const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
    url.searchParams.set("symbols", ticker);
    // No `fields` filter: the crumb'd v7 endpoint returns a partial record when
    // filtered, so request the full quote object (price, pre/post, day range,
    // 52-week, volume, avg volume, market cap, 50/200-day averages, state).
    if (crumb) url.searchParams.set("crumb", crumb);
    return url;
  };
  const requestWith = async (session) => {
    const headers = { "Accept": "application/json" };
    if (session.cookie) headers.Cookie = session.cookie;
    return yahooFetch(buildUrl(session.crumb), { timeoutMs: 12000, headers, breaker: yahooV7Breaker });
  };
  let payload;
  try {
    payload = await requestWith(await getYahooSession());
  } catch {
    // Crumb/cookie may be stale or missing - refresh once and retry.
    payload = await requestWith(await getYahooSession(true));
  }
  const quote = payload?.quoteResponse?.result?.[0];
  if (!quote) throw new Error("Yahoo quote endpoint returned no quote");
  return yahooQuoteFromFields(ticker, quote, fallbackCurrency, "yahoo");
}

async function yahooChartQuote(ticker, fallbackCurrency = "USD") {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  // 2 days is enough for the current/overnight pre/post price and keeps the
  // response small (US tickers carry pre+regular+post bars, so 5d was ~3x heavier
  // and more prone to timing out under throttling). Day range / 52-week / volume
  // come from meta and don't depend on the range.
  url.searchParams.set("range", "2d");
  url.searchParams.set("interval", "5m");
  url.searchParams.set("includePrePost", "true");
  const payload = await yahooFetch(url, { timeoutMs: 12000, breaker: yahooV7Breaker });
  const result = payload?.chart?.result?.[0];
  const meta = { ...(result?.meta || {}) };
  // The chart endpoint doesn't expose marketState or pre/post prices directly,
  // so derive them from the intraday series and the current trading periods.
  const periods = meta.currentTradingPeriod || {};
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const lastCloseInWindow = (start, end) => {
    if (start == null || end == null) return null;
    let found = null;
    for (let i = 0; i < timestamps.length; i += 1) {
      const t = timestamps[i];
      if (t >= start && t < end && closes[i] != null) found = { price: closes[i], time: t };
    }
    return found;
  };
  if (meta.preMarketPrice == null && periods.pre) {
    const pre = lastCloseInWindow(periods.pre.start, periods.pre.end);
    if (pre) { meta.preMarketPrice = pre.price; meta.preMarketTime = pre.time; }
  }
  if (meta.postMarketPrice == null) {
    // Find the end of the most recent regular session, then take the last bar
    // after it (the current/overnight after-hours price). Prefer today's regular
    // close; fall back to the trading-periods history for the overnight dead zone.
    // NOTE: meta.tradingPeriods can be an ARRAY of arrays OR an OBJECT
    // ({pre,regular,post}) when includePrePost is set - handle both so this never
    // throws and silently kills the whole chart fetch.
    let regularEnd = periods.regular?.end ?? null;
    if (regularEnd == null) {
      const raw = meta.tradingPeriods;
      const arr = Array.isArray(raw)
        ? raw
        : (raw && Array.isArray(raw.regular) ? raw.regular : []);
      const flat = arr
        .map((p) => (Array.isArray(p) ? p[p.length - 1] : p))
        .filter((p) => p && p.end != null);
      if (flat.length) regularEnd = flat[flat.length - 1].end;
    }
    if (regularEnd != null) {
      let post = null;
      for (let i = 0; i < timestamps.length; i += 1) {
        const t = timestamps[i];
        if (closes[i] == null) continue;
        if (t >= regularEnd) post = { price: closes[i], time: t };
      }
      if (post) { meta.postMarketPrice = post.price; meta.postMarketTime = post.time; }
    }
  }
  if (!meta.marketState) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (periods.regular && nowSec >= periods.regular.start && nowSec < periods.regular.end) meta.marketState = "REGULAR";
    else if (periods.pre && nowSec >= periods.pre.start && nowSec < periods.pre.end) meta.marketState = "PRE";
    else if (periods.post && nowSec >= periods.post.start && nowSec < periods.post.end) meta.marketState = "POST";
    else meta.marketState = "CLOSED";
  }
  return yahooQuoteFromFields(ticker, meta, fallbackCurrency, "yahoo");
}

// Lightweight international quote via the v8 chart endpoint. This endpoint needs NO
// crumb and NO cookie (unlike v7), and international names have no pre/post session,
// so daily bars are all we need - the smallest possible chart payload, least likely
// to time out under throttling. Runs on its OWN breaker (yahooChartBreaker) so it is
// fully isolated from the US v7 path - a v7 rate-limit storm can't freeze it.
async function yahooChartQuoteLight(ticker, fallbackCurrency = "USD") {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set("range", "5d");
  url.searchParams.set("interval", "1d");
  const payload = await yahooFetch(url, { timeoutMs: 12000, retries: 1, breaker: yahooChartBreaker });
  const result = payload?.chart?.result?.[0];
  const meta = { ...(result?.meta || {}) };
  // chart meta carries regularMarketPrice, chartPreviousClose, regularMarketTime,
  // day high/low, 52-week high/low, volume, currency, exchange. Fall back to the
  // last non-null daily close if regularMarketPrice is somehow missing.
  if (meta.regularMarketPrice == null) {
    const closes = result?.indicators?.quote?.[0]?.close || [];
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      if (closes[i] != null) { meta.regularMarketPrice = closes[i]; break; }
    }
  }
  if (meta.regularMarketPreviousClose == null && meta.chartPreviousClose != null) {
    meta.regularMarketPreviousClose = meta.chartPreviousClose;
  }
  meta.marketState = meta.marketState || "CLOSED";
  return yahooQuoteFromFields(ticker, meta, fallbackCurrency, "yahoo");
}

export async function debugQuoteSources(ticker) {
  const t = normalizeTicker(ticker);
  const keys = ["price", "changeAmount", "changePercent", "preMarketPrice", "postMarketPrice",
    "dayLow", "dayHigh", "volume", "averageVolume", "fiftyTwoWeekLow", "fiftyTwoWeekHigh",
    "marketCap", "fiftyDayAverage", "twoHundredDayAverage"];
  const summarize = (q) => q
    ? { status: q.status, provider: q.provider, marketState: q.marketState,
        fields: Object.fromEntries(keys.map((k) => [k, q[k] ?? null])) }
    : null;
  let v7 = null; let chart = null; let v7err = null; let charterr = null;
  try { v7 = await yahooQuoteEndpoint(t); } catch (e) { v7err = String(e?.message || e); }
  try { chart = await yahooChartQuote(t); } catch (e) { charterr = String(e?.message || e); }
  return {
    ticker: t,
    session: { hasCookie: Boolean(yahooSession?.cookie), hasCrumb: Boolean(yahooSession?.crumb) },
    v7: summarize(v7), v7err,
    chart: summarize(chart), charterr
  };
}

function mergeQuotes(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const merged = { ...secondary };
  for (const [key, value] of Object.entries(primary)) {
    if (value != null) merged[key] = value;
  }
  return merged;
}

// The v10 quoteSummary endpoint returns the FULL record (day range, 52-week,
// volume, moving averages, pre/post prices, market cap, market state) in one small
// request, using the same crumb auth that already works for v7. The v8 chart call
// is large and has been failing for US tickers, so try quoteSummary first.
async function yahooQuoteSummary(ticker, fallbackCurrency = "USD") {
  const session = await getYahooSession();
  const url = new URL(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`);
  url.searchParams.set("modules", "price,summaryDetail");
  if (session.crumb) url.searchParams.set("crumb", session.crumb);
  const headers = { "Accept": "application/json" };
  if (session.cookie) headers.Cookie = session.cookie;
  const payload = await yahooFetch(url, { timeoutMs: 10000, headers, breaker: yahooV7Breaker });
  const result = payload?.quoteSummary?.result?.[0];
  if (!result) return null;
  const price = result.price || {};
  const detail = result.summaryDetail || {};
  const raw = (v) => (v && typeof v === "object" ? (v.raw ?? null) : (v ?? null));
  const fields = {
    regularMarketPrice: raw(price.regularMarketPrice),
    regularMarketPreviousClose: raw(price.regularMarketPreviousClose),
    regularMarketDayHigh: raw(price.regularMarketDayHigh),
    regularMarketDayLow: raw(price.regularMarketDayLow),
    regularMarketVolume: raw(price.regularMarketVolume),
    regularMarketTime: raw(price.regularMarketTime),
    preMarketPrice: raw(price.preMarketPrice),
    preMarketTime: raw(price.preMarketTime),
    postMarketPrice: raw(price.postMarketPrice),
    postMarketTime: raw(price.postMarketTime),
    marketCap: raw(price.marketCap),
    marketState: price.marketState || null,
    currency: price.currency || fallbackCurrency,
    fullExchangeName: price.exchangeName || null,
    shortName: price.shortName || price.longName || null,
    fiftyTwoWeekHigh: raw(detail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: raw(detail.fiftyTwoWeekLow),
    fiftyDayAverage: raw(detail.fiftyDayAverage),
    twoHundredDayAverage: raw(detail.twoHundredDayAverage),
    averageVolume: raw(detail.averageVolume ?? detail.averageDailyVolume3Month)
  };
  return yahooQuoteFromFields(ticker, fields, fallbackCurrency, "yahoo");
}

async function yahooFinanceQuote(ticker, fallbackCurrency = "USD") {
  let endpointQuote = null;
  try {
    endpointQuote = await yahooQuoteEndpoint(ticker, fallbackCurrency);
  } catch {
    endpointQuote = null;
  }
  const endpointLive = endpointQuote && endpointQuote.status === "LIVE";
  // International tickers (.AX, .L, etc.) have no extended-hours session and no
  // Finnhub fallback. Spending 2-3 Yahoo calls each just to enrich them is what
  // tripped the rate-limit breaker - which then froze exactly those tickers.
  // So for international names, take the v7 price and stop; only reach for the
  // heavier endpoints if v7 itself failed.
  const isInternational = ticker.includes(".");
  const inExtendedHours = endpointQuote
    && ["PRE", "POST", "PREPRE", "POSTPOST"].includes(String(endpointQuote.marketState || "").toUpperCase());
  const needsMore = !endpointLive
    || (!isInternational && (
        endpointQuote.dayLow == null
        || endpointQuote.dayHigh == null
        || endpointQuote.volume == null
        || endpointQuote.fiftyTwoWeekLow == null
        || (inExtendedHours && endpointQuote.preMarketPrice == null && endpointQuote.postMarketPrice == null)
      ));

  // Prefer quoteSummary (small, full record). Fall back to the heavy chart only if
  // quoteSummary also fails.
  let richQuote = null;
  if (needsMore) {
    try {
      richQuote = await yahooQuoteSummary(ticker, fallbackCurrency);
    } catch {
      richQuote = null;
    }
    if (!richQuote || richQuote.status !== "LIVE") {
      try {
        richQuote = await yahooChartQuote(ticker, fallbackCurrency);
      } catch {
        richQuote = null;
      }
    }
  }
  const richLive = richQuote && richQuote.status === "LIVE";
  // Merge so the full record (day range / 52w / pre/post / MAs) is kept while the
  // v7 quote supplies a reliable live price + market state.
  if (endpointLive && richLive) return mergeQuotes(endpointQuote, richQuote);
  if (endpointLive) return endpointQuote;
  if (richLive) return richQuote;
  return endpointQuote || richQuote;
}

function exchangeCurrencyGuess(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.endsWith(".AX")) return "AUD";
  if (s.endsWith(".L")) return "GBP";
  if (s.endsWith(".DE") || s.endsWith(".PA") || s.endsWith(".AS") || s.endsWith(".MI")
    || s.endsWith(".MC") || s.endsWith(".BR") || s.endsWith(".LS") || s.endsWith(".VI")
    || s.endsWith(".HE") || s.endsWith(".IR")) return "EUR";
  if (s.endsWith(".CO")) return "DKK";
  if (s.endsWith(".ST")) return "SEK";
  if (s.endsWith(".OL")) return "NOK";
  if (s.endsWith(".SW")) return "CHF";
  if (s.endsWith(".HK")) return "HKD";
  if (s.endsWith(".TO") || s.endsWith(".V")) return "CAD";
  if (s.endsWith(".T")) return "JPY";
  if (s.endsWith(".NS") || s.endsWith(".BO")) return "INR";
  return "USD";
}

// Interactive search must NOT queue behind the bulk-refresh limiter (35+ holdings
// spaced 550ms apart = ~19s), or it times out before it runs. Give it a small
// dedicated lane and the Yahoo session cookie (Yahoo increasingly gates search).
const yahooSearchLimiter = new RateLimiter(250);

async function yahooSearchSymbols(q) {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", q);
  url.searchParams.set("quotesCount", "10");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "true");
  let payload;
  try {
    const session = await getYahooSession().catch(() => null);
    const headers = {
      "User-Agent": YAHOO_UA,
      "Accept": "application/json",
      ...(session?.cookie ? { Cookie: session.cookie } : {})
    };
    payload = await yahooSearchLimiter.enqueue(() => fetchJson(url, { timeoutMs: 8000, headers }));
  } catch {
    return [];
  }
  const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
  const allowed = new Set(["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "CURRENCY", "MUTUALFUND"]);
  return quotes
    .filter((item) => item.symbol && allowed.has(item.quoteType))
    .map((item) => ({
      symbol: item.symbol,
      name: item.longname || item.shortname || item.symbol,
      exchange: item.exchDisp || item.exchange || "",
      type: item.quoteType || "",
      currency: exchangeCurrencyGuess(item.symbol)
    }))
    .slice(0, 10);
}

async function finnhubSearchSymbols(q) {
  if (!config.finnhubApiKey) return [];
  const url = new URL("https://finnhub.io/api/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("token", config.finnhubApiKey);
  let payload;
  try {
    payload = await finnhubLimiter.enqueue(() => fetchJson(url, { timeoutMs: 9000 }));
  } catch {
    return [];
  }
  const result = Array.isArray(payload?.result) ? payload.result : [];
  return result
    .filter((item) => Boolean(item.symbol))
    .filter((item) => /stock|common|etf|adr/i.test(item.type || "Common Stock"))
    .map((item) => ({
      symbol: item.symbol,
      name: item.description || item.symbol,
      exchange: item.type || "",
      type: item.type || "",
      currency: exchangeCurrencyGuess(item.symbol)
    }))
    .slice(0, 10);
}

const COMMON_NAME_TICKERS = {
  "oracle": "ORCL", "apple": "AAPL", "microsoft": "MSFT", "amazon": "AMZN",
  "google": "GOOGL", "alphabet": "GOOGL", "meta": "META", "facebook": "META",
  "nvidia": "NVDA", "tesla": "TSLA", "netflix": "NFLX", "micron": "MU",
  "broadcom": "AVGO", "amd": "AMD", "intel": "INTC", "salesforce": "CRM",
  "adobe": "ADBE", "paypal": "PYPL", "disney": "DIS", "boeing": "BA",
  "visa": "V", "mastercard": "MA", "walmart": "WMT", "pepsi": "PEP",
  "nike": "NKE", "starbucks": "SBUX", "uber": "UBER", "airbnb": "ABNB",
  "palantir": "PLTR", "snowflake": "SNOW", "shopify": "SHOP", "spotify": "SPOT",
  "qualcomm": "QCOM", "cisco": "CSCO", "ibm": "IBM", "cme group": "CME",
  "coinbase": "COIN", "block": "SQ", "robinhood": "HOOD", "datadog": "DDOG",
  "crowdstrike": "CRWD", "servicenow": "NOW", "arista": "ANET", "supermicro": "SMCI",
  "vertiv": "VRT", "western digital": "WDC", "ge vernova": "GEV", "ionq": "IONQ",
  "alibaba": "BABA", "eli lilly": "LLY", "bitcoin": "BTC-USD",
  "novo nordisk": "NOVO-B.CO", "novo": "NOVO-B.CO", "arm": "ARM.L", "arm holdings": "ARM.L",
  "metcash": "MTO.AX", "wise": "WISE.L",
  "light and wonder": "LNW", "light & wonder": "LNW"
};

function curatedSymbolMatch(q) {
  const key = q.trim().toLowerCase();
  if (!key) return [];
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  const seen = new Set();
  const out = [];
  for (const [name, sym] of Object.entries(COMMON_NAME_TICKERS)) {
    if ((name.startsWith(key) || sym.toLowerCase().startsWith(key)) && !seen.has(sym)) {
      seen.add(sym);
      out.push({ symbol: sym, name: titleCase(name), exchange: "", type: "EQUITY", currency: exchangeCurrencyGuess(sym) });
    }
  }
  return out.slice(0, 10);
}

export async function searchSymbols(query) {
  const q = String(query || "").trim();
  if (q.length < 1) return [];
  const yahoo = await yahooSearchSymbols(q);
  if (yahoo.length) return yahoo;
  // Yahoo throttled or empty - fall back to Finnhub, then a small curated list of
  // common names so the basics always resolve.
  const finnhub = await finnhubSearchSymbols(q);
  if (finnhub.length) return finnhub;
  return curatedSymbolMatch(q);
}

// If the user typed a clean uppercase ticker, keep it. If they typed a company
// name or a casual lowercase/mixed string, resolve it to a real symbol so we never
// create a blank watchlist entry like "ORACLE".
export async function resolveTickerInput(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return raw;
  const looksLikeName = /\s/.test(raw) || /[a-z]/.test(raw);
  if (!looksLikeName) return raw.toUpperCase();
  try {
    const matches = await searchSymbols(raw);
    const upper = raw.toUpperCase();
    const exact = matches.find((m) => m.symbol.toUpperCase() === upper);
    if (exact) return exact.symbol;
    if (matches.length) return matches[0].symbol;
  } catch {
    // fall through to the raw value
  }
  return raw.toUpperCase();
}

// Verifies the international chart path: clears the breakers, runs the lightweight
// chart fetch for every tracked international ticker, and reports how many resolved.
// Used by /api/diag/batch to confirm the international fix is working.
export async function diagnoseBatch(scope = "all") {
  resetYahooBreaker();
  const tickers = trackedTickers(getDb(), scope);
  const usTickers = tickers.filter((t) => !t.includes("."));
  const intlTickers = tickers.filter((t) => t.includes("."));

  // US/crypto via the batched v7 call.
  let batch = new Map();
  let error = null;
  try {
    batch = await yahooBatchQuotes(usTickers);
  } catch (err) {
    error = String(err?.message || err);
  }
  // International via the lightweight chart path (what they actually use now).
  for (const ticker of intlTickers) {
    try {
      const q = await yahooChartQuoteLight(ticker, exchangeCurrencyGuess(ticker));
      if (q && q.status === "LIVE") batch.set(normalizeTicker(ticker), q);
    } catch (err) {
      if (!error) error = `${ticker}: ${String(err?.message || err)}`;
    }
  }

  const resolved = [];
  const missing = [];
  let withPre = 0;
  let withPost = 0;
  for (const ticker of tickers) {
    const q = batch.get(normalizeTicker(ticker));
    if (q && q.status === "LIVE") {
      if (q.preMarketPrice != null) withPre++;
      if (q.postMarketPrice != null) withPost++;
      resolved.push({
        ticker,
        price: q.price,
        marketState: q.marketState,
        preMarketPrice: q.preMarketPrice ?? null,
        postMarketPrice: q.postMarketPrice ?? null
      });
    } else {
      missing.push(ticker);
    }
  }
  return {
    scope,
    requested: tickers.length,
    resolved: resolved.length,
    missing,
    withPreMarketPrice: withPre,
    withPostMarketPrice: withPost,
    breaker: yahooBreakerState(),
    chartBreaker: yahooChartBreakerState(),
    error,
    quotes: resolved
  };
}

export async function diagnoseQuote(tickerInput, { reset = false } = {}) {
  const ticker = normalizeTicker(tickerInput);
  if (reset) resetYahooBreaker();
  const isInternational = ticker.includes(".");
  const session = isInternational && config.alphaVantageApiKey
    ? { crumb: "", cookie: "" }
    : await getYahooSession();
  const fieldList = [
    "price", "regularMarketPrice", "preMarketPrice", "postMarketPrice", "marketState",
    "dayLow", "dayHigh", "fiftyTwoWeekLow", "fiftyTwoWeekHigh", "volume",
    "averageVolume", "marketCap", "fiftyDayAverage", "twoHundredDayAverage"
  ];
  const summarize = (quote) => {
    if (!quote) return null;
    const out = { status: quote.status, provider: quote.provider, asOf: quote.asOf ?? null, error: quote.error ?? null };
    for (const field of fieldList) out[field] = quote[field] ?? null;
    return out;
  };
  const result = {
    ticker,
    crumbObtained: Boolean(session.crumb),
    cookieObtained: Boolean(session.cookie),
    breaker: yahooBreakerState(),
    chartBreaker: yahooChartBreakerState()
  };
  try {
    result.alphaVantage = summarize(await alphaVantageQuote(ticker, exchangeCurrencyGuess(ticker)));
  } catch (error) {
    result.alphaVantageError = String(error?.message || error);
  }
  try {
    result.finnhub = summarize(await finnhubQuote(ticker, exchangeCurrencyGuess(ticker)));
  } catch (error) {
    result.finnhubError = String(error?.message || error);
  }
  if (isInternational && result.alphaVantage?.status === "LIVE") {
    result.yahooSkipped = "Alpha Vantage returned a live international quote; Yahoo checks skipped to avoid Railway timeout.";
    return result;
  }
  try {
    result.v7 = summarize(await yahooQuoteEndpoint(ticker, "USD"));
  } catch (error) {
    result.v7Error = String(error?.message || error);
  }
  try {
    result.quoteSummary = summarize(await yahooQuoteSummary(ticker, "USD"));
  } catch (error) {
    result.quoteSummaryError = String(error?.message || error);
  }
  try {
    result.chart = summarize(await yahooChartQuote(ticker, "USD"));
  } catch (error) {
    result.chartError = String(error?.message || error);
  }
  // The lightweight chart path is what international tickers actually use - report it
  // separately so an international diagnosis reflects the real code path.
  try {
    result.chartLight = summarize(await yahooChartQuoteLight(ticker, exchangeCurrencyGuess(ticker)));
  } catch (error) {
    result.chartLightError = String(error?.message || error);
  }
  try {
    result.asx = summarize(await asxQuote(ticker, exchangeCurrencyGuess(ticker)));
  } catch (error) {
    result.asxError = String(error?.message || error);
  }
  try {
    result.stooq = summarize(await stooqQuote(ticker, exchangeCurrencyGuess(ticker)));
  } catch (error) {
    result.stooqError = String(error?.message || error);
  }
  return result;
}

// When Yahoo's chart endpoint is throttled, a v7-only quote comes back "LIVE" but
// missing day range / 52-week. Finnhub (which the app already reaches for market
// caps) can fill those gaps so the Market Data view isn't blank for US tickers.
const finnhubMetricCache = new Map();
const FINNHUB_METRIC_TTL_MS = 6 * 60 * 60 * 1000;

async function finnhubDayRange(ticker) {
  if (!config.finnhubApiKey) return null;
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("token", config.finnhubApiKey);
  try {
    const payload = await finnhubLimiter.enqueue(() => fetchJson(url));
    const low = Number(payload?.l);
    const high = Number(payload?.h);
    return {
      dayLow: Number.isFinite(low) && low > 0 ? low : null,
      dayHigh: Number.isFinite(high) && high > 0 ? high : null
    };
  } catch {
    return null;
  }
}

async function finnhubFiftyTwoWeek(ticker) {
  if (!config.finnhubApiKey) return null;
  const cached = finnhubMetricCache.get(ticker);
  if (cached && Date.now() - cached.at < FINNHUB_METRIC_TTL_MS) return cached;
  const url = new URL("https://finnhub.io/api/v1/stock/metric");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("metric", "all");
  url.searchParams.set("token", config.finnhubApiKey);
  try {
    const payload = await finnhubLimiter.enqueue(() => fetchJson(url));
    const metric = payload?.metric || {};
    const high = Number(metric["52WeekHigh"]);
    const low = Number(metric["52WeekLow"]);
    const entry = {
      at: Date.now(),
      fiftyTwoWeekLow: Number.isFinite(low) && low > 0 ? low : null,
      fiftyTwoWeekHigh: Number.isFinite(high) && high > 0 ? high : null
    };
    finnhubMetricCache.set(ticker, entry);
    return entry;
  } catch {
    return null;
  }
}

async function enrichQuoteFromFinnhub(quote) {
  if (!quote || quote.status !== "LIVE" || !config.finnhubApiKey) return quote;
  const needDayRange = quote.dayLow == null || quote.dayHigh == null;
  const needFiftyTwo = quote.fiftyTwoWeekLow == null || quote.fiftyTwoWeekHigh == null;
  if (!needDayRange && !needFiftyTwo) return quote;
  if (needDayRange) {
    const range = await finnhubDayRange(quote.ticker);
    if (range) {
      if (quote.dayLow == null) quote.dayLow = range.dayLow;
      if (quote.dayHigh == null) quote.dayHigh = range.dayHigh;
    }
  }
  if (needFiftyTwo) {
    const window = await finnhubFiftyTwoWeek(quote.ticker);
    if (window) {
      if (quote.fiftyTwoWeekLow == null) quote.fiftyTwoWeekLow = window.fiftyTwoWeekLow;
      if (quote.fiftyTwoWeekHigh == null) quote.fiftyTwoWeekHigh = window.fiftyTwoWeekHigh;
    }
  }
  return quote;
}

export async function getQuote(tickerInput, { force = false } = {}) {
  const ticker = normalizeTicker(tickerInput);
  const database = getDb();
  const cached = database.prepare("SELECT * FROM market_prices WHERE ticker = ?").get(ticker);
  if (!force && cacheFresh(cached)) return quoteFromRow(cached, false);

  const equity = database.prepare("SELECT * FROM equities WHERE ticker = ?").get(ticker);
  // Exchange-suffixed names (.AX/.L/.CO ...) are international. Crypto uses a dash
  // (BTC-USD) and has no dot, so it is NOT treated as international here.
  const isInternational = ticker.includes(".");
  const fallbackCurrency = isInternational
    ? exchangeCurrencyGuess(ticker)
    : normalizeCurrency(equity?.currency, "USD");
  const needsProfile = !equity?.name || !equity?.currency;

  // Railway's IP is frequently blocked by Yahoo for exchange-suffixed tickers.
  // When real API keys are configured, try those first for international names so
  // .AX/.L/.CO prices do not sit behind several Yahoo timeouts.
  const providers = isInternational
    ? [
        ...(config.alphaVantageApiKey ? [alphaVantageQuote] : []),
        ...(config.finnhubApiKey ? [finnhubQuote] : []),
        ...(ticker.endsWith(".AX") ? [asxQuote] : []),
        stooqQuote,
        yahooChartQuoteLight,
        yahooFinanceQuote
      ]
    : [yahooFinanceQuote, ...(config.finnhubApiKey ? [finnhubQuote] : []), ...(config.alphaVantageApiKey ? [alphaVantageQuote] : [])];
  let lastError = null;
  let bestUnavailableQuote = null;
  for (const provider of providers) {
    try {
      const quote = await provider(ticker, fallbackCurrency, needsProfile);
      if (quote.status !== "LIVE") {
        bestUnavailableQuote ||= quote;
        continue;
      }
      await enrichQuoteFromFinnhub(quote);
      savePrice(database, quote);
      if (quote.name || quote.currency) {
        database.prepare("UPDATE equities SET name = COALESCE(name, ?), currency = ?, updated_at = ? WHERE ticker = ?")
          .run(quote.name, quote.currency, nowIso(), ticker);
      }
      return quote;
    } catch (error) {
      lastError = error;
    }
  }

  const fallback = quoteFromRow(cached, true);
  if (fallback?.status === "LIVE") return { ...fallback, error: lastError?.message || fallback.error };
  if (bestUnavailableQuote) {
    const quote = {
      ...bestUnavailableQuote,
      error: lastError?.message || bestUnavailableQuote.error
    };
    savePrice(database, quote);
    return quote;
  }
  if (fallback) return { ...fallback, error: lastError?.message || fallback.error };

  const emptyQuote = {
    ticker,
    price: null,
    currency: fallbackCurrency,
    previousClose: null,
    changeAmount: null,
    changePercent: null,
    provider: "none",
    status: "UNAVAILABLE",
    asOf: nowIso(),
    error: lastError?.message || "No market data provider is configured"
  };
  savePrice(database, emptyQuote);
  return emptyQuote;
}

export function trackedTickers(database = getDb(), scope = "all") {
  const held = "SELECT ticker FROM holding_lots WHERE quantity > 0";
  const pulse = "SELECT symbol AS ticker FROM market_pulse_items WHERE active = 1";
  const alerts = "SELECT ticker FROM price_alerts WHERE active = 1";
  const watch = "SELECT ticker FROM watchlist_items";

  if (scope === "fast") {
    // Holdings + dashboard Market Pulse: refreshed most often.
    return database.prepare(`SELECT DISTINCT ticker FROM (${held} UNION ${pulse}) ORDER BY ticker`)
      .all().map((row) => row.ticker);
  }
  if (scope === "alerts") {
    // Active alert tickers not already covered by the fast set - need fresh-ish
    // prices so alerts fire, but not every minute.
    return database.prepare(`
      SELECT DISTINCT ticker FROM (${alerts})
      WHERE ticker NOT IN (${held} UNION ${pulse})
      ORDER BY ticker
    `).all().map((row) => row.ticker);
  }
  if (scope === "watchlist") {
    // Watch-only names: refreshed least often.
    return database.prepare(`
      SELECT DISTINCT ticker FROM watchlist_items
      WHERE ticker NOT IN (${held} UNION ${pulse} UNION ${alerts})
      ORDER BY ticker
    `).all().map((row) => row.ticker);
  }
  if (scope === "intl") {
    // International tickers only (.AX/.L/.CO etc.) - Yahoo-only, no fallback.
    // Used by the on-demand "Refresh International" button so we can fetch just
    // these few names with a freshly-cleared chart breaker.
    return database.prepare(`
      SELECT DISTINCT ticker FROM (${held} UNION ${pulse} UNION ${alerts} UNION ${watch})
      WHERE ticker LIKE '%.%'
      ORDER BY ticker
    `).all().map((row) => row.ticker);
  }
  return database.prepare(`
    SELECT DISTINCT ticker FROM (${held} UNION ${pulse} UNION ${alerts} UNION ${watch})
    ORDER BY ticker
  `).all().map((row) => row.ticker);
}

export function resetYahooBreaker() {
  for (const breaker of [yahooV7Breaker, yahooChartBreaker]) {
    breaker.until = 0;
    breaker.streak = 0;
    breaker.trips = 0;
  }
  lastIntlRefreshAt = 0; // let the next refresh re-fetch international tickers immediately
}

export async function refreshTrackedQuotes({ force = true, scope = "all", resetBreaker = false } = {}) {
  if (trackedRefreshInFlight.has(scope)) return trackedRefreshInFlight.get(scope);
  const run = (async () => {
    // IMPORTANT: a manual refresh no longer clears the v7 breaker. Clearing it on
    // every "Refresh Prices" press is what kept re-poking Yahoo and escalated the IP
    // penalty into a hard block, defeating the escalating cooldown. The ONLY manual
    // reset left is "Refresh International", and it clears ONLY the chart breaker the
    // international path uses (never v7) + lets the international fetch run now.
    // (`resetBreaker` is still accepted for call-site compatibility but is
    // intentionally not honored for the v7 breaker.)
    if (scope === "intl") {
      yahooChartBreaker.until = 0;
      yahooChartBreaker.streak = 0;
      yahooChartBreaker.trips = 0;
      lastIntlRefreshAt = 0;
    }

    const db = getDb();
    const tickers = trackedTickers(db, scope);
    const usTickers = tickers.filter((t) => !t.includes("."));
    const intlTickers = tickers.filter((t) => t.includes("."));
    const results = [];

    // --- US / crypto: ONE batched v7 call, per-ticker provider chain as fallback ---
    let batch = new Map();
    if (usTickers.length) {
      try {
        batch = await yahooBatchQuotes(usTickers);
      } catch {
        batch = new Map();
      }
    }
    for (const ticker of usTickers) {
      const batched = batch.get(normalizeTicker(ticker));
      if (batched && batched.status === "LIVE") {
        try {
          savePrice(db, batched);
          if (batched.name || batched.currency) {
            db.prepare("UPDATE equities SET name = COALESCE(name, ?), currency = ?, updated_at = ? WHERE ticker = ?")
              .run(batched.name, batched.currency, nowIso(), ticker);
          }
          results.push(batched);
          continue;
        } catch {
          // Save failed for this row - fall through to the per-ticker path below.
        }
      }
      // Not covered by the batch (Yahoo throttled, unknown symbol, or save error):
      // use the full provider chain (Yahoo per-ticker -> Finnhub -> Alpha Vantage).
      results.push(await getQuote(ticker, { force }));
    }

    // --- International: lightweight v8 chart only, on its own breaker, THROTTLED ---
    // These exchanges have one close per day and no fallback, so we fetch them at
    // most ~4x/day. The frequent background refresh skips them entirely (serving the
    // last stored close); only the ~6h timer or an explicit "Refresh International"
    // actually hits Yahoo. This keeps Railway's IP off Yahoo's rate-limit radar.
    if (intlTickers.length) {
      if (intlRefreshDue(scope)) {
        lastIntlRefreshAt = Date.now();
        for (const ticker of intlTickers) {
          // getQuote routes international tickers to the chart-only provider chain.
          results.push(await getQuote(ticker, { force: true }));
        }
      } else {
        // Not due yet - serve the last stored price so the dashboard stays populated.
        for (const ticker of intlTickers) {
          const row = db.prepare("SELECT * FROM market_prices WHERE ticker = ?").get(normalizeTicker(ticker));
          if (row) results.push(quoteFromRow(row, true));
        }
      }
    }

    return results;
  })();
  trackedRefreshInFlight.set(scope, run);
  try {
    return await run;
  } finally {
    trackedRefreshInFlight.delete(scope);
  }
}

export function marketProviderStatus() {
  return {
    finnhubConfigured: Boolean(config.finnhubApiKey),
    alphaVantageConfigured: Boolean(config.alphaVantageApiKey),
    quoteCacheSeconds: config.quoteCacheSeconds
  };
}
