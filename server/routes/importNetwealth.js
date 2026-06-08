/**
 * Netwealth Import — /api/import/netwealth  (Drop 1: writes to the LEDGER)
 *
 * Parses the "Cash Transaction Listing - Detail" export into buy/sell/dividend/fee
 * transactions, with fingerprint-based duplicate detection and import history.
 *
 * POST /preview  — dry run: shows detected txns, duplicates, realised impact
 * POST /          — commit import (skips duplicates), records an import batch
 * GET  /history   — list previous import batches
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const Papa = require('papaparse');
const { getDb } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Ledger = require('../services/ledgerService');
const Snapshot = require('../services/snapshotService');

router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function portfolioId(db, userId) {
  let p = db.prepare('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1').get(userId);
  if (!p) {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO portfolios (user_id, name, base_currency) VALUES (?, 'My Portfolio', 'AUD')`
    ).run(userId);
    p = { id: lastInsertRowid };
  }
  return p.id;
}

function cleanTicker(code) {
  if (!code) return null;
  return code.replace(/\.(ND|NY|LN|CO|AX|ASX)$/i, '').toUpperCase().trim();
}

function parseNetwealthCSV(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  let headerRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Effective Date')) { headerRow = i; break; }
  }
  if (headerRow === -1) throw new Error('Not a Netwealth "Cash Transaction Listing - Detail" export.');
  const dataText = lines.slice(headerRow).join('\n');
  return Papa.parse(dataText, { header: true, skipEmptyLines: true }).data;
}

function num(v) { return parseFloat(String(v || '0').replace(/[,$]/g, '')) || 0; }

function parseDate(raw) {
  const s = (raw || '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [d, m, y] = s.split('/'); return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

// Convert Netwealth rows → normalised transactions
function extractTransactions(rows) {
  const txns = [];
  const SKIP = ['Closing Cash Balance','Opening Cash Balance','Cash Account Interest','Administration Fees',
    'Family Fee Rebate','Tax on Investment Income','Foreign Exchange Adjustment'];
  const SKIP_CODES = ['FXUSD','FXGBP','FXEUR','FXDKK','FXJPY',''];

  rows.forEach(row => {
    const desc = (row['Description'] || '').trim();
    const code = (row['Code'] || '').trim();
    const asset = (row['Asset'] || '').trim();
    if (SKIP.some(s => desc.startsWith(s))) return;
    if (SKIP_CODES.includes(code)) return;
    if (!code) return;

    const ticker = cleanTicker(code);
    const units = Math.abs(num(row['Units']));
    const buyPrice = num(row['Purchase price']);
    const sellPrice = num(row['Sale price']);
    const debits = num(row['Debits']);
    const credits = num(row['Credits']);
    const date = parseDate(row['Effective Date']);
    const ref = (row['Reference'] || row['Transaction ID'] || '').trim() || null;

    if (!ticker || !date) return;

    if (desc.includes('Asset Purchase') && units > 0 && buyPrice > 0) {
      txns.push({ ticker, company_name: asset, type: 'buy', quantity: units, price: buyPrice,
        fees: 0, currency: 'AUD', amount: -debits, trade_date: date, reference: ref, source: 'netwealth' });
    } else if (desc.includes('Asset Sale') && units > 0 && sellPrice > 0) {
      txns.push({ ticker, company_name: asset, type: 'sell', quantity: units, price: sellPrice,
        fees: 0, currency: 'AUD', amount: credits, trade_date: date, reference: ref, source: 'netwealth' });
    } else if (desc === 'Distribution' && credits > 0) {
      txns.push({ ticker, company_name: asset, type: 'dividend', quantity: 0, price: credits,
        fees: 0, currency: 'AUD', amount: credits, trade_date: date, reference: ref, source: 'netwealth' });
    } else if (desc.includes('Brokerage') && debits > 0) {
      txns.push({ ticker, company_name: asset, type: 'fee', quantity: 0, price: 0,
        fees: debits, currency: 'AUD', amount: -debits, trade_date: date, reference: ref, source: 'netwealth' });
    }
  });
  return txns;
}

// Split incoming txns into new vs duplicate vs possible-duplicate
function classify(db, pid, txns) {
  const existing = new Set(
    db.prepare('SELECT fingerprint FROM transactions WHERE portfolio_id = ?').all(pid)
      .map(r => r.fingerprint)
  );
  const newOnes = [], duplicates = [];
  const seenInBatch = new Set();
  txns.forEach(t => {
    const fp = Ledger.fingerprint(t);
    t.fingerprint = fp;
    if (existing.has(fp) || seenInBatch.has(fp)) duplicates.push(t);
    else { newOnes.push(t); seenInBatch.add(fp); }
  });
  return { newOnes, duplicates };
}

// ─── PREVIEW ──────────────────────────────────────────────────────────────────
router.post('/preview', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDb();
    const pid = portfolioId(db, req.user.id);

    const rows = parseNetwealthCSV(req.file.buffer);
    const txns = extractTransactions(rows);
    const { newOnes, duplicates } = classify(db, pid, txns);

    const counts = {
      rowsProcessed: rows.length,
      detected: txns.length,
      newTransactions: newOnes.length,
      duplicatesSkipped: duplicates.length,
      buys: newOnes.filter(t => t.type === 'buy').length,
      sells: newOnes.filter(t => t.type === 'sell').length,
      dividends: newOnes.filter(t => t.type === 'dividend').length,
      fees: newOnes.filter(t => t.type === 'fee').length,
    };
    const holdingsAffected = [...new Set(newOnes.map(t => t.ticker))];
    res.json({ counts, holdingsAffected, sample: newOnes.slice(0, 25) });
  } catch (err) { next(err); }
});

// ─── COMMIT IMPORT ────────────────────────────────────────────────────────────
router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getDb();
    const pid = portfolioId(db, req.user.id);

    const rows = parseNetwealthCSV(req.file.buffer);
    const txns = extractTransactions(rows);
    const { newOnes, duplicates } = classify(db, pid, txns);

    // Create import batch record
    const batch = db.prepare(`
      INSERT INTO import_batches (portfolio_id, filename, source, rows_processed, added, duplicates, errors)
      VALUES (?,?,?,?,?,?,?)
    `).run(pid, req.file.originalname, 'netwealth', rows.length, newOnes.length, duplicates.length, 0);
    const batchId = batch.lastInsertRowid;

    const ensureSec = db.prepare(`
      INSERT INTO securities (portfolio_id, ticker, company_name, currency) VALUES (?,?,?,?)
      ON CONFLICT(portfolio_id, ticker) DO UPDATE SET company_name = COALESCE(excluded.company_name, company_name)
    `);
    const insert = db.prepare(`
      INSERT INTO transactions
        (portfolio_id, ticker, company_name, type, quantity, price, fees, currency, fx_rate,
         amount, trade_date, source, import_batch_id, reference, fingerprint)
      VALUES
        (@portfolio_id, @ticker, @company_name, @type, @quantity, @price, @fees, @currency, 1,
         @amount, @trade_date, 'netwealth', @batchId, @reference, @fingerprint)
    `);

    const txn = db.transaction(() => {
      newOnes.forEach(t => {
        ensureSec.run(pid, t.ticker, t.company_name, 'AUD');
        insert.run({ ...t, portfolio_id: pid, batchId });
      });
    });
    txn();

    Ledger.refresh(pid);
    // Snapshot now so performance history begins immediately (non-blocking)
    Snapshot.snapshotPortfolio(pid).catch(() => {});
    const realised = Ledger.getRealisedSummary(pid).total;

    res.json({
      success: true,
      batchId,
      added: newOnes.length,
      duplicatesSkipped: duplicates.length,
      realisedTotal: realised,
      message: `Imported ${newOnes.length} transactions. ${duplicates.length} duplicates skipped.`,
    });
  } catch (err) { next(err); }
});

// ─── IMPORT HISTORY ───────────────────────────────────────────────────────────
router.get('/history', (req, res, next) => {
  try {
    const db = getDb();
    const pid = portfolioId(db, req.user.id);
    const batches = db.prepare('SELECT * FROM import_batches WHERE portfolio_id = ? ORDER BY created_at DESC').all(pid);
    res.json({ batches });
  } catch (err) { next(err); }
});

module.exports = router;
