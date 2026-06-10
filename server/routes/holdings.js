/**
 * Holdings Router — /api/holdings  (Drop 1: derived from the ledger)
 *
 * GET /                  — open holdings with live prices + P&L + group
 * GET /closed            — closed positions
 * GET /realised          — realised gains summary (by position / year)
 * GET /summary/groups    — group allocation vs target
 *
 * NOTE: manual "Add Lot" now posts a BUY transaction (see frontend), so the
 * old POST/PUT/DELETE holding endpoints are superseded by /api/transactions.
 * We keep PUT /:ticker for group assignment + notes for backward-compat.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const PriceService = require('../services/priceService');
const Ledger = require('../services/ledgerService');

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

// ─── OPEN HOLDINGS ────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const holdings = Ledger.getHoldings(pid);
    if (!holdings.length) return res.json({ holdings: [], totals: null });

    const tickers = holdings.map(h => h.ticker);
    let prices = {};
    try { prices = await PriceService.getPrices(tickers); } catch {}

    // Cost basis is ALREADY in AUD (Netwealth records AUD prices). Do NOT re-convert it.
    // Only the live current price needs conversion to AUD (handled by priceService).
    const enriched = holdings.map(h => {
      const pd = prices[h.ticker] || {};
      const priceAUD = pd.price || h.avg_cost || 0;   // live AUD price; fallback to AUD avg cost
      const totalCost = h.cost_total;                 // already AUD from import
      const currentValue = h.total_qty * priceAUD;    // AUD
      const unrealizedGL = currentValue - totalCost;
      const nativeCcy = pd.nativeCcy || h.currency || 'AUD';
      const fxToAud = pd.fxToAud || 1;
      // Market classification from ticker suffix
      const t = (h.ticker || '').toUpperCase();
      let market = 'US';
      if (t.endsWith('.AX')) market = 'Australia';
      else if (t.endsWith('.L')) market = 'UK';
      else if (t.endsWith('.CO') || t.endsWith('.DE') || t.endsWith('.PA') || t.endsWith('.AS') || t.endsWith('.MI')) market = 'Europe';
      // Native (non-AUD) figures for the currency toggle
      const nativeValue = fxToAud > 0 ? currentValue / fxToAud : currentValue;  // value in native ccy
      const nativeCostTotal = fxToAud > 0 ? totalCost / fxToAud : totalCost;    // approx cost in native at today's fx
      return {
        ...h,
        currency: 'AUD',
        nativeCurrency: nativeCcy,
        nativePrice: pd.nativePrice || null,
        nativeValue,
        nativeCostTotal,
        fxToAud,
        market,
        currentPrice: priceAUD,
        priceChange: pd.change || 0,
        priceChangePct: pd.changePct || 0,
        preMarket: pd.preMarket ?? null,        // native ccy
        postMarket: pd.postMarket ?? null,      // native ccy
        marketState: pd.marketState || null,
        totalCost,
        currentValue,
        unrealizedGL,
        unrealizedGLPct: totalCost > 0 ? (unrealizedGL / totalCost * 100) : 0,
        priceStale: pd.stale || false,
      };
    });

    const totalValue = enriched.reduce((s, h) => s + h.currentValue, 0);
    const totalCost  = enriched.reduce((s, h) => s + h.totalCost, 0);
    const totalGL    = totalValue - totalCost;
    enriched.forEach(h => h.allocationPct = totalValue > 0 ? (h.currentValue / totalValue * 100) : 0);

    const realised = Ledger.getRealisedSummary(pid).total;

    res.json({
      holdings: enriched,
      totals: {
        totalValue, totalCost, totalGL,
        totalGLPct: totalCost > 0 ? (totalGL / totalCost * 100) : 0,
        realisedTotal: realised,
        combinedReturn: totalGL + realised,
      },
      priceRefreshedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─── CLOSED POSITIONS ─────────────────────────────────────────────────────────
router.get('/closed', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    res.json({ closed: Ledger.getClosedPositions(pid) });
  } catch (err) { next(err); }
});

// ─── REALISED GAINS ───────────────────────────────────────────────────────────
router.get('/realised', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    res.json(Ledger.getRealisedSummary(pid));
  } catch (err) { next(err); }
});

// ─── GROUP ALLOCATION SUMMARY ─────────────────────────────────────────────────
router.get('/summary/groups', async (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const holdings = Ledger.getHoldings(pid);
    const tickers = holdings.map(h => h.ticker);
    let prices = {};
    try { prices = await PriceService.getPrices(tickers); } catch {}

    const groups = db.prepare('SELECT * FROM groups WHERE portfolio_id = ? ORDER BY sort_order').all(pid);
    const byGroup = {};
    groups.forEach(g => byGroup[g.id] = { id: g.id, name: g.name, color: g.color, target: g.target_pct, value: 0, cost: 0 });
    byGroup['none'] = { id: null, name: 'Uncategorized', color: '#4a5570', target: 0, value: 0, cost: 0 };

    let totalValue = 0;
    holdings.forEach(h => {
      const price = prices[h.ticker]?.price || h.avg_cost;
      const value = h.total_qty * price;
      const key = h.group_id || 'none';
      const bucket = byGroup[key] || byGroup['none'];
      bucket.value += value;
      bucket.cost += h.cost_total;
      totalValue += value;
    });

    const result = Object.values(byGroup).filter(g => g.value > 0 || g.id !== null).map(g => ({
      ...g,
      actualPct: totalValue > 0 ? (g.value / totalValue * 100) : 0,
      deltaPct: (totalValue > 0 ? (g.value / totalValue * 100) : 0) - g.target,
      gl: g.value - g.cost,
    }));

    res.json({ groups: result, totalValue });
  } catch (err) { next(err); }
});

// ─── ASSIGN GROUP / NOTES (backward-compat) ───────────────────────────────────
router.put('/:ticker', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const ticker = req.params.ticker.toUpperCase();
    const { groupId, notes } = req.body;
    db.prepare(`
      INSERT INTO securities (portfolio_id, ticker, group_id, notes) VALUES (?,?,?,?)
      ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
        group_id = COALESCE(excluded.group_id, group_id),
        notes = COALESCE(excluded.notes, notes)
    `).run(pid, ticker, groupId || null, notes || null);
    res.json({ updated: true });
  } catch (err) { next(err); }
});

module.exports = router;
