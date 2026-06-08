/**
 * Watchlist Router — /api/watchlist  (Drop 1)
 * GET /           — list with live prices
 * POST /          — add ticker
 * PUT /:ticker    — update notes/target
 * DELETE /:ticker — remove
 */
const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const PriceService = require('../services/priceService');

router.use(requireAuth);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

function portfolioId(db, userId) {
  let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(userId);
  if (!p) {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO portfolios (user_id, name, base_currency) VALUES (?, 'My Portfolio', 'AUD')`
    ).run(userId);
    p = { id: lastInsertRowid };
  }
  return p.id;
}

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const items = db.prepare('SELECT * FROM watchlist WHERE portfolio_id = ? ORDER BY added_at DESC').all(pid);
    if (!items.length) return res.json({ watchlist: [] });
    let prices = {};
    try { prices = await PriceService.getPrices(items.map(i => i.ticker)); } catch {}
    const enriched = items.map(i => ({
      ...i,
      currentPrice: prices[i.ticker]?.price || null,
      priceChange: prices[i.ticker]?.change || null,
      priceChangePct: prices[i.ticker]?.changePct || null,
    }));
    res.json({ watchlist: enriched });
  } catch (err) { next(err); }
});

router.post('/', [body('ticker').isString().trim()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { ticker, companyName, targetPrice, notes } = req.body;
    const tkr = ticker.toUpperCase();
    const exists = db.prepare('SELECT id FROM watchlist WHERE ticker=? AND portfolio_id=?').get(tkr, pid);
    if (exists) return res.status(409).json({ error: `${tkr} already in watchlist` });
    const r = db.prepare(`INSERT INTO watchlist (portfolio_id, ticker, company_name, target_price, notes) VALUES (?,?,?,?,?)`)
      .run(pid, tkr, companyName || null, targetPrice || null, notes || null);
    res.status(201).json({ id: r.lastInsertRowid, ticker: tkr });
  } catch (err) { next(err); }
});

router.put('/:ticker', [param('ticker').isString().trim()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const tkr = req.params.ticker.toUpperCase();
    const { targetPrice, notes, companyName } = req.body;
    const changes = db.prepare(`
      UPDATE watchlist SET target_price=COALESCE(@t,target_price), notes=COALESCE(@n,notes),
        company_name=COALESCE(@c,company_name) WHERE ticker=? AND portfolio_id=?
    `).run({ t: targetPrice ?? null, n: notes ?? null, c: companyName ?? null }, tkr, pid).changes;
    if (!changes) return res.status(404).json({ error: `${tkr} not in watchlist` });
    res.json({ updated: true });
  } catch (err) { next(err); }
});

router.delete('/:ticker', [param('ticker').isString().trim()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const tkr = req.params.ticker.toUpperCase();
    const changes = db.prepare('DELETE FROM watchlist WHERE ticker=? AND portfolio_id=?').run(tkr, pid).changes;
    if (!changes) return res.status(404).json({ error: `${tkr} not in watchlist` });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
