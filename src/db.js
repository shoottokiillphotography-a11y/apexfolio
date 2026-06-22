import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { id, nowIso, PORTFOLIO_GROUPS, PORTFOLIO_GROUP_TICKERS, normalizeTicker } from "./utils.js";

let db;

export function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    db = new DatabaseSync(config.databasePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    seed(db);
  }
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      base_currency TEXT NOT NULL CHECK (base_currency IN ('USD','AUD','GBP')),
      created_at TEXT NOT NULL,
      display_name TEXT,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      updated_at TEXT,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user
      ON user_sessions(user_id, expires_at);

    CREATE TABLE IF NOT EXISTS user_ai_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('openai','gemini')),
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      target_percent REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#C9A86A',
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS equities (
      ticker TEXT PRIMARY KEY,
      name TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      category_id TEXT REFERENCES categories(id),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      buy_blocked INTEGER NOT NULL DEFAULT 0,
      max_buy_weight_percent REAL,
      risk_note TEXT
    );

    CREATE TABLE IF NOT EXISTS holding_lots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      original_quantity REAL NOT NULL CHECK (original_quantity >= 0),
      quantity REAL NOT NULL CHECK (quantity >= 0),
      purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
      purchase_currency TEXT NOT NULL,
      purchase_date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_event_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_holding_lots_user_ticker ON holding_lots(user_id, ticker);

    CREATE TABLE IF NOT EXISTS realized_lots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      lot_id TEXT REFERENCES holding_lots(id),
      quantity REAL NOT NULL,
      sale_price REAL NOT NULL,
      sale_currency TEXT NOT NULL,
      sold_at TEXT NOT NULL,
      cost_basis_base REAL NOT NULL,
      proceeds_base REAL NOT NULL,
      gain_loss_base REAL NOT NULL,
      gain_loss_percent REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_event_id TEXT,
      buy_price REAL,
      buy_currency TEXT,
      bought_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dividend_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      ex_date TEXT NOT NULL,
      pay_date TEXT,
      record_date TEXT,
      amount_per_share REAL NOT NULL,
      currency TEXT NOT NULL,
      eligible_quantity REAL NOT NULL,
      gross_amount REAL NOT NULL,
      gross_amount_base REAL NOT NULL,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, ticker, source, source_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dividend_payments_user_ticker
      ON dividend_payments(user_id, ticker, ex_date);

    CREATE TABLE IF NOT EXISTS cash_balances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, currency)
    );

    CREATE TABLE IF NOT EXISTS market_prices (
      ticker TEXT PRIMARY KEY,
      price REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      previous_close REAL,
      change_amount REAL,
      change_percent REAL,
      pre_market_price REAL,
      pre_market_time TEXT,
      post_market_price REAL,
      post_market_time TEXT,
      regular_market_price REAL,
      day_low REAL,
      day_high REAL,
      fifty_two_week_low REAL,
      fifty_two_week_high REAL,
      market_cap REAL,
      volume REAL,
      average_volume REAL,
      fifty_day_average REAL,
      two_hundred_day_average REAL,
      market_state TEXT,
      exchange_name TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS historical_prices (
      ticker TEXT NOT NULL,
      price_date TEXT NOT NULL,
      close REAL NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, price_date)
    );

    CREATE INDEX IF NOT EXISTS idx_historical_prices_ticker_date
      ON historical_prices(ticker, price_date);

    CREATE TABLE IF NOT EXISTS exchange_rates (
      pair TEXT PRIMARY KEY,
      from_currency TEXT NOT NULL,
      to_currency TEXT NOT NULL,
      rate REAL NOT NULL,
      provider TEXT NOT NULL,
      as_of TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fundamental_metrics (
      ticker TEXT PRIMARY KEY REFERENCES equities(ticker),
      pe_ratio REAL,
      forward_pe REAL,
      ev_ebitda REAL,
      price_sales REAL,
      fcf_yield REAL,
      peg REAL,
      revenue_growth REAL,
      eps_growth REAL,
      beta REAL,
      market_cap REAL,
      gross_margin REAL,
      operating_margin REAL,
      debt_equity REAL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      error TEXT,
      metric_json TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS watchlist_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      target_price REAL,
      buy_zone_low REAL,
      buy_zone_high REAL,
      add_zone_low REAL,
      add_zone_high REAL,
      fair_value REAL,
      trim_price REAL,
      currency TEXT NOT NULL,
      category_id TEXT REFERENCES categories(id),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, watchlist_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS price_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      scope TEXT NOT NULL CHECK (scope IN ('EQUITY','LOT','WATCHLIST')),
      lot_id TEXT REFERENCES holding_lots(id) ON DELETE CASCADE,
      watchlist_item_id TEXT REFERENCES watchlist_items(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('ABOVE','BELOW')),
      threshold_price REAL NOT NULL CHECK (threshold_price >= 0),
      currency TEXT NOT NULL,
      label TEXT,
      company_name TEXT,
      exchange TEXT,
      strategy_group TEXT,
      alert_type TEXT NOT NULL DEFAULT 'PRICE_ALERT',
      priority TEXT NOT NULL DEFAULT 'medium',
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      active INTEGER NOT NULL DEFAULT 1,
      triggered INTEGER NOT NULL DEFAULT 0,
      triggered_at TEXT,
      acknowledged_at TEXT,
      archived_at TEXT,
      snoozed_until TEXT,
      last_triggered_at TEXT,
      last_triggered_price REAL,
      last_reset_price REAL,
      cooldown_minutes INTEGER NOT NULL DEFAULT 1440,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(user_id, active, ticker);

    CREATE TABLE IF NOT EXISTS corporate_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      payload_json TEXT,
      notified_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, ticker, source, source_event_id)
    );

    CREATE TABLE IF NOT EXISTS notification_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ticker TEXT,
      alert_id TEXT REFERENCES price_alerts(id),
      event_id TEXT REFERENCES corporate_events(id),
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      provider_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notification_history(status, created_at);

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      created_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      errors_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_pulse_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      display_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, symbol)
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);

  ensureColumn(database, "users", "display_name", "TEXT");
  ensureColumn(database, "users", "password_hash", "TEXT");
  ensureColumn(database, "users", "role", "TEXT NOT NULL DEFAULT 'member'");
  ensureColumn(database, "users", "updated_at", "TEXT");
  ensureColumn(database, "users", "last_login_at", "TEXT");
  database.exec("UPDATE users SET role = 'owner' WHERE id = 'primary-user' AND (role IS NULL OR role = 'member');");
  database.exec("UPDATE users SET updated_at = COALESCE(updated_at, created_at);");

  ensureColumn(database, "categories", "color", "TEXT NOT NULL DEFAULT '#C9A86A'");
  ensureColumn(database, "categories", "active", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "equities", "buy_blocked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "equities", "max_buy_weight_percent", "REAL");
  ensureColumn(database, "equities", "risk_note", "TEXT");
  ensureColumn(database, "holding_lots", "source_event_id", "TEXT");
  ensureColumn(database, "realized_lots", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, "realized_lots", "source_event_id", "TEXT");
  ensureColumn(database, "realized_lots", "buy_price", "REAL");
  ensureColumn(database, "realized_lots", "buy_currency", "TEXT");
  ensureColumn(database, "realized_lots", "bought_at", "TEXT");
  ensureColumn(database, "realized_lots", "notes", "TEXT");
  backfillRealizedLotBuyDetails(database);
  ensureColumn(database, "market_prices", "pre_market_price", "REAL");
  ensureColumn(database, "market_prices", "pre_market_time", "TEXT");
  ensureColumn(database, "market_prices", "post_market_price", "REAL");
  ensureColumn(database, "market_prices", "post_market_time", "TEXT");
  ensureColumn(database, "market_prices", "regular_market_price", "REAL");
  ensureColumn(database, "market_prices", "day_low", "REAL");
  ensureColumn(database, "market_prices", "day_high", "REAL");
  ensureColumn(database, "market_prices", "fifty_two_week_low", "REAL");
  ensureColumn(database, "market_prices", "fifty_two_week_high", "REAL");
  ensureColumn(database, "market_prices", "market_cap", "REAL");
  ensureColumn(database, "market_prices", "volume", "REAL");
  ensureColumn(database, "market_prices", "average_volume", "REAL");
  ensureColumn(database, "market_prices", "fifty_day_average", "REAL");
  ensureColumn(database, "market_prices", "two_hundred_day_average", "REAL");
  ensureColumn(database, "market_prices", "market_state", "TEXT");
  ensureColumn(database, "market_prices", "exchange_name", "TEXT");
  migrateHoldingLotsCurrency(database);
  migrateRealizedLotsCurrency(database);
  migrateCashBalancesCurrency(database);
  ensureColumn(database, "realized_lots", "buy_price", "REAL");
  ensureColumn(database, "realized_lots", "buy_currency", "TEXT");
  ensureColumn(database, "realized_lots", "bought_at", "TEXT");
  ensureColumn(database, "realized_lots", "notes", "TEXT");
  migrateWatchlistItems(database);
  ensureColumn(database, "watchlist_items", "buy_zone_low", "REAL");
  ensureColumn(database, "watchlist_items", "buy_zone_high", "REAL");
  ensureColumn(database, "watchlist_items", "add_zone_low", "REAL");
  ensureColumn(database, "watchlist_items", "add_zone_high", "REAL");
  ensureColumn(database, "watchlist_items", "fair_value", "REAL");
  ensureColumn(database, "watchlist_items", "trim_price", "REAL");
  migrateWatchlistItemsCurrency(database);
  migratePriceAlertsCurrency(database);
  ensureColumn(database, "price_alerts", "company_name", "TEXT");
  ensureColumn(database, "price_alerts", "exchange", "TEXT");
  ensureColumn(database, "price_alerts", "strategy_group", "TEXT");
  ensureColumn(database, "price_alerts", "alert_type", "TEXT NOT NULL DEFAULT 'PRICE_ALERT'");
  ensureColumn(database, "price_alerts", "priority", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn(database, "price_alerts", "note", "TEXT");
  ensureColumn(database, "price_alerts", "source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, "price_alerts", "triggered_at", "TEXT");
  ensureColumn(database, "price_alerts", "acknowledged_at", "TEXT");
  ensureColumn(database, "price_alerts", "archived_at", "TEXT");
  ensureColumn(database, "price_alerts", "snoozed_until", "TEXT");
  ensureColumn(database, "price_alerts", "last_triggered_price", "REAL");
  ensureColumn(database, "price_alerts", "last_reset_price", "REAL");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holding_lots_source_event
      ON holding_lots(user_id, source, source_event_id)
      WHERE source_event_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_holding_lots_user_ticker
      ON holding_lots(user_id, ticker);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_realized_lots_source_event
      ON realized_lots(user_id, source, source_event_id)
      WHERE source_event_id IS NOT NULL;
  `);
}

function backfillRealizedLotBuyDetails(database) {
  database.exec(`
    UPDATE realized_lots
    SET buy_price = COALESCE(buy_price, (
          SELECT purchase_price FROM holding_lots WHERE holding_lots.id = realized_lots.lot_id
        )),
        buy_currency = COALESCE(buy_currency, (
          SELECT purchase_currency FROM holding_lots WHERE holding_lots.id = realized_lots.lot_id
        )),
        bought_at = COALESCE(bought_at, (
          SELECT purchase_date FROM holding_lots WHERE holding_lots.id = realized_lots.lot_id
        ))
    WHERE lot_id IS NOT NULL
      AND (buy_price IS NULL OR buy_currency IS NULL OR bought_at IS NULL);
  `);
}

function tableSql(database, tableName) {
  return database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName)?.sql || "";
}

function createCashBalancesTable(database, tableName = "cash_balances") {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, currency)
    );
  `);
}

function migrateCashBalancesCurrency(database) {
  if (!tableSql(database, "cash_balances").includes("currency IN ('USD','AUD','GBP')")) return;

  const existingRows = database.prepare("SELECT * FROM cash_balances").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createCashBalancesTable(database, "cash_balances_new");
  const insert = database.prepare(`
    INSERT INTO cash_balances_new (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(row.id, row.user_id, row.currency, row.amount, row.updated_at);
  }
  database.exec("DROP TABLE cash_balances;");
  database.exec("ALTER TABLE cash_balances_new RENAME TO cash_balances;");
  database.exec("PRAGMA foreign_keys = ON;");
}

function createHoldingLotsTable(database, tableName = "holding_lots") {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      original_quantity REAL NOT NULL CHECK (original_quantity >= 0),
      quantity REAL NOT NULL CHECK (quantity >= 0),
      purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
      purchase_currency TEXT NOT NULL,
      purchase_date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_event_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
  `);
}

function migrateHoldingLotsCurrency(database) {
  if (!tableSql(database, "holding_lots").includes("purchase_currency IN ('USD','AUD','GBP')")) return;

  const existingRows = database.prepare("SELECT * FROM holding_lots").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createHoldingLotsTable(database, "holding_lots_new");
  const insert = database.prepare(`
    INSERT INTO holding_lots_new (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, source_event_id, notes,
      created_at, updated_at, closed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(
      row.id,
      row.user_id,
      row.ticker,
      row.original_quantity,
      row.quantity,
      row.purchase_price,
      row.purchase_currency,
      row.purchase_date,
      row.source,
      row.source_event_id,
      row.notes,
      row.created_at,
      row.updated_at,
      row.closed_at
    );
  }
  database.exec("DROP TABLE holding_lots;");
  database.exec("ALTER TABLE holding_lots_new RENAME TO holding_lots;");
  database.exec("PRAGMA foreign_keys = ON;");
}

function createRealizedLotsTable(database, tableName = "realized_lots") {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      lot_id TEXT REFERENCES holding_lots(id),
      quantity REAL NOT NULL,
      sale_price REAL NOT NULL,
      sale_currency TEXT NOT NULL,
      sold_at TEXT NOT NULL,
      cost_basis_base REAL NOT NULL,
      proceeds_base REAL NOT NULL,
      gain_loss_base REAL NOT NULL,
      gain_loss_percent REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_event_id TEXT,
      buy_price REAL,
      buy_currency TEXT,
      bought_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function migrateRealizedLotsCurrency(database) {
  if (!tableSql(database, "realized_lots").includes("sale_currency IN ('USD','AUD','GBP')")) return;

  const existingRows = database.prepare("SELECT * FROM realized_lots").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createRealizedLotsTable(database, "realized_lots_new");
  const insert = database.prepare(`
    INSERT INTO realized_lots_new (
      id, user_id, ticker, lot_id, quantity, sale_price, sale_currency, sold_at,
      cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
      source, source_event_id, buy_price, buy_currency, bought_at, notes, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(
      row.id,
      row.user_id,
      row.ticker,
      row.lot_id,
      row.quantity,
      row.sale_price,
      row.sale_currency,
      row.sold_at,
      row.cost_basis_base,
      row.proceeds_base,
      row.gain_loss_base,
      row.gain_loss_percent,
      row.source,
      row.source_event_id,
      row.buy_price ?? null,
      row.buy_currency ?? null,
      row.bought_at ?? null,
      row.notes ?? null,
      row.created_at
    );
  }
  database.exec("DROP TABLE realized_lots;");
  database.exec("ALTER TABLE realized_lots_new RENAME TO realized_lots;");
  database.exec("PRAGMA foreign_keys = ON;");
}

function createPriceAlertsTable(database, tableName = "price_alerts") {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      scope TEXT NOT NULL CHECK (scope IN ('EQUITY','LOT','WATCHLIST')),
      lot_id TEXT REFERENCES holding_lots(id) ON DELETE CASCADE,
      watchlist_item_id TEXT REFERENCES watchlist_items(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('ABOVE','BELOW')),
      threshold_price REAL NOT NULL CHECK (threshold_price >= 0),
      currency TEXT NOT NULL,
      label TEXT,
      company_name TEXT,
      exchange TEXT,
      strategy_group TEXT,
      alert_type TEXT NOT NULL DEFAULT 'PRICE_ALERT',
      priority TEXT NOT NULL DEFAULT 'medium',
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      active INTEGER NOT NULL DEFAULT 1,
      triggered INTEGER NOT NULL DEFAULT 0,
      triggered_at TEXT,
      acknowledged_at TEXT,
      archived_at TEXT,
      snoozed_until TEXT,
      last_triggered_at TEXT,
      last_triggered_price REAL,
      last_reset_price REAL,
      cooldown_minutes INTEGER NOT NULL DEFAULT 1440,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migratePriceAlertsCurrency(database) {
  if (!tableSql(database, "price_alerts").includes("currency IN ('USD','AUD','GBP')")) return;

  const existingRows = database.prepare("SELECT * FROM price_alerts").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createPriceAlertsTable(database, "price_alerts_new");
  const insert = database.prepare(`
    INSERT INTO price_alerts_new (
      id, user_id, ticker, scope, lot_id, watchlist_item_id, direction,
      threshold_price, currency, label, company_name, exchange, strategy_group,
      alert_type, priority, note, source, active, triggered, triggered_at,
      acknowledged_at, archived_at, snoozed_until, last_triggered_at,
      last_triggered_price, last_reset_price,
      cooldown_minutes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(
      row.id,
      row.user_id,
      row.ticker,
      row.scope,
      row.lot_id,
      row.watchlist_item_id,
      row.direction,
      row.threshold_price,
      row.currency,
      row.label,
      row.company_name ?? null,
      row.exchange ?? null,
      row.strategy_group ?? null,
      row.alert_type ?? "PRICE_ALERT",
      row.priority ?? "medium",
      row.note ?? null,
      row.source ?? "manual",
      row.active,
      row.triggered,
      row.triggered_at ?? null,
      row.acknowledged_at ?? null,
      row.archived_at ?? null,
      row.snoozed_until ?? null,
      row.last_triggered_at,
      row.last_triggered_price ?? null,
      row.last_reset_price ?? null,
      row.cooldown_minutes,
      row.created_at,
      row.updated_at
    );
  }
  database.exec("DROP TABLE price_alerts;");
  database.exec("ALTER TABLE price_alerts_new RENAME TO price_alerts;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(user_id, active, ticker);");
}

function createWatchlistItemsTable(database, tableName = "watchlist_items") {
  database.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL REFERENCES equities(ticker),
      target_price REAL,
      buy_zone_low REAL,
      buy_zone_high REAL,
      add_zone_low REAL,
      add_zone_high REAL,
      fair_value REAL,
      trim_price REAL,
      currency TEXT NOT NULL,
      category_id TEXT REFERENCES categories(id),
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, watchlist_id, ticker)
    );
  `);
}

function defaultWatchlistId(database, userId) {
  const existing = database.prepare("SELECT id FROM watchlists WHERE user_id = ? AND name = 'Default'").get(userId);
  if (existing) return existing.id;
  const now = nowIso();
  const watchlistId = id("watchlist");
  database.prepare(`
    INSERT INTO watchlists (id, user_id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, 'Default', 0, ?, ?)
  `).run(watchlistId, userId, now, now);
  return watchlistId;
}

function migrateWatchlistItems(database) {
  database.prepare("SELECT id FROM users").all().forEach((user) => defaultWatchlistId(database, user.id));
  const columns = database.prepare("PRAGMA table_info(watchlist_items)").all();
  if (columns.some((column) => column.name === "watchlist_id")) return;

  const existingRows = database.prepare("SELECT * FROM watchlist_items").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createWatchlistItemsTable(database, "watchlist_items_new");
  const insert = database.prepare(`
    INSERT INTO watchlist_items_new (
      id, user_id, watchlist_id, ticker, target_price, currency, category_id,
      note, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(
      row.id,
      row.user_id,
      defaultWatchlistId(database, row.user_id),
      row.ticker,
      row.target_price,
      row.currency,
      row.category_id,
      row.note,
      row.created_at,
      row.updated_at
    );
  }
  database.exec("DROP TABLE watchlist_items;");
  database.exec("ALTER TABLE watchlist_items_new RENAME TO watchlist_items;");
  database.exec("PRAGMA foreign_keys = ON;");
}

function migrateWatchlistItemsCurrency(database) {
  if (!tableSql(database, "watchlist_items").includes("currency IN ('USD','AUD','GBP')")) return;

  const existingRows = database.prepare("SELECT * FROM watchlist_items").all();
  database.exec("PRAGMA foreign_keys = OFF;");
  createWatchlistItemsTable(database, "watchlist_items_new");
  const insert = database.prepare(`
    INSERT INTO watchlist_items_new (
      id, user_id, watchlist_id, ticker, target_price, buy_zone_low, buy_zone_high,
      add_zone_low, add_zone_high, fair_value, trim_price, currency, category_id,
      note, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of existingRows) {
    insert.run(
      row.id,
      row.user_id,
      row.watchlist_id,
      row.ticker,
      row.target_price,
      row.buy_zone_low,
      row.buy_zone_high,
      row.add_zone_low,
      row.add_zone_high,
      row.fair_value,
      row.trim_price,
      row.currency,
      row.category_id,
      row.note,
      row.created_at,
      row.updated_at
    );
  }
  database.exec("DROP TABLE watchlist_items;");
  database.exec("ALTER TABLE watchlist_items_new RENAME TO watchlist_items;");
  database.exec("PRAGMA foreign_keys = ON;");
}

function ensureColumn(database, table, column, definition) {
  const exists = database.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);
  if (!exists) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

const DEFAULT_EQUITY_RISK_SETTINGS = [
  {
    ticker: "MU",
    buyBlocked: false,
    maxBuyWeightPercent: 15,
    riskNote: "Memory concentration limit: review instead of adding above 15% portfolio weight."
  },
  {
    ticker: "LNW.AX",
    buyBlocked: true,
    maxBuyWeightPercent: 0,
    riskNote: "Position is marked do-not-add until the risk setting is changed."
  }
];

function seedDefaultEquityRiskSettings(database, now) {
  const update = database.prepare(`
    UPDATE equities
    SET buy_blocked = CASE
          WHEN buy_blocked = 0 AND max_buy_weight_percent IS NULL AND risk_note IS NULL THEN ?
          ELSE buy_blocked
        END,
        max_buy_weight_percent = COALESCE(max_buy_weight_percent, ?),
        risk_note = COALESCE(risk_note, ?),
        updated_at = ?
    WHERE ticker = ?
  `);
  for (const setting of DEFAULT_EQUITY_RISK_SETTINGS) {
    update.run(
      setting.buyBlocked ? 1 : 0,
      setting.maxBuyWeightPercent,
      setting.riskNote,
      now,
      normalizeTicker(setting.ticker)
    );
  }
}

function seed(database) {
  const now = nowIso();
  const user = database.prepare("SELECT id FROM users LIMIT 1").get();
  if (!user) {
    database.prepare(`
      INSERT INTO users (id, email, base_currency, created_at)
      VALUES (?, ?, ?, ?)
    `).run("primary-user", config.defaultUserEmail, config.baseCurrency, now);
  }

  const categoryCount = database.prepare("SELECT COUNT(*) AS count FROM categories").get().count;
  if (categoryCount === 0) resetDefaultPortfolioGroups(database);
  seedDefaultEquityRiskSettings(database, now);

  const pulseDefaults = [
    ["pulse_ixic", "^IXIC", "Nasdaq", "Index", 1],
    ["pulse_gspc", "^GSPC", "S&P 500", "Index", 2],
    ["pulse_dji", "^DJI", "Dow Jones", "Index", 3],
    ["pulse_axjo", "^AXJO", "ASX 200", "Index", 4],
    ["pulse_audusd", "AUDUSD=X", "AUD/USD", "FX", 5],
    ["pulse_gbpusd", "GBPUSD=X", "GBP/USD", "FX", 6],
    ["pulse_dx", "DX-Y.NYB", "USD Index", "FX", 7],
    ["pulse_btc", "BTC-USD", "Bitcoin", "Crypto", 8],
    ["pulse_tnx", "^TNX", "US 10Y Yield", "Rate", 9],
    ["pulse_vix", "^VIX", "VIX", "Index", 10]
  ];
  const insertPulse = database.prepare(`
    INSERT OR IGNORE INTO market_pulse_items (
      id, user_id, symbol, display_name, category, sort_order, active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const userRow of database.prepare("SELECT id FROM users").all()) {
    for (const row of pulseDefaults) insertPulse.run(`${row[0]}_${userRow.id}`, userRow.id, row[1], row[2], row[3], row[4], now, now);
  }

  const cashId = id("cash");
  database.prepare(`
    INSERT OR IGNORE INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, 'primary-user', ?, 0, ?)
  `).run(cashId, config.baseCurrency, now);

  database.prepare("SELECT id FROM users").all().forEach((row) => defaultWatchlistId(database, row.id));
}

function avoidCategoryNameCollision(database, categoryId, name) {
  const duplicate = database.prepare("SELECT id, name FROM categories WHERE name = ? AND id <> ?").get(name, categoryId);
  if (!duplicate) return;
  database.prepare("UPDATE categories SET name = ?, active = 0 WHERE id = ?")
    .run(`${duplicate.name} (old)`, duplicate.id);
}

export function resetDefaultPortfolioGroups(database = getDb()) {
  const now = nowIso();
  const activeIds = PORTFOLIO_GROUPS.map((group) => group.id);
  for (const group of PORTFOLIO_GROUPS) avoidCategoryNameCollision(database, group.id, group.name);

  const upsertCategory = database.prepare(`
    INSERT INTO categories (id, name, target_percent, sort_order, color, active)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      target_percent = excluded.target_percent,
      sort_order = excluded.sort_order,
      color = excluded.color,
      active = 1
  `);
  for (const group of PORTFOLIO_GROUPS) {
    upsertCategory.run(group.id, group.name, group.targetPercent, group.sortOrder, group.color);
  }

  database.prepare(`UPDATE categories SET active = 0 WHERE id NOT IN (${activeIds.map(() => "?").join(",")})`)
    .run(...activeIds);

  const updateEquity = database.prepare("UPDATE equities SET category_id = ?, updated_at = ? WHERE ticker = ?");
  const updateWatchlist = database.prepare("UPDATE watchlist_items SET category_id = ?, updated_at = ? WHERE ticker = ?");
  for (const [categoryId, tickers] of Object.entries(PORTFOLIO_GROUP_TICKERS)) {
    for (const ticker of tickers.map(normalizeTicker)) {
      updateEquity.run(categoryId, now, ticker);
      updateWatchlist.run(categoryId, now, ticker);
    }
  }

  return {
    groups: PORTFOLIO_GROUPS.map((group) => ({
      id: group.id,
      name: group.name,
      targetPercent: group.targetPercent,
      sortOrder: group.sortOrder,
      color: group.color
    }))
  };
}

export function getPrimaryUser() {
  return getDb().prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get();
}

export function transaction(work) {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    const result = work(database);
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
