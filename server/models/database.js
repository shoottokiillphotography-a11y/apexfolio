/**
 * ApexFolio — Database (Drop 1: transaction-ledger architecture)
 *
 * ARCHITECTURE: The `transactions` table is the SINGLE SOURCE OF TRUTH.
 * Holdings, realised gains, and closed positions are all DERIVED from
 * transactions (see services/ledgerService.js). The `lots` table is a
 * materialised view of open buy-tax-lots, rebuilt from the ledger, so the
 * UI can do fast specific-lot selling without recomputing on every read.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/apexfolio.db');

let db;
function getDb() {
  if (!db) throw new Error('DB not initialised');
  return db;
}

async function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      is_verified   INTEGER NOT NULL DEFAULT 0,
      verify_token  TEXT,
      reset_token   TEXT,
      reset_expires TEXT,
      ai_key_enc    TEXT,
      ai_key_iv     TEXT,
      prefs_json    TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS portfolios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL DEFAULT 'My Portfolio',
      base_currency TEXT    NOT NULL DEFAULT 'AUD',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

    CREATE TABLE IF NOT EXISTS groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      color        TEXT    DEFAULT '#3b82f6',
      target_pct   REAL    DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_portfolio ON groups(portfolio_id);

    CREATE TABLE IF NOT EXISTS securities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      exchange     TEXT,
      currency     TEXT    DEFAULT 'USD',
      group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_securities_portfolio ON securities(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_securities_ticker ON securities(ticker);

    CREATE TABLE IF NOT EXISTS import_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      filename       TEXT,
      source         TEXT    DEFAULT 'netwealth',
      rows_processed INTEGER DEFAULT 0,
      added          INTEGER DEFAULT 0,
      duplicates     INTEGER DEFAULT 0,
      errors         INTEGER DEFAULT 0,
      detail_json    TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_batches_portfolio ON import_batches(portfolio_id);

    CREATE TABLE IF NOT EXISTS transactions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker          TEXT    NOT NULL,
      company_name    TEXT,
      type            TEXT    NOT NULL CHECK(type IN ('buy','sell','dividend','fee')),
      quantity        REAL    NOT NULL DEFAULT 0,
      price           REAL    NOT NULL DEFAULT 0,
      fees            REAL    NOT NULL DEFAULT 0,
      currency        TEXT    NOT NULL DEFAULT 'AUD',
      fx_rate         REAL    NOT NULL DEFAULT 1,
      amount          REAL    NOT NULL DEFAULT 0,
      trade_date      TEXT    NOT NULL,
      settle_date     TEXT,
      matched_lot_id  INTEGER,
      realized_gl     REAL,
      cost_basis      REAL,
      source          TEXT    DEFAULT 'manual',
      import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
      reference       TEXT,
      fingerprint     TEXT,
      notes           TEXT,
      rationale       TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_portfolio ON transactions(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_txn_ticker ON transactions(ticker);
    CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(trade_date);
    CREATE INDEX IF NOT EXISTS idx_txn_fingerprint ON transactions(fingerprint);

    CREATE TABLE IF NOT EXISTS lots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      buy_txn_id     INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      quantity       REAL    NOT NULL,
      remaining_qty  REAL    NOT NULL,
      cost_per_share REAL    NOT NULL,
      currency       TEXT    DEFAULT 'AUD',
      trade_date     TEXT    NOT NULL,
      notes          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_lots_ticker ON lots(ticker);

    CREATE TABLE IF NOT EXISTS alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      kind           TEXT    NOT NULL DEFAULT 'custom'
                      CHECK(kind IN ('buy_below','review_below','review_above','trim_above','take_profit','stop_loss','custom')),
      direction      TEXT    NOT NULL CHECK(direction IN ('above','below')),
      threshold      REAL    NOT NULL,
      email          TEXT,
      status         TEXT    NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','paused','triggered')),
      last_triggered TEXT,
      cooldown_mins  INTEGER NOT NULL DEFAULT 1440,
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_portfolio ON alerts(portfolio_id);

    CREATE TABLE IF NOT EXISTS executed_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      ticker        TEXT    NOT NULL,
      kind          TEXT,
      target_price  REAL,
      trigger_price REAL,
      triggered_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      status        TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','reviewed','ignored','acted')),
      email_sent    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_exec_alerts_alert ON executed_alerts(alert_id);

    CREATE TABLE IF NOT EXISTS watchlist (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      target_price REAL,
      notes        TEXT,
      added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id      INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      ticker            TEXT,
      recipient_email   TEXT,
      subject           TEXT,
      status            TEXT DEFAULT 'sent',
      error_msg         TEXT,
      sent_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      ticker      TEXT PRIMARY KEY,
      price       REAL NOT NULL,
      change      REAL,
      change_pct  REAL,
      currency    TEXT DEFAULT 'USD',
      source      TEXT DEFAULT 'finnhub',
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ══ PORTFOLIO SNAPSHOTS — daily value history for performance ════════════
    -- One row per portfolio per day. Enables day/week/month/YTD/1y/3y/5y/all-time
    -- returns. Recorded by the daily snapshot cron, and backfillable from the
    -- transaction ledger + historical prices (Drop 2).
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      snapshot_date TEXT    NOT NULL,            -- YYYY-MM-DD
      market_value  REAL    NOT NULL DEFAULT 0,  -- value of open holdings (base ccy)
      cost_basis    REAL    NOT NULL DEFAULT 0,  -- cost of open holdings
      cash          REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      realised_cum  REAL    NOT NULL DEFAULT 0,  -- cumulative realised to that date
      total_value   REAL    NOT NULL DEFAULT 0,  -- market_value + cash
      source        TEXT    DEFAULT 'cron',       -- cron | backfill
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_psnap_portfolio ON portfolio_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_psnap_date ON portfolio_snapshots(snapshot_date);

    -- ══ GROUP SNAPSHOTS — daily value history per group ══════════════════════
    CREATE TABLE IF NOT EXISTS group_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      group_id      INTEGER,                      -- NULL = Uncategorized
      group_name    TEXT,
      snapshot_date TEXT    NOT NULL,
      market_value  REAL    NOT NULL DEFAULT 0,
      cost_basis    REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      source        TEXT    DEFAULT 'cron',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, group_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_gsnap_portfolio ON group_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_gsnap_date ON group_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS corporate_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      event_date   TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      source_id    TEXT,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticker, event_type, event_date, source_id)
    );

    CREATE TABLE IF NOT EXISTS cash_holdings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL,
      label         TEXT,
      currency      TEXT NOT NULL DEFAULT 'AUD',
      amount        REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS external_gains (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL,
      broker        TEXT,
      description   TEXT NOT NULL,
      inv_type      TEXT,
      date_bought   TEXT,
      date_sold     TEXT,
      amount        REAL NOT NULL DEFAULT 0,
      direction     TEXT NOT NULL DEFAULT 'gain',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );
  `);

  console.log('[DB] Drop 1 + Drop 2 schema ready ✅');
  return db;
}

module.exports = { getDb, initDb };
      password_hash TEXT    NOT NULL,
      is_verified   INTEGER NOT NULL DEFAULT 0,
      verify_token  TEXT,
      reset_token   TEXT,
      reset_expires TEXT,
      ai_key_enc    TEXT,
      ai_key_iv     TEXT,
      prefs_json    TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS portfolios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL DEFAULT 'My Portfolio',
      base_currency TEXT    NOT NULL DEFAULT 'AUD',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

    CREATE TABLE IF NOT EXISTS groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      color        TEXT    DEFAULT '#3b82f6',
      target_pct   REAL    DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_portfolio ON groups(portfolio_id);

    CREATE TABLE IF NOT EXISTS securities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      exchange     TEXT,
      currency     TEXT    DEFAULT 'USD',
      group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_securities_portfolio ON securities(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_securities_ticker ON securities(ticker);

    CREATE TABLE IF NOT EXISTS import_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      filename       TEXT,
      source         TEXT    DEFAULT 'netwealth',
      rows_processed INTEGER DEFAULT 0,
      added          INTEGER DEFAULT 0,
      duplicates     INTEGER DEFAULT 0,
      errors         INTEGER DEFAULT 0,
      detail_json    TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_batches_portfolio ON import_batches(portfolio_id);

    CREATE TABLE IF NOT EXISTS transactions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker          TEXT    NOT NULL,
      company_name    TEXT,
      type            TEXT    NOT NULL CHECK(type IN ('buy','sell','dividend','fee')),
      quantity        REAL    NOT NULL DEFAULT 0,
      price           REAL    NOT NULL DEFAULT 0,
      fees            REAL    NOT NULL DEFAULT 0,
      currency        TEXT    NOT NULL DEFAULT 'AUD',
      fx_rate         REAL    NOT NULL DEFAULT 1,
      amount          REAL    NOT NULL DEFAULT 0,
      trade_date      TEXT    NOT NULL,
      settle_date     TEXT,
      matched_lot_id  INTEGER,
      realized_gl     REAL,
      cost_basis      REAL,
      source          TEXT    DEFAULT 'manual',
      import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
      reference       TEXT,
      fingerprint     TEXT,
      notes           TEXT,
      rationale       TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_portfolio ON transactions(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_txn_ticker ON transactions(ticker);
    CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(trade_date);
    CREATE INDEX IF NOT EXISTS idx_txn_fingerprint ON transactions(fingerprint);

    CREATE TABLE IF NOT EXISTS lots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      buy_txn_id     INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      quantity       REAL    NOT NULL,
      remaining_qty  REAL    NOT NULL,
      cost_per_share REAL    NOT NULL,
      currency       TEXT    DEFAULT 'AUD',
      trade_date     TEXT    NOT NULL,
      notes          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_lots_ticker ON lots(ticker);

    CREATE TABLE IF NOT EXISTS alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      kind           TEXT    NOT NULL DEFAULT 'custom'
                      CHECK(kind IN ('buy_below','review_below','review_above','trim_above','take_profit','stop_loss','custom')),
      direction      TEXT    NOT NULL CHECK(direction IN ('above','below')),
      threshold      REAL    NOT NULL,
      email          TEXT,
      status         TEXT    NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','paused','triggered')),
      last_triggered TEXT,
      cooldown_mins  INTEGER NOT NULL DEFAULT 1440,
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_portfolio ON alerts(portfolio_id);

    CREATE TABLE IF NOT EXISTS executed_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      ticker        TEXT    NOT NULL,
      kind          TEXT,
      target_price  REAL,
      trigger_price REAL,
      triggered_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      status        TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','reviewed','ignored','acted')),
      email_sent    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_exec_alerts_alert ON executed_alerts(alert_id);

    CREATE TABLE IF NOT EXISTS watchlist (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      target_price REAL,
      notes        TEXT,
      added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id      INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      ticker            TEXT,
      recipient_email   TEXT,
      subject           TEXT,
      status            TEXT DEFAULT 'sent',
      error_msg         TEXT,
      sent_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      ticker      TEXT PRIMARY KEY,
      price       REAL NOT NULL,
      change      REAL,
      change_pct  REAL,
      currency    TEXT DEFAULT 'USD',
      source      TEXT DEFAULT 'finnhub',
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ══ PORTFOLIO SNAPSHOTS — daily value history for performance ════════════
    -- One row per portfolio per day. Enables day/week/month/YTD/1y/3y/5y/all-time
    -- returns. Recorded by the daily snapshot cron, and backfillable from the
    -- transaction ledger + historical prices (Drop 2).
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      snapshot_date TEXT    NOT NULL,            -- YYYY-MM-DD
      market_value  REAL    NOT NULL DEFAULT 0,  -- value of open holdings (base ccy)
      cost_basis    REAL    NOT NULL DEFAULT 0,  -- cost of open holdings
      cash          REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      realised_cum  REAL    NOT NULL DEFAULT 0,  -- cumulative realised to that date
      total_value   REAL    NOT NULL DEFAULT 0,  -- market_value + cash
      source        TEXT    DEFAULT 'cron',       -- cron | backfill
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_psnap_portfolio ON portfolio_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_psnap_date ON portfolio_snapshots(snapshot_date);

    -- ══ GROUP SNAPSHOTS — daily value history per group ══════════════════════
    CREATE TABLE IF NOT EXISTS group_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      group_id      INTEGER,                      -- NULL = Uncategorized
      group_name    TEXT,
      snapshot_date TEXT    NOT NULL,
      market_value  REAL    NOT NULL DEFAULT 0,
      cost_basis    REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      source        TEXT    DEFAULT 'cron',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, group_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_gsnap_portfolio ON group_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_gsnap_date ON group_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS corporate_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      event_date   TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      source_id    TEXT,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticker, event_type, event_date, source_id)
    );

    CREATE TABLE IF NOT EXISTS cash_holdings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL,
      label         TEXT,
      currency      TEXT NOT NULL DEFAULT 'AUD',
      amount        REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS external_gains (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL,
      broker        TEXT,
      description   TEXT NOT NULL,
      inv_type      TEXT,
      date_bought   TEXT,
      date_sold     TEXT,
      amount        REAL NOT NULL DEFAULT 0,
      direction     TEXT NOT NULL DEFAULT 'gain',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );
  `);

  console.log('[DB] Drop 1 + Drop 2 schema ready ✅');
  return db;
}

module.exports = { getDb, initDb };
      password_hash TEXT    NOT NULL,
      is_verified   INTEGER NOT NULL DEFAULT 0,
      verify_token  TEXT,
      reset_token   TEXT,
      reset_expires TEXT,
      ai_key_enc    TEXT,
      ai_key_iv     TEXT,
      prefs_json    TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS portfolios (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT    NOT NULL DEFAULT 'My Portfolio',
      base_currency TEXT    NOT NULL DEFAULT 'AUD',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

    CREATE TABLE IF NOT EXISTS groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      color        TEXT    DEFAULT '#3b82f6',
      target_pct   REAL    DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_portfolio ON groups(portfolio_id);

    CREATE TABLE IF NOT EXISTS securities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      exchange     TEXT,
      currency     TEXT    DEFAULT 'USD',
      group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_securities_portfolio ON securities(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_securities_ticker ON securities(ticker);

    CREATE TABLE IF NOT EXISTS import_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      filename       TEXT,
      source         TEXT    DEFAULT 'netwealth',
      rows_processed INTEGER DEFAULT 0,
      added          INTEGER DEFAULT 0,
      duplicates     INTEGER DEFAULT 0,
      errors         INTEGER DEFAULT 0,
      detail_json    TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_batches_portfolio ON import_batches(portfolio_id);

    CREATE TABLE IF NOT EXISTS transactions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker          TEXT    NOT NULL,
      company_name    TEXT,
      type            TEXT    NOT NULL CHECK(type IN ('buy','sell','dividend','fee')),
      quantity        REAL    NOT NULL DEFAULT 0,
      price           REAL    NOT NULL DEFAULT 0,
      fees            REAL    NOT NULL DEFAULT 0,
      currency        TEXT    NOT NULL DEFAULT 'AUD',
      fx_rate         REAL    NOT NULL DEFAULT 1,
      amount          REAL    NOT NULL DEFAULT 0,
      trade_date      TEXT    NOT NULL,
      settle_date     TEXT,
      matched_lot_id  INTEGER,
      realized_gl     REAL,
      cost_basis      REAL,
      source          TEXT    DEFAULT 'manual',
      import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
      reference       TEXT,
      fingerprint     TEXT,
      notes           TEXT,
      rationale       TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_portfolio ON transactions(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_txn_ticker ON transactions(ticker);
    CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(trade_date);
    CREATE INDEX IF NOT EXISTS idx_txn_fingerprint ON transactions(fingerprint);

    CREATE TABLE IF NOT EXISTS lots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      buy_txn_id     INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      quantity       REAL    NOT NULL,
      remaining_qty  REAL    NOT NULL,
      cost_per_share REAL    NOT NULL,
      currency       TEXT    DEFAULT 'AUD',
      trade_date     TEXT    NOT NULL,
      notes          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_lots_ticker ON lots(ticker);

    CREATE TABLE IF NOT EXISTS alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id   INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker         TEXT    NOT NULL,
      kind           TEXT    NOT NULL DEFAULT 'custom'
                      CHECK(kind IN ('buy_below','review_below','review_above','trim_above','take_profit','stop_loss','custom')),
      direction      TEXT    NOT NULL CHECK(direction IN ('above','below')),
      threshold      REAL    NOT NULL,
      email          TEXT,
      status         TEXT    NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','paused','triggered')),
      last_triggered TEXT,
      cooldown_mins  INTEGER NOT NULL DEFAULT 1440,
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_portfolio ON alerts(portfolio_id);

    CREATE TABLE IF NOT EXISTS executed_alerts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id      INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      ticker        TEXT    NOT NULL,
      kind          TEXT,
      target_price  REAL,
      trigger_price REAL,
      triggered_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      status        TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','reviewed','ignored','acted')),
      email_sent    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_exec_alerts_alert ON executed_alerts(alert_id);

    CREATE TABLE IF NOT EXISTS watchlist (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      ticker       TEXT    NOT NULL,
      company_name TEXT,
      target_price REAL,
      notes        TEXT,
      added_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, ticker)
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id      INTEGER REFERENCES portfolios(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      ticker            TEXT,
      recipient_email   TEXT,
      subject           TEXT,
      status            TEXT DEFAULT 'sent',
      error_msg         TEXT,
      sent_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      ticker      TEXT PRIMARY KEY,
      price       REAL NOT NULL,
      change      REAL,
      change_pct  REAL,
      currency    TEXT DEFAULT 'USD',
      source      TEXT DEFAULT 'finnhub',
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ══ PORTFOLIO SNAPSHOTS — daily value history for performance ════════════
    -- One row per portfolio per day. Enables day/week/month/YTD/1y/3y/5y/all-time
    -- returns. Recorded by the daily snapshot cron, and backfillable from the
    -- transaction ledger + historical prices (Drop 2).
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      snapshot_date TEXT    NOT NULL,            -- YYYY-MM-DD
      market_value  REAL    NOT NULL DEFAULT 0,  -- value of open holdings (base ccy)
      cost_basis    REAL    NOT NULL DEFAULT 0,  -- cost of open holdings
      cash          REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      realised_cum  REAL    NOT NULL DEFAULT 0,  -- cumulative realised to that date
      total_value   REAL    NOT NULL DEFAULT 0,  -- market_value + cash
      source        TEXT    DEFAULT 'cron',       -- cron | backfill
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_psnap_portfolio ON portfolio_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_psnap_date ON portfolio_snapshots(snapshot_date);

    -- ══ GROUP SNAPSHOTS — daily value history per group ══════════════════════
    CREATE TABLE IF NOT EXISTS group_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id  INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      group_id      INTEGER,                      -- NULL = Uncategorized
      group_name    TEXT,
      snapshot_date TEXT    NOT NULL,
      market_value  REAL    NOT NULL DEFAULT 0,
      cost_basis    REAL    NOT NULL DEFAULT 0,
      unrealised_gl REAL    NOT NULL DEFAULT 0,
      source        TEXT    DEFAULT 'cron',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(portfolio_id, group_id, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_gsnap_portfolio ON group_snapshots(portfolio_id);
    CREATE INDEX IF NOT EXISTS idx_gsnap_date ON group_snapshots(snapshot_date);

    CREATE TABLE IF NOT EXISTS corporate_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      event_date   TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      source_id    TEXT,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ticker, event_type, event_date, source_id)
    );
  `);

  console.log('[DB] Drop 1 schema ready ✅');
  return db;
}

module.exports = { getDb, initDb };
