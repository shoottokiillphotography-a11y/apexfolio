import { getDb, transaction } from "../db.js";
import { config } from "../config.js";
import {
  fetchJson,
  id,
  normalizeCurrency,
  nowIso,
  RateLimiter,
  roundMoney,
  roundShares,
  todayIsoDate
} from "../utils.js";
import { convertAmount } from "./currency.js";

const limiter = new RateLimiter(config.finnhubMinIntervalMs);

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dividendSourceId(ticker, dividend) {
  const exDate = dateOnly(dividend.exDate || dividend.date);
  const amount = Number(dividend.amount ?? dividend.dividend ?? dividend.cashDividend);
  return [
    dividend.source || "finnhub",
    ticker,
    exDate,
    Number.isFinite(amount) ? amount : "unknown"
  ].join(":");
}

export function eligibleQuantityForDividend(lots, realizedLots, exDate) {
  const ex = dateOnly(exDate);
  let eligible = 0;
  for (const lot of lots) {
    const purchaseDate = dateOnly(lot.purchase_date);
    if (!purchaseDate || purchaseDate >= ex) continue;
    const soldBeforeExDate = realizedLots
      .filter((sale) => sale.lot_id === lot.id && dateOnly(sale.sold_at) < ex)
      .reduce((total, sale) => total + Number(sale.quantity || 0), 0);
    eligible += Math.max(0, Number(lot.original_quantity || lot.quantity || 0) - soldBeforeExDate);
  }
  return roundShares(eligible) || 0;
}

async function fetchFinnhubDividends(ticker, from, to) {
  if (!config.finnhubApiKey) throw new Error("FINNHUB_API_KEY is not configured");
  const url = new URL("https://finnhub.io/api/v1/stock/dividend");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("token", config.finnhubApiKey);
  const payload = await limiter.enqueue(() => fetchJson(url));
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchYahooDividends(ticker, from, to) {
  const period1 = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "div");
  const payload = await fetchJson(url, { timeoutMs: 15000 });
  const result = payload?.chart?.result?.[0];
  const dividends = result?.events?.dividends || {};
  return Object.values(dividends).map((dividend) => ({
    source: "yahoo",
    exDate: dividend.date ? new Date(dividend.date * 1000).toISOString().slice(0, 10) : null,
    amount: Number(dividend.amount),
    currency: result?.meta?.currency
  })).filter((dividend) => dividend.exDate && Number.isFinite(dividend.amount));
}

async function fetchDividendHistory(ticker, from, to) {
  try {
    const dividends = await fetchFinnhubDividends(ticker, from, to);
    return { source: "finnhub", dividends: dividends.map((dividend) => ({ ...dividend, source: "finnhub" })) };
  } catch (error) {
    if (!/403/.test(error.message)) throw error;
    const dividends = await fetchYahooDividends(ticker, from, to);
    return { source: "yahoo", dividends };
  }
}

function trackedDividendTickers(database, userId) {
  return database.prepare(`
    SELECT l.ticker, MIN(l.purchase_date) AS firstPurchaseDate, e.currency
    FROM holding_lots l
    JOIN equities e ON e.ticker = l.ticker
    WHERE l.user_id = ?
    GROUP BY l.ticker
    ORDER BY l.ticker
  `).all(userId);
}

function lotsWithBackfillStart(lots, fromDate) {
  const start = dateOnly(fromDate);
  if (!start) return lots;
  return lots.map((lot) => ({
    ...lot,
    purchase_date: dateOnly(lot.purchase_date) > start ? start : lot.purchase_date
  }));
}

export async function syncDividends(userId, { fromDate = null } = {}) {
  const database = getDb();
  const removed = database.prepare(`
    DELETE FROM dividend_payments
    WHERE user_id = ?
      AND source <> 'netwealth'
  `).run(userId).changes || 0;
  const row = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(gross_amount_base), 0) AS grossAmountBase
    FROM dividend_payments
    WHERE user_id = ?
      AND source = 'netwealth'
  `).get(userId);

  return {
    createdCount: 0,
    updatedCount: 0,
    removedExternalCount: removed,
    csvDividendCount: Number(row?.count || 0),
    csvGrossAmountBase: roundMoney(Number(row?.grossAmountBase || 0)),
    csvOnly: true,
    message: "Dividends are loaded only from uploaded transaction CSV files.",
    yahooFallbackCount: 0,
    errorCount: 0,
    fromDate: dateOnly(fromDate),
    errors: [],
    created: [],
    updated: []
  };
}

export function listDividendPayments(database, userId, limit = 100) {
  return database.prepare(`
    SELECT id, ticker, ex_date AS exDate, pay_date AS payDate, record_date AS recordDate,
      amount_per_share AS amountPerShare, currency, eligible_quantity AS eligibleQuantity,
      gross_amount AS grossAmount, gross_amount_base AS grossAmountBase,
      source, created_at AS createdAt, updated_at AS updatedAt
    FROM dividend_payments
    WHERE user_id = ?
    ORDER BY ex_date DESC, ticker
    LIMIT ?
  `).all(userId, limit);
}
