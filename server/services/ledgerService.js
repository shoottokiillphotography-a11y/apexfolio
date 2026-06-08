/**
 * LedgerService — derives ALL portfolio state from the transaction ledger.
 *
 * The transactions table is the single source of truth. This service:
 *   - rebuilds the `lots` materialised view from buy/sell transactions
 *   - computes current holdings (open positions)
 *   - computes realised gains (persistent, by position/txn/year)
 *   - computes closed positions
 *
 * Specific-lot selling: a sell transaction may carry matched_lot_id to consume
 * a chosen lot. If absent, FIFO is used as a fallback.
 */

const { getDb } = require('../models/database');

// ─── FINGERPRINT (duplicate detection) ────────────────────────────────────────
function fingerprint(t) {
  // Stable hash of the economically-identifying fields
  const parts = [
    t.trade_date, (t.ticker || '').toUpperCase(), t.type,
    round(t.quantity, 4), round(t.price, 4), round(t.amount, 2),
    (t.currency || '').toUpperCase(), t.reference || '',
  ];
  return parts.join('|');
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round((Number(n) || 0) * f) / f;
}

// ─── REBUILD LOTS from the full transaction history ───────────────────────────
// Processes buys/sells chronologically; specific-lot match honoured when present.
function rebuildLots(portfolioId) {
  const db = getDb();

  const txns = db.prepare(`
    SELECT * FROM transactions
    WHERE portfolio_id = ? AND type IN ('buy','sell')
    ORDER BY trade_date ASC, id ASC
  `).all(portfolioId);

  // Wipe and rebuild lots for this portfolio
  db.prepare('DELETE FROM lots WHERE portfolio_id = ?').run(portfolioId);

  // Track open lots in memory keyed by buy txn id
  const openLots = {}; // buyTxnId -> { ...lot }
  const insertLot = db.prepare(`
    INSERT INTO lots (portfolio_id, buy_txn_id, ticker, quantity, remaining_qty, cost_per_share, currency, trade_date, notes)
    VALUES (@portfolio_id, @buy_txn_id, @ticker, @quantity, @remaining_qty, @cost_per_share, @currency, @trade_date, @notes)
  `);

  for (const t of txns) {
    if (t.type === 'buy') {
      // cost per share includes fees spread across the quantity
      const qty = Math.abs(t.quantity) || 0;
      if (qty <= 0) continue;
      const costPerShare = t.price + (t.fees ? t.fees / qty : 0);
      openLots[t.id] = {
        portfolio_id: portfolioId,
        buy_txn_id: t.id,
        ticker: t.ticker.toUpperCase(),
        quantity: qty,
        remaining_qty: qty,
        cost_per_share: costPerShare,
        currency: t.currency,
        trade_date: t.trade_date,
        notes: t.notes || null,
      };
    } else if (t.type === 'sell') {
      let qtyToSell = Math.abs(t.quantity) || 0;
      const ticker = t.ticker.toUpperCase();

      // Specific-lot selling: if matched_lot_id points to a buy txn, consume it first
      let order = Object.values(openLots).filter(l => l.ticker === ticker && l.remaining_qty > 0);
      if (t.matched_lot_id && openLots[t.matched_lot_id]) {
        const matched = openLots[t.matched_lot_id];
        order = [matched, ...order.filter(l => l.buy_txn_id !== t.matched_lot_id)];
      } else {
        // FIFO fallback — oldest first (already sorted by date asc)
        order.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.buy_txn_id - b.buy_txn_id);
      }

      for (const lot of order) {
        if (qtyToSell <= 0) break;
        const take = Math.min(lot.remaining_qty, qtyToSell);
        lot.remaining_qty -= take;
        qtyToSell -= take;
      }
      // Oversell (more than held) is ignored beyond available — data issue, surfaced elsewhere
    }
  }

  // Persist remaining open lots
  const persist = db.transaction(() => {
    for (const lot of Object.values(openLots)) {
      if (lot.remaining_qty > 1e-9) insertLot.run(lot);
    }
  });
  persist();
}

// ─── REALISED GAINS — computed from sell transactions ─────────────────────────
// Re-derives realised_gl + cost_basis for each sell against the lots it consumed.
function recomputeRealisedGains(portfolioId) {
  const db = getDb();

  const txns = db.prepare(`
    SELECT * FROM transactions
    WHERE portfolio_id = ? AND type IN ('buy','sell')
    ORDER BY trade_date ASC, id ASC
  `).all(portfolioId);

  // Simulate lot consumption to attribute cost basis per sell
  const openLots = {}; // buyTxnId -> { remaining, costPerShare, ticker, date }
  const updates = [];

  for (const t of txns) {
    if (t.type === 'buy') {
      const qty = Math.abs(t.quantity) || 0;
      if (qty <= 0) continue;
      openLots[t.id] = {
        ticker: t.ticker.toUpperCase(),
        remaining: qty,
        costPerShare: t.price + (t.fees ? t.fees / qty : 0),
        date: t.trade_date,
        buyTxnId: t.id,
      };
    } else if (t.type === 'sell') {
      let qtyToSell = Math.abs(t.quantity) || 0;
      const ticker = t.ticker.toUpperCase();
      const sellPerShare = t.price - (t.fees ? t.fees / (Math.abs(t.quantity) || 1) : 0);

      let order = Object.values(openLots).filter(l => l.ticker === ticker && l.remaining > 0);
      if (t.matched_lot_id && openLots[t.matched_lot_id]) {
        const m = openLots[t.matched_lot_id];
        order = [m, ...order.filter(l => l.buyTxnId !== t.matched_lot_id)];
      } else {
        order.sort((a, b) => a.date.localeCompare(b.date) || a.buyTxnId - b.buyTxnId);
      }

      let costBasis = 0, matchedQty = 0;
      for (const lot of order) {
        if (qtyToSell <= 0) break;
        const take = Math.min(lot.remaining, qtyToSell);
        costBasis += take * lot.costPerShare;
        matchedQty += take;
        lot.remaining -= take;
        qtyToSell -= take;
      }
      const proceeds = matchedQty * sellPerShare;
      const realised = proceeds - costBasis;
      updates.push({ id: t.id, realized_gl: realised, cost_basis: costBasis });
    }
  }

  const upd = db.prepare('UPDATE transactions SET realized_gl = ?, cost_basis = ? WHERE id = ?');
  const run = db.transaction(() => updates.forEach(u => upd.run(u.realized_gl, u.cost_basis, u.id)));
  run();
}

// Call after any ledger mutation
function refresh(portfolioId) {
  rebuildLots(portfolioId);
  recomputeRealisedGains(portfolioId);
}

// ─── CURRENT HOLDINGS (open positions) ────────────────────────────────────────
function getHoldings(portfolioId) {
  const db = getDb();

  const lots = db.prepare(`
    SELECT l.*, s.company_name, s.group_id, s.currency as sec_currency, g.name as group_name, g.color as group_color
    FROM lots l
    LEFT JOIN securities s ON s.portfolio_id = l.portfolio_id AND s.ticker = l.ticker
    LEFT JOIN groups g ON g.id = s.group_id
    WHERE l.portfolio_id = ? AND l.remaining_qty > 0
    ORDER BY l.ticker, l.trade_date
  `).all(portfolioId);

  // Aggregate lots into holdings per ticker
  const map = {};
  for (const lot of lots) {
    const k = lot.ticker;
    if (!map[k]) {
      map[k] = {
        ticker: k,
        company_name: lot.company_name || k,
        currency: lot.currency || lot.sec_currency || 'AUD',
        group_id: lot.group_id || null,
        group_name: lot.group_name || 'Uncategorized',
        group_color: lot.group_color || '#4a5570',
        total_qty: 0,
        cost_total: 0,
        lots: [],
      };
    }
    map[k].total_qty += lot.remaining_qty;
    map[k].cost_total += lot.remaining_qty * lot.cost_per_share;
    map[k].lots.push({
      id: lot.id,
      buy_txn_id: lot.buy_txn_id,
      quantity: lot.quantity,
      remaining_qty: lot.remaining_qty,
      cost_per_share: lot.cost_per_share,
      trade_date: lot.trade_date,
      notes: lot.notes,
    });
  }

  return Object.values(map).map(h => ({
    ...h,
    avg_cost: h.total_qty > 0 ? h.cost_total / h.total_qty : 0,
    lot_count: h.lots.length,
  }));
}

// ─── CLOSED POSITIONS ─────────────────────────────────────────────────────────
// A ticker is "closed" if total bought == total sold (no open lots remain) but it
// has sell history. Aggregates buys/sells across all time.
function getClosedPositions(portfolioId) {
  const db = getDb();

  const rows = db.prepare(`
    SELECT ticker, type,
      SUM(CASE WHEN type='buy'  THEN quantity ELSE 0 END) as bought,
      SUM(CASE WHEN type='sell' THEN quantity ELSE 0 END) as sold,
      SUM(CASE WHEN type='buy'  THEN quantity*price + fees ELSE 0 END) as cost,
      SUM(CASE WHEN type='sell' THEN quantity*price - fees ELSE 0 END) as proceeds,
      SUM(CASE WHEN type='sell' THEN COALESCE(realized_gl,0) ELSE 0 END) as realised,
      MIN(CASE WHEN type='buy'  THEN trade_date END) as first_buy,
      MAX(CASE WHEN type='sell' THEN trade_date END) as last_sell
    FROM transactions
    WHERE portfolio_id = ? AND type IN ('buy','sell')
    GROUP BY ticker
  `).all(portfolioId);

  // open qty still held per ticker
  const open = {};
  db.prepare('SELECT ticker, SUM(remaining_qty) q FROM lots WHERE portfolio_id = ? GROUP BY ticker')
    .all(portfolioId).forEach(r => { open[r.ticker] = r.q; });

  return rows
    .filter(r => r.sold > 0 && (open[r.ticker] || 0) < 1e-6) // fully closed
    .map(r => {
      const sec = db.prepare('SELECT company_name FROM securities WHERE portfolio_id=? AND ticker=?')
        .get(portfolioId, r.ticker);
      return {
        ticker: r.ticker,
        company_name: sec?.company_name || r.ticker,
        shares_bought: r.bought,
        shares_sold: r.sold,
        avg_buy: r.bought > 0 ? r.cost / r.bought : 0,
        avg_sell: r.sold > 0 ? (r.proceeds + 0) / r.sold : 0,
        total_cost: r.cost,
        total_proceeds: r.proceeds,
        realised_gl: r.realised,
        realised_pct: r.cost > 0 ? (r.realised / r.cost * 100) : 0,
        first_buy_date: r.first_buy,
        final_sell_date: r.last_sell,
      };
    });
}

// ─── REALISED GAINS SUMMARY (by position / by year) ───────────────────────────
function getRealisedSummary(portfolioId) {
  const db = getDb();
  const byPosition = db.prepare(`
    SELECT ticker, SUM(COALESCE(realized_gl,0)) as realised, COUNT(*) as sells
    FROM transactions WHERE portfolio_id = ? AND type='sell'
    GROUP BY ticker ORDER BY realised DESC
  `).all(portfolioId);

  const byYear = db.prepare(`
    SELECT substr(trade_date,1,4) as year, SUM(COALESCE(realized_gl,0)) as realised
    FROM transactions WHERE portfolio_id = ? AND type='sell'
    GROUP BY year ORDER BY year DESC
  `).all(portfolioId);

  const total = byPosition.reduce((s, r) => s + r.realised, 0);
  return { total, byPosition, byYear };
}

module.exports = {
  fingerprint, refresh, rebuildLots, recomputeRealisedGains,
  getHoldings, getClosedPositions, getRealisedSummary,
};
