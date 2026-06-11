/**
 * ApexFolio v2 — Multi-user server
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const cron      = require('node-cron');
const path      = require('path');

const { initDb }           = require('./models/database');
const { requireAuth }      = require('./middleware/auth');
const authRouter           = require('./routes/auth');
const holdingsRouter       = require('./routes/holdings');
const alertsRouter         = require('./routes/alerts');
const watchlistRouter      = require('./routes/watchlist');
const pricesRouter         = require('./routes/prices');
const notificationsRouter  = require('./routes/notifications');
const netwealthRouter      = require('./routes/importNetwealth');
const lookupRouter         = require('./routes/lookup');
const transactionsRouter   = require('./routes/transactions');
const groupsRouter         = require('./routes/groups');
const cashRouter           = require('./routes/cash');
const externalRouter       = require('./routes/external');

const PriceService  = require('./services/priceService');
const AlertService  = require('./services/alertService');
const EventsService = require('./services/eventsService');
const SnapshotService = require('./services/snapshotService');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP handled by frontend
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));
app.use(express.json({ limit: '10mb' }));

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/holdings',      holdingsRouter);     // auth enforced inside
app.use('/api/alerts',        requireAuth, alertsRouter);
app.use('/api/watchlist',     requireAuth, watchlistRouter);
app.use('/api/prices',        rateLimit({ windowMs:60_000, max:60 }), pricesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/import/netwealth', netwealthRouter);
app.use('/api/lookup',        requireAuth, rateLimit({ windowMs:60_000, max:120 }), lookupRouter);
app.use('/api/transactions',  transactionsRouter);
app.use('/api/groups',        groupsRouter);
app.use('/api/cash',          cashRouter);
app.use('/api/external',      externalRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date(), version: '3.0.0-drop1' }));

// Performance (snapshot-derived). Auth required.
app.get('/api/performance', requireAuth, (req, res, next) => {
  try {
    const { getDb } = require('./models/database');
    const db = getDb();
    let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!p) return res.json({ available: false });
    res.json(SnapshotService.performance(p.id));
  } catch (err) { next(err); }
});

// Daily snapshot time-series for charting
app.get('/api/performance/history', requireAuth, (req, res, next) => {
  try {
    const { getDb } = require('./models/database');
    const db = getDb();
    let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!p) return res.json({ points: [] });
    const rows = db.prepare(`
      SELECT snapshot_date, total_value, market_value, cost_basis, cash, unrealised_gl, realised_cum
      FROM portfolio_snapshots WHERE portfolio_id = ?
      ORDER BY snapshot_date ASC
    `).all(p.id);
    res.json({ points: rows });
  } catch (err) { next(err); }
});

// Manual snapshot trigger (useful right after import so history starts immediately)
app.post('/api/performance/snapshot', requireAuth, async (req, res, next) => {
  try {
    const { getDb } = require('./models/database');
    const db = getDb();
    let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!p) return res.status(404).json({ error: 'No portfolio' });
    const snap = await SnapshotService.snapshotPortfolio(p.id);
    res.json({ recorded: true, snapshot: snap });
  } catch (err) { next(err); }
});

// Historical backfill — reconstruct daily portfolio value from the ledger +
// Yahoo historical prices/FX. Idempotent; safe to re-run.
const BackfillService = require('./services/backfillService');
app.post('/api/performance/backfill', requireAuth, async (req, res, next) => {
  try {
    const { getDb } = require('./models/database');
    const db = getDb();
    let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!p) return res.status(404).json({ error: 'No portfolio' });
    const rebuild = req.body && req.body.rebuild;
    if (rebuild) BackfillService.clearBackfill(p.id);
    const result = await BackfillService.backfill(p.id, { fxToday: false });
    res.json(result);
  } catch (err) { next(err); }
});
app.delete('/api/performance/backfill', requireAuth, (req, res, next) => {
  try {
    const { getDb } = require('./models/database');
    const db = getDb();
    let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!p) return res.status(404).json({ error: 'No portfolio' });
    const removed = BackfillService.clearBackfill(p.id);
    res.json({ cleared: removed });
  } catch (err) { next(err); }
});

// ─── SERVE REACT BUILD (production) ──────────────────────────────────────────
// Serve PWA static files
const clientPath = path.join(__dirname, '../client');
const publicPath = path.join(clientPath, 'public');

app.use('/icons', express.static(path.join(publicPath, 'icons'), { maxAge: '7d' }));

// Service worker served with no-cache (required for PWA updates)
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(publicPath, 'sw.js'));
});

app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(publicPath, 'manifest.json'));
});

// Serve app HTML for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// Check price alerts every 2 min during market hours
cron.schedule('*/2 9-16 * * 1-5', () => AlertService.checkAndFireAlerts().catch(console.error), { timezone: 'America/New_York' });
// Fetch corporate events daily 7 AM ET
cron.schedule('0 7 * * 1-5', () => EventsService.fetchAndStoreEvents().catch(console.error), { timezone: 'America/New_York' });
// Refresh price cache every 60s during market hours
cron.schedule('*/1 9-16 * * 1-5', () => PriceService.refreshPriceCache().catch(console.error), { timezone: 'America/New_York' });
// Daily portfolio snapshot at 4:30pm ET (after US market close) — builds performance history
cron.schedule('30 16 * * 1-5', () => SnapshotService.snapshotAll().catch(console.error), { timezone: 'America/New_York' });
// Also snapshot once on startup so history begins immediately on first deploy
setTimeout(() => SnapshotService.snapshotAll().catch(console.error), 8000);

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message,
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ ApexFolio v2 running on port ${PORT}`);
    console.log(`   Multi-user: enabled`);
    console.log(`   Auth: JWT (30-day tokens)`);
    console.log(`   Env: ${process.env.NODE_ENV || 'development'}\n`);
  });
}).catch(err => { console.error('Startup failed:', err); process.exit(1); });

module.exports = app;
