/**
 * Alerts Router — /api/alerts  (Drop 1: alert kinds + executed alerts)
 *
 * GET    /            — list alerts
 * POST   /            — create alert (kind: buy_below, trim_above, etc.)
 * PUT    /:id         — edit / pause / reactivate
 * DELETE /:id         — delete
 * GET    /executed    — executed alerts log (never deleted on trigger)
 * PUT    /executed/:id — set status (reviewed/ignored/acted)
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const KINDS = ['buy_below','review_below','review_above','trim_above','take_profit','stop_loss','custom'];

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

// Map alert kind → default direction
function dirForKind(kind, explicit) {
  if (explicit) return explicit;
  return ['buy_below','review_below','stop_loss'].includes(kind) ? 'below' : 'above';
}

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const alerts = db.prepare('SELECT * FROM alerts WHERE portfolio_id = ? ORDER BY created_at DESC').all(pid);
    res.json({ alerts });
  } catch (err) { next(err); }
});

router.post('/', [
  body('ticker').isString().trim(),
  body('kind').optional().isIn(KINDS),
  body('threshold').isFloat({ gt: 0 }),
  body('email').optional().isEmail(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { ticker, kind = 'custom', threshold, email, notes } = req.body;
    const direction = dirForKind(kind, req.body.direction);
    const r = db.prepare(`
      INSERT INTO alerts (portfolio_id, ticker, kind, direction, threshold, email, notes)
      VALUES (?,?,?,?,?,?,?)
    `).run(pid, ticker.toUpperCase(), kind, direction, threshold, email || null, notes || null);
    res.status(201).json({ id: r.lastInsertRowid, message: `Alert created for ${ticker.toUpperCase()}` });
  } catch (err) { next(err); }
});

router.put('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const id = parseInt(req.params.id);
    const a = db.prepare('SELECT id FROM alerts WHERE id=? AND portfolio_id=?').get(id, pid);
    if (!a) return res.status(404).json({ error: 'Alert not found' });
    const { threshold, status, email, notes, kind } = req.body;
    db.prepare(`
      UPDATE alerts SET
        threshold=COALESCE(@threshold,threshold), status=COALESCE(@status,status),
        email=COALESCE(@email,email), notes=COALESCE(@notes,notes), kind=COALESCE(@kind,kind),
        updated_at=datetime('now')
      WHERE id=@id
    `).run({ id, threshold: threshold ?? null, status: status ?? null, email: email ?? null, notes: notes ?? null, kind: kind ?? null });
    res.json({ updated: true });
  } catch (err) { next(err); }
});

router.delete('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const changes = db.prepare('DELETE FROM alerts WHERE id=? AND portfolio_id=?').run(parseInt(req.params.id), pid).changes;
    if (!changes) return res.status(404).json({ error: 'Alert not found' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ─── EXECUTED ALERTS ──────────────────────────────────────────────────────────
router.get('/executed', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const rows = db.prepare(`
      SELECT e.* FROM executed_alerts e
      JOIN alerts a ON a.id = e.alert_id
      WHERE a.portfolio_id = ?
      ORDER BY e.triggered_at DESC
    `).all(pid);
    res.json({ executed: rows });
  } catch (err) { next(err); }
});

router.put('/executed/:id', [param('id').isInt(), body('status').isIn(['pending','reviewed','ignored','acted'])], validate, (req, res, next) => {
  try {
    const db = getDb();
    db.prepare('UPDATE executed_alerts SET status=? WHERE id=?').run(req.body.status, parseInt(req.params.id));
    res.json({ updated: true });
  } catch (err) { next(err); }
});

module.exports = router;
