import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { InputError } from "../utils.js";

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
  return String(sourceEventId || "").replace(/:\d+$/, "");
}

function baseAmount(amount, currency, baseCurrency) {
  if (String(currency || "").toUpperCase() !== String(baseCurrency || "").toUpperCase()) {
    throw new InputError(`The LNW repair expects ${baseCurrency} rows. Found ${currency}.`);
  }
  return money(amount);
}

function newestCheapestSort(a, b) {
  const dateDiff = String(b.purchase_date).localeCompare(String(a.purchase_date));
  if (dateDiff) return dateDiff;
  const costDiff = Number(a.purchase_price) - Number(b.purchase_price);
  if (costDiff) return costDiff;
  return String(b.created_at || "").localeCompare(String(a.created_at || ""));
}

function compactLot(lot) {
  return {
    id: lot.id,
    date: lot.purchase_date,
    quantity: shares(lot.quantity ?? lot.workingQuantity),
    originalQuantity: shares(lot.original_quantity),
    purchasePrice: money(lot.purchase_price)
  };
}

export function reallocateLightWonderSales(userId, { apply = true } = {}) {
  const ticker = "LNW.AX";
  const fromDate = "2026-06-03";
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new InputError("User not found", 404);

  const targetSales = database.prepare(`
    SELECT *
    FROM realized_lots
    WHERE user_id = ?
      AND ticker = ?
      AND source = 'netwealth'
      AND sold_at >= ?
    ORDER BY sold_at, created_at, source_event_id
  `).all(user.id, ticker, fromDate);
  if (!targetSales.length) {
    throw new InputError(`No Netwealth sales found for ${ticker} from ${fromDate}`);
  }

  const beforeLots = database.prepare(`
    SELECT id, original_quantity, quantity, purchase_price, purchase_currency,
      purchase_date, created_at, closed_at
    FROM holding_lots
    WHERE user_id = ? AND ticker = ?
    ORDER BY purchase_date, created_at
  `).all(user.id, ticker);

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
    if (!sale.lot_id) throw new InputError(`Sale ${sale.id} has no lot_id; refusing repair`);
    restoredQuantityByLot.set(
      sale.lot_id,
      shares((restoredQuantityByLot.get(sale.lot_id) || 0) + Number(sale.quantity || 0))
    );
  }

  const restoredLots = beforeLots.map((lot) => ({
    ...lot,
    workingQuantity: shares(Number(lot.quantity || 0) + (restoredQuantityByLot.get(lot.id) || 0))
  }));
  const saleLots = restoredLots.filter((lot) => Number(lot.workingQuantity) > 0).sort(newestCheapestSort);
  if (shares(saleLots.reduce((total, lot) => total + Number(lot.workingQuantity || 0), 0)) + 1e-8 < totalQuantity) {
    throw new InputError(`Not enough restored quantity to reallocate ${totalQuantity} ${ticker} shares`);
  }

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
        notes: `${group.notes || "Netwealth sale"} | Reallocated to newest/cheapest lots`
      });
      lot.workingQuantity = shares(Number(lot.workingQuantity) - matchedQuantity);
      remaining = shares(remaining - matchedQuantity);
      index += 1;
    }
    if (remaining > 0.000001) throw new InputError(`Unable to allocate ${remaining} shares for ${group.key}`);
  }

  const totalNewCost = money(newSales.reduce((total, sale) => total + Number(sale.costBasisBase || 0), 0));
  const totalNewGain = money(newSales.reduce((total, sale) => total + Number(sale.gainLossBase || 0), 0));
  const totalNewProceeds = money(newSales.reduce((total, sale) => total + Number(sale.proceedsBase || 0), 0));
  const summary = {
    ticker,
    fromDate,
    strategy: "newest-cheapest",
    targetSaleCount: targetSales.length,
    targetSaleQuantity: totalQuantity,
    proceedsBefore: totalProceeds,
    proceedsAfter: totalNewProceeds,
    costBasisBefore: totalOldCost,
    costBasisAfter: totalNewCost,
    realizedGainLossBefore: totalOldGain,
    realizedGainLossAfter: totalNewGain,
    realizedGainLossChange: money(totalNewGain - totalOldGain),
    beforeOpenLots: beforeLots.map(compactLot),
    afterOpenLots: restoredLots.map((lot) => compactLot({ ...lot, quantity: lot.workingQuantity })),
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
  };

  if (!apply) return { applied: false, ...summary };

  database.exec("PRAGMA wal_checkpoint(FULL);");
  const backupPath = `${config.databasePath}.bak-lnw-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(config.databasePath, backupPath);

  database.exec("BEGIN IMMEDIATE;");
  try {
    const now = new Date().toISOString();
    for (const lot of restoredLots) {
      database.prepare(`
        UPDATE holding_lots
        SET quantity = ?, updated_at = ?, closed_at = CASE WHEN ? <= 0.000001 THEN ? ELSE NULL END
        WHERE id = ?
      `).run(lot.workingQuantity, now, lot.workingQuantity, now, lot.id);
    }
    database.prepare(`
      DELETE FROM realized_lots
      WHERE user_id = ?
        AND ticker = ?
        AND source = 'netwealth'
        AND sold_at >= ?
    `).run(user.id, ticker, fromDate);
    const insert = database.prepare(`
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
    database.exec("COMMIT;");
    return { applied: true, backupPath, ...summary };
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
