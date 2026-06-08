/**
 * PriceService — Live price fetching with provider abstraction
 *
 * Supported providers: Finnhub (default), Alpha Vantage, IEX Cloud
 * Strategy: primary → fallback → stale cache → error
 *
 * Features:
 *  - In-memory + DB price cache (60s TTL for market hours, 15min off-hours)
 *  - Batch fetching to minimise API calls
 *  - Automatic provider failover
 *  - Rate limit tracking and backoff
 */

const fetch = require('node-fetch');
const { getDb } = require('../models/database');

const PROVIDERS = {
  finnhub: {
    name: 'Finnhub',
    baseUrl: 'https://finnhub.io/api/v1',
    apiKey: () => process.env.FINNHUB_API_KEY,
    rateLimit: { calls: 60, windowMs: 60_000 },
    fetchQuote: fetchFinnhubQuote,
    fetchBatch: fetchFinnhubBatch,
  },
  alphavantage: {
    name: 'Alpha Vantage',
    baseUrl: 'https://www.alphavantage.co/query',
    apiKey: () => process.env.ALPHA_VANTAGE_API_KEY,
    rateLimit: { calls: 5, windowMs: 60_000 },
    fetchQuote: fetchAlphaVantageQuote,
    fetchBatch: null, // Alpha Vantage is single-ticker
  },
  iexcloud: {
    name: 'IEX Cloud',
    baseUrl: 'https://cloud.iexapis.com/stable',
    apiKey: () => process.env.IEX_API_KEY,
    rateLimit: { calls: 100, windowMs: 60_000 },
    fetchQuote: fetchIEXQuote,
    fetchBatch: fetchIEXBatch,
  },
};

// In-memory price cache (ticker → {price, change, changePct, fetchedAt})
const memCache = new Map();
const CACHE_TTL_MS = {
  market_hours: 60_000,    // 1 minute during trading hours
  after_hours: 900_000,    // 15 minutes outside hours
  error_fallback: 300_000, // 5 minutes if API errors
};

// Rate limit tracking per provider
const rateLimitState = {};
Object.keys(PROVIDERS).forEach(p => {
  rateLimitState[p] = { calls: [], blocked_until: null };
});

function isMarketOpen() {
  const now = new Date();
  const etHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
  const etMin  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getMinutes();
  const day = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
  if (day === 0 || day === 6) return false;
  const minutesSinceMidnight = etHour * 60 + etMin;
  return minutesSinceMidnight >= 570 && minutesSinceMidnight < 960; // 9:30–16:00
}

function getCacheTTL() {
  return isMarketOpen() ? CACHE_TTL_MS.market_hours : CACHE_TTL_MS.after_hours;
}

function isStale(ticker) {
  const cached = memCache.get(ticker);
  if (!cached) return true;
  return Date.now() - cached.fetchedAt > getCacheTTL();
}

function checkRateLimit(provider) {
  const state = rateLimitState[provider];
  const limit = PROVIDERS[provider].rateLimit;

  if (state.blocked_until && Date.now() < state.blocked_until) {
    throw new Error(`${provider} rate limit active. Retry after ${new Date(state.blocked_until).toISOString()}`);
  }

  // Clean old calls outside window
  const windowStart = Date.now() - limit.windowMs;
  state.calls = state.calls.filter(t => t > windowStart);

  if (state.calls.length >= limit.calls) {
    state.blocked_until = Date.now() + limit.windowMs;
    throw new Error(`${provider} rate limit reached (${limit.calls} calls/${limit.windowMs}ms)`);
  }

  state.calls.push(Date.now());
}

// ─── PROVIDER IMPLEMENTATIONS ───────────────────────────────────────────────
async function fetchFinnhubQuote(ticker) {
  checkRateLimit('finnhub');
  const apiKey = PROVIDERS.finnhub.apiKey();
  if (!apiKey) throw new Error('FINNHUB_API_KEY not set');

  const res = await fetch(
    `${PROVIDERS.finnhub.baseUrl}/quote?symbol=${ticker}&token=${apiKey}`,
    { timeout: 5000 }
  );
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const data = await res.json();

  if (!data.c || data.c === 0) throw new Error(`No price data for ${ticker}`);
  return {
    ticker,
    price: data.c,           // current price
    change: data.d,          // change vs prev close
    changePct: data.dp,      // change %
    high: data.h,
    low: data.l,
    open: data.o,
    prevClose: data.pc,
    timestamp: data.t,
    source: 'finnhub',
  };
}

async function fetchFinnhubBatch(tickers) {
  // Finnhub doesn't support true batch; parallelise with rate limit guard
  checkRateLimit('finnhub');
  const results = await Promise.allSettled(
    tickers.map(t => fetchFinnhubQuote(t))
  );
  return results
    .map((r, i) => r.status === 'fulfilled' ? r.value : { ticker: tickers[i], error: r.reason?.message })
    .filter(r => !r.error);
}

async function fetchAlphaVantageQuote(ticker) {
  checkRateLimit('alphavantage');
  const apiKey = PROVIDERS.alphavantage.apiKey();
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY not set');

  const res = await fetch(
    `${PROVIDERS.alphavantage.baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${apiKey}`,
    { timeout: 8000 }
  );
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const data = await res.json();
  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error(`No price data for ${ticker}`);

  return {
    ticker,
    price: parseFloat(q['05. price']),
    change: parseFloat(q['09. change']),
    changePct: parseFloat(q['10. change percent'].replace('%', '')),
    high: parseFloat(q['03. high']),
    low: parseFloat(q['04. low']),
    open: parseFloat(q['02. open']),
    prevClose: parseFloat(q['08. previous close']),
    volume: parseInt(q['06. volume']),
    source: 'alphavantage',
  };
}

async function fetchIEXQuote(ticker) {
  checkRateLimit('iexcloud');
  const apiKey = PROVIDERS.iexcloud.apiKey();
  if (!apiKey) throw new Error('IEX_API_KEY not set');

  const res = await fetch(
    `${PROVIDERS.iexcloud.baseUrl}/stock/${ticker}/quote?token=${apiKey}`,
    { timeout: 5000 }
  );
  if (!res.ok) throw new Error(`IEX HTTP ${res.status}`);
  const q = await res.json();

  return {
    ticker,
    price: q.latestPrice,
    change: q.change,
    changePct: q.changePercent * 100,
    high: q.high,
    low: q.low,
    open: q.open,
    prevClose: q.previousClose,
    volume: q.volume,
    marketCap: q.marketCap,
    week52High: q.week52High,
    week52Low: q.week52Low,
    isMarketOpen: q.isUSMarketOpen,
    source: 'iexcloud',
  };
}

async function fetchIEXBatch(tickers) {
  checkRateLimit('iexcloud');
  const apiKey = PROVIDERS.iexcloud.apiKey();
  if (!apiKey) throw new Error('IEX_API_KEY not set');

  const symbols = tickers.join(',');
  const res = await fetch(
    `${PROVIDERS.iexcloud.baseUrl}/stock/market/batch?symbols=${symbols}&types=quote&token=${apiKey}`,
    { timeout: 8000 }
  );
  if (!res.ok) throw new Error(`IEX batch HTTP ${res.status}`);
  const data = await res.json();

  return tickers.map(ticker => {
    const q = data[ticker]?.quote;
    if (!q) return null;
    return {
      ticker,
      price: q.latestPrice,
      change: q.change,
      changePct: q.changePercent * 100,
      source: 'iexcloud',
    };
  }).filter(Boolean);
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────
async function getPrice(ticker) {
  // 1. Check memory cache first
  if (!isStale(ticker)) {
    return memCache.get(ticker);
  }

  // 2. Try DB cache as fast fallback
  const db = getDb();
  const dbCached = db.prepare('SELECT * FROM price_cache WHERE ticker = ?').get(ticker);
  const cacheAge = dbCached ? (Date.now() - new Date(dbCached.fetched_at).getTime()) : Infinity;

  // Determine primary provider
  const providerKey = process.env.PRICE_API_PROVIDER || 'finnhub';
  const provider = PROVIDERS[providerKey];
  const fallbackKey = providerKey === 'finnhub' ? 'alphavantage' : 'finnhub';
  const fallback = PROVIDERS[fallbackKey];

  let result = null;

  // 3. Try primary provider
  try {
    result = await provider.fetchQuote(ticker);
  } catch (primaryErr) {
    console.warn(`[PriceService] Primary (${providerKey}) failed for ${ticker}: ${primaryErr.message}`);

    // 4. Try fallback provider
    try {
      result = await fallback.fetchQuote(ticker);
    } catch (fallbackErr) {
      console.warn(`[PriceService] Fallback (${fallbackKey}) failed for ${ticker}: ${fallbackErr.message}`);

      // 5. Use stale DB cache rather than returning nothing
      if (dbCached) {
        console.warn(`[PriceService] Using stale cache for ${ticker} (age: ${Math.round(cacheAge/1000)}s)`);
        return { ...dbCached, stale: true };
      }

      throw new Error(`Price unavailable for ${ticker}: both providers failed`);
    }
  }

  // Store in memory cache
  result.fetchedAt = Date.now();
  memCache.set(ticker, result);

  // Persist to DB cache (upsert)
  db.prepare(`
    INSERT INTO price_cache (ticker, price, change, change_pct, volume, source, fetched_at)
    VALUES (@ticker, @price, @change, @changePct, @volume, @source, datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      price=excluded.price, change=excluded.change, change_pct=excluded.change_pct,
      volume=excluded.volume, source=excluded.source, fetched_at=excluded.fetched_at
  `).run(result);

  return result;
}

async function getPrices(tickers) {
  if (!tickers.length) return {};

  const stale = tickers.filter(t => isStale(t));
  const fresh  = tickers.filter(t => !isStale(t));

  const result = {};

  // Return fresh cached prices immediately
  fresh.forEach(t => {
    result[t] = memCache.get(t);
  });

  if (!stale.length) return result;

  // Batch fetch stale tickers
  const providerKey = process.env.PRICE_API_PROVIDER || 'finnhub';
  const provider = PROVIDERS[providerKey];

  try {
    const fetcher = provider.fetchBatch || (async (tickers) =>
      Promise.all(tickers.map(t => provider.fetchQuote(t).catch(() => null))).then(r => r.filter(Boolean))
    );
    const prices = await fetcher(stale);
    prices.forEach(p => {
      p.fetchedAt = Date.now();
      memCache.set(p.ticker, p);
      result[p.ticker] = p;
    });
  } catch (err) {
    console.error('[PriceService] Batch fetch error:', err.message);
    // Fall through — stale cache already checked per-ticker in getPrice
  }

  return result;
}

async function refreshPriceCache() {
  const db = getDb();
  const holdings = db.prepare('SELECT DISTINCT ticker FROM holdings WHERE is_active = 1').all();
  const watchlist = db.prepare('SELECT DISTINCT ticker FROM watchlist').all();
  const allTickers = [...new Set([...holdings, ...watchlist].map(r => r.ticker))];

  if (!allTickers.length) return;
  console.log(`[PriceService] Refreshing ${allTickers.length} tickers...`);

  try {
    await getPrices(allTickers);
  } catch (err) {
    console.error('[PriceService] Cache refresh error:', err.message);
  }
}

module.exports = { getPrice, getPrices, refreshPriceCache, isMarketOpen };
