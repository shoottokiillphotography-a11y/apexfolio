import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-netwealth-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.BASE_CURRENCY = "AUD";
process.env.DEFAULT_USER_EMAIL = "test@example.com";

const { getDb, getPrimaryUser } = await import("../src/db.js");
const { importFile } = await import("../src/services/importer.js");
const { calculatePortfolio } = await import("../src/services/calculations.js");
const { nowIso } = await import("../src/utils.js");

test("Netwealth cash transaction listing imports buys, sells, dividends, and cash", async () => {
  const csv = [
    "Cash Transaction Listing - Detail",
    "",
    "\"Cash Balance\",\"1234.56\"",
    "",
    "Cash transactions",
    "\"Effective Date\",\"Description\",\"EFTReference\",\"Narration\",\"Employer\",\"Asset\",\"Code\",\"Units\",\"Debits\",\"Credits\",\"Cash balance\",\"Purchase price\",\"Sale price\",\"TransactionListing Summary Group\",\"Processed Date\"",
    "\"03/01/2026\",\"Distribution\",\"\",\"\",\"\",\"Magellan Financial Group Ltd\",\"MFG\",\"0.000000\",\"0\",\"12.00\",\"1234.56\",\"0\",\"0\",\"Distributions (inc dividends)\",\"04/01/2026\"",
    "\"02/01/2026\",\"Asset Sale\",\"\",\"\",\"\",\"Magellan Financial Group Ltd\",\"MFG\",\"-40.000000\",\"0\",\"520.00\",\"1222.56\",\"0\",\"13.00\",\"Asset Sales\",\"02/01/2026\"",
    "\"01/01/2026\",\"Asset Purchase\",\"\",\"\",\"\",\"Magellan Financial Group Ltd\",\"MFG\",\"100.000000\",\"1000.00\",\"0\",\"702.56\",\"10.00\",\"0\",\"Asset Purchases\",\"01/01/2026\""
  ].join("\n");

  const db = getDb();
  const user = getPrimaryUser();
  const result = await importFile({
    userId: user.id,
    filename: "CashTransactionListingDetail.csv",
    buffer: Buffer.from(csv),
    kind: "auto",
    replace: true
  });

  assert.equal(result.kind, "netwealth_transactions");
  assert.equal(result.details.purchasesCreated, 1);
  assert.equal(result.details.salesCreated, 1);
  assert.equal(result.details.dividendsCreated, 1);
  assert.equal(result.errorCount, 0);

  const lot = db.prepare("SELECT ticker, quantity, purchase_price, purchase_currency FROM holding_lots").get();
  assert.deepEqual({ ...lot }, {
    ticker: "MFG.AX",
    quantity: 60,
    purchase_price: 10,
    purchase_currency: "AUD"
  });

  const realized = db.prepare(`
    SELECT quantity, cost_basis_base, proceeds_base, gain_loss_base,
      buy_price, buy_currency, bought_at, source
    FROM realized_lots
  `).get();
  assert.deepEqual({ ...realized }, {
    quantity: 40,
    cost_basis_base: 400,
    proceeds_base: 520,
    gain_loss_base: 120,
    buy_price: 10,
    buy_currency: "AUD",
    bought_at: "2026-01-01",
    source: "netwealth"
  });

  const dividend = db.prepare("SELECT ticker, gross_amount, gross_amount_base, source FROM dividend_payments").get();
  assert.deepEqual({ ...dividend }, {
    ticker: "MFG.AX",
    gross_amount: 12,
    gross_amount_base: 12,
    source: "netwealth"
  });

  const cash = db.prepare("SELECT currency, amount FROM cash_balances WHERE currency = 'AUD'").get();
  assert.deepEqual({ ...cash }, { currency: "AUD", amount: 1234.56 });

  db.prepare(`
    INSERT INTO market_prices (ticker, price, currency, previous_close, provider, status, as_of)
    VALUES ('MFG.AX', 14, 'AUD', 13.5, 'test', 'LIVE', ?)
    ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, as_of = excluded.as_of
  `).run(nowIso());
  const dashboard = await calculatePortfolio(user.id);
  const position = dashboard.positions.find((item) => item.ticker === "MFG.AX");
  assert.equal(position.quantity, 60);
  assert.equal(position.lots.length, 1);
  assert.equal(position.lots[0].originalQuantity, 100);
  assert.equal(position.lots[0].quantity, 60);
  assert.equal(position.lots[0].soldQuantity, 40);
  assert.equal(position.lots[0].sales.length, 1);
  assert.equal(position.lots[0].sales[0].quantity, 40);
});

test("Netwealth fully sold lots remain visible with sale history", async () => {
  const csv = [
    "Cash Transaction Listing - Detail",
    "",
    "\"Cash Balance\",\"2000.00\"",
    "",
    "Cash transactions",
    "\"Effective Date\",\"Description\",\"EFTReference\",\"Narration\",\"Employer\",\"Asset\",\"Code\",\"Units\",\"Debits\",\"Credits\",\"Cash balance\",\"Purchase price\",\"Sale price\",\"TransactionListing Summary Group\",\"Processed Date\"",
    "\"05/01/2026\",\"Asset Sale\",\"\",\"\",\"\",\"Magellan Financial Group Ltd\",\"MFG\",\"-20.000000\",\"0\",\"300.00\",\"2000.00\",\"0\",\"15.00\",\"Asset Sales\",\"05/01/2026\"",
    "\"01/01/2026\",\"Asset Purchase\",\"\",\"\",\"\",\"Magellan Financial Group Ltd\",\"MFG\",\"20.000000\",\"200.00\",\"0\",\"1700.00\",\"10.00\",\"0\",\"Asset Purchases\",\"01/01/2026\""
  ].join("\n");

  const user = getPrimaryUser();
  const result = await importFile({
    userId: user.id,
    filename: "CashTransactionListingDetail-full-sale.csv",
    buffer: Buffer.from(csv),
    kind: "auto",
    replace: true
  });

  assert.equal(result.kind, "netwealth_transactions");
  assert.equal(result.details.purchasesCreated, 1);
  assert.equal(result.details.salesCreated, 1);
  assert.equal(result.errorCount, 0);

  const dashboard = await calculatePortfolio(user.id);
  const position = dashboard.positions.find((item) => item.ticker === "MFG.AX");
  assert.equal(position.closed, true);
  assert.equal(position.quantity, 0);
  assert.equal(position.realizedGainLossBase, 100);
  assert.equal(position.lots.length, 1);
  assert.equal(position.lots[0].quantity, 0);
  assert.equal(position.lots[0].originalQuantity, 20);
  assert.equal(position.lots[0].soldQuantity, 20);
  assert.equal(position.lots[0].sales.length, 1);
  assert.equal(position.lots[0].sales[0].quantity, 20);
});
