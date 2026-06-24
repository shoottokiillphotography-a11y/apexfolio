import { getDb, transaction } from "../db.js";
import {
  assertFxCurrency,
  id,
  InputError,
  nowIso,
  roundMoney,
  roundPercent,
  roundShares,
  toNumber
} from "../utils.js";
import { convertAmount } from "./currency.js";

const EVENT_FILTERS = new Set(["all", "sales", "dividends", "external_income", "external_expense"]);
const RANGE_FILTERS = new Set(["month", "ytd", "1y", "3y", "5y", "all"]);

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}

function normalizeDate(input, field = "Date") {
  const value = String(input || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError(`${field} is required`);
  return value;
}

function normalizeType(input, amount) {
  const raw = String(input || "").trim().toUpperCase();
  if (raw === "EXPENSE") return "EXPENSE";
  if (raw === "INCOME") return "INCOME";
  return Number(amount) < 0 ? "EXPENSE" : "INCOME";
}

function netAmountFor(type, amountInput, feesTaxInput, netInput) {
  const amount = toNumber(amountInput, null);
  const feesTax = Math.abs(toNumber(feesTaxInput, 0) || 0);
  if (amount == null || amount === 0) throw new InputError("Amount is required");
  const explicitNet = toNumber(netInput, null);
  if (explicitNet != null && explicitNet !== 0) return { grossAmount: Math.abs(amount), feesTax, netAmount: explicitNet };
  const grossAmount = Math.abs(amount);
  const netAmount = type === "EXPENSE" ? -(grossAmount + feesTax) : grossAmount - feesTax;
  return { grossAmount, feesTax, netAmount };
}

async function conversionFor(amount, currency, baseCurrency) {
  try {
    const converted = await convertAmount(amount, currency, baseCurrency);
    return {
      convertedAmountBase: roundMoney(converted.amount),
      convertedCurrency: baseCurrency,
      fxRate: converted.rate,
      conversionDate: nowIso(),
      conversionError: converted.error || null
    };
  } catch (error) {
    return {
      convertedAmountBase: null,
      convertedCurrency: baseCurrency,
      fxRate: null,
      conversionDate: nowIso(),
      conversionError: error.message
    };
  }
}

function adjustCash(tx, userId, currency, delta) {
  if (!currency || !Number.isFinite(Number(delta)) || Math.abs(Number(delta)) < 0.000001) return;
  const now = nowIso();
  tx.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET
      amount = cash_balances.amount + excluded.amount,
      updated_at = excluded.updated_at
  `).run(id("cash"), userId, currency, Number(delta), now);
}

function externalPayload(input = {}, userBaseCurrency = "AUD") {
  const eventDate = normalizeDate(input.date || input.eventDate, "External income date");
  const type = normalizeType(input.type || input.eventType, input.amount);
  const currency = assertFxCurrency(input.currency || userBaseCurrency);
  const { grossAmount, feesTax, netAmount } = netAmountFor(type, input.amount ?? input.grossAmount, input.feesTax ?? input.fees ?? input.tax, input.netAmount);
  const category = String(input.category || (type === "EXPENSE" ? "External Expense" : "Other Income")).trim();
  const sourceDescription = String(input.description || input.sourceDescription || input.source || "").trim();
  if (!sourceDescription) throw new InputError("Description or source is required");
  return {
    eventType: type,
    eventDate,
    category,
    sourceDescription,
    propertyAccount: String(input.propertyAccount || input.account || "").trim() || null,
    grossAmount,
    currency,
    feesTax,
    netAmount,
    recurring: input.recurring === true || input.recurring === "true" || input.recurring === "1" ? 1 : 0,
    addToCash: input.addToCash === true || input.addToCash === "true" || input.addToCash === "1" ? 1 : 0,
    notes: String(input.notes || "").trim() || null
  };
}

function currentUser(database, userId) {
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new InputError("User not found", 404);
  return user;
}

export async function createExternalIncomeEvent(userId, input = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const payload = externalPayload(input, user.base_currency);
  const conversion = await conversionFor(payload.netAmount, payload.currency, user.base_currency);
  const eventId = id("income");
  const now = nowIso();

  transaction((tx) => {
    tx.prepare(`
      INSERT INTO external_income_events (
        id, user_id, event_type, event_date, category, source_description,
        property_account, gross_amount, currency, fees_tax, net_amount,
        recurring, add_to_cash, cash_applied_amount, cash_applied_currency,
        converted_amount_base, converted_currency, fx_rate, conversion_date,
        conversion_error, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      userId,
      payload.eventType,
      payload.eventDate,
      payload.category,
      payload.sourceDescription,
      payload.propertyAccount,
      payload.grossAmount,
      payload.currency,
      payload.feesTax,
      payload.netAmount,
      payload.recurring,
      payload.addToCash,
      payload.addToCash ? payload.netAmount : 0,
      payload.addToCash ? payload.currency : null,
      conversion.convertedAmountBase,
      conversion.convertedCurrency,
      conversion.fxRate,
      conversion.conversionDate,
      conversion.conversionError,
      payload.notes,
      now,
      now
    );
    if (payload.addToCash) adjustCash(tx, userId, payload.currency, payload.netAmount);
  });

  return { id: eventId, cashUpdated: Boolean(payload.addToCash), conversionError: conversion.conversionError };
}

export async function updateExternalIncomeEvent(userId, eventId, input = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const existing = database.prepare("SELECT * FROM external_income_events WHERE id = ? AND user_id = ?").get(eventId, userId);
  if (!existing) throw new InputError("External income entry not found", 404);
  const payload = externalPayload(input, user.base_currency);
  const conversion = await conversionFor(payload.netAmount, payload.currency, user.base_currency);
  const now = nowIso();

  transaction((tx) => {
    if (Number(existing.cash_applied_amount) !== 0 && existing.cash_applied_currency) {
      adjustCash(tx, userId, existing.cash_applied_currency, -Number(existing.cash_applied_amount));
    }
    tx.prepare(`
      UPDATE external_income_events
      SET event_type = ?, event_date = ?, category = ?, source_description = ?,
        property_account = ?, gross_amount = ?, currency = ?, fees_tax = ?,
        net_amount = ?, recurring = ?, add_to_cash = ?, cash_applied_amount = ?,
        cash_applied_currency = ?, converted_amount_base = ?, converted_currency = ?,
        fx_rate = ?, conversion_date = ?, conversion_error = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      payload.eventType,
      payload.eventDate,
      payload.category,
      payload.sourceDescription,
      payload.propertyAccount,
      payload.grossAmount,
      payload.currency,
      payload.feesTax,
      payload.netAmount,
      payload.recurring,
      payload.addToCash,
      payload.addToCash ? payload.netAmount : 0,
      payload.addToCash ? payload.currency : null,
      conversion.convertedAmountBase,
      conversion.convertedCurrency,
      conversion.fxRate,
      conversion.conversionDate,
      conversion.conversionError,
      payload.notes,
      now,
      eventId,
      userId
    );
    if (payload.addToCash) adjustCash(tx, userId, payload.currency, payload.netAmount);
  });

  return { ok: true, cashUpdated: Boolean(payload.addToCash || Number(existing.cash_applied_amount)), conversionError: conversion.conversionError };
}

export function deleteExternalIncomeEvent(userId, eventId) {
  const database = getDb();
  const existing = database.prepare("SELECT * FROM external_income_events WHERE id = ? AND user_id = ?").get(eventId, userId);
  if (!existing) throw new InputError("External income entry not found", 404);
  transaction((tx) => {
    if (Number(existing.cash_applied_amount) !== 0 && existing.cash_applied_currency) {
      adjustCash(tx, userId, existing.cash_applied_currency, -Number(existing.cash_applied_amount));
    }
    tx.prepare("DELETE FROM external_income_events WHERE id = ? AND user_id = ?").run(eventId, userId);
  });
  return { ok: true, cashAdjusted: Number(existing.cash_applied_amount) !== 0 };
}

function rangeStart(range) {
  const now = new Date();
  const value = String(range || "all").toLowerCase();
  if (value === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (value === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10);
  const years = value === "1y" ? 1 : value === "3y" ? 3 : value === "5y" ? 5 : null;
  if (!years) return null;
  const start = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return start.toISOString().slice(0, 10);
}

function baseEvent(row, eventType, transactionType, amountBase, amountOriginal, currency, details = {}) {
  return {
    id: row.id,
    eventType,
    transactionType,
    date: row.date,
    ticker: row.ticker || null,
    source: row.source || row.ticker || null,
    amountOriginal: roundMoney(amountOriginal),
    currency,
    amountBase: amountBase == null ? null : roundMoney(amountBase),
    baseCurrency: row.baseCurrency,
    positive: Number(amountOriginal) >= 0,
    conversionUnavailable: amountBase == null,
    details
  };
}

async function saleEvents(database, user, fxWarnings) {
  const rows = database.prepare(`
    SELECT r.id, r.ticker, r.quantity, r.sale_price, r.sale_currency,
      r.sold_at AS date, r.cost_basis_base, r.proceeds_base, r.gain_loss_base,
      r.gain_loss_percent, r.source, r.notes, r.lot_id, r.buy_price, r.buy_currency,
      r.bought_at, l.purchase_price AS lot_purchase_price, l.purchase_currency AS lot_purchase_currency,
      l.purchase_date AS lot_purchase_date
    FROM realized_lots r
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ?
    ORDER BY r.sold_at, r.created_at
  `).all(user.id);
  return rows.map((row) => {
    const gain = Number(row.gain_loss_base) || 0;
    return baseEvent(
      { ...row, baseCurrency: user.base_currency, source: row.source === "external" ? "External closed trade" : "Share sale" },
      gain >= 0 ? "gain" : "loss",
      "share_sale",
      gain,
      gain,
      user.base_currency,
      {
        ticker: row.ticker,
        quantity: roundShares(row.quantity),
        salePrice: row.sale_price,
        saleCurrency: row.sale_currency,
        costBasisBase: roundMoney(row.cost_basis_base),
        proceedsBase: roundMoney(row.proceeds_base),
        gainLossBase: roundMoney(row.gain_loss_base),
        gainLossPercent: roundPercent(row.gain_loss_percent),
        fees: 0,
        taxes: 0,
        lotId: row.lot_id,
        originalLotCost: row.lot_purchase_price ?? row.buy_price,
        originalLotCurrency: row.lot_purchase_currency ?? row.buy_currency,
        originalLotDate: row.lot_purchase_date ?? row.bought_at,
        notes: row.notes,
        accounting: "Realized P&L = sale proceeds - actual sold-lot cost basis. Fees/taxes are shown as 0 unless recorded."
      }
    );
  });
}

async function dividendEvents(database, user) {
  const rows = database.prepare(`
    SELECT id, ticker, COALESCE(pay_date, ex_date) AS date, ex_date, pay_date,
      amount_per_share, currency, eligible_quantity, gross_amount, gross_amount_base,
      source, source_event_id, payload_json
    FROM dividend_payments
    WHERE user_id = ?
    ORDER BY COALESCE(pay_date, ex_date), created_at
  `).all(user.id);
  return rows.map((row) => baseEvent(
    { ...row, baseCurrency: user.base_currency, source: row.ticker },
    "income",
    "dividend",
    Number(row.gross_amount_base) || 0,
    Number(row.gross_amount) || 0,
    row.currency,
    {
      ticker: row.ticker,
      grossDividend: row.gross_amount,
      withholdingTax: 0,
      fees: 0,
      netDividend: row.gross_amount,
      amountPerShare: row.amount_per_share,
      eligibleQuantity: roundShares(row.eligible_quantity),
      exDate: row.ex_date,
      payDate: row.pay_date,
      source: row.source,
      sourceEventId: row.source_event_id
    }
  ));
}

async function externalEvents(database, user) {
  const rows = database.prepare(`
    SELECT *
    FROM external_income_events
    WHERE user_id = ?
    ORDER BY event_date, created_at
  `).all(user.id);
  return Promise.all(rows.map(async (row) => {
    let converted = null;
    let conversionUnavailable = false;
    try {
      converted = await convertAmount(row.net_amount, row.currency, user.base_currency);
    } catch {
      conversionUnavailable = true;
    }
    const amountBase = converted?.amount ?? row.converted_amount_base ?? null;
    const type = row.event_type === "EXPENSE" || Number(row.net_amount) < 0 ? "external_expense" : "external_income";
    const event = baseEvent(
      {
        id: row.id,
        date: row.event_date,
        source: row.source_description,
        baseCurrency: user.base_currency
      },
      type === "external_expense" ? "expense" : "income",
      type,
      amountBase,
      Number(row.net_amount) || 0,
      row.currency,
      {
        category: row.category,
        description: row.source_description,
        grossAmount: row.gross_amount,
        feesTax: row.fees_tax,
        netAmount: row.net_amount,
        recurring: Boolean(row.recurring),
        propertyAccount: row.property_account,
        addToCash: Boolean(row.add_to_cash),
        cashAppliedAmount: row.cash_applied_amount,
        notes: row.notes,
        fxRate: converted?.rate ?? row.fx_rate,
        conversionDate: row.conversion_date,
        conversionError: conversionUnavailable ? `FX unavailable for ${row.currency}/${user.base_currency}` : row.conversion_error
      }
    );
    event.conversionUnavailable = event.amountBase == null;
    return event;
  }));
}

function periodAndTypeFilter(events, range, filter) {
  const start = rangeStart(range);
  return events.filter((event) => {
    if (start && event.date < start) return false;
    if (filter === "sales") return event.transactionType === "share_sale";
    if (filter === "dividends") return event.transactionType === "dividend";
    if (filter === "external_income") return event.transactionType === "external_income";
    if (filter === "external_expense") return event.transactionType === "external_expense";
    return true;
  });
}

function summaryFor(events) {
  const shareGains = events.filter((e) => e.transactionType === "share_sale" && Number(e.amountBase) > 0);
  const shareLosses = events.filter((e) => e.transactionType === "share_sale" && Number(e.amountBase) < 0);
  const dividends = events.filter((e) => e.transactionType === "dividend");
  const externalIncome = events.filter((e) => e.transactionType === "external_income");
  const externalExpenses = events.filter((e) => e.transactionType === "external_expense");
  const realizedShareGainsBase = roundMoney(sum(shareGains.map((e) => e.amountBase)));
  const realizedShareLossesBase = roundMoney(sum(shareLosses.map((e) => e.amountBase)));
  const dividendsReceivedBase = roundMoney(sum(dividends.map((e) => e.amountBase)));
  const externalIncomeBase = roundMoney(sum(externalIncome.map((e) => e.amountBase)));
  const externalExpensesBase = roundMoney(sum(externalExpenses.map((e) => e.amountBase)));
  return {
    realizedShareGainsBase,
    realizedShareLossesBase,
    netRealizedPnlBase: roundMoney(realizedShareGainsBase + realizedShareLossesBase),
    dividendsReceivedBase,
    externalIncomeBase,
    externalExpensesBase,
    totalNetIncomeBase: roundMoney(realizedShareGainsBase + realizedShareLossesBase + dividendsReceivedBase + externalIncomeBase + externalExpensesBase),
    count: events.length,
    conversionUnavailableCount: events.filter((event) => event.conversionUnavailable).length
  };
}

export async function realizedIncomeTimeline(userId, options = {}) {
  const database = getDb();
  const user = currentUser(database, userId);
  const range = RANGE_FILTERS.has(String(options.range || "").toLowerCase()) ? String(options.range).toLowerCase() : "all";
  const filter = EVENT_FILTERS.has(String(options.filter || "").toLowerCase()) ? String(options.filter).toLowerCase() : "all";
  const events = [
    ...await saleEvents(database, user),
    ...await dividendEvents(database, user),
    ...await externalEvents(database, user)
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const filteredEvents = periodAndTypeFilter(events, range, filter);
  return {
    baseCurrency: user.base_currency,
    range,
    filter,
    events: filteredEvents,
    summary: summaryFor(filteredEvents)
  };
}
