import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-sales-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.BASE_CURRENCY = "USD";
process.env.DEFAULT_USER_EMAIL = "test@example.com";

const { getDb, getPrimaryUser } = await import("../src/db.js");
const {
  calculatePortfolio,
  deleteExternalClosedTransaction,
  recordExternalClosedTransaction,
  recordSale
} = await import("../src/services/calculations.js");
const { id, nowIso } = await import("../src/utils.js");

test("recordSale calculates FIFO realized gains accurately", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const category = db.prepare("SELECT id FROM categories WHERE id = 'cat_ai_infrastructure'").get();
  db.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES ('NVDA', 'NVIDIA', 'USD', ?, 'ACTIVE', ?, ?)
  `).run(category.id, nowIso(), nowIso());
  db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, created_at, updated_at
    )
    VALUES (?, ?, 'NVDA', 10, 10, 100, 'USD', '2024-01-01', 'test', ?, ?)
  `).run(id("lot"), user.id, nowIso(), nowIso());

  const result = await recordSale(user.id, {
    ticker: "NVDA",
    quantity: 4,
    salePrice: 125,
    saleCurrency: "USD",
    soldAt: "2024-03-01"
  });

  assert.equal(result.realizedGainLossBase, 100);
  assert.equal(result.matches, 1);
  const remaining = db.prepare("SELECT quantity FROM holding_lots WHERE ticker = 'NVDA'").get();
  assert.equal(remaining.quantity, 6);
  const realized = db.prepare(`
    SELECT buy_price AS buyPrice, buy_currency AS buyCurrency, bought_at AS boughtAt, source
    FROM realized_lots
    WHERE ticker = 'NVDA'
  `).get();
  assert.deepEqual({ ...realized }, {
    buyPrice: 100,
    buyCurrency: "USD",
    boughtAt: "2024-01-01",
    source: "manual"
  });
});

test("recordSale can sell a partial quantity from a selected lot", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const category = db.prepare("SELECT id FROM categories WHERE id = 'cat_ai_infrastructure'").get();
  db.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES ('LOTX', 'Lot Example', 'USD', ?, 'ACTIVE', ?, ?)
  `).run(category.id, nowIso(), nowIso());
  const firstLotId = id("lot");
  const secondLotId = id("lot");
  const insertLot = db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, created_at, updated_at
    )
    VALUES (?, ?, 'LOTX', 10, 10, ?, 'USD', ?, 'test', ?, ?)
  `);
  insertLot.run(firstLotId, user.id, 100, "2024-01-01", nowIso(), nowIso());
  insertLot.run(secondLotId, user.id, 200, "2024-02-01", nowIso(), nowIso());

  const result = await recordSale(user.id, {
    ticker: "LOTX",
    lotId: secondLotId,
    quantity: 4,
    salePrice: 250,
    saleCurrency: "USD",
    soldAt: "2024-04-01"
  });

  assert.equal(result.realizedGainLossBase, 200);
  assert.equal(result.matches, 1);
  assert.equal(result.saleMethod, "SPECIFIC_LOT");

  const lots = db.prepare("SELECT id, quantity FROM holding_lots WHERE ticker = 'LOTX' ORDER BY purchase_date").all();
  assert.deepEqual(lots.map((lot) => [lot.id, lot.quantity]), [
    [firstLotId, 10],
    [secondLotId, 6]
  ]);
  const realized = db.prepare("SELECT lot_id, cost_basis_base, proceeds_base, gain_loss_base FROM realized_lots WHERE ticker = 'LOTX'").get();
  assert.equal(realized.lot_id, secondLotId);
  assert.equal(realized.cost_basis_base, 800);
  assert.equal(realized.proceeds_base, 1000);
  assert.equal(realized.gain_loss_base, 200);
});

test("fully sold positions remain visible through realized history", async () => {
  const db = getDb();
  const user = getPrimaryUser();
  const category = db.prepare("SELECT id FROM categories WHERE id = 'cat_speculative'").get();
  db.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES ('XYZ', 'Example', 'USD', ?, 'ACTIVE', ?, ?)
  `).run(category.id, nowIso(), nowIso());
  db.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, created_at, updated_at
    )
    VALUES (?, ?, 'XYZ', 5, 5, 10, 'USD', '2024-01-01', 'test', ?, ?)
  `).run(id("lot"), user.id, nowIso(), nowIso());

  await recordSale(user.id, {
    ticker: "XYZ",
    quantity: 5,
    salePrice: 12,
    saleCurrency: "USD",
    soldAt: "2024-04-01"
  });

  const dashboard = await calculatePortfolio(user.id);
  const closed = dashboard.positions.find((position) => position.ticker === "XYZ");
  assert.equal(closed.quantity, 0);
  assert.equal(closed.closed, true);
  assert.equal(closed.realizedGainLossBase, 10);
  assert.equal(closed.lots.length, 1);
  assert.equal(closed.lots[0].quantity, 0);
  assert.equal(closed.lots[0].originalQuantity, 5);
  assert.equal(closed.lots[0].soldQuantity, 5);
  assert.equal(closed.lots[0].sales.length, 1);
  assert.equal(closed.lots[0].sales[0].quantity, 5);
  assert.equal(dashboard.summary.realizedGainLossBase >= 10, true);
});

test("outside broker closed transactions add to realized gains", async () => {
  const user = getPrimaryUser();
  const result = await recordExternalClosedTransaction(user.id, {
    ticker: "EXTX",
    quantity: 10,
    buyDate: "2024-01-05",
    buyPrice: 100,
    buyCurrency: "USD",
    sellDate: "2024-06-05",
    salePrice: 130,
    saleCurrency: "USD",
    notes: "Outside broker"
  });

  assert.equal(result.gainLossBase, 300);
  const dashboard = await calculatePortfolio(user.id);
  const external = dashboard.externalTransactions.find((item) => item.id === result.id);
  const closed = dashboard.positions.find((position) => position.ticker === "EXTX");
  assert.equal(external.gainLossBase, 300);
  assert.equal(closed.quantity, 0);
  assert.equal(closed.realizedGainLossBase, 300);

  deleteExternalClosedTransaction(user.id, result.id);
  const afterDelete = await calculatePortfolio(user.id);
  assert.equal(afterDelete.externalTransactions.some((item) => item.id === result.id), false);
});
