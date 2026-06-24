import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("realized income timeline keeps manual external income separate and cash-safe", async () => {
  const databasePath = `/private/tmp/apexfolio-realized-income-${Date.now()}.sqlite`;
  process.env.DATABASE_PATH = databasePath;
  process.env.BASE_CURRENCY = "AUD";
  process.env.DEFAULT_USER_EMAIL = "realized-income-test@example.com";

  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });

  const { getDb } = await import("../src/db.js");
  const {
    createExternalIncomeEvent,
    deleteExternalIncomeEvent,
    realizedIncomeTimeline,
    updateExternalIncomeEvent
  } = await import("../src/services/realized-income.js");

  const database = getDb();
  const userId = "primary-user";
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO equities (ticker, name, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("TST", "Test Equity", "AUD", now, now);

  database.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, source_event_id, notes,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("lot_test_1", userId, "TST", 10, 0, 100, "AUD", "2025-01-05", "test", "buy1", "Closed test lot", now, now);

  database.prepare(`
    INSERT INTO realized_lots (
      id, user_id, ticker, lot_id, quantity, sale_price, sale_currency,
      sold_at, cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
      source, source_event_id, buy_price, buy_currency, bought_at, notes, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("realized_test_1", userId, "TST", "lot_test_1", 10, 140, "AUD", "2025-06-01", 1000, 1400, 400, 40, "manual", "sell1", 100, "AUD", "2025-01-05", "Test sale", now);

  database.prepare(`
    INSERT INTO dividend_payments (
      id, user_id, ticker, ex_date, pay_date, record_date, amount_per_share,
      currency, eligible_quantity, gross_amount, gross_amount_base, source,
      source_event_id, payload_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("div_test_1", userId, "TST", "2025-07-01", "2025-07-15", "2025-07-03", 2, "AUD", 10, 20, 20, "netwealth", "div1", "{}", now, now);

  const income = await createExternalIncomeEvent(userId, {
    type: "INCOME",
    date: "2025-08-01",
    category: "Rental Income",
    description: "Test property rent",
    amount: 1000,
    currency: "AUD",
    feesTax: 100,
    addToCash: true
  });
  await createExternalIncomeEvent(userId, {
    type: "EXPENSE",
    date: "2025-08-02",
    category: "External Expense",
    description: "Test property repair",
    amount: 250,
    currency: "AUD"
  });

  assert.equal(database.prepare("SELECT amount FROM cash_balances WHERE user_id = ? AND currency = 'AUD'").get(userId).amount, 900);

  await updateExternalIncomeEvent(userId, income.id, {
    type: "INCOME",
    date: "2025-08-01",
    category: "Rental Income",
    description: "Test property rent revised",
    amount: 1200,
    currency: "AUD",
    feesTax: 100,
    addToCash: true
  });
  assert.equal(database.prepare("SELECT amount FROM cash_balances WHERE user_id = ? AND currency = 'AUD'").get(userId).amount, 1100);

  const timelineWithIncome = await realizedIncomeTimeline(userId, { range: "all", filter: "all" });
  assert.equal(timelineWithIncome.summary.realizedShareGainsBase, 400);
  assert.equal(timelineWithIncome.summary.dividendsReceivedBase, 20);
  assert.equal(timelineWithIncome.summary.externalIncomeBase, 1100);
  assert.equal(timelineWithIncome.summary.externalExpensesBase, -250);
  assert.equal(timelineWithIncome.summary.totalNetIncomeBase, 1270);

  await deleteExternalIncomeEvent(userId, income.id);
  assert.equal(database.prepare("SELECT amount FROM cash_balances WHERE user_id = ? AND currency = 'AUD'").get(userId).amount, 0);

  const timelineAfterDelete = await realizedIncomeTimeline(userId, { range: "all", filter: "all" });
  const counts = timelineAfterDelete.events.reduce((acc, event) => {
    acc[event.transactionType] = (acc[event.transactionType] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { share_sale: 1, dividend: 1, external_expense: 1 });
});
