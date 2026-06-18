import { getDb } from "../db.js";
import { config } from "../config.js";
import { fetchJson, id, nowIso } from "../utils.js";

export function renderPriceAlertEmail({ alert, quote, currentPrice, userCurrency, lot }) {
  const scope = alert.scope === "LOT" && lot
    ? `Lot purchased ${lot.purchase_date} (${lot.quantity} shares)`
    : alert.scope.toLowerCase();
  const alertType = alert.effective_alert_type || alert.alert_type || "PRICE_ALERT";
  const subject = `${alert.ticker} ${alertType}: ${alert.direction.toLowerCase()} ${alert.threshold_price} ${alert.currency}`;
  const body = [
    `${alert.ticker} reached your ${alert.direction.toLowerCase()} threshold.`,
    "",
    alert.company_name ? `Company: ${alert.company_name}` : null,
    alert.strategy_group ? `Group: ${alert.strategy_group}` : null,
    `Alert type: ${alertType}`,
    alert.priority ? `Priority: ${String(alert.priority).toUpperCase()}` : null,
    `Current price: ${currentPrice} ${userCurrency}`,
    `Alert threshold: ${alert.threshold_price} ${alert.currency}`,
    `Scope: ${scope}`,
    alert.position_weight_percent != null ? `Portfolio weight: ${alert.position_weight_percent}%` : null,
    alert.note ? `Note: ${alert.note}` : alert.label ? `Label: ${alert.label}` : null,
    alert.safety_warning ? `Safety: ${alert.safety_warning}` : null,
    alert.suggested_action ? `Suggested review: ${alert.suggested_action}` : null,
    quote?.asOf ? `Market data timestamp: ${quote.asOf}` : null,
    "",
    "This is a review signal only. The portfolio tracker never places trades automatically."
  ].filter(Boolean).join("\n");
  return { subject, body };
}

export function renderCorporateEventEmail({ event }) {
  const subject = `${event.ticker} corporate event: ${event.event_type}`;
  const body = [
    `${event.title}`,
    "",
    `Ticker: ${event.ticker}`,
    `Event type: ${event.event_type}`,
    `Event date: ${event.event_date}`,
    event.details ? `Details: ${event.details}` : null,
    `Source: ${event.source}`,
    "",
    "This notification was generated because the equity is in your portfolio, watchlist, or active alerts."
  ].filter(Boolean).join("\n");
  return { subject, body };
}

export function createNotification({ userId, kind, ticker, alertId = null, eventId = null, recipient, subject, body }) {
  const database = getDb();
  const notificationId = id("notif");
  database.prepare(`
    INSERT INTO notification_history (
      id, user_id, kind, ticker, alert_id, event_id, recipient, subject, body,
      status, provider, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `).run(notificationId, userId, kind, ticker || null, alertId, eventId, recipient, subject, body, config.emailProvider, nowIso());
  return notificationId;
}

function emailProviderConfigured() {
  if (config.emailProvider === "brevo") return Boolean(config.brevoApiKey && config.brevoFromEmail);
  return Boolean(config.sendgridApiKey && config.sendgridFromEmail);
}

async function sendWithSendGrid(notification) {
  if (!config.sendgridApiKey || !config.sendgridFromEmail) {
    throw new Error("SENDGRID_API_KEY and SENDGRID_FROM_EMAIL are required for email delivery");
  }

  return fetchJson("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: notification.recipient }] }],
      from: { email: config.sendgridFromEmail, name: config.sendgridFromName },
      subject: notification.subject,
      content: [{ type: "text/plain", value: notification.body }]
    })
  });
}

async function sendWithBrevo(notification) {
  if (!config.brevoApiKey || !config.brevoFromEmail) {
    throw new Error("BREVO_API_KEY and BREVO_FROM_EMAIL are required for email delivery");
  }

  return fetchJson("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": config.brevoApiKey,
      accept: "application/json"
    },
    body: JSON.stringify({
      sender: { email: config.brevoFromEmail, name: config.brevoFromName },
      to: [{ email: notification.recipient }],
      subject: notification.subject,
      textContent: notification.body
    })
  });
}

export async function sendNotification(notificationId) {
  const database = getDb();
  const notification = database.prepare("SELECT * FROM notification_history WHERE id = ?").get(notificationId);
  if (!notification) return null;

  try {
    const response = config.emailProvider === "brevo"
      ? await sendWithBrevo(notification)
      : await sendWithSendGrid(notification);
    database.prepare(`
      UPDATE notification_history
      SET status = 'SENT', provider = ?, provider_message_id = ?, sent_at = ?, error = NULL
      WHERE id = ?
    `).run(config.emailProvider, response?.messageId || response?.message_id || null, nowIso(), notificationId);
    return { id: notificationId, status: "SENT" };
  } catch (error) {
    const status = emailProviderConfigured() ? "FAILED" : "WAITING_FOR_CONFIGURATION";
    database.prepare(`
      UPDATE notification_history
      SET status = ?, provider = ?, error = ?
      WHERE id = ?
    `).run(status, config.emailProvider, error.message, notificationId);
    return { id: notificationId, status, error: error.message };
  }
}

export async function sendPendingNotifications(limit = 25) {
  const database = getDb();
  const pending = database.prepare(`
    SELECT id
    FROM notification_history
    WHERE status IN ('PENDING', 'FAILED', 'WAITING_FOR_CONFIGURATION')
    ORDER BY created_at
    LIMIT ?
  `).all(limit);

  const results = [];
  for (const row of pending) {
    results.push(await sendNotification(row.id));
  }
  return results;
}

export async function createAndSendNotification(input) {
  const notificationId = createNotification(input);
  return sendNotification(notificationId);
}
