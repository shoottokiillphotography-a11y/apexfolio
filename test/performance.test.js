import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-performance-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.BASE_CURRENCY = "USD";
process.env.DEFAULT_USER_EMAIL = "test@example.com";
process.env.FINNHUB_API_KEY = "";
process.env.ALPHA_VANTAGE_API_KEY = "";

const { getDb, getPrimaryUser } = await import("../src/db.js");
const { portfolioPerformance, tickerPerformance } = await import("../src/services/performance.js");
const { id, nowIso } = await import("../src/utils.js");

function isoDaysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

test("performance endpoints calculate historical ticker and portfolio returns", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const category = db.prepare("SELECT id FROM categories WHERE id = 'cat_speculative'").get();
  const firstDate = isoDaysAgo(2);
  const secondDate = isoDaysAgo(1);
  const lastDate = isoDaysAgo(0);
  db.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES ('PERF', 'Performance Test', 'USD', ?, 'ACTIVE', ?, ?)
  `).run(category.id, nowIso(), nowIso());
  db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, created_at, updated_at
    )
    VALUES (?, ?, 'PERF', 10, 10, 8, 'USD', ?, 'test', ?, ?)
  `).run(id("lot"), user.id, firstDate, nowIso(), nowIso());

  const insertPrice = db.prepare(`
    INSERT INTO historical_prices (ticker, price_date, close, currency, provider, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertPrice.run("PERF", firstDate, 10, "USD", "test", nowIso());
  insertPrice.run("PERF", secondDate, 12, "USD", "test", nowIso());
  insertPrice.run("PERF", lastDate, 15, "USD", "test", nowIso());

  const ticker = await tickerPerformance("PERF", "1mo");
  assert.equal(ticker.startValue, 10);
  assert.equal(ticker.endValue, 15);
  assert.equal(ticker.changePercent, 50);

  const portfolio = await portfolioPerformance(user.id, "1mo");
  assert.equal(portfolio.startValue, 100);
  assert.equal(portfolio.endValue, 150);
  assert.equal(portfolio.changeValue, 50);
  assert.equal(portfolio.changePercent, 50);

  db.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, 'USD', 100, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(id("cash"), user.id, nowIso());
  const valueHistory = await portfolioPerformance(user.id, "1mo");
  assert.equal(valueHistory.performanceReliable, false);
  assert.match(valueHistory.warnings.join(" "), /Large performance move detected/);
  assert.equal(valueHistory.cashFlowDiagnostics.cashIncludedBase, 100);
  assert.equal(valueHistory.changeValue, 50);
  assert.equal(valueHistory.changePercent, 25);
});
