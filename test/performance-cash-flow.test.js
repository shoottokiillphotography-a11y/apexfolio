import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-performance-cash-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.BASE_CURRENCY = "USD";
process.env.DEFAULT_USER_EMAIL = "cash-flow-test@example.com";
process.env.FINNHUB_API_KEY = "";
process.env.ALPHA_VANTAGE_API_KEY = "";

const { getDb, getPrimaryUser } = await import("../src/db.js");
const { portfolioPerformance } = await import("../src/services/performance.js");
const { id, nowIso } = await import("../src/utils.js");

function isoDaysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

test("portfolio performance keeps sale proceeds out of cash before sale date", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const now = nowIso();
  const buyDate = isoDaysAgo(30);
  const saleDate = isoDaysAgo(1);
  const today = isoDaysAgo(0);
  const lotId = id("lot");

  db.prepare(`
    INSERT INTO equities (ticker, name, currency, status, created_at, updated_at)
    VALUES ('SALE', 'Sale Flow Test', 'USD', 'ACTIVE', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, created_at, updated_at
    )
    VALUES (?, ?, 'SALE', 100, 50, 10, 'USD', ?, 'test', ?, ?)
  `).run(lotId, user.id, buyDate, now, now);
  db.prepare(`
    INSERT INTO realized_lots (
      id, user_id, ticker, lot_id, quantity, sale_price, sale_currency, sold_at,
      cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
      source, buy_price, buy_currency, bought_at, notes, created_at
    )
    VALUES (?, ?, 'SALE', ?, 50, 20, 'USD', ?, 500, 1000, 500, 100,
      'test', 10, 'USD', ?, 'partial sale', ?)
  `).run(id("realized"), user.id, lotId, saleDate, buyDate, now);
  db.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, 'USD', 1000, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(id("cash"), user.id, now);

  const insertPrice = db.prepare(`
    INSERT INTO historical_prices (ticker, price_date, close, currency, provider, updated_at)
    VALUES ('SALE', ?, ?, 'USD', 'test', ?)
  `);
  insertPrice.run(buyDate, 10, now);
  insertPrice.run(saleDate, 20, now);
  insertPrice.run(today, 30, now);

  const performance = await portfolioPerformance(user.id, "1mo");
  assert.equal(performance.points.length >= 28, true);
  assert.equal(performance.startValue, 1000);
  assert.equal(performance.points[0].cashValueBase, 0);

  const salePoint = performance.points.find((point) => point.date === saleDate);
  assert.ok(salePoint);
  assert.equal(salePoint.cashValueBase, 1000);
  assert.equal(salePoint.holdingsMarketValueBase, 1000);
  assert.equal(salePoint.rawValue, 2000);

  assert.equal(performance.cashFlowDiagnostics.saleProceedsIncludedBase, 1000);
  assert.equal(performance.dataQuality.cashReconciled, true);
});
