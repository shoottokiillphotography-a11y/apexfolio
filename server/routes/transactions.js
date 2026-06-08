/**
 * Transactions Router — /api/transactions
 *
 * GET    /              — full ledger (search/filter/sort)
 * POST   /              — add a transaction (buy/sell/dividend/fee)
 * POST   /sell          — record a sell against specific lots (partial or full)
 * PUT    /:id           — edit a transaction
 * DELETE /:id           — delete a transaction (re-derives everything)
 * GET    /lots/:ticker  — open lots for a ticker (for the sell picker)
 */

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Ledger = require('../services/ledgerService');

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

// Ensure a security row exists (ticker metadata + group assignment)
function ensureSecurity(db, pid, ticker, companyName, currency) {
  db.prepare(`
    INSERT INTO securities (portfolio_id, ticker, company_name, currency)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
      company_name = COALESCE(excluded.company_name, company_name)
  `).run(pid, ticker.toUpperCase(), companyName || null, currency || 'USD');
}

// ─── LEDGER LIST ──────────────────────────────────────────────────────────────
router.get('/', [
  query('ticker').optional().isString().trim(),
  query('type').optional().isIn(['buy', 'sell', 'dividend', 'fee']),
  query('search').optional().isString().trim(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { ticker, type, search } = req.query;

    let sql = 'SELECT * FROM transactions WHERE portfolio_id = ?';
    const params = [pid];
    if (ticker) { sql += ' AND ticker = ?'; params.push(ticker.toUpperCase()); }
    if (type)   { sql += ' AND type = ?'; params.push(type); }
    if (search) { sql += ' AND (ticker LIKE ? OR company_name LIKE ? OR notes LIKE ?)';
      const s = `%${search}%`; params.push(s, s, s); }
    sql += ' ORDER BY trade_date DESC, id DESC';

    const txns = db.prepare(sql).all(...params);
    res.json({ transactions: txns, count: txns.length });
  } catch (err) { next(err); }
});

// ─── OPEN LOTS for a ticker (sell picker) ─────────────────────────────────────
router.get('/lots/:ticker', param('ticker').isString().trim(), validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const ticker = req.params.ticker.toUpperCase();
    const lots = db.prepare(`
      SELECT id, buy_txn_id, quantity, remaining_qty, cost_per_share, currency, trade_date, notes
      FROM lots WHERE portfolio_id = ? AND ticker = ? AND remaining_qty > 0
      ORDER BY trade_date ASC
    `).all(pid, ticker);
    res.json({ ticker, lots });
  } catch (err) { next(err); }
});

// ─── ADD TRANSACTION (buy / dividend / fee) ───────────────────────────────────
router.post('/', [
  body('ticker').isString().trim().isLength({ min: 1, max: 12 }),
  body('type').isIn(['buy', 'sell', 'dividend', 'fee']),
  body('quantity').optional().isFloat({ min: 0 }),
  body('price').optional().isFloat({ min: 0 }),
  body('fees').optional().isFloat({ min: 0 }),
  body('currency').optional().isString().trim(),
  body('fxRate').optional().isFloat({ gt: 0 }),
  body('tradeDate').isISO8601(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const {
      ticker, companyName, type, quantity = 0, price = 0, fees = 0,
      currency = 'AUD', fxRate = 1, tradeDate, settleDate, reference,
      notes, rationale, source = 'manual',
    } = req.body;

    const tkr = ticker.toUpperCase();
    ensureSecurity(db, pid, tkr, companyName, currency);

    // signed cash amount in txn currency
    let amount = 0;
    if (type === 'buy')  amount = -(quantity * price + fees);
    if (type === 'sell') amount =  (quantity * price - fees);
    if (type === 'dividend') amount = price || req.body.amount || 0;
    if (type === 'fee')  amount = -(fees || price || 0);

    const txn = {
      portfolio_id: pid, ticker: tkr, company_name: companyName || null, type,
      quantity, price, fees, currency, fx_rate: fxRate,
      amount, trade_date: tradeDate, settle_date: settleDate || null,
      matched_lot_id: req.body.matchedLotId || null,
      source, reference: reference || null, notes: notes || null, rationale: rationale || null,
    };
    txn.fingerprint = Ledger.fingerprint(txn);

    const result = db.prepare(`
      INSERT INTO transactions
        (portfolio_id, ticker, company_name, type, quantity, price, fees, currency, fx_rate,
         amount, trade_date, settle_date, matched_lot_id, source, reference, fingerprint, notes, rationale)
      VALUES
        (@portfolio_id, @ticker, @company_name, @type, @quantity, @price, @fees, @currency, @fx_rate,
         @amount, @trade_date, @settle_date, @matched_lot_id, @source, @reference, @fingerprint, @notes, @rationale)
    `).run(txn);

    Ledger.refresh(pid);
    res.status(201).json({ id: result.lastInsertRowid, message: `${type} recorded for ${tkr}` });
  } catch (err) { next(err); }
});

// ─── SELL against specific lots (partial or full) ─────────────────────────────
// Body: { ticker, sells:[{ lotId, quantity }], price, date, fees?, currency?, notes? }
router.post('/sell', [
  body('ticker').isString().trim(),
  body('sells').isArray({ min: 1 }),
  body('sells.*.lotId').isInt(),
  body('sells.*.quantity').isFloat({ gt: 0 }),
  body('price').isFloat({ gt: 0 }),
  body('date').isISO8601(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const { ticker, sells, price, date, fees = 0, currency = 'AUD', fxRate = 1, notes } = req.body;
    const tkr = ticker.toUpperCase();

    // Validate each chosen lot has enough remaining
    const getLot = db.prepare('SELECT * FROM lots WHERE id = ? AND portfolio_id = ? AND ticker = ?');
    for (const s of sells) {
      const lot = getLot.get(s.lotId, pid, tkr);
      if (!lot) return res.status(404).json({ error: `Lot ${s.lotId} not found for ${tkr}` });
      if (s.quantity > lot.remaining_qty + 1e-9) {
        return res.status(400).json({ error: `Lot ${s.lotId} only has ${lot.remaining_qty} shares (tried to sell ${s.quantity})` });
      }
    }

    // Create one sell transaction per chosen lot (so each is matched precisely)
    const insert = db.prepare(`
      INSERT INTO transactions
        (portfolio_id, ticker, company_name, type, quantity, price, fees, currency, fx_rate,
         amount, trade_date, matched_lot_id, source, fingerprint, notes)
      VALUES
        (@portfolio_id, @ticker, @company_name, 'sell', @quantity, @price, @fees, @currency, @fx_rate,
         @amount, @trade_date, @matched_lot_id, 'manual', @fingerprint, @notes)
    `);

    const sec = db.prepare('SELECT company_name FROM securities WHERE portfolio_id=? AND ticker=?').get(pid, tkr);

    const txn = db.transaction(() => {
      sells.forEach((s, i) => {
        const lot = getLot.get(s.lotId, pid, tkr);
        const feeShare = sells.length > 0 ? fees / sells.length : 0;
        const row = {
          portfolio_id: pid, ticker: tkr, company_name: sec?.company_name || tkr,
          quantity: s.quantity, price, fees: feeShare, currency, fx_rate: fxRate,
          amount: s.quantity * price - feeShare, trade_date: date,
          matched_lot_id: lot.buy_txn_id, notes: notes || null,
        };
        row.fingerprint = Ledger.fingerprint({ ...row, type: 'sell' }) + `|${i}`;
        insert.run(row);
      });
    });
    txn();

    Ledger.refresh(pid);
    const summary = Ledger.getRealisedSummary(pid);
    res.json({ success: true, message: `Sold ${tkr} across ${sells.length} lot(s)`, realisedTotal: summary.total });
  } catch (err) { next(err); }
});

// ─── EDIT TRANSACTION ─────────────────────────────────────────────────────────
router.put('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const id = parseInt(req.params.id);
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ? AND portfolio_id = ?').get(id, pid);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const f = req.body;
    db.prepare(`
      UPDATE transactions SET
        quantity = COALESCE(@quantity, quantity),
        price    = COALESCE(@price, price),
        fees     = COALESCE(@fees, fees),
        trade_date = COALESCE(@tradeDate, trade_date),
        notes    = COALESCE(@notes, notes),
        rationale= COALESCE(@rationale, rationale)
      WHERE id = @id
    `).run({
      id,
      quantity: f.quantity ?? null, price: f.price ?? null, fees: f.fees ?? null,
      tradeDate: f.tradeDate ?? null, notes: f.notes ?? null, rationale: f.rationale ?? null,
    });

    Ledger.refresh(pid);
    res.json({ updated: true });
  } catch (err) { next(err); }
});

// ─── DELETE TRANSACTION ───────────────────────────────────────────────────────
router.delete('/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const id = parseInt(req.params.id);
    const changes = db.prepare('DELETE FROM transactions WHERE id = ? AND portfolio_id = ?').run(id, pid).changes;
    if (!changes) return res.status(404).json({ error: 'Transaction not found' });
    Ledger.refresh(pid);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
