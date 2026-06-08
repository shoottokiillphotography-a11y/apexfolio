/**
 * Notifications + Events Router — /api/notifications  (Drop 1)
 * GET /          — notification history
 * GET /events    — upcoming corporate events for tracked tickers
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const logs = db.prepare('SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT 100').all();
    res.json({ notifications: logs });
  } catch (err) { next(err); }
});

router.get('/events', (req, res, next) => {
  try {
    const db = getDb();
    const events = db.prepare(`
      SELECT * FROM corporate_events
      WHERE event_date >= date('now') ORDER BY event_date ASC LIMIT 100
    `).all();
    res.json({ events });
  } catch (err) { next(err); }
});

module.exports = router;
