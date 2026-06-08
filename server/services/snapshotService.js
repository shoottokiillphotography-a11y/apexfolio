/**
 * SnapshotService — records daily portfolio + group value history.
 *
 * Runs once per day (cron). Each run writes ONE row per portfolio into
 * portfolio_snapshots and one row per group into group_snapshots, capturing:
 *   - market value of open holdings (live prices)
 *   - cost basis of open holdings
 *   - cumulative realised gains to date
 *
 * This is what powers day/week/month/YTD/1y/3y/5y/all-time performance in Drop 2.
 * Because it starts the day you deploy, history accumulates from inception.
 *
 * UNIQUE(portfolio_id, snapshot_date) means re-running the same day is safe
 * (idempotent upsert) — no duplicate history rows.
 */

const { getDb } = require('../models/database');
const PriceService = require('./priceService');
const Ledger = require('./ledgerService');

async function snapshotAll() {
  const db = getDb();
  const portfolios = db.prepare('SELECT id FROM portfolios').all();
  for (const p of portfolios) {
    try { await snapshotPortfolio(p.id); }
    catch (e) { console.error(`[Snapshot] portfolio ${p.id} failed:`, e.message); }
  }
}

async function snapshotPortfolio(portfolioId, dateOverride) {
  const db = getDb();
  const date = dateOverride || new Date().toISOString().slice(0, 10);

  const holdings = Ledger.getHoldings(portfolioId);
  const realisedCum = Ledger.getRealisedSummary(portfolioId).total;

  // Live prices (fall back to avg cost if unavailable)
  let prices = {};
  if (holdings.length) {
    try { prices = await PriceService.getPrices(holdings.map(h => h.ticker)); } catch {}
  }

  let marketValue = 0, costBasis = 0;
  const groupAgg = {}; // key -> { id, name, mv, cost }

  for (const h of holdings) {
    const price = prices[h.ticker]?.price || h.avg_cost;
    const mv = h.total_qty * price;
    marketValue += mv;
    costBasis  += h.cost_total;

    const key = h.group_id || 'none';
    if (!groupAgg[key]) groupAgg[key] = { id: h.group_id || null, name: h.group_name || 'Uncategorized', mv: 0, cost: 0 };
    groupAgg[key].mv  += mv;
    groupAgg[key].cost += h.cost_total;
  }

  const unrealised = marketValue - costBasis;
  const cash = 0; // cash tracking comes from ledger dividends/fees in a later drop
  const totalValue = marketValue + cash;

  // Upsert portfolio snapshot (idempotent per day)
  db.prepare(`
    INSERT INTO portfolio_snapshots
      (portfolio_id, snapshot_date, market_value, cost_basis, cash, unrealised_gl, realised_cum, total_value, source)
    VALUES (@pid, @date, @mv, @cost, @cash, @unreal, @realised, @total, 'cron')
    ON CONFLICT(portfolio_id, snapshot_date) DO UPDATE SET
      market_value=excluded.market_value, cost_basis=excluded.cost_basis,
      cash=excluded.cash, unrealised_gl=excluded.unrealised_gl,
      realised_cum=excluded.realised_cum, total_value=excluded.total_value
  `).run({ pid: portfolioId, date, mv: marketValue, cost: costBasis, cash,
           unreal: unrealised, realised: realisedCum, total: totalValue });

  // Upsert group snapshots
  const upsertGroup = db.prepare(`
    INSERT INTO group_snapshots
      (portfolio_id, group_id, group_name, snapshot_date, market_value, cost_basis, unrealised_gl, source)
    VALUES (@pid, @gid, @gname, @date, @mv, @cost, @unreal, 'cron')
    ON CONFLICT(portfolio_id, group_id, snapshot_date) DO UPDATE SET
      market_value=excluded.market_value, cost_basis=excluded.cost_basis,
      unrealised_gl=excluded.unrealised_gl, group_name=excluded.group_name
  `);
  const txn = db.transaction(() => {
    for (const g of Object.values(groupAgg)) {
      upsertGroup.run({ pid: portfolioId, gid: g.id, gname: g.name, date,
        mv: g.mv, cost: g.cost, unreal: g.mv - g.cost });
    }
  });
  txn();

  return { date, marketValue, costBasis, unrealised, realisedCum, totalValue };
}

// ─── PERFORMANCE QUERY (used by Drop 2 endpoints; available now) ──────────────
// Returns the snapshot on/before a target date for a portfolio.
function snapshotOnOrBefore(portfolioId, date) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM portfolio_snapshots
    WHERE portfolio_id = ? AND snapshot_date <= ?
    ORDER BY snapshot_date DESC LIMIT 1
  `).get(portfolioId, date);
}

function performance(portfolioId) {
  const db = getDb();
  const latest = db.prepare(`
    SELECT * FROM portfolio_snapshots WHERE portfolio_id = ?
    ORDER BY snapshot_date DESC LIMIT 1
  `).get(portfolioId);
  if (!latest) return { available: false };

  const today = latest.snapshot_date;
  const d = (days) => {
    const dt = new Date(today); dt.setDate(dt.getDate() - days);
    return dt.toISOString().slice(0, 10);
  };
  const ytdStart = today.slice(0, 4) + '-01-01';

  const windows = {
    day: 1, week: 7, month: 30, '3m': 90, '6m': 180,
    '1y': 365, '3y': 1095, '5y': 1825,
  };
  const out = { available: true, asOf: today, current: latest.total_value };

  for (const [label, days] of Object.entries(windows)) {
    const past = snapshotOnOrBefore(portfolioId, d(days));
    if (past) {
      const change = latest.total_value - past.total_value;
      out[label] = {
        from: past.total_value, change,
        pct: past.total_value > 0 ? (change / past.total_value * 100) : 0,
      };
    } else out[label] = null;
  }

  // YTD
  const ytd = snapshotOnOrBefore(portfolioId, ytdStart);
  if (ytd) {
    const change = latest.total_value - ytd.total_value;
    out.ytd = { from: ytd.total_value, change, pct: ytd.total_value > 0 ? (change / ytd.total_value * 100) : 0 };
  } else out.ytd = null;

  // All-time (first snapshot)
  const first = db.prepare(`
    SELECT * FROM portfolio_snapshots WHERE portfolio_id = ?
    ORDER BY snapshot_date ASC LIMIT 1
  `).get(portfolioId);
  if (first) {
    const change = latest.total_value - first.total_value;
    out.all = { from: first.total_value, since: first.snapshot_date, change,
      pct: first.total_value > 0 ? (change / first.total_value * 100) : 0 };
  }

  return out;
}

module.exports = { snapshotAll, snapshotPortfolio, performance, snapshotOnOrBefore };
