#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const args = new Set(process.argv.slice(2));
const valueArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
};

const apply = args.has("--apply");
const ticker = valueArg("ticker", "LNW.AX").toUpperCase();
const fromDate = valueArg("from", "2026-06-03");
const strategy = valueArg("strategy", "newest-cheapest");
const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "portfolio.sqlite");

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function shares(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

function percent(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function groupKey(sourceEventId) {
  const value = String(sourceEventId || "");
  return value.replace(/:\d+$/, "");
}

function baseAmount(amount, currency, baseCurrency) {
  if (String(currency || "").toUpperCase() !== String(baseCurrency || "").toUpperCase()) {
    throw new Error(`This one-off repair expects ${baseCurrency} rows. Found ${currency}.`);
  }
  return money(amount);
}

function lotSort(a, b) {
  if (strategy === "lowest-cost") return Number(a.purchase_price) - Number(b.purchase_price);
  if (strategy === "newest") return String(b.purchase_date).localeCompare(String(a.purchase_date));
  // For this LNW.AX repair: sell the newest parcels, and when same-day parcels
  // exist, take the cheapest first because that is what the broker disposal used.
  const dateDiff = String(b.purchase_date).localeCompare(String(a.purchase_date));
  if (dateDiff) return dateDiff;
  const costDiff = Number(a.purchase_price) - Number(b.purchase_price);
  if (costDiff) return costDiff;
  return String(b.created_at || "").localeCompare(String(a.created_at || ""));
}

function snapshot(db, userId) {
  const lots = db.prepare(`
    SELECT id, original_quantity, quantity, purchase_price, purchase_currency,
      purchase_date, created_at, closed_at
    FROM holding_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY purchase_date, created_at
  `).all(userId, ticker);
  const sales = db.prepare(`
    SELECT id, lot_id, quantity, sale_price, sale_currency, sold_at,
      cost_basis_base, proceeds_base, gain_loss_base, source_event_id
    FROM realized_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY sold_at, source_event_id
  `).all(userId, ticker);
  return {
    openShares: shares(lots.reduce((total, lot) => total + Number(lot.quantity || 0), 0)),
    realized: money(sales.reduce((total, sale) => total + Number(sale.gain_loss_base || 0), 0)),
    lots,
    sales
  };
}

function formatLots(lots) {
  return lots.map((lot) => ({
    date: lot.purchase_date,
    qty: shares(lot.quantity),
    original: shares(lot.original_quantity),
    cost: money(lot.purchase_price),
    id: lot.id
  }));
}

function main() {
  if (!fs.existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");

  const user = db.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get();
  if (!user) throw new Error("No user found");

  const targetSales = db.prepare(`
    SELECT *
    FROM realized_lots
    WHERE user_id = ?
      AND ticker = ?
      AND source = 'netwealth'
      AND sold_at >= ?
    ORDER BY sold_at, created_at, source_event_id
  `).all(user.id, ticker, fromDate);
  if (!targetSales.length) throw new Error(`No Netwealth sales found for ${ticker} from ${fromDate}`);

  const before = snapshot(db, user.id);
  const totalQuantity = shares(targetSales.reduce((total, sale) => total + Number(sale.quantity || 0), 0));
  const totalProceeds = money(targetSales.reduce((total, sale) => total + Number(sale.proceeds_base || 0), 0));
  const totalOldCost = money(targetSales.reduce((total, sale) => total + Number(sale.cost_basis_base || 0), 0));
  const totalOldGain = money(targetSales.reduce((total, sale) => total + Number(sale.gain_loss_base || 0), 0));

  const groups = [...targetSales.reduce((map, sale) => {
    const key = groupKey(sale.source_event_id) || sale.id;
    const current = map.get(key) || {
      key,
      soldAt: sale.sold_at,
      salePrice: Number(sale.sale_price),
      saleCurrency: sale.sale_currency,
      quantity: 0,
      proceedsBase: 0,
      notes: sale.notes || ""
    };
    current.quantity = shares(current.quantity + Number(sale.quantity || 0));
    current.proceedsBase = money(current.proceedsBase + Number(sale.proceeds_base || 0));
    map.set(key, current);
    return map;
  }, new Map()).values()].sort((a, b) => (
    String(a.soldAt).localeCompare(String(b.soldAt))
    || String(a.key).localeCompare(String(b.key))
  ));

  const restoredQuantityByLot = new Map();
  for (const sale of targetSales) {
    if (!sale.lot_id) throw new Error(`Sale ${sale.id} has no lot_id; refusing repair`);
    restoredQuantityByLot.set(
      sale.lot_id,
      shares((restoredQuantityByLot.get(sale.lot_id) || 0) + Number(sale.quantity || 0))
    );
  }

  const restoredLots = db.prepare(`
    SELECT *
    FROM holding_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY purchase_date, created_at
  `).all(user.id, ticker).map((lot) => ({
    ...lot,
    workingQuantity: shares(Number(lot.quantity || 0) + (restoredQuantityByLot.get(lot.id) || 0))
  }));

  if (shares(restoredLots.reduce((total, lot) => total + Number(lot.workingQuantity || 0), 0)) + 1e-8 < totalQuantity) {
    throw new Error(`Not enough restored quantity to reallocate ${totalQuantity} ${ticker} shares`);
  }

  const saleLots = restoredLots
    .filter((lot) => Number(lot.workingQuantity) > 0)
    .sort(lotSort);
  const newSales = [];
  for (const group of groups) {
    let remaining = Number(group.quantity);
    let index = 0;
    for (const lot of saleLots) {
      if (remaining <= 0) break;
      if (Number(lot.workingQuantity) <= 0) continue;
      const matchedQuantity = shares(Math.min(Number(lot.workingQuantity), remaining));
      const costBasisBase = baseAmount(matchedQuantity * Number(lot.purchase_price), lot.purchase_currency, user.base_currency);
      const proceedsBase = baseAmount(matchedQuantity * Number(group.salePrice), group.saleCurrency, user.base_currency);
      const gainLossBase = money(proceedsBase - costBasisBase);
      newSales.push({
        id: `realized_realloc_${randomUUID().replaceAll("-", "")}`,
        ticker,
        lotId: lot.id,
        quantity: matchedQuantity,
        salePrice: group.salePrice,
        saleCurrency: group.saleCurrency,
        soldAt: group.soldAt,
        costBasisBase,
        proceedsBase,
        gainLossBase,
        gainLossPercent: costBasisBase ? percent((gainLossBase / costBasisBase) * 100) : 0,
        sourceEventId: `${group.key}:${index}`,
        buyPrice: lot.purchase_price,
        buyCurrency: lot.purchase_currency,
        boughtAt: lot.purchase_date,
        notes: `${group.notes || "Netwealth sale"} | Reallocated by script to ${strategy} lots`
      });
      lot.workingQuantity = shares(Number(lot.workingQuantity) - matchedQuantity);
      remaining = shares(remaining - matchedQuantity);
      index += 1;
    }
    if (remaining > 0.000001) throw new Error(`Unable to allocate ${remaining} shares for ${group.key}`);
  }

  const totalNewCost = money(newSales.reduce((total, sale) => total + Number(sale.costBasisBase || 0), 0));
  const totalNewGain = money(newSales.reduce((total, sale) => total + Number(sale.gainLossBase || 0), 0));
  const totalNewProceeds = money(newSales.reduce((total, sale) => total + Number(sale.proceedsBase || 0), 0));

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    databasePath,
    ticker,
    fromDate,
    strategy,
    targetSaleCount: targetSales.length,
    targetSaleQuantity: totalQuantity,
    proceedsCheck: { before: totalProceeds, after: totalNewProceeds },
    costBasis: { before: totalOldCost, after: totalNewCost },
    realizedGainLoss: { before: totalOldGain, after: totalNewGain, change: money(totalNewGain - totalOldGain) },
    beforeOpenLots: formatLots(before.lots),
    afterOpenLots: formatLots(restoredLots.map((lot) => ({ ...lot, quantity: lot.workingQuantity }))),
    newSaleRows: newSales.map((sale) => ({
      soldAt: sale.soldAt,
      quantity: sale.quantity,
      salePrice: sale.salePrice,
      lotDate: sale.boughtAt,
      lotCost: sale.buyPrice,
      costBasisBase: sale.costBasisBase,
      proceedsBase: sale.proceedsBase,
      gainLossBase: sale.gainLossBase
    }))
  }, null, 2));

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to update the database.");
    return;
  }

  const backupPath = `${databasePath}.bak-lnw-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(databasePath, backupPath);

  db.exec("BEGIN IMMEDIATE;");
  try {
    const now = new Date().toISOString();
    for (const lot of restoredLots) {
      db.prepare(`
        UPDATE holding_lots
        SET quantity = ?, updated_at = ?, closed_at = CASE WHEN ? <= 0.000001 THEN ? ELSE NULL END
        WHERE id = ?
      `).run(lot.workingQuantity, now, lot.workingQuantity, now, lot.id);
    }
    db.prepare(`
      DELETE FROM realized_lots
      WHERE user_id = ?
        AND ticker = ?
        AND source = 'netwealth'
        AND sold_at >= ?
    `).run(user.id, ticker, fromDate);
    const insert = db.prepare(`
      INSERT INTO realized_lots (
        id, user_id, ticker, lot_id, quantity, sale_price, sale_currency, sold_at,
        cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
        source, source_event_id, buy_price, buy_currency, bought_at, notes, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'netwealth', ?, ?, ?, ?, ?, ?)
    `);
    for (const sale of newSales) {
      insert.run(
        sale.id,
        user.id,
        sale.ticker,
        sale.lotId,
        sale.quantity,
        sale.salePrice,
        sale.saleCurrency,
        sale.soldAt,
        sale.costBasisBase,
        sale.proceedsBase,
        sale.gainLossBase,
        sale.gainLossPercent,
        sale.sourceEventId,
        sale.buyPrice,
        sale.buyCurrency,
        sale.boughtAt,
        sale.notes,
        now
      );
    }
    db.exec("COMMIT;");
    console.log(`\nApplied. Backup created: ${backupPath}`);
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

main();
