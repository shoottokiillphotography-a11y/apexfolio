/**
 * Cash Router — /api/cash
 * Manual cash balances in any currency; each converted to AUD for totals.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const PriceService = require('../services/priceService');

router.use(requireAuth);

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

// List cash holdings (with AUD conversion)
router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const rows = db.prepare('SELECT * FROM cash_holdings WHERE portfolio_id = ? ORDER BY id').all(pid);
    let totalAUD = 0;
    const enriched = await Promise.all(rows.map(async c => {
      const fx = await PriceService.getFxToAud(c.currency).catch(() => 1);
      const amountAUD = c.amount * fx;
      totalAUD += amountAUD;
      return { ...c, fxToAud: fx, amountAUD };
    }));
    res.json({ cash: enriched, totalAUD });
  } catch (err) { next(err); }
});

// Add a cash holding
router.post('/', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { label, currency, amount } = req.body;
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO cash_holdings (portfolio_id, label, currency, amount) VALUES (?,?,?,?)`
    ).run(pid, label || null, (currency || 'AUD').toUpperCase(), parseFloat(amount) || 0);
    res.json({ id: lastInsertRowid, created: true });
  } catch (err) { next(err); }
});

// Update a cash holding
router.put('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { label, currency, amount } = req.body;
    db.prepare(
      `UPDATE cash_holdings SET
         label = COALESCE(?, label),
         currency = COALESCE(?, currency),
         amount = COALESCE(?, amount)
       WHERE id = ? AND portfolio_id = ?`
    ).run(label ?? null, currency ? currency.toUpperCase() : null,
          amount != null ? parseFloat(amount) : null, req.params.id, pid);
    res.json({ updated: true });
  } catch (err) { next(err); }
});

// Delete a cash holding
router.delete('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    db.prepare('DELETE FROM cash_holdings WHERE id = ? AND portfolio_id = ?').run(req.params.id, pid);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
