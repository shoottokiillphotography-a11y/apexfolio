import { getDb } from "../db.js";
import { id, InputError, nowIso } from "../utils.js";

export function cleanWatchlistName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (!clean) return "Default";
  if (clean.length > 80) throw new InputError("Watchlist name is too long");
  return clean;
}

export function ensureWatchlist(database, userId, name = "Default") {
  const clean = cleanWatchlistName(name);
  const existing = database.prepare(`
    SELECT id, name, sort_order AS sortOrder
    FROM watchlists
    WHERE user_id = ? AND lower(name) = lower(?)
  `).get(userId, clean);
  if (existing) return existing;

  const sortOrder = (database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder
    FROM watchlists
    WHERE user_id = ?
  `).get(userId).nextOrder) || 0;
  const now = nowIso();
  const watchlist = { id: id("watchlist"), name: clean, sortOrder };
  database.prepare(`
    INSERT INTO watchlists (id, user_id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(watchlist.id, userId, watchlist.name, watchlist.sortOrder, now, now);
  return watchlist;
}

export function resolveWatchlist(database, userId, input = {}) {
  if (input.watchlistId) {
    const watchlist = database.prepare(`
      SELECT id, name, sort_order AS sortOrder
      FROM watchlists
      WHERE id = ? AND user_id = ?
    `).get(input.watchlistId, userId);
    if (!watchlist) throw new InputError("Watchlist not found", 404);
    return watchlist;
  }
  return ensureWatchlist(database, userId, input.watchlistName || "Default");
}

export function createWatchlist(userId, input = {}) {
  const database = getDb();
  return ensureWatchlist(database, userId, input.name);
}

export function renameWatchlist(userId, watchlistId, input = {}) {
  const name = cleanWatchlistName(input.name);
  const database = getDb();
  const duplicate = database.prepare(`
    SELECT id
    FROM watchlists
    WHERE user_id = ? AND lower(name) = lower(?) AND id <> ?
  `).get(userId, name, watchlistId);
  if (duplicate) throw new InputError("Another watchlist already uses that name");

  const result = database.prepare(`
    UPDATE watchlists
    SET name = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name, nowIso(), watchlistId, userId);
  if (!result.changes) throw new InputError("Watchlist not found", 404);
  return { id: watchlistId, name };
}
