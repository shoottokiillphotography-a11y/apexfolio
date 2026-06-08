/**
 * Prices Router — /api/prices
 * (sits behind priceLimiter: 30 req/min)
 *
 * GET  /quote/:ticker          — single live quote
 * POST /quotes                 — batch quotes { tickers: ['AAPL','MSFT'] }
 * GET  /history/:ticker        — OHLCV history for charting
 * GET  /cache                  — dump current price cache (admin/debug)
 * GET  /market/status          — is US market currently open?
 */

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const PriceService = require('../services/priceService');
const { getDb } = require('../models/database');
const fetch = require('node-fetch');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ─── SINGLE QUOTE ──────────────────────────────────────────────────────────────
router.get('/quote/:ticker',
  param('ticker').isString().trim().toUpperCase().isLength({ min: 1, max: 10 }),
  validate,
  async (req, res, next) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const data = await PriceService.getPrice(ticker);
      res.json({ ticker, ...data, fetchedAt: new Date().toISOString() });
    } catch (err) {
      if (err.message.includes('unavailable')) return res.status(503).json({ error: err.message });
      next(err);
    }
  }
);

// ─── BATCH QUOTES ─────────────────────────────────────────────────────────────
router.post('/quotes', [
  body('tickers').isArray({ min: 1, max: 100 }),
  body('tickers.*').isString().trim().toUpperCase(),
], validate, async (req, res, next) => {
  try {
    const tickers = [...new Set(req.body.tickers.map(t => t.toUpperCase()))];
    const prices = await PriceService.getPrices(tickers);
    res.json({ prices, count: Object.keys(prices).length, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ─── HISTORICAL DATA ──────────────────────────────────────────────────────────
// Returns OHLCV candles from Finnhub for charting
router.get('/history/:ticker',
  [
    param('ticker').isString().trim().toUpperCase(),
    query('resolution').optional().isIn(['1', '5', '15', '30', '60', 'D', 'W', 'M']),
    query('from').optional().isInt(),
    query('to').optional().isInt(),
    query('period').optional().isIn(['1W', '1M', '3M', '6M', '1Y', '5Y']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const ticker = req.params.ticker.toUpperCase();
      const resolution = req.query.resolution || 'D';
      const apiKey = process.env.FINNHUB_API_KEY;

      if (!apiKey) return res.status(503).json({ error: 'Price history requires FINNHUB_API_KEY' });

      // Calculate from/to from period if provided
      let { from, to } = req.query;
      if (!from || !to) {
        to = Math.floor(Date.now() / 1000);
        const periodMap = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825 };
        const days = periodMap[req.query.period || '3M'];
        from = to - days * 86400;
      }

      const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=${resolution}&from=${from}&to=${to}&token=${apiKey}`;
      const resp = await fetch(url, { timeout: 8000 });
      if (!resp.ok) throw new Error(`Finnhub history HTTP ${resp.status}`);
      const data = await resp.json();

      if (data.s !== 'ok') {
        return res.status(404).json({ error: `No history data for ${ticker}`, finnhubStatus: data.s });
      }

      // Format as OHLCV array
      const candles = data.t.map((t, i) => ({
        time: t,
        date: new Date(t * 1000).toISOString().split('T')[0],
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v[i],
      }));

      res.json({ ticker, resolution, candles, count: candles.length });
    } catch (err) {
      next(err);
    }
  }
);

// ─── MARKET STATUS ─────────────────────────────────────────────────────────────
router.get('/market/status', (_req, res) => {
  const isOpen = PriceService.isMarketOpen();
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  res.json({
    isOpen,
    localTime: now,
    timezone: 'America/New_York',
    message: isOpen ? 'US markets are open' : 'US markets are closed',
  });
});

// ─── CACHE DUMP (dev/admin) ───────────────────────────────────────────────────
router.get('/cache', (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.headers['x-admin-key']) {
    return res.status(403).json({ error: 'Admin key required in production' });
  }
  try {
    const db = getDb();
    const cache = db.prepare('SELECT * FROM price_cache ORDER BY ticker').all();
    res.json({ cache, count: cache.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
