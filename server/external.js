/**
 * External Gains Router — /api/external
 * Realized gains/losses from OTHER brokers, added to overall realised P&L.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');

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

// signed amount: gain = +, loss = -
function signed(amount, direction) {
  const a = Math.abs(parseFloat(amount) || 0);
  return direction === 'loss' ? -a : a;
}

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const rows = db.prepare('SELECT * FROM external_gains WHERE portfolio_id = ? ORDER BY date_sold DESC, id DESC').all(pid);
    const total = rows.reduce((s, r) => s + signed(r.amount, r.direction), 0);
    res.json({ entries: rows, total });
  } catch (err) { next(err); }
});

router.post('/', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { broker, description, invType, dateBought, dateSold, amount, direction } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required' });
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO external_gains (portfolio_id, broker, description, inv_type, date_bought, date_sold, amount, direction)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(pid, broker || null, description, invType || null, dateBought || null, dateSold || null,
          Math.abs(parseFloat(amount) || 0), direction === 'loss' ? 'loss' : 'gain');
    res.json({ id: lastInsertRowid, created: true });
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    db.prepare('DELETE FROM external_gains WHERE id = ? AND portfolio_id = ?').run(req.params.id, pid);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
