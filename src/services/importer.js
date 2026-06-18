import { transaction } from "../db.js";
import {
  id,
  InputError,
  DEFAULT_PORTFOLIO_CATEGORY_ID,
  normalizeFxCurrency,
  normalizeTicker,
  nowIso,
  portfolioGroupIdForName,
  portfolioGroupIdForTicker,
  safeJsonParse,
  toNumber
} from "../utils.js";
import { parseXlsx } from "./xlsx.js";
import {
  importNetwealthTransactions,
  isNetwealthMatrix,
  NETWEALTH_KIND,
  previewNetwealthImport
} from "./netwealth-importer.js";
import { ensureWatchlist } from "./watchlists.js";

const FIELD_ALIASES = {
  ticker: ["symbol", "ticker", "ticker symbol", "security", "instrument", "code"],
  name: ["name", "company", "company name", "security name", "description"],
  quantity: ["quantity", "qty", "shares", "units", "holding", "holdings"],
  purchasePrice: [
    "purchase price",
    "price paid",
    "average cost",
    "avg cost",
    "cost basis",
    "cost price",
    "purchaseprice"
  ],
  purchaseDate: ["trade date", "date traded", "purchase date", "date acquired", "acquired date", "date"],
  currency: ["currency", "ccy", "purchase currency", "trade currency"],
  category: ["category", "segment", "portfolio segment"],
  targetPrice: ["target price", "price target", "limit", "watch price", "alert price"],
  note: ["note", "notes", "comment", "comments"]
};

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      value += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value);
      if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
  return rows;
}

function rowsFromFile(filename, buffer) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return parseXlsx(buffer);
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return parseCsv(buffer.toString("utf8"));
  throw new InputError("Upload must be a .csv or .xlsx file");
}

function headerMap(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const index = normalized.findIndex((header) => header === alias);
      if (index >= 0) {
        map[field] = index;
        break;
      }
    }
  }
  return map;
}

function objectRows(matrix) {
  if (matrix.length < 2) return [];
  const headers = matrix[0];
  const map = headerMap(headers);
  return matrix.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    ticker: row[map.ticker],
    name: row[map.name],
    quantity: row[map.quantity],
    purchasePrice: row[map.purchasePrice],
    purchaseDate: row[map.purchaseDate],
    currency: row[map.currency],
    category: row[map.category],
    targetPrice: row[map.targetPrice],
    note: row[map.note],
    raw: row
  }));
}

function resolveCategory(database, name, ticker) {
  const clean = String(name || "").trim();
  const aliasId = clean ? portfolioGroupIdForName(clean, "") : "";
  if (aliasId && database.prepare("SELECT id FROM categories WHERE id = ? AND active = 1").get(aliasId)) {
    return aliasId;
  }
  const category = clean
    ? database.prepare("SELECT id FROM categories WHERE lower(name) = lower(?) AND active = 1").get(clean)
    : null;
  if (category) return category.id;
  const tickerGroupId = portfolioGroupIdForTicker(ticker, DEFAULT_PORTFOLIO_CATEGORY_ID);
  if (database.prepare("SELECT id FROM categories WHERE id = ?").get(tickerGroupId)) return tickerGroupId;
  return DEFAULT_PORTFOLIO_CATEGORY_ID;
}

function normalizeImportDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  const yyyymmdd = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (yyyymmdd) return `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}`;
  const separated = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw);
  if (separated) {
    return `${separated[1]}-${separated[2].padStart(2, "0")}-${separated[3].padStart(2, "0")}`;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 20000 && numeric < 80000) {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + numeric * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function ensureEquity(database, row, categoryId, fallbackCurrency = "USD") {
  const ticker = normalizeTicker(row.ticker);
  if (!ticker) throw new InputError("Ticker is required");
  const now = nowIso();
  const currency = normalizeFxCurrency(row.currency, fallbackCurrency);
  database.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(excluded.name, equities.name),
      currency = excluded.currency,
      category_id = COALESCE(equities.category_id, excluded.category_id),
      updated_at = excluded.updated_at
  `).run(ticker, row.name || null, currency, categoryId, now, now);
  return ticker;
}

function existingLot(database, userId, row, ticker, currency) {
  const quantity = toNumber(row.quantity, 0);
  const price = toNumber(row.purchasePrice, 0);
  const date = String(row.purchaseDate || "1970-01-01").slice(0, 10);
  return database.prepare(`
    SELECT id FROM holding_lots
    WHERE user_id = ?
      AND ticker = ?
      AND abs(quantity - ?) < 0.000001
      AND abs(purchase_price - ?) < 0.000001
      AND purchase_currency = ?
      AND purchase_date = ?
    LIMIT 1
  `).get(userId, ticker, quantity, price, currency, date);
}

function importPortfolioRows(database, userId, rows, filename, replace) {
  if (replace) {
    database.prepare("DELETE FROM realized_lots WHERE user_id = ?").run(userId);
    database.prepare("DELETE FROM dividend_payments WHERE user_id = ?").run(userId);
    database.prepare("DELETE FROM holding_lots WHERE user_id = ?").run(userId);
  }

  let created = 0;
  let updated = 0;
  const errors = [];
  for (const row of rows) {
    try {
      const quantity = toNumber(row.quantity, null);
      const purchasePrice = toNumber(row.purchasePrice, null);
      if (!normalizeTicker(row.ticker)) throw new InputError("Missing ticker");
      if (quantity == null || quantity <= 0) throw new InputError("Quantity must be greater than zero");
      if (purchasePrice == null || purchasePrice < 0) throw new InputError("Purchase price is required");
      const currency = normalizeFxCurrency(row.currency, "USD");
      const categoryId = resolveCategory(database, row.category, row.ticker);
      const ticker = ensureEquity(database, row, categoryId, currency);
      const purchaseDate = normalizeImportDate(row.purchaseDate);
      if (existingLot(database, userId, { ...row, purchaseDate }, ticker, currency)) {
        updated += 1;
        continue;
      }
      const now = nowIso();
      database.prepare(`
        INSERT INTO holding_lots (
          id, user_id, ticker, original_quantity, quantity, purchase_price,
          purchase_currency, purchase_date, source, notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id("lot"),
        userId,
        ticker,
        quantity,
        quantity,
        purchasePrice,
        currency,
        purchaseDate,
        filename.toLowerCase().includes("yahoo") ? "yahoo" : "import",
        row.note || null,
        now,
        now
      );
      created += 1;
    } catch (error) {
      errors.push({ row: row.rowNumber, message: error.message });
    }
  }
  return { created, updated, errors };
}

function importWatchlistRows(database, userId, rows, filename, replace, watchlistName = "Default") {
  const watchlist = ensureWatchlist(database, userId, watchlistName);
  if (replace) {
    database.prepare("DELETE FROM watchlist_items WHERE user_id = ? AND watchlist_id = ?")
      .run(userId, watchlist.id);
  }

  let created = 0;
  let updated = 0;
  const errors = [];
  for (const row of rows) {
    try {
      if (!normalizeTicker(row.ticker)) throw new InputError("Missing ticker");
      const currency = normalizeFxCurrency(row.currency, "USD");
      const categoryId = resolveCategory(database, row.category, row.ticker);
      const ticker = ensureEquity(database, row, categoryId, currency);
      const now = nowIso();
      const existing = database.prepare(`
        SELECT id FROM watchlist_items
        WHERE user_id = ? AND watchlist_id = ? AND ticker = ?
      `).get(userId, watchlist.id, ticker);
      const result = database.prepare(`
        INSERT INTO watchlist_items (
          id, user_id, watchlist_id, ticker, target_price, currency, category_id, note, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, watchlist_id, ticker) DO UPDATE SET
          target_price = COALESCE(excluded.target_price, watchlist_items.target_price),
          currency = excluded.currency,
          category_id = COALESCE(excluded.category_id, watchlist_items.category_id),
          note = COALESCE(excluded.note, watchlist_items.note),
          updated_at = excluded.updated_at
      `).run(
        id("watch"),
        userId,
        watchlist.id,
        ticker,
        toNumber(row.targetPrice, null),
        currency,
        categoryId,
        row.note || null,
        now,
        now
      );
      if (result.changes) {
        if (existing) updated += 1;
        else created += 1;
      }
    } catch (error) {
      errors.push({ row: row.rowNumber, message: error.message });
    }
  }
  return { created, updated, errors };
}

function inferKind(rows, requestedKind) {
  if (requestedKind === "portfolio" || requestedKind === "watchlist" || requestedKind === NETWEALTH_KIND) {
    return requestedKind;
  }
  const portfolioLike = rows.some((row) => toNumber(row.quantity, null) != null && toNumber(row.purchasePrice, null) != null);
  return portfolioLike ? "portfolio" : "watchlist";
}

export function previewImport(filename, buffer) {
  const matrix = rowsFromFile(filename, buffer);
  if (isNetwealthMatrix(matrix)) return previewNetwealthImport(filename, matrix);
  const rows = objectRows(matrix);
  const kind = inferKind(rows, "auto");
  return { kind, rows: rows.slice(0, 10), totalRows: rows.length };
}

export async function importFile({ userId, filename, buffer, kind = "auto", replace = false, watchlistName = "Default" }) {
  const matrix = rowsFromFile(filename, buffer);
  if (kind !== "watchlist" && isNetwealthMatrix(matrix)) {
    return importNetwealthTransactions({ userId, filename, matrix, replace });
  }
  if (kind === NETWEALTH_KIND) {
    throw new InputError("This does not look like a Netwealth cash transaction listing");
  }

  const rows = objectRows(matrix);
  const resolvedKind = inferKind(rows, kind);
  if (!rows.length) throw new InputError("The file did not contain importable rows");

  return transaction((database) => {
    const result = resolvedKind === "portfolio"
      ? importPortfolioRows(database, userId, rows, filename, replace)
      : importWatchlistRows(database, userId, rows, filename, replace, watchlistName);

    const batch = {
      id: id("import"),
      kind: resolvedKind,
      filename,
      totalRows: rows.length,
      createdCount: result.created,
      updatedCount: result.updated,
      errorCount: result.errors.length,
      errors: result.errors
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
      JSON.stringify(batch.errors),
      nowIso()
    );
    return batch;
  });
}

export function listImportBatches(database, userId) {
  return database.prepare(`
    SELECT id, kind, filename, total_rows AS totalRows, created_count AS createdCount,
      updated_count AS updatedCount, error_count AS errorCount, errors_json AS errorsJson,
      created_at AS createdAt
    FROM import_batches
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(userId).map((batch) => ({ ...batch, errors: safeJsonParse(batch.errorsJson, []) }));
}

export { parseCsv };
