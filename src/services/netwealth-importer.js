import crypto from "node:crypto";
import { getDb, transaction } from "../db.js";
import {
  id,
  InputError,
  DEFAULT_PORTFOLIO_CATEGORY_ID,
  normalizeCurrency,
  normalizeTicker,
  nowIso,
  portfolioGroupIdForTicker,
  roundMoney,
  roundPercent,
  roundShares,
  safeJsonParse,
  toNumber
} from "../utils.js";
import { convertAmount } from "./currency.js";

export const NETWEALTH_KIND = "netwealth_transactions";
const NETWEALTH_CURRENCY = "AUD";

function clean(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function headerIndex(matrix) {
  return matrix.findIndex((row) => {
    const headers = row.map(normalized);
    return headers.includes("effective date")
      && headers.includes("transactionlisting summary group")
      && headers.includes("purchase price")
      && headers.includes("sale price");
  });
}

export function isNetwealthMatrix(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return false;
  const title = normalized(matrix[0]?.[0]);
  return title.includes("cash transaction listing") || headerIndex(matrix) >= 0;
}

function netwealthRows(matrix) {
  const index = headerIndex(matrix);
  if (index < 0) throw new InputError("Netwealth transaction header was not found");
  const headers = matrix[index].map(clean);
  return matrix.slice(index + 1).map((cells, offset) => {
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, clean(cells[cellIndex])]));
    return {
      rowNumber: index + offset + 2,
      effectiveDate: row["Effective Date"],
      date: parseNetwealthDate(row["Effective Date"]),
      description: row.Description || "",
      asset: row.Asset || "",
      code: row.Code || "",
      units: toNumber(row.Units, 0),
      debits: toNumber(row.Debits, 0),
      credits: toNumber(row.Credits, 0),
      purchasePrice: toNumber(row["Purchase price"], 0),
      salePrice: toNumber(row["Sale price"], 0),
      group: row["TransactionListing Summary Group"] || "",
      processedDate: parseNetwealthDate(row["Processed Date"]),
      raw: row
    };
  }).filter((row) => row.date);
}

function parseNetwealthDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean(value));
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function sourceEventId(row, kind, suffix = "") {
  const fingerprint = [
    kind,
    row.date,
    row.processedDate,
    row.description,
    row.asset,
    row.code,
    row.units,
    row.debits,
    row.credits,
    row.purchasePrice,
    row.salePrice,
    row.group,
    suffix
  ].join("|");
  return `netwealth:${kind}:${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

function isFxCode(code) {
  return normalizeTicker(code).startsWith("FX");
}

function tickerCandidates(code) {
  const raw = normalizeTicker(code);
  if (!raw || isFxCode(raw)) return [];
  const special = {
    "LNW.ND": "LNW.AX",
    "NWWISE.LN": "WISE.L",
    "WISE.LN": "WISE.L",
    "NOVOB.CO": "NOVO-B.CO"
  }[raw];
  if (special) return [special, raw];
  if (raw.endsWith(".ND") || raw.endsWith(".NY")) return [raw.replace(/\.(ND|NY)$/, ""), raw];
  if (raw.endsWith(".LN")) return [raw.replace(/\.LN$/, ".L"), raw];
  if (raw.includes(".")) return [raw];
  return [`${raw}.AX`, raw];
}

function normalizeNetwealthTicker(database, code) {
  const candidates = tickerCandidates(code);
  for (const candidate of candidates) {
    if (database.prepare("SELECT ticker FROM equities WHERE ticker = ?").get(candidate)) return candidate;
  }
  return candidates[0] || "";
}

function marketCurrency(ticker) {
  if (ticker.endsWith(".AX")) return "AUD";
  if (ticker.endsWith(".L")) return "GBP";
  return "USD";
}

function resolveCategory(database, ticker) {
  const existing = database.prepare("SELECT category_id AS categoryId FROM equities WHERE ticker = ?").get(ticker);
  if (existing?.categoryId) return existing.categoryId;
  const mappedId = portfolioGroupIdForTicker(ticker, DEFAULT_PORTFOLIO_CATEGORY_ID);
  if (database.prepare("SELECT id FROM categories WHERE id = ?").get(mappedId)) return mappedId;
  return DEFAULT_PORTFOLIO_CATEGORY_ID;
}

function ensureEquity(database, ticker, name) {
  const now = nowIso();
  const categoryId = resolveCategory(database, ticker);
  const currency = normalizeCurrency(marketCurrency(ticker), "USD");
  database.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(excluded.name, equities.name),
      currency = excluded.currency,
      category_id = COALESCE(equities.category_id, excluded.category_id),
      status = 'ACTIVE',
      updated_at = excluded.updated_at
  `).run(ticker, name || null, currency, categoryId, now, now);
}

function classify(row) {
  const description = normalized(row.description);
  const group = normalized(row.group);
  if (!row.code || isFxCode(row.code)) return "ignored";
  if ((description === "distribution" || group.includes("distributions")) && row.credits > 0) return "distribution";
  const tradeLike = group.includes("asset purchases")
    || group.includes("asset sales")
    || group.includes("corporate actions")
    || description.includes("asset purchase")
    || description.includes("asset sale")
    || description.includes("corporate action")
    || description.includes("capital reconstruction");
  if (!tradeLike) return "ignored";
  if (row.units > 0) return "purchase";
  if (row.units < 0) return "sale";
  return "ignored";
}

function chronological(rows) {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return b.rowNumber - a.rowNumber;
  });
}

function extractCashBalance(matrix) {
  for (const row of matrix) {
    if (normalized(row[0]) === "cash balance") {
      const amount = toNumber(row[1], null);
      if (amount != null) return amount;
    }
  }
  return null;
}

function insertedBatch(database, userId, filename, rows, stats, errors) {
  const batch = {
    id: id("import"),
    kind: NETWEALTH_KIND,
    filename,
    totalRows: rows.length,
    createdCount: stats.purchasesCreated + stats.salesCreated + stats.dividendsCreated + stats.cashBalancesUpdated,
    updatedCount: stats.purchasesMatched + stats.salesMatched + stats.dividendsUpdated,
    errorCount: errors.length,
    errors,
    details: stats
  };
  database.prepare(`
    INSERT INTO import_batches (
      id, user_id, kind, filename, total_rows, created_count, updated_count,
      error_count, errors_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batch.id,
    userId,
    batch.kind,
    batch.filename,
    batch.totalRows,
    batch.createdCount,
    batch.updatedCount,
    batch.errorCount,
    JSON.stringify({ errors, details: stats }),
    nowIso()
  );
  return batch;
}

function resetImportedHistory(database, userId) {
  transaction((tx) => {
    tx.prepare("DELETE FROM realized_lots WHERE user_id = ?").run(userId);
    tx.prepare("DELETE FROM dividend_payments WHERE user_id = ?").run(userId);
    tx.prepare("DELETE FROM holding_lots WHERE user_id = ?").run(userId);
    tx.prepare("DELETE FROM cash_balances WHERE user_id = ?").run(userId);
  });
}

function insertPurchase(database, userId, row) {
  const ticker = normalizeNetwealthTicker(database, row.code);
  if (!ticker) return { skipped: true };
  const quantity = roundShares(row.units);
  const purchasePrice = row.purchasePrice > 0
    ? row.purchasePrice
    : quantity > 0
      ? roundMoney(row.debits / quantity)
      : 0;
  if (!quantity || quantity <= 0) throw new InputError("Purchase units must be greater than zero");
  if (purchasePrice == null || purchasePrice < 0) throw new InputError("Purchase price is missing");

  const eventId = sourceEventId(row, "purchase");
  const existing = database.prepare(`
    SELECT id FROM holding_lots
    WHERE user_id = ? AND source = 'netwealth' AND source_event_id = ?
  `).get(userId, eventId);
  if (existing) return { matched: true };

  ensureEquity(database, ticker, row.asset);
  const now = nowIso();
  database.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, source_event_id, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'netwealth', ?, ?, ?, ?)
  `).run(
    id("lot"),
    userId,
    ticker,
    quantity,
    quantity,
    purchasePrice,
    NETWEALTH_CURRENCY,
    row.date,
    eventId,
    `${row.description}${row.processedDate ? ` processed ${row.processedDate}` : ""}`,
    now,
    now
  );
  return { created: true };
}

async function converted(amount, fromCurrency, toCurrency) {
  const result = await convertAmount(amount, fromCurrency, toCurrency);
  return roundMoney(result.amount);
}

async function insertSale(database, user, row) {
  const ticker = normalizeNetwealthTicker(database, row.code);
  if (!ticker) return { skipped: true };
  const eventId = sourceEventId(row, "sale");
  const existing = database.prepare(`
    SELECT id FROM realized_lots
    WHERE user_id = ? AND source = 'netwealth' AND source_event_id LIKE ?
    LIMIT 1
  `).get(user.id, `${eventId}:%`);
  if (existing) return { matched: true };

  ensureEquity(database, ticker, row.asset);
  const quantityToSell = roundShares(Math.abs(row.units));
  const salePrice = row.salePrice > 0
    ? row.salePrice
    : quantityToSell > 0
      ? roundMoney(row.credits / quantityToSell)
      : 0;
  if (!quantityToSell || quantityToSell <= 0) throw new InputError("Sale units must be greater than zero");
  if (salePrice == null || salePrice < 0) throw new InputError("Sale price is missing");

  const lots = database.prepare(`
    SELECT * FROM holding_lots
    WHERE user_id = ? AND ticker = ? AND quantity > 0
    ORDER BY purchase_date, created_at
  `).all(user.id, ticker);
  const openQuantity = lots.reduce((total, lot) => total + Number(lot.quantity || 0), 0);
  if (openQuantity + 1e-8 < quantityToSell) {
    throw new InputError(`Sale quantity exceeds imported open holdings for ${ticker}`);
  }

  let remaining = quantityToSell;
  const matches = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const matchedQuantity = Math.min(Number(lot.quantity), remaining);
    const costBasisBase = await converted(
      matchedQuantity * Number(lot.purchase_price),
      lot.purchase_currency,
      user.base_currency
    );
    const proceedsBase = await converted(
      matchedQuantity * salePrice,
      NETWEALTH_CURRENCY,
      user.base_currency
    );
    const gainLossBase = roundMoney(proceedsBase - costBasisBase);
    matches.push({
      lot,
      matchedQuantity,
      costBasisBase,
      proceedsBase,
      gainLossBase,
      gainLossPercent: costBasisBase ? roundPercent((gainLossBase / costBasisBase) * 100) : 0
    });
    remaining = roundShares(remaining - matchedQuantity);
  }

  transaction((tx) => {
    const now = nowIso();
    matches.forEach((match, index) => {
      tx.prepare(`
        INSERT INTO realized_lots (
          id, user_id, ticker, lot_id, quantity, sale_price, sale_currency, sold_at,
          cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
          source, source_event_id, buy_price, buy_currency, bought_at, notes, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'netwealth', ?, ?, ?, ?, ?, ?)
      `).run(
        id("realized"),
        user.id,
        ticker,
        match.lot.id,
        match.matchedQuantity,
        salePrice,
        NETWEALTH_CURRENCY,
        row.date,
        match.costBasisBase,
        match.proceedsBase,
        match.gainLossBase,
        match.gainLossPercent,
        `${eventId}:${index}`,
        match.lot.purchase_price,
        match.lot.purchase_currency,
        match.lot.purchase_date,
        `${row.description}${row.processedDate ? ` processed ${row.processedDate}` : ""}`,
        now
      );
      const newQuantity = roundShares(Number(match.lot.quantity) - match.matchedQuantity);
      tx.prepare(`
        UPDATE holding_lots
        SET quantity = ?, updated_at = ?, closed_at = CASE WHEN ? <= 0.000001 THEN ? ELSE closed_at END
        WHERE id = ?
      `).run(Math.max(0, newQuantity), now, newQuantity, now, match.lot.id);
    });
  });
  return { created: true, realizedRows: matches.length };
}

function estimatedEligibleQuantity(database, userId, ticker, date) {
  const lots = database.prepare(`
    SELECT id, original_quantity, purchase_date
    FROM holding_lots
    WHERE user_id = ? AND ticker = ? AND purchase_date <= ?
  `).all(userId, ticker, date);
  const sold = database.prepare(`
    SELECT lot_id, SUM(quantity) AS quantity
    FROM realized_lots
    WHERE user_id = ? AND ticker = ? AND sold_at < ?
    GROUP BY lot_id
  `).all(userId, ticker, date);
  const soldByLot = new Map(sold.map((row) => [row.lot_id, Number(row.quantity || 0)]));
  return roundShares(lots.reduce((total, lot) => (
    total + Math.max(0, Number(lot.original_quantity || 0) - (soldByLot.get(lot.id) || 0))
  ), 0));
}

async function insertDistribution(database, user, row) {
  const ticker = normalizeNetwealthTicker(database, row.code);
  if (!ticker) return { skipped: true };
  const grossAmount = roundMoney(row.credits - row.debits);
  if (!grossAmount || grossAmount <= 0) throw new InputError("Distribution amount is missing");
  const eventId = sourceEventId(row, "distribution");
  const existing = database.prepare(`
    SELECT id FROM dividend_payments
    WHERE user_id = ? AND ticker = ? AND source = 'netwealth' AND source_event_id = ?
  `).get(user.id, ticker, eventId);

  ensureEquity(database, ticker, row.asset);
  const eligibleQuantity = estimatedEligibleQuantity(database, user.id, ticker, row.date) || 0;
  const amountPerShare = eligibleQuantity > 0 ? roundMoney(grossAmount / eligibleQuantity) : 0;
  const grossAmountBase = await converted(grossAmount, NETWEALTH_CURRENCY, user.base_currency);
  const now = nowIso();
  database.prepare(`
    INSERT INTO dividend_payments (
      id, user_id, ticker, ex_date, pay_date, record_date, amount_per_share,
      currency, eligible_quantity, gross_amount, gross_amount_base,
      source, source_event_id, payload_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'netwealth', ?, ?, ?, ?)
    ON CONFLICT(user_id, ticker, source, source_event_id) DO UPDATE SET
      pay_date = excluded.pay_date,
      amount_per_share = excluded.amount_per_share,
      currency = excluded.currency,
      eligible_quantity = excluded.eligible_quantity,
      gross_amount = excluded.gross_amount,
      gross_amount_base = excluded.gross_amount_base,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    id("dividend"),
    user.id,
    ticker,
    row.date,
    row.processedDate || row.date,
    amountPerShare,
    NETWEALTH_CURRENCY,
    eligibleQuantity,
    grossAmount,
    grossAmountBase,
    eventId,
    JSON.stringify(row.raw),
    now,
    now
  );
  return existing ? { updated: true } : { created: true };
}

function updateCashBalance(database, userId, amount) {
  if (amount == null) return false;
  database.prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, 'AUD', ?, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(id("cash"), userId, amount, nowIso());
  return true;
}

export function previewNetwealthImport(filename, matrix) {
  const rows = netwealthRows(matrix);
  const counts = { purchases: 0, sales: 0, distributions: 0, ignored: 0 };
  const sample = [];
  for (const row of chronological(rows)) {
    const type = classify(row);
    if (type === "purchase") counts.purchases += 1;
    else if (type === "sale") counts.sales += 1;
    else if (type === "distribution") counts.distributions += 1;
    else counts.ignored += 1;
    if (type !== "ignored" && sample.length < 10) {
      sample.push({ type, date: row.date, asset: row.asset, code: row.code, units: row.units, amount: row.credits || row.debits });
    }
  }
  return { kind: NETWEALTH_KIND, filename, totalRows: rows.length, summary: counts, rows: sample };
}

export async function importNetwealthTransactions({ userId, filename, matrix, replace = false }) {
  const database = getDb();
  const rows = netwealthRows(matrix);
  if (!rows.length) throw new InputError("The Netwealth file did not contain transaction rows");

  if (replace) resetImportedHistory(database, userId);
  database.prepare("UPDATE users SET base_currency = 'AUD' WHERE id = ?").run(userId);

  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const stats = {
    purchasesCreated: 0,
    purchasesMatched: 0,
    salesCreated: 0,
    salesMatched: 0,
    realizedRowsCreated: 0,
    dividendsCreated: 0,
    dividendsUpdated: 0,
    cashBalancesUpdated: 0,
    ignoredRows: 0
  };
  const errors = [];
  const cashBalance = extractCashBalance(matrix);
  if (updateCashBalance(database, userId, cashBalance)) stats.cashBalancesUpdated += 1;

  for (const row of chronological(rows)) {
    const type = classify(row);
    try {
      if (type === "purchase") {
        const result = insertPurchase(database, userId, row);
        if (result.created) stats.purchasesCreated += 1;
        else if (result.matched) stats.purchasesMatched += 1;
        else stats.ignoredRows += 1;
      } else if (type === "sale") {
        const result = await insertSale(database, user, row);
        if (result.created) {
          stats.salesCreated += 1;
          stats.realizedRowsCreated += result.realizedRows || 0;
        } else if (result.matched) {
          stats.salesMatched += 1;
        } else {
          stats.ignoredRows += 1;
        }
      } else if (type === "distribution") {
        const result = await insertDistribution(database, user, row);
        if (result.created) stats.dividendsCreated += 1;
        else if (result.updated) stats.dividendsUpdated += 1;
        else stats.ignoredRows += 1;
      } else {
        stats.ignoredRows += 1;
      }
    } catch (error) {
      errors.push({
        row: row.rowNumber,
        code: row.code || null,
        date: row.date,
        type,
        message: error.message
      });
    }
  }

  return insertedBatch(database, userId, filename, rows, stats, errors);
}

export function netwealthImportDetails(batch) {
  return safeJsonParse(batch.errorsJson, { errors: [], details: null });
}
