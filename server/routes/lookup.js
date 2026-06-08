const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY;

function currencyForExchange(exchange) {
  const map = {
    'ASX':'AUD','AX':'AUD','LSE':'GBP','L':'GBP','FRA':'EUR','F':'EUR',
    'XETRA':'EUR','TYO':'JPY','TSE':'JPY','HKG':'HKD','SGX':'SGD',
    'CPH':'DKK','CO':'DKK','STO':'SEK','NZX':'NZD','TSX':'CAD',
  };
  return map[exchange] || 'USD';
}

router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json({ results: [] });
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
      const r = await fetch(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) {
        const data = await r.json();
        const quotes = (data?.quotes || [])
          .filter(q => q.symbol && (q.longname || q.shortname))
          .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
          .slice(0, 10)
          .map(q => ({
            symbol: q.symbol,
            name: q.longname || q.shortname || q.symbol,
            exchange: q.exchange || '',
            currency: q.currency || currencyForExchange(q.exchange),
          }));
        if (quotes.length) return res.json({ results: quotes, source: 'yahoo' });
      }
    } catch (e) {}
    if (FINNHUB_KEY()) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_KEY()}`, { timeout: 5000 });
        if (r.ok) {
          const data = await r.json();
          const results = (data.result || []).filter(x => x.symbol && x.description).slice(0, 8)
            .map(x => ({ symbol: x.symbol, name: x.description, currency: 'USD' }));
          if (results.length) return res.json({ results, source: 'finnhub' });
        }
      } catch (e) {}
    }
    res.json({ results: [], source: 'none' });
  } catch (err) { next(err); }
});

router.get('/resolve', async (req, res, next) => {
  try {
    const ticker = (req.query.ticker || '').trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: 'ticker required' });
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
      const r = await fetch(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      if (r.ok) {
        const data = await r.json();
        const q = data?.quoteResponse?.result?.[0];
        if (q) return res.json({ ticker, name: q.longName || q.shortName || ticker, currency: q.currency || 'USD', exchange: q.fullExchangeName || '' });
      }
    } catch (e) {}
    res.json({ ticker, name: null, currency: 'USD' });
  } catch (err) { next(err); }
});

router.get('/historical', async (req, res, next) => {
  try {
    const ticker = (req.query.ticker || '').trim().toUpperCase();
    const date   = (req.query.date || '').trim();
    if (!ticker || !date) return res.status(400).json({ error: 'ticker and date required' });
    const yahoo = await tryYahoo(ticker, date);
    if (yahoo) return res.json(yahoo);
    const stooq = await tryStooq(ticker, date);
    if (stooq) return res.json({ ...stooq, currency: 'USD' });
    if (FINNHUB_KEY()) {
      const fh = await tryFinnhubCandle(ticker, date);
      if (fh) return res.json({ ...fh, currency: 'USD' });
    }
    res.status(404).json({ error: `No historical price found for ${ticker} on ${date}` });
  } catch (err) { next(err); }
});

async function tryYahoo(ticker, date) {
  try {
    const target = new Date(date + 'T00:00:00Z');
    const start  = new Date(target); start.setUTCDate(start.getUTCDate() - 7);
    const end    = new Date(target); end.setUTCDate(end.getUTCDate() + 1);
    const p1 = Math.floor(start.getTime() / 1000);
    const p2 = Math.floor(end.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${p1}&period2=${p2}`;
    const r = await fetch(url, { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const currency   = result.meta?.currency || 'USD';
    const timestamps = result.timestamp;
    const closes     = result.indicators?.quote?.[0]?.close;
    if (!timestamps || !closes || !timestamps.length) return null;
    let bestClose = null, bestDate = null;
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      if (d <= date && closes[i] != null) { bestClose = closes[i]; bestDate = d; }
    }
    if (bestClose && bestDate) return { ticker, date: bestDate, close: parseFloat(bestClose.toFixed(4)), currency, source: 'yahoo' };
  } catch (e) {}
  return null;
}

async function tryStooq(ticker, date) {
  try {
    const target = new Date(date + 'T00:00:00Z');
    const start  = new Date(target); start.setUTCDate(start.getUTCDate() - 7);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const variants = [`${ticker.toLowerCase()}.us`, ticker.toLowerCase()];
    for (const sym of variants) {
      const url = `https://stooq.com/q/d/l/?s=${sym}&d1=${fmt(start)}&d2=${fmt(target)}&i=d`;
      const r = await fetch(url, { timeout: 6000 });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || text.startsWith('<') || !text.includes('Close')) continue;
      const lines = text.trim().split('\n').slice(1).filter(Boolean);
      if (!lines.length) continue;
      const last = lines[lines.length - 1].split(',');
      const close = parseFloat(last[4]);
      if (!isNaN(close) && close > 0) return { ticker, date: last[0], close, source: 'stooq' };
    }
  } catch (e) {}
  return null;
}

async function tryFinnhubCandle(ticker, date) {
  try {
    const target = Math.floor(new Date(date + 'T23:59:59Z').getTime() / 1000);
    const from   = target - 10 * 86400;
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${target}&token=${FINNHUB_KEY()}`;
    const r = await fetch(url, { timeout: 6000 });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.s !== 'ok' || !d.c || !d.c.length) return null;
    const idx = d.c.length - 1;
    return { ticker, date: new Date(d.t[idx] * 1000).toISOString().slice(0, 10), close: d.c[idx], source: 'finnhub' };
  } catch (e) { return null; }
}

module.exports = router;
