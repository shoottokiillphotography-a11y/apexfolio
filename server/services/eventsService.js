/**
 * EventsService — fetches corporate events (earnings) from Finnhub for tracked tickers.
 * Drop 1: reads tickers from securities + watchlist (holdings table removed).
 */

const fetch = require('node-fetch');
const { getDb } = require('../models/database');

const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY;

async function fetchAndStoreEvents() {
  const db = getDb();
  if (!FINNHUB_KEY()) return;

  const secs = db.prepare('SELECT DISTINCT ticker FROM securities').all();
  const watch = db.prepare('SELECT DISTINCT ticker FROM watchlist').all();
  const tickers = [...new Set([...secs, ...watch].map(r => r.ticker))];
  if (!tickers.length) return;

  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  try {
    const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB_KEY()}`, { timeout: 10000 });
    if (!r.ok) return;
    const data = await r.json();
    const tset = new Set(tickers);
    const ins = db.prepare(`
      INSERT OR IGNORE INTO corporate_events (ticker, event_type, event_date, title, description, source_id)
      VALUES (?, 'earnings', ?, ?, ?, ?)
    `);
    (data.earningsCalendar || []).filter(e => tset.has(e.symbol)).forEach(e => {
      ins.run(e.symbol, e.date, `${e.symbol} Earnings`,
        `EPS est ${e.epsEstimate ?? 'N/A'}`, `earnings_${e.symbol}_${e.date}`);
    });
  } catch (e) { /* ignore */ }
}

module.exports = { fetchAndStoreEvents };
