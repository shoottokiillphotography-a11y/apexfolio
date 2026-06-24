import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-exports-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.BASE_CURRENCY = "AUD";
process.env.DEFAULT_USER_EMAIL = "exports@example.com";

const { getDb, getPrimaryUser } = await import("../src/db.js");
const {
  exportInvestmentHistoryCsv,
  exportPortfolioSnapshotCsv,
  exportTriggeredAlertsCsv
} = await import("../src/services/export-data.js");
const { id, nowIso } = await import("../src/utils.js");

function rows(download) {
  return String(download.body).trim().split("\n").map((line) => line.split(","));
}

function header(download) {
  return rows(download)[0];
}

test("clean CSV exports use flat purpose-built columns and no json blob", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const group = db.prepare("SELECT id FROM categories WHERE id = 'cat_ai_infrastructure'").get();
  const now = nowIso();

  db.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES ('EXPA', 'Export Alpha', 'AUD', ?, 'ACTIVE', ?, ?)
  `).run(group.id, now, now);
  const lotId = id("lot");
  db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, notes, created_at, updated_at
    )
    VALUES (?, ?, 'EXPA', 10, 7, 100, 'AUD', '2025-01-01', 'netwealth', 'Main account', ?, ?)
  `).run(lotId, user.id, now, now);
  db.prepare(`
    INSERT INTO market_prices (
      ticker, price, currency, previous_close, change_amount, change_percent,
      provider, status, as_of
    )
    VALUES ('EXPA', 150, 'AUD', 140, 10, 7.14, 'test', 'LIVE', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, 'AUD', 500, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(id("cash"), user.id, now);
  db.prepare(`
    INSERT INTO realized_lots (
      id, user_id, ticker, lot_id, quantity, sale_price, sale_currency,
      sold_at, cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
      source, buy_price, buy_currency, bought_at, notes, created_at
    )
    VALUES (?, ?, 'EXPA', ?, 3, 140, 'AUD', '2025-02-01', 300, 420, 120, 40, 'manual', 100, 'AUD', '2025-01-01', 'Partial sale', ?)
  `).run(id("sale"), user.id, lotId, now);
  db.prepare(`
    INSERT INTO dividend_payments (
      id, user_id, ticker, ex_date, pay_date, record_date, amount_per_share,
      currency, eligible_quantity, gross_amount, gross_amount_base, source,
      source_event_id, payload_json, created_at, updated_at
    )
    VALUES (?, ?, 'EXPA', '2025-03-01', '2025-03-15', '2025-03-02', 1, 'AUD', 7, 7, 7, 'netwealth', 'div1', '{}', ?, ?)
  `).run(id("div"), user.id, now, now);
  db.prepare(`
    INSERT INTO price_alerts (
      id, user_id, ticker, scope, direction, threshold_price, currency,
      label, company_name, strategy_group, alert_type, priority, note,
      active, triggered, triggered_at, last_triggered_at, last_triggered_price,
      created_at, updated_at
    )
    VALUES (?, ?, 'EXPA', 'EQUITY', 'ABOVE', 155, 'AUD', 'Trim', 'Export Alpha', 'AI', 'PRICE_ALERT', 'high', 'Triggered note', 1, 1, '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z', 156, ?, ?)
  `).run(id("alert"), user.id, now, now);
  db.prepare(`
    INSERT INTO price_alerts (
      id, user_id, ticker, scope, direction, threshold_price, currency,
      label, company_name, strategy_group, alert_type, priority, note,
      active, triggered, triggered_at, acknowledged_at, last_triggered_price,
      created_at, updated_at
    )
    VALUES (?, ?, 'EXPA', 'EQUITY', 'BELOW', 90, 'AUD', 'Review', 'Export Alpha', 'AI', 'PRICE_ALERT', 'medium', 'Reviewed note', 1, 1, '2025-04-02T00:00:00.000Z', '2025-04-03T00:00:00.000Z', 89, ?, ?)
  `).run(id("alert"), user.id, now, now);

  const portfolio = await exportPortfolioSnapshotCsv(user.id);
  assert.equal(portfolio.filename.startsWith("apexfolio-portfolio_"), true);
  assert.deepEqual(header(portfolio), [
    "row_type", "ticker", "name", "group", "currency", "quantity", "price",
    "market_value_aud", "cost_basis_aud", "unrealized_aud", "unrealized_pct",
    "day_change_aud", "day_change_pct", "weight_pct"
  ]);
  assert.equal(header(portfolio).includes("json"), false);
  assert.equal(rows(portfolio).some((row) => row[0] === "HOLDING"), true);
  assert.equal(rows(portfolio).some((row) => row[0] === "CASH"), true);

  const history = await exportInvestmentHistoryCsv(user.id);
  assert.equal(history.filename.startsWith("apexfolio-history_"), true);
  assert.equal(header(history).includes("json"), false);
  assert.deepEqual(rows(history).slice(1).map((row) => row[1]), ["BUY", "SELL", "DIVIDEND"]);

  const triggered = exportTriggeredAlertsCsv(user.id);
  assert.equal(triggered.filename.startsWith("apexfolio-alerts-triggered_"), true);
  assert.equal(header(triggered).includes("json"), false);
  assert.equal(rows(triggered).length, 2);
  assert.equal(rows(triggered)[1][13], "triggered");

  const reviewed = exportTriggeredAlertsCsv(user.id, { includeReviewed: true });
  assert.equal(rows(reviewed).length, 3);
});
