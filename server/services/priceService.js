/**
 * PriceService — Yahoo Finance live prices + live FX, all converted to AUD.
 *
 * - Fetches live quote in the stock's NATIVE currency from Yahoo
 * - Fetches live FX rate (native -> AUD) from Yahoo
 * - Returns price ALREADY CONVERTED TO AUD so the whole app is AUD-consistent
 * - In-memory cache with short TTL to avoid hammering Yahoo
 */

const fetch = require('node-fetch');

const memCache = new Map();      // ticker -> {priceAUD, change, changePct, nativeCcy, nativePrice, fetchedAt}
const fxCache  = new Map();      // 'USDAUD' -> {rate, fetchedAt}
const PRICE_TTL_MS = 60_000;     // 1 min
const FX_TTL_MS    = 3_600_000;  // 1 hour

const YH_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// ─── LIVE FX (native currency -> AUD) ───────────────────────────────────────
async function getFxToAud(fromCcy) {
  const ccy = (fromCcy || 'AUD').toUpperCase();
  if (ccy === 'AUD') return 1;

  const key = `${ccy}AUD`;
  const cached = fxCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) return cached.rate;

  // Yahoo FX pair symbol, e.g. USDAUD=X, GBPAUD=X
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ccy}AUD=X?interval=1d&range=1d`;
    const r = await fetch(url, { timeout: 6000, headers: YH_HEADERS });
    if (r.ok) {
      const data = await r.json();
      const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (rate && rate > 0) {
        fxCache.set(key, { rate, fetchedAt: Date.now() });
        return rate;
      }
    }
  } catch (e) {}

  // Fallback static rates if Yahoo FX fails (updated to ~Jun 2026 levels)
  const FALLBACK = { USD:1.42, GBP:1.92, EUR:1.64, DKK:0.22, JPY:0.0098, HKD:0.18, SGD:1.11, NZD:0.86, CAD:1.04, ZAR:0.082 };
  const fb = FALLBACK[ccy] || 1;
  if (cached) return cached.rate; // prefer last known good
  return fb;
}

// ─── LIVE QUOTE (native currency) from Yahoo ────────────────────────────────
async function fetchYahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const r = await fetch(url, { timeout: 7000, headers: YH_HEADERS });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error(`No price for ${ticker}`);
  let price = meta.regularMarketPrice;
  let prevClose = meta.chartPreviousClose || meta.previousClose || price;
  let nativeCcy = meta.currency || 'USD';
  // Pre/post-market (US tickers). Yahoo provides these in meta when available.
  let preMarket = meta.preMarketPrice ?? null;
  let postMarket = meta.postMarketPrice ?? null;
  const marketState = meta.marketState || null; // PRE, REGULAR, POST, POSTPOST, CLOSED
  // London quotes come back in pence (GBp/GBX). Convert to pounds (GBP).
  if (nativeCcy === 'GBp' || nativeCcy === 'GBX' || nativeCcy === 'ZAc') {
    price = price / 100;
    prevClose = prevClose / 100;
    if (preMarket != null) preMarket = preMarket / 100;
    if (postMarket != null) postMarket = postMarket / 100;
    nativeCcy = nativeCcy === 'ZAc' ? 'ZAR' : 'GBP';
  }
  return {
    nativePrice: price,
    nativeCcy,
    change: price - prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose * 100) : 0,
    preMarket, postMarket, marketState,
  };
}

// ─── PUBLIC: get one price (in AUD) ─────────────────────────────────────────
async function getPrice(ticker) {
  const cached = memCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached;

  try {
    const q = await fetchYahooQuote(ticker);
    const fx = await getFxToAud(q.nativeCcy);
    const priceAUD = q.nativePrice * fx;
    const result = {
      ticker,
      price: priceAUD,                 // AUD price (what holdings route multiplies by qty)
      nativePrice: q.nativePrice,
      nativeCcy: q.nativeCcy,
      fxToAud: fx,
      change: q.change * fx,
      changePct: q.changePct,          // pct is currency-independent
      preMarket: q.preMarket,          // native ccy
      postMarket: q.postMarket,        // native ccy
      marketState: q.marketState,
      stale: false,
      fetchedAt: Date.now(),
    };
    memCache.set(ticker, result);
    return result;
  } catch (e) {
    if (cached) return { ...cached, stale: true };
    return { ticker, price: 0, nativePrice: 0, nativeCcy: 'AUD', fxToAud: 1, change: 0, changePct: 0, stale: true, fetchedAt: Date.now() };
  }
}

// ─── PUBLIC: batch get prices (in AUD) ──────────────────────────────────────
async function getPrices(tickers) {
  const out = {};
  // Yahoo chart endpoint is per-symbol; fetch in parallel with small concurrency
  const unique = [...new Set(tickers)];
  const CONCURRENCY = 6;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(t => getPrice(t).catch(() => null)));
    results.forEach((r, idx) => { if (r) out[batch[idx]] = r; });
  }
  return out;
}

async function refreshPriceCache(tickers) {
  memCache.clear();
  return getPrices(tickers || []);
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

// ─── HISTORICAL FX (native -> AUD) on a given date, for original-cost display ─
const histFxCache = new Map(); // 'USD|2025-08-19' -> rate
async function getHistoricalFxToAud(fromCcy, dateStr) {
  const ccy = (fromCcy || 'AUD').toUpperCase();
  if (ccy === 'AUD') return 1;
  if (!dateStr) return getFxToAud(ccy);
  const key = `${ccy}|${dateStr}`;
  if (histFxCache.has(key)) return histFxCache.get(key);
  try {
    const d = new Date(dateStr + 'T00:00:00Z');
    const period1 = Math.floor(d.getTime() / 1000) - 86400 * 3;
    const period2 = Math.floor(d.getTime() / 1000) + 86400 * 3;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ccy}AUD=X?period1=${period1}&period2=${period2}&interval=1d`;
    const r = await fetch(url, { timeout: 6000, headers: YH_HEADERS });
    if (r.ok) {
      const data = await r.json();
      const res = data?.chart?.result?.[0];
      const closes = res?.indicators?.quote?.[0]?.close || [];
      const valid = closes.filter(x => x != null);
      const rate = valid.length ? valid[valid.length - 1] : null;
      if (rate && rate > 0) { histFxCache.set(key, rate); return rate; }
    }
  } catch (e) {}
  const live = await getFxToAud(ccy);   // fallback to today's rate
  histFxCache.set(key, live);
  return live;
}

module.exports = { getPrice, getPrices, refreshPriceCache, isMarketOpen, getFxToAud, getHistoricalFxToAud };
  const data = await r.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error(`No price for ${ticker}`);
 let price = meta.regularMarketPrice;
  let prevClose = meta.chartPreviousClose || meta.previousClose || price;
  let nativeCcy = meta.currency || 'USD';
  if (nativeCcy === 'GBp' || nativeCcy === 'GBX' || nativeCcy === 'ZAc') {
    price = price / 100;
    prevClose = prevClose / 100;
    nativeCcy = nativeCcy === 'ZAc' ? 'ZAR' : 'GBP';
  }
  return {
    nativePrice: price,
    nativeCcy,
    change: price - prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose * 100) : 0,
  };
}

async function getPrice(ticker) {
  const cached = memCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached;
  try {
    const q = await fetchYahooQuote(ticker);
    const fx = await getFxToAud(q.nativeCcy);
    const priceAUD = q.nativePrice * fx;
    const result = {
      ticker,
      price: priceAUD,
      nativePrice: q.nativePrice,
      nativeCcy: q.nativeCcy,
      fxToAud: fx,
      change: q.change * fx,
      changePct: q.changePct,
      stale: false,
      fetchedAt: Date.now(),
    };
    memCache.set(ticker, result);
    return result;
  } catch (e) {
    if (cached) return { ...cached, stale: true };
    return { ticker, price: 0, nativePrice: 0, nativeCcy: 'AUD', fxToAud: 1, change: 0, changePct: 0, stale: true, fetchedAt: Date.now() };
  }
}

async function getPrices(tickers) {
  const out = {};
  const unique = [...new Set(tickers)];
  const CONCURRENCY = 6;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(t => getPrice(t).catch(() => null)));
    results.forEach((r, idx) => { if (r) out[batch[idx]] = r; });
  }
  return out;
}

async function refreshPriceCache(tickers) {
  memCache.clear();
  return getPrices(tickers || []);
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

module.exports = { getPrice, getPrices, refreshPriceCache, isMarketOpen, getFxToAud };
