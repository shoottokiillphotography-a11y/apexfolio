/**
 * AlertService — evaluates alerts against live prices (Drop 1 schema).
 * On trigger: records an executed_alert (never deletes the alert), sends email.
 */

const { getDb } = require('../models/database');
const PriceService = require('./priceService');
const EmailService = require('./emailService');

async function checkAndFireAlerts() {
  const db = getDb();
  const alerts = db.prepare(`SELECT * FROM alerts WHERE status = 'active'`).all();
  if (!alerts.length) return;

  const tickers = [...new Set(alerts.map(a => a.ticker))];
  let prices = {};
  try { prices = await PriceService.getPrices(tickers); } catch { return; }

  const now = new Date().toISOString();

  for (const a of alerts) {
    const pd = prices[a.ticker];
    if (!pd?.price) continue;

    // cooldown
    if (a.last_triggered) {
      const since = Date.now() - new Date(a.last_triggered).getTime();
      if (since < (a.cooldown_mins || 1440) * 60000) continue;
    }

    const price = pd.price;
    const hit = a.direction === 'above' ? price >= a.threshold : price <= a.threshold;
    if (!hit) continue;

    // Record executed alert (persistent)
    const ex = db.prepare(`
      INSERT INTO executed_alerts (alert_id, ticker, kind, target_price, trigger_price, status)
      VALUES (?,?,?,?,?, 'pending')
    `).run(a.id, a.ticker, a.kind, a.threshold, price);

    db.prepare(`UPDATE alerts SET status='triggered', last_triggered=? WHERE id=?`).run(now, a.id);

    // Email if configured
    if (a.email) {
      try {
        await EmailService.sendAlertEmail({
          to: a.email, ticker: a.ticker, companyName: a.ticker,
          context: { condition: `${a.kind.replace('_',' ')} ${a.direction} ${a.threshold}`, currentPrice: price },
          alertType: a.direction === 'above' ? 'price_above' : 'price_below',
        });
        db.prepare('UPDATE executed_alerts SET email_sent=1 WHERE id=?').run(ex.lastInsertRowid);
        db.prepare(`INSERT INTO notification_log (notification_type, ticker, recipient_email, subject, status)
          VALUES ('alert', ?, ?, ?, 'sent')`).run(a.ticker, a.email, `Alert: ${a.ticker}`);
      } catch (e) {
        db.prepare(`INSERT INTO notification_log (notification_type, ticker, recipient_email, subject, status, error_msg)
          VALUES ('alert', ?, ?, ?, 'failed', ?)`).run(a.ticker, a.email, `Alert: ${a.ticker}`, e.message);
      }
    }
  }
}

module.exports = { checkAndFireAlerts };
