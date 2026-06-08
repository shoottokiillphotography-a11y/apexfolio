/**
 * Groups Router — /api/groups
 * Fully user-editable custom segments.
 *
 * GET    /             — list groups (with live computed value/allocation)
 * POST   /             — create group
 * PUT    /:id          — rename / recolor / set target
 * DELETE /:id          — delete group (securities fall back to Uncategorized)
 * PUT    /reorder      — reorder groups
 * PUT    /assign       — assign a ticker to a group
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

// Seed default groups the first time
function seedDefaults(db, pid) {
  const count = db.prepare('SELECT COUNT(*) c FROM groups WHERE portfolio_id = ?').get(pid).c;
  if (count > 0) return;
  const defaults = [
    ['AI Bottlenecks', '#a855f7'], ['AI Platforms', '#3b82f6'], ['Compounders', '#22c55e'],
    ['Defensive', '#14b8a6'], ['Financials', '#f59e0b'], ['Healthcare', '#ef4444'],
    ['Infrastructure', '#8b93a8'], ['Speculative', '#ec4899'],
  ];
  const ins = db.prepare('INSERT INTO groups (portfolio_id, name, color, sort_order) VALUES (?,?,?,?)');
  const txn = db.transaction(() => defaults.forEach(([n, c], i) => ins.run(pid, n, c, i)));
  txn();
}

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    seedDefaults(db, pid);
    const groups = db.prepare('SELECT * FROM groups WHERE portfolio_id = ? ORDER BY sort_order, name').all(pid);
    res.json({ groups });
  } catch (err) { next(err); }
});

router.post('/', [
  body('name').isString().trim().isLength({ min: 1, max: 50 }),
  body('color').optional().isString().trim(),
  body('targetPct').optional().isFloat({ min: 0, max: 100 }),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { name, color = '#3b82f6', targetPct = 0 } = req.body;
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM groups WHERE portfolio_id = ?').get(pid).m;
    try {
      const r = db.prepare('INSERT INTO groups (portfolio_id, name, color, target_pct, sort_order) VALUES (?,?,?,?,?)')
        .run(pid, name, color, targetPct, maxOrder + 1);
      res.status(201).json({ id: r.lastInsertRowid, name });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: `Group "${name}" already exists` });
      throw e;
    }
  } catch (err) { next(err); }
});

router.put('/reorder', [body('order').isArray()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const upd = db.prepare('UPDATE groups SET sort_order = ? WHERE id = ? AND portfolio_id = ?');
    const txn = db.transaction(() => req.body.order.forEach((id, i) => upd.run(i, id, pid)));
    txn();
    res.json({ reordered: true });
  } catch (err) { next(err); }
});

router.put('/assign', [
  body('ticker').isString().trim(),
  body('groupId').optional({ nullable: true }).isInt(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const ticker = req.body.ticker.toUpperCase();
    const groupId = req.body.groupId || null;
    db.prepare(`
      INSERT INTO securities (portfolio_id, ticker, group_id) VALUES (?,?,?)
      ON CONFLICT(portfolio_id, ticker) DO UPDATE SET group_id = excluded.group_id
    `).run(pid, ticker, groupId);
    res.json({ assigned: true, ticker, groupId });
  } catch (err) { next(err); }
});

router.put('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const id = parseInt(req.params.id);
    const { name, color, targetPct } = req.body;
    const g = db.prepare('SELECT id FROM groups WHERE id = ? AND portfolio_id = ?').get(id, pid);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    db.prepare(`
      UPDATE groups SET name=COALESCE(@name,name), color=COALESCE(@color,color),
        target_pct=COALESCE(@targetPct,target_pct) WHERE id=@id
    `).run({ id, name: name ?? null, color: color ?? null, targetPct: targetPct ?? null });
    res.json({ updated: true });
  } catch (err) { next(err); }
});

router.delete('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const id = parseInt(req.params.id);
    const changes = db.prepare('DELETE FROM groups WHERE id = ? AND portfolio_id = ?').run(id, pid).changes;
    if (!changes) return res.status(404).json({ error: 'Group not found' });
    // securities.group_id auto-set to NULL via ON DELETE SET NULL
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
