/**
 * backfillService.js — Reconstruct historical daily portfolio snapshots.
 *
 * Walks the transaction ledger to know holdings on each past date, fetches
 * each ticker's full daily close history + per-day FX from Yahoo, and writes
 * one portfolio_snapshots row per day from the first purchase to today.
 *
 * Safe + idempotent: snapshots upsert per (portfolio, date). A clear() helper
 * lets you wipe backfilled history and rebuild from scratch.
 *
 * Native-currency handling mirrors priceService: London pence (GBp/GBX) and
 * South African cents (ZAc) are divided by 100; everything else is taken as-is
 * and converted to AUD using that day's FX rate.
 */

const { getDb } = require('../models/database');

const YH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
const DAY = 86400;

function ymd(d) { return d.toISOString().slice(0, 10); }
function parseYmd(s) { return new Date(s + 'T00:00:00Z'); }

// ─── Fetch a ticker's full daily history: { 'YYYY-MM-DD': {close, ccy} } ──────
async function fetchPriceHistory(ticker, fromTs, toTs) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${fromTs}&period2=${toTs}&interval=1d`;
  const out = {};
  let nativeCcy = 'USD';
  try {
    const r = await fetch(url, { timeout: 12000, headers: YH_HEADERS });
    if (!r.ok) return { map: out, nativeCcy };
    const data = await r.json();
    const res = data?.chart?.result?.[0];
    if (!res) return { map: out, nativeCcy };
    nativeCcy = res.meta?.currency || 'USD';
    let div = 1;
    if (nativeCcy === 'GBp' || nativeCcy === 'GBX') { div = 100; nativeCcy = 'GBP'; }
    else if (nativeCcy === 'ZAc') { div = 100; nativeCcy = 'ZAR'; }
    const ts = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const day = ymd(new Date(ts[i] * 1000));
      out[day] = c / div;
    }
  } catch (e) { /* leave out empty on failure */ }
  return { map: out, nativeCcy };
}

// ─── Fetch a currency's daily AUD rate history: { 'YYYY-MM-DD': rate } ────────
async function fetchFxHistory(ccy, fromTs, toTs) {
  if (!ccy || ccy.toUpperCase() === 'AUD') return {};
  const c = ccy.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${c}AUD=X?period1=${fromTs}&period2=${toTs}&interval=1d`;
  const out = {};
  try {
    const r = await fetch(url, { timeout: 12000, headers: YH_HEADERS });
    if (!r.ok) return out;
    const data = await r.json();
    const res = data?.chart?.result?.[0];
    if (!res) return out;
    const ts = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      out[ymd(new Date(ts[i] * 1000))] = closes[i];
    }
  } catch (e) {}
  return out;
}

// Forward-fill: given a date->value map, get value on/before a date.
function asOf(map, day) {
  if (map[day] != null) return map[day];
  // walk backwards up to ~10 days to cover weekends/holidays
  const d = parseYmd(day);
  for (let i = 1; i <= 10; i++) {
    const prev = ymd(new Date(d.getTime() - i * DAY * 1000));
    if (map[prev] != null) return map[prev];
  }
  return null;
}

function clearBackfill(portfolioId) {
  const db = getDb();
  const info = db.prepare(
    `DELETE FROM portfolio_snapshots WHERE portfolio_id = ? AND source = 'backfill'`
  ).run(portfolioId);
  return info.changes;
}

async function backfill(portfolioId, { fxToday } = {}) {
  const db = getDb();

  // 1) Pull all transactions (buys/sells) ordered by date.
  const txns = db.prepare(`
    SELECT ticker, type, quantity, price, fees, currency, amount, trade_date
    FROM transactions
    WHERE portfolio_id = ? AND type IN ('buy','sell')
    ORDER BY trade_date ASC, id ASC
  `).all(portfolioId);

  if (!txns.length) return { ok: false, reason: 'No transactions to backfill.' };

  const firstDate = txns[0].trade_date.slice(0, 10);
  const fromTs = Math.floor(parseYmd(firstDate).getTime() / 1000) - DAY * 5;
  const toTs = Math.floor(Date.now() / 1000) + DAY;

  // 2) Unique tickers + their cost currency (from first buy seen).
  const tickers = [...new Set(txns.map(t => t.ticker))];

  // 3) Fetch price history per ticker (sequential w/ tiny gap to be gentle on Yahoo).
  const priceHist = {};      // ticker -> {map, nativeCcy}
  for (const tk of tickers) {
    priceHist[tk] = await fetchPriceHistory(tk, fromTs, toTs);
    await new Promise(r => setTimeout(r, 120));
  }

  // 4) Fetch FX history for each native currency encountered.
  const ccys = [...new Set(Object.values(priceHist).map(p => p.nativeCcy))];
  const fxHist = {};         // ccy -> {map}
  for (const c of ccys) {
    if (c && c.toUpperCase() !== 'AUD') fxHist[c] = await fetchFxHistory(c, fromTs, toTs);
    await new Promise(r => setTimeout(r, 120));
  }

  // 5) Build cumulative holdings per day by replaying txns.
  //    qtyByTicker[ticker] = running share count.
  //    costByTicker[ticker] = running AUD cost basis (amount already AUD in ledger).
  const txByDay = {};
  for (const t of txns) {
    const day = t.trade_date.slice(0, 10);
    (txByDay[day] = txByDay[day] || []).push(t);
  }

  const upsert = db.prepare(`
    INSERT INTO portfolio_snapshots
      (portfolio_id, snapshot_date, market_value, cost_basis, cash, unrealised_gl, realised_cum, total_value, source)
    VALUES (@pid, @date, @mv, @cost, 0, @unreal, 0, @total, 'backfill')
    ON CONFLICT(portfolio_id, snapshot_date) DO UPDATE SET
      market_value=excluded.market_value, cost_basis=excluded.cost_basis,
      unrealised_gl=excluded.unrealised_gl, total_value=excluded.total_value,
      source='backfill'
  `);

  const qty = {};            // ticker -> shares held
  const costAud = {};        // ticker -> AUD cost basis of held shares (approx, avg-cost)
  const avgCostAud = {};     // ticker -> running average AUD cost per share

  let written = 0, daysSkipped = 0;
  const start = parseYmd(firstDate);
  const end = parseYmd(ymd(new Date()));

  const writeAll = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });
  const rows = [];

  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + DAY * 1000)) {
    const day = ymd(d);

    // apply any transactions on this day (avg-cost basis in AUD)
    const todays = txByDay[day] || [];
    for (const t of todays) {
      const tk = t.ticker;
      if (!(tk in qty)) { qty[tk] = 0; costAud[tk] = 0; avgCostAud[tk] = 0; }
      if (t.type === 'buy') {
        qty[tk] += t.quantity;
        costAud[tk] += Math.abs(t.amount || (t.quantity * t.price));
        avgCostAud[tk] = qty[tk] > 0 ? costAud[tk] / qty[tk] : 0;
      } else if (t.type === 'sell') {
        const sold = Math.min(t.quantity, qty[tk]);
        costAud[tk] -= sold * avgCostAud[tk];   // remove cost at running avg
        qty[tk] -= sold;
        if (qty[tk] < 1e-9) { qty[tk] = 0; costAud[tk] = 0; avgCostAud[tk] = 0; }
      }
    }

    // skip weekends — markets closed, no meaningful snapshot
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) { daysSkipped++; continue; }

    // value the holdings as of this day
    let mv = 0, cost = 0;
    for (const tk of Object.keys(qty)) {
      if (qty[tk] <= 0) continue;
      const ph = priceHist[tk];
      if (!ph) continue;
      const px = asOf(ph.map, day);
      if (px == null) continue;            // no price yet (pre-listing or gap)
      const ccy = ph.nativeCcy;
      let rate = 1;
      if (ccy && ccy.toUpperCase() !== 'AUD') {
        rate = fxToday ? null : asOf(fxHist[ccy] || {}, day);
        if (rate == null) rate = 1;        // last-resort; AUD-equivalent if FX missing
      }
      mv += qty[tk] * px * rate;
      cost += costAud[tk];
    }

    if (mv <= 0) { daysSkipped++; continue; }
    rows.push({ pid: portfolioId, date: day, mv, cost, unreal: mv - cost, total: mv });
    written++;
  }

  writeAll(rows);

  return {
    ok: true,
    firstDate,
    lastDate: ymd(end),
    daysWritten: written,
    daysSkipped,
    tickers: tickers.length,
    currencies: ccys.filter(c => c && c.toUpperCase() !== 'AUD'),
  };
}

module.exports = { backfill, clearBackfill };
