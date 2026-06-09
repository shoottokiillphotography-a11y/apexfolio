const fetch = require('node-fetch');

const memCache = new Map();
const fxCache  = new Map();
const PRICE_TTL_MS = 60_000;
const FX_TTL_MS    = 3_600_000;

const YH_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

async function getFxToAud(fromCcy) {
  const ccy = (fromCcy || 'AUD').toUpperCase();
  if (ccy === 'AUD') return 1;
  const key = `${ccy}AUD`;
  const cached = fxCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) return cached.rate;
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
const FALLBACK = { USD:1.42, GBP:1.92, EUR:1.64, DKK:0.22, JPY:0.0098, HKD:0.18, SGD:1.11, NZD:0.86, CAD:1.04, ZAR:0.082 };  const fb = FALLBACK[ccy] || 1;
  if (cached) return cached.rate;
  return fb;
}

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
