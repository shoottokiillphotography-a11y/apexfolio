import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("transaction wealth modes work without historical market prices", async () => {
  const databasePath = `/private/tmp/apexfolio-portfolio-wealth-${Date.now()}.sqlite`;
  process.env.DATABASE_PATH = databasePath;
  process.env.BASE_CURRENCY = "AUD";
  process.env.DEFAULT_USER_EMAIL = "portfolio-wealth-test@example.com";

  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });

  const { getDb } = await import("../src/db.js");
  const {
    createManualPortfolioSnapshot,
    deletePortfolioSnapshot,
    portfolioWealthTimeline,
    saveAutomaticPortfolioSnapshot,
    saveOpeningPortfolioBalance,
    updateManualPortfolioSnapshot
  } = await import("../src/services/portfolio-wealth.js");

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
  `).run("lot_tst_1", userId, "TST", 10, 0, 100, "AUD", "2025-01-01", "test", "buy1", "Closed test lot", now, now);

  database.prepare(`
    INSERT INTO realized_lots (
      id, user_id, ticker, lot_id, quantity, sale_price, sale_currency,
      sold_at, cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
      source, source_event_id, buy_price, buy_currency, bought_at, notes, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("sale_tst_1", userId, "TST", "lot_tst_1", 10, 150, "AUD", "2025-02-01", 1000, 1500, 500, 50, "test", "sell1", 100, "AUD", "2025-01-01", "Full exit", now);

  database.prepare(`
    INSERT INTO dividend_payments (
      id, user_id, ticker, ex_date, pay_date, record_date, amount_per_share,
      currency, eligible_quantity, gross_amount, gross_amount_base, source,
      source_event_id, payload_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("div_tst_1", userId, "TST", "2025-01-10", "2025-01-15", "2025-01-11", 2, "AUD", 10, 20, 20, "test", "div1", "{}", now, now);

  const insertExternal = database.prepare(`
    INSERT INTO external_income_events (
      id, user_id, event_type, event_date, category, source_description,
      gross_amount, currency, fees_tax, net_amount, recurring, add_to_cash,
      cash_applied_amount, cash_applied_currency, converted_amount_base,
      converted_currency, conversion_date, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertExternal.run("income_cash_1", userId, "INCOME", "2025-01-20", "External Income", "Cash rent", 200, "AUD", 0, 200, 0, 1, 200, "AUD", 200, "AUD", "2025-01-20", "Add to cash", now, now);
  insertExternal.run("income_not_cash_1", userId, "INCOME", "2025-01-21", "External Income", "Reported rent", 999, "AUD", 0, 999, 0, 0, 0, "AUD", 999, "AUD", "2025-01-21", "Do not add to cash", now, now);
  insertExternal.run("expense_1", userId, "EXPENSE", "2025-01-22", "External Expense", "Property cost", 100, "AUD", 0, -100, 0, 0, 0, "AUD", -100, "AUD", "2025-01-22", "Do not add to cash", now, now);

  database.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET
      amount = excluded.amount,
      updated_at = excluded.updated_at
  `).run("cash_aud", userId, "AUD", 1720, now);

  await saveOpeningPortfolioBalance(userId, {
    amount: 1000,
    currency: "AUD",
    date: "2025-01-01",
    notes: "Seed capital"
  });

  const timeline = await portfolioWealthTimeline(userId, { range: "all" });
  assert.equal(timeline.firstInvestmentDate, "2025-01-01");
  assert.equal(timeline.dataQuality.usesHistoricalCloses, false);
  assert.equal(timeline.dataQuality.noFakeHistoricalPrices, true);
  assert.equal(timeline.recommendedMode, "realized_growth");

  assert.equal(timeline.realizedGrowth.points[0].date, "2025-01-01");
  assert.equal(timeline.realizedGrowth.points[0].cumulativeRealizedBase, 0);
  assert.equal(timeline.realizedGrowth.points.at(-1).cumulativeRealizedBase, 1619);
  assert.equal(timeline.summary.netRealizedPnlBase, 500);
  assert.equal(timeline.summary.dividendsBase, 20);
  assert.equal(timeline.summary.externalIncomeBase, 1199);
  assert.equal(timeline.summary.externalExpensesBase, -100);

  const salePoint = timeline.realizedGrowth.points.find((point) => point.date === "2025-02-01");
  assert.equal(salePoint.eventAmountBase, 500);
  assert.equal(salePoint.events.some((event) => event.type === "share_sale"), true);

  const finalBookPoint = timeline.bookValue.points.at(-1);
  assert.equal(finalBookPoint.remainingCostBasisBase, 0);
  assert.equal(finalBookPoint.cashValueBase, 1720);
  assert.equal(finalBookPoint.bookValueBase, 1720);
  assert.equal(finalBookPoint.netCapitalContributedBase, 1000);
  assert.equal(timeline.bookValue.summary.cashReconciliationBase, 0);

  const manual = await createManualPortfolioSnapshot(userId, {
    date: "2025-01-31",
    holdingsValue: 1200,
    cashValue: 220,
    currency: "AUD",
    source: "January broker statement",
    notes: "Manual test snapshot"
  });
  let withManual = await portfolioWealthTimeline(userId, { range: "all" });
  assert.equal(withManual.actualPortfolioValue.points.length, 1);
  assert.equal(withManual.actualPortfolioValue.points[0].manual, true);
  assert.equal(withManual.actualPortfolioValue.points[0].totalValueBase, 1420);

  await updateManualPortfolioSnapshot(userId, manual.snapshot.id, {
    date: "2025-01-31",
    holdingsValue: 1300,
    cashValue: 220,
    currency: "AUD",
    source: "January broker statement corrected",
    notes: "Corrected"
  });
  withManual = await portfolioWealthTimeline(userId, { range: "all" });
  assert.equal(withManual.actualPortfolioValue.points[0].totalValueBase, 1520);
  assert.equal(withManual.actualPortfolioValue.points[0].source, "January broker statement corrected");

  await deletePortfolioSnapshot(userId, manual.snapshot.id);
  let afterDelete = await portfolioWealthTimeline(userId, { range: "all" });
  assert.equal(afterDelete.actualPortfolioValue.points.length, 0);

  const autoSnapshot = saveAutomaticPortfolioSnapshot(userId, {
    summary: {
      totalValueBase: 1720,
      cashAvailableBase: 1720
    },
    positions: []
  });
  assert.equal(autoSnapshot.manual, false);
  afterDelete = await portfolioWealthTimeline(userId, { range: "all" });
  assert.equal(afterDelete.actualPortfolioValue.points.length, 1);
  assert.equal(afterDelete.actualPortfolioValue.points[0].totalValueBase, 1720);
});
