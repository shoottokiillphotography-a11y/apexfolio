import { getDb, transaction } from "../db.js";
import { config } from "../config.js";
import {
  assertCurrency,
  assertFxCurrency,
  clampPercent,
  id,
  InputError,
  normalizeCurrency,
  normalizeFxCurrency,
  normalizeTicker,
  nowIso,
  portfolioGroupIdForTicker,
  roundMoney,
  roundShares,
  roundPercent,
  safeJsonParse,
  toNumber
} from "../utils.js";
import { convertAmount } from "./currency.js";
import { getQuote, refreshTrackedQuotes } from "./market-data.js";
import { listImportBatches } from "./importer.js";
import { resolveWatchlist } from "./watchlists.js";
import { buildIntelligence } from "./intelligence.js";
import { buildDashboardIntelligence } from "./dashboard-intelligence.js";
import { getRules, saveRules, resetRules, DEFAULT_RULES } from "./rules.js";
import { fundamentalsFromRows } from "./fundamentals.js";

const GROUP_PALETTE = [
  "#C9A86A",
  "#8B7CFF",
  "#00C27A",
  "#FFB547",
  "#FF5A67",
  "#5B8DEF",
  "#3FA7D6",
  "#B8BDC7",
  "#7D8592"
];

const MARKET_PULSE_CATEGORIES = new Set(["Index", "FX", "Crypto", "Rate", "Commodity", "Other"]);

function normalizeGroupColor(input, fallback = "#C9A86A") {
  const value = String(input || fallback).trim().toUpperCase();
  const normalized = value.startsWith("#") ? value : `#${value}`;
  if (/^#[0-9A-F]{6}$/.test(normalized)) return normalized;
  return GROUP_PALETTE.find((color) => color.toUpperCase() === normalized) || fallback;
}

function normalizeCategoryActive(input, fallback = true) {
  if (input == null) return fallback;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  const value = String(input).trim().toLowerCase();
  if (["0", "false", "inactive", "off", "no"].includes(value)) return false;
  if (["1", "true", "active", "on", "yes"].includes(value)) return true;
  return fallback;
}

function normalizeMarketPulseCategory(input) {
  const value = String(input || "Other").trim();
  return MARKET_PULSE_CATEGORIES.has(value) ? value : "Other";
}

async function convertOrWarn(amount, fromCurrency, toCurrency, warnings, context) {
  if (amount == null) return null;
  try {
    const converted = await convertAmount(amount, fromCurrency, toCurrency);
    if (converted.stale) {
      warnings.push(`Using stale FX rate for ${fromCurrency}/${toCurrency} on ${context}`);
    }
    return converted.amount;
  } catch (error) {
    warnings.push(`${context}: ${error.message}`);
    return null;
  }
}

function priceFromRow(row) {
  if (!row) return null;
  return {
    ticker: row.ticker,
    price: row.price,
    currency: row.currency,
    previousClose: row.previous_close,
    changeAmount: row.change_amount,
    changePercent: row.change_percent,
    preMarketPrice: row.pre_market_price,
    preMarketTime: row.pre_market_time,
    postMarketPrice: row.post_market_price,
    postMarketTime: row.post_market_time,
    regularMarketPrice: row.regular_market_price,
    dayLow: row.day_low,
    dayHigh: row.day_high,
    fiftyTwoWeekLow: row.fifty_two_week_low,
    fiftyTwoWeekHigh: row.fifty_two_week_high,
    marketCap: row.market_cap,
    volume: row.volume,
    averageVolume: row.average_volume,
    fiftyDayAverage: row.fifty_day_average,
    twoHundredDayAverage: row.two_hundred_day_average,
    marketState: row.market_state,
    exchangeName: row.exchange_name,
    provider: row.provider,
    status: row.status,
    asOf: row.as_of,
    error: row.error
  };
}

function eventSourceUrl(payload) {
  const candidates = [
    payload?.url,
    payload?.articleUrl,
    payload?.link,
    payload?.filingUrl,
    payload?.reportUrl,
    payload?.sourceUrl,
    payload?.report?.url,
    payload?.report?.reportUrl,
    payload?.report?.filingUrl
  ];
  return candidates.find((value) => typeof value === "string" && value.trim()) || null;
}

function tickerRoot(ticker) {
  return String(ticker || "").split(".")[0].replace(/-USD$/i, "");
}

function officialMarketSource(ticker) {
  const symbol = String(ticker || "").toUpperCase();
  const root = encodeURIComponent(tickerRoot(symbol));
  if (symbol.endsWith(".AX")) {
    return {
      label: "ASX announcements",
      url: `https://www.asx.com.au/markets/company/${root}`
    };
  }
  if (symbol.endsWith(".L")) {
    return {
      label: "LSE news",
      url: `https://www.londonstockexchange.com/news?tab=news-explorer&keywords=${root}`
    };
  }
  if (symbol.endsWith(".HK")) {
    return {
      label: "HKEXnews",
      url: "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en"
    };
  }
  if (symbol.endsWith(".CO")) {
    return {
      label: "Nasdaq Nordic announcements",
      url: "https://www.nasdaqomxnordic.com/news/companynews"
    };
  }
  if (!symbol.includes(".") && !symbol.includes("-")) {
    return {
      label: "SEC EDGAR",
      url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(symbol)}&dateRange=all`
    };
  }
  return null;
}

function eventNewsSource(row, payload) {
  return payload?.source || payload?.provider || payload?.site || payload?.publisher || officialMarketSource(row.ticker)?.label || row.source;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function coveredFundamentalStatus(status) {
  return status === "LIVE" || status === "NOT_APPLICABLE";
}

function pushUniqueWarning(warnings, warning) {
  if (warning && !warnings.includes(warning)) warnings.push(warning);
}

export async function calculatePortfolio(userId, { refreshPrices = false } = {}) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const baseCurrency = user.base_currency;
  const warnings = [];

  if (refreshPrices) {
    await refreshTrackedQuotes({ force: true });
  }

  const categories = database.prepare(`
    SELECT c.id, c.name, c.target_percent AS targetPercent, c.sort_order AS sortOrder,
      c.color, c.active
    FROM categories c
    WHERE c.active = 1
      OR c.id IN (
        SELECT e.category_id
        FROM holding_lots l
        JOIN equities e ON e.ticker = l.ticker
        WHERE l.user_id = ? AND l.quantity > 0 AND e.category_id IS NOT NULL
        UNION
        SELECT w.category_id
        FROM watchlist_items w
        WHERE w.user_id = ? AND w.category_id IS NOT NULL
      )
    ORDER BY c.sort_order, c.name
  `).all(userId, userId);

  const categoryTotals = new Map(categories.map((category) => [category.id, {
    ...category,
    subtotalBase: 0,
    actualPercent: 0,
    variancePercent: 0,
    missingOrExcessBase: 0
  }]));

  const lots = database.prepare(`
    SELECT l.*, e.name AS equityName, e.category_id AS categoryId, e.status AS equityStatus,
      e.buy_blocked AS buyBlocked, e.max_buy_weight_percent AS maxBuyWeightPercent,
      e.risk_note AS riskNote, c.name AS categoryName
    FROM holding_lots l
    JOIN equities e ON e.ticker = l.ticker
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE l.user_id = ? AND l.quantity > 0
    ORDER BY l.ticker, l.purchase_date, l.created_at
  `).all(userId);

  const realizedSourceRows = database.prepare(`
    SELECT r.ticker, r.quantity, r.sale_price AS salePrice, r.sale_currency AS saleCurrency,
      r.cost_basis_base AS storedCostBasisBase, r.proceeds_base AS storedProceedsBase,
      r.gain_loss_base AS storedGainLossBase, r.buy_price AS manualBuyPrice,
      r.buy_currency AS manualBuyCurrency, r.bought_at AS manualBoughtAt,
      l.purchase_price AS lotPurchasePrice, l.purchase_currency AS lotPurchaseCurrency,
      l.purchase_date AS lotPurchaseDate
    FROM realized_lots r
    LEFT JOIN holding_lots l ON l.id = r.lot_id
    WHERE r.user_id = ?
  `).all(userId);
  const realizedByTicker = new Map();
  for (const row of realizedSourceRows) {
    const quantity = Number(row.quantity) || 0;
    const buyCurrency = row.lotPurchaseCurrency || row.manualBuyCurrency;
    const buyPrice = row.lotPurchaseCurrency ? row.lotPurchasePrice : row.manualBuyPrice;
    const costBasisBase = buyCurrency
      ? await convertOrWarn(
        quantity * (Number(buyPrice) || 0),
        buyCurrency,
        baseCurrency,
        warnings,
        `${row.ticker} realized cost basis`
      )
      : Number(row.storedCostBasisBase) || 0;
    const proceedsBase = row.saleCurrency
      ? await convertOrWarn(
        quantity * (Number(row.salePrice) || 0),
        row.saleCurrency,
        baseCurrency,
        warnings,
        `${row.ticker} realized proceeds`
      )
      : Number(row.storedProceedsBase) || 0;
    const gainLossBase = costBasisBase != null && proceedsBase != null
      ? roundMoney(proceedsBase - costBasisBase)
      : Number(row.storedGainLossBase) || 0;
    const existing = realizedByTicker.get(row.ticker) || { ticker: row.ticker, costBasisBase: 0, proceedsBase: 0, gainLossBase: 0 };
    existing.costBasisBase += costBasisBase || 0;
    existing.proceedsBase += proceedsBase || 0;
    existing.gainLossBase += gainLossBase || 0;
    realizedByTicker.set(row.ticker, existing);
  }
  const realizedRows = [...realizedByTicker.values()].map((row) => ({
    ticker: row.ticker,
    costBasisBase: roundMoney(row.costBasisBase),
    proceedsBase: roundMoney(row.proceedsBase),
    gainLossBase: roundMoney(row.gainLossBase)
  }));

  const dividendSourceRows = database.prepare(`
    SELECT id, ticker, ex_date AS exDate, pay_date AS payDate, record_date AS recordDate,
      amount_per_share AS amountPerShare, currency, eligible_quantity AS eligibleQuantity,
      gross_amount AS grossAmount, gross_amount_base AS storedGrossAmountBase,
      source, created_at AS createdAt, updated_at AS updatedAt
    FROM dividend_payments
    WHERE user_id = ?
    ORDER BY ex_date DESC, ticker
  `).all(userId);
  const dividendsByTicker = new Map();
  const dividends = [];
  for (const row of dividendSourceRows) {
    const grossAmountBase = await convertOrWarn(
      row.grossAmount,
      row.currency,
      baseCurrency,
      warnings,
      `${row.ticker} dividend`
    );
    const convertedGrossAmountBase = roundMoney(grossAmountBase ?? (Number(row.storedGrossAmountBase) || 0));
    dividends.push({
      ...row,
      grossAmountBase: convertedGrossAmountBase
    });
    const existing = dividendsByTicker.get(row.ticker) || { ticker: row.ticker, dividendIncomeBase: 0 };
    existing.dividendIncomeBase += convertedGrossAmountBase || 0;
    dividendsByTicker.set(row.ticker, existing);
  }
  const dividendRows = [...dividendsByTicker.values()].map((row) => ({
    ticker: row.ticker,
    dividendIncomeBase: roundMoney(row.dividendIncomeBase)
  }));

  const externalTransactions = [];
  const externalRows = database.prepare(`
    SELECT id, ticker, quantity, buy_price AS buyPrice, buy_currency AS buyCurrency,
      bought_at AS boughtAt, sale_price AS salePrice, sale_currency AS saleCurrency,
      sold_at AS soldAt, notes, created_at AS createdAt
    FROM realized_lots
    WHERE user_id = ? AND source = 'external'
    ORDER BY sold_at DESC, created_at DESC
  `).all(userId);
  for (const row of externalRows) {
    const costBasisBase = await convertOrWarn(
      (Number(row.quantity) || 0) * (Number(row.buyPrice) || 0),
      row.buyCurrency,
      baseCurrency,
      warnings,
      `${row.ticker} outside broker buy`
    );
    const proceedsBase = await convertOrWarn(
      (Number(row.quantity) || 0) * (Number(row.salePrice) || 0),
      row.saleCurrency,
      baseCurrency,
      warnings,
      `${row.ticker} outside broker sale`
    );
    const gainLossBase = costBasisBase != null && proceedsBase != null
      ? roundMoney(proceedsBase - costBasisBase)
      : null;
    externalTransactions.push({
      ...row,
      costBasisBase,
      proceedsBase,
      gainLossBase,
      gainLossPercent: costBasisBase ? roundPercent((gainLossBase / costBasisBase) * 100) : null
    });
  }

  const prices = database.prepare("SELECT * FROM market_prices").all();
  const pricesByTicker = new Map(prices.map((row) => [row.ticker, priceFromRow(row)]));
  const fundamentalsByTicker = fundamentalsFromRows(database);
  const positions = new Map();

  for (const lot of lots) {
    let quote = pricesByTicker.get(lot.ticker);
    if (!quote) {
      quote = await getQuote(lot.ticker);
      pricesByTicker.set(lot.ticker, quote);
    }

    const costBasisBase = await convertOrWarn(
      lot.quantity * lot.purchase_price,
      lot.purchase_currency,
      baseCurrency,
      warnings,
      `${lot.ticker} lot ${lot.id} cost basis`
    );
    const purchasePriceBase = await convertOrWarn(
      lot.purchase_price,
      lot.purchase_currency,
      baseCurrency,
      warnings,
      `${lot.ticker} lot ${lot.id} purchase price`
    );
    const currentPriceBase = quote?.price
      ? await convertOrWarn(quote.price, quote.currency, baseCurrency, warnings, `${lot.ticker} live price`)
      : null;

    const currentValueBase = currentPriceBase == null
      ? costBasisBase
      : roundMoney(currentPriceBase * lot.quantity);
    const unrealizedBase = costBasisBase == null || currentValueBase == null
      ? null
      : roundMoney(currentValueBase - costBasisBase);
    const unrealizedPercent = costBasisBase && costBasisBase !== 0 && unrealizedBase != null
      ? roundPercent((unrealizedBase / costBasisBase) * 100)
      : null;

    const lotView = {
      id: lot.id,
      ticker: lot.ticker,
      quantity: lot.quantity,
      originalQuantity: lot.original_quantity,
      purchasePrice: lot.purchase_price,
      purchaseCurrency: lot.purchase_currency,
      purchasePriceBase,
      purchaseDate: lot.purchase_date,
      costBasisBase,
      currentValueBase,
      unrealizedBase,
      unrealizedPercent,
      valuationSource: currentPriceBase == null ? "COST_BASIS_FALLBACK" : "LIVE_OR_STALE_PRICE",
      notes: lot.notes
    };

    if (!positions.has(lot.ticker)) {
      const realized = realizedByTicker.get(lot.ticker) || {};
      const dividend = dividendsByTicker.get(lot.ticker) || {};
      const realizedGainLossBase = roundMoney(realized.gainLossBase || 0);
      const dividendIncomeBase = roundMoney(dividend.dividendIncomeBase || 0);
      positions.set(lot.ticker, {
        ticker: lot.ticker,
        name: lot.equityName,
        categoryId: lot.categoryId,
        categoryName: lot.categoryName,
        equityStatus: lot.equityStatus,
        buyBlocked: Boolean(lot.buyBlocked),
        maxBuyWeightPercent: lot.maxBuyWeightPercent == null ? null : Number(lot.maxBuyWeightPercent),
        riskNote: lot.riskNote || null,
        quantity: 0,
        lotCount: 0,
        averagePurchasePriceBase: null,
        costBasisBase: 0,
        currentValueBase: 0,
        unrealizedBase: 0,
        unrealizedPercent: null,
        realizedBase: roundMoney(realizedGainLossBase + dividendIncomeBase),
        realizedGainLossBase,
        dividendIncomeBase,
        realizedProceedsBase: roundMoney(realized.proceedsBase || 0),
        price: quote,
        fundamentals: fundamentalsByTicker.get(lot.ticker) || null,
        lots: []
      });
    }

    const position = positions.get(lot.ticker);
    position.quantity += lot.quantity;
    position.lotCount += 1;
    position.costBasisBase += costBasisBase || 0;
    position.currentValueBase += currentValueBase || 0;
    position.unrealizedBase += unrealizedBase || 0;
    position.lots.push(lotView);
  }

  const realizedTickers = new Set([
    ...realizedRows.map((row) => row.ticker),
    ...dividendRows.map((row) => row.ticker)
  ]);
  for (const ticker of realizedTickers) {
    if (positions.has(ticker)) continue;
    const equity = database.prepare(`
      SELECT e.*, c.name AS categoryName
      FROM equities e
      LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.ticker = ?
    `).get(ticker);
    const realized = realizedByTicker.get(ticker) || {};
    const dividend = dividendsByTicker.get(ticker) || {};
    const realizedGainLossBase = roundMoney(realized.gainLossBase || 0);
    const dividendIncomeBase = roundMoney(dividend.dividendIncomeBase || 0);
    positions.set(ticker, {
      ticker,
      name: equity?.name || null,
      categoryId: equity?.category_id || null,
      categoryName: equity?.categoryName || null,
      equityStatus: "CLOSED",
      buyBlocked: Boolean(equity?.buy_blocked),
      maxBuyWeightPercent: equity?.max_buy_weight_percent == null ? null : Number(equity.max_buy_weight_percent),
      riskNote: equity?.risk_note || null,
      quantity: 0,
      lotCount: 0,
      averagePurchasePriceBase: null,
      costBasisBase: 0,
      currentValueBase: 0,
      unrealizedBase: 0,
      unrealizedPercent: null,
      realizedBase: roundMoney(realizedGainLossBase + dividendIncomeBase),
      realizedGainLossBase,
      dividendIncomeBase,
      realizedProceedsBase: roundMoney(realized.proceedsBase || 0),
      price: pricesByTicker.get(ticker) || null,
      fundamentals: fundamentalsByTicker.get(ticker) || null,
      lots: [],
      closed: true
    });
  }

  const positionList = [...positions.values()].map((position) => {
    const costBasisBase = roundMoney(position.costBasisBase);
    const currentValueBase = roundMoney(position.currentValueBase);
    const unrealizedBase = roundMoney(position.unrealizedBase);
    const averagePurchasePriceBase = position.quantity > 0
      ? roundMoney(costBasisBase / position.quantity)
      : null;
    const unrealizedPercent = costBasisBase
      ? roundPercent((unrealizedBase / costBasisBase) * 100)
      : null;
    const category = categoryTotals.get(position.categoryId);
    if (category) category.subtotalBase += currentValueBase || 0;
    return {
      ...position,
      quantity: roundShares(position.quantity),
      costBasisBase,
      currentValueBase,
      unrealizedBase,
      unrealizedPercent,
      averagePurchasePriceBase
    };
  });

  let dayChangeBase = 0;
  let dayChangeCovered = 0;
  let dayChangeCoveredValueBase = 0;
  let dayChangeExcluded = 0;
  for (const position of positionList) {
    const quote = position.price;
    if (position.closed || !quote?.price || !quote?.previousClose || !position.quantity) {
      position.dayChangeBase = null;
      position.dayChangePercent = null;
      if (!position.closed && position.quantity > 0) dayChangeExcluded += 1;
      continue;
    }
    const deltaBase = await convertOrWarn(
      quote.price - quote.previousClose,
      quote.currency,
      baseCurrency,
      warnings,
      `${position.ticker} day change`
    );
    if (deltaBase == null) {
      position.dayChangeBase = null;
      position.dayChangePercent = null;
      dayChangeExcluded += 1;
      continue;
    }
    position.dayChangeBase = roundMoney(deltaBase * position.quantity);
    position.dayChangePercent = roundPercent(((quote.price - quote.previousClose) / quote.previousClose) * 100);
    dayChangeBase += position.dayChangeBase || 0;
    dayChangeCovered += 1;
    dayChangeCoveredValueBase += Number(position.currentValueBase) || 0;
  }

  const cashRows = database.prepare(`
    SELECT id, currency, amount, updated_at AS updatedAt
    FROM cash_balances
    WHERE user_id = ?
    ORDER BY currency
  `).all(userId);

  const cashCategory = categories.find((category) => category.id === "cat_cash") || categories.find((category) => category.name === "Cash");
  const cashBalances = [];
  for (const cash of cashRows) {
    const amountBase = await convertOrWarn(
      cash.amount,
      cash.currency,
      baseCurrency,
      warnings,
      `${cash.currency} cash`
    );
    if (cashCategory) categoryTotals.get(cashCategory.id).subtotalBase += amountBase || 0;
    cashBalances.push({ ...cash, amountBase });
  }
  const cashAvailableBase = roundMoney(sum(cashBalances.map((cash) => Number(cash.amountBase) || 0)));

  const totalValueBase = roundMoney(sum([...categoryTotals.values()].map((category) => category.subtotalBase)));
  const openPositionValueBase = roundMoney(sum(positionList
    .filter((position) => !position.closed && (Number(position.quantity) || 0) > 0)
    .map((position) => Number(position.currentValueBase) || 0)));
  const hasDayChangeCoverage = dayChangeCovered > 0 || openPositionValueBase === 0;
  const dayChangeAmountBase = hasDayChangeCoverage ? roundMoney(dayChangeBase) : null;
  const priorSessionValueBase = hasDayChangeCoverage ? roundMoney(totalValueBase - (dayChangeAmountBase || 0)) : null;
  const dayChangeCoveragePercent = openPositionValueBase
    ? roundPercent((dayChangeCoveredValueBase / openPositionValueBase) * 100)
    : null;
  const allocation = [...categoryTotals.values()].map((category) => {
    const subtotalBase = roundMoney(category.subtotalBase);
    const actualPercent = totalValueBase ? roundPercent((subtotalBase / totalValueBase) * 100) : 0;
    const targetBase = roundMoney((category.targetPercent / 100) * totalValueBase);
    const missingOrExcessBase = roundMoney(targetBase - subtotalBase);
    return {
      ...category,
      subtotalBase,
      actualPercent,
      variancePercent: roundPercent(actualPercent - category.targetPercent),
      targetBase,
      missingOrExcessBase,
      status: missingOrExcessBase > 0 ? "MISSING" : missingOrExcessBase < 0 ? "EXCESS" : "ON_TARGET"
    };
  });
  const valueForTicker = (ticker) => positionList.find((position) => position.ticker === ticker && !position.closed)?.currentValueBase || 0;
  const percentOfPortfolio = (value) => totalValueBase ? roundPercent(((Number(value) || 0) / totalValueBase) * 100) : 0;
  for (const position of positionList.filter((item) => !item.closed && (Number(item.currentValueBase) || 0) > 0)) {
    const positionPercent = percentOfPortfolio(position.currentValueBase);
    const maxBuyWeight = position.maxBuyWeightPercent == null ? null : Number(position.maxBuyWeightPercent);
    if (position.buyBlocked) {
      pushUniqueWarning(warnings, `${position.ticker}: buying blocked by saved risk setting${position.riskNote ? ` - ${position.riskNote}` : ""}`);
    } else if (Number.isFinite(maxBuyWeight) && maxBuyWeight >= 0 && positionPercent >= maxBuyWeight) {
      pushUniqueWarning(warnings, `${position.ticker}: above saved buy limit of ${maxBuyWeight}%${position.riskNote ? ` - ${position.riskNote}` : ""}`);
    }
  }
  const memoryStoragePercent = percentOfPortfolio(sum(["MU", "WDC", "SNDK", "STX"].map(valueForTicker)));
  if (memoryStoragePercent > 12) pushUniqueWarning(warnings, "Memory/storage exposure elevated - check concentration before adding.");
  if (positionList.some((position) => position.ticker === "WISE.L" && !position.closed)) {
    pushUniqueWarning(warnings, "WISE regulatory risk - do not average aggressively.");
  }
  const speculative = allocation.find((row) => row.id === "cat_speculative");
  if ((speculative?.actualPercent || 0) > 8) {
    pushUniqueWarning(warnings, "Speculative/special situations above target - reduce risk before adding more.");
  }
  const cashPercent = allocation.find((row) => row.id === "cat_cash")?.actualPercent || 0;
  if (cashPercent > 20) pushUniqueWarning(warnings, "High cash - consider phased deployment.");
  if (cashPercent < 5) pushUniqueWarning(warnings, "Low cash - limited dry powder.");

  const watchlists = database.prepare(`
    SELECT wl.id, wl.name, wl.sort_order AS sortOrder, wl.created_at AS createdAt,
      wl.updated_at AS updatedAt, COUNT(w.id) AS itemCount
    FROM watchlists wl
    LEFT JOIN watchlist_items w ON w.watchlist_id = wl.id AND w.user_id = wl.user_id
    WHERE wl.user_id = ?
    GROUP BY wl.id
    ORDER BY wl.sort_order, wl.name
  `).all(userId);

  const watchlist = database.prepare(`
    SELECT w.id, w.watchlist_id AS watchlistId, wl.name AS watchlistName,
      wl.sort_order AS watchlistSortOrder, w.ticker, w.target_price AS targetPrice,
      w.buy_zone_low AS buyZoneLow, w.buy_zone_high AS buyZoneHigh,
      w.add_zone_low AS addZoneLow, w.add_zone_high AS addZoneHigh,
      w.fair_value AS fairValue, w.trim_price AS trimPrice,
      w.currency, w.note, w.created_at AS createdAt, w.updated_at AS updatedAt,
      c.name AS categoryName, w.category_id AS categoryId, e.name
    FROM watchlist_items w
    JOIN watchlists wl ON wl.id = w.watchlist_id
    JOIN equities e ON e.ticker = w.ticker
    LEFT JOIN categories c ON c.id = w.category_id
    WHERE w.user_id = ?
    ORDER BY wl.sort_order, wl.name, w.created_at DESC
  `).all(userId).map((item) => ({
    ...item,
    price: pricesByTicker.get(item.ticker) || null,
    fundamentals: fundamentalsByTicker.get(item.ticker) || null
  }));

  const marketPulseRows = database.prepare(`
    SELECT id, symbol, display_name AS displayName, category, sort_order AS sortOrder,
      active, updated_at AS updatedAt
    FROM market_pulse_items
    WHERE user_id = ? AND active = 1
    ORDER BY sort_order, display_name
  `).all(userId);
  const marketPulse = [];
  for (const item of marketPulseRows) {
    let quote = pricesByTicker.get(item.symbol);
    if (!quote) {
      quote = await getQuote(item.symbol);
      pricesByTicker.set(item.symbol, quote);
    }
    marketPulse.push({
      ...item,
      price: quote || null
    });
  }

  const qualityTickers = new Set([
    ...positionList.filter((position) => !position.closed && position.quantity > 0).map((position) => position.ticker),
    ...watchlist.map((item) => item.ticker)
  ]);
  for (const ticker of qualityTickers) {
    const quote = pricesByTicker.get(ticker);
    if (!quote || quote.status !== "LIVE") {
      pushUniqueWarning(warnings, `${ticker}: live price ${quote?.status || "MISSING"}${quote?.error ? ` - ${quote.error}` : ""}`);
    }
    const fundamentals = fundamentalsByTicker.get(ticker);
    if (!fundamentals) {
      pushUniqueWarning(warnings, `${ticker}: fundamentals have not been fetched yet`);
    } else if (!coveredFundamentalStatus(fundamentals.status)) {
      pushUniqueWarning(warnings, `${ticker}: fundamentals ${fundamentals.status}${fundamentals.error ? ` - ${fundamentals.error}` : ""}`);
    }
  }

  const alerts = database.prepare(`
    SELECT a.*, l.purchase_date AS lotPurchaseDate, l.quantity AS lotQuantity,
      w.note AS watchlistNote, e.name AS equityName
    FROM price_alerts a
    LEFT JOIN equities e ON e.ticker = a.ticker
    LEFT JOIN holding_lots l ON l.id = a.lot_id
    LEFT JOIN watchlist_items w ON w.id = a.watchlist_item_id
    WHERE a.user_id = ?
    ORDER BY a.archived_at IS NOT NULL, a.triggered DESC, a.active DESC, a.created_at DESC
  `).all(userId).map((alert) => {
    const price = pricesByTicker.get(alert.ticker) || null;
    return {
      ...alert,
      companyName: alert.company_name || alert.equityName || null,
      strategyGroup: alert.strategy_group || null,
      alertType: alert.alert_type || "PRICE_ALERT",
      targetPrice: alert.threshold_price,
      currentPrice: price?.price ?? null,
      currentCurrency: price?.currency ?? alert.currency,
      quoteStatus: price?.status || null,
      quoteAsOf: price?.asOf || null
    };
  });

  const events = database.prepare(`
    SELECT id, ticker, event_type AS eventType, event_date AS eventDate, title,
      details, source, source_event_id AS sourceEventId, payload_json AS payloadJson,
      notified_at AS notifiedAt, created_at AS createdAt,
      (
        SELECT status
        FROM notification_history
        WHERE event_id = corporate_events.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS notificationStatus,
      (
        SELECT error
        FROM notification_history
        WHERE event_id = corporate_events.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS notificationError
    FROM corporate_events
    WHERE user_id = ?
    ORDER BY event_date DESC
    LIMIT 50
  `).all(userId).map((event) => {
    const payload = safeJsonParse(event.payloadJson, {}) || {};
    const officialSource = officialMarketSource(event.ticker);
    const { payloadJson, ...eventView } = event;
    return {
      ...eventView,
      sourceUrl: eventSourceUrl(payload) || officialSource?.url || null,
      newsSource: eventNewsSource(event, payload)
    };
  });

  const notifications = database.prepare(`
    SELECT id, kind, ticker, recipient, subject, status, provider, error,
      created_at AS createdAt, sent_at AS sentAt
    FROM notification_history
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(userId);

  const dividendIncomeBase = roundMoney(sum(dividendRows.map((row) => row.dividendIncomeBase)));
  const realizedGainLossBase = roundMoney(sum(realizedRows.map((row) => row.gainLossBase)));

  const watchlistGroupCount = watchlists.filter((watchlistGroup) => watchlistGroup.itemCount > 0).length;
  const firstLotRow = database.prepare(
    "SELECT MIN(purchase_date) AS firstLotDate FROM holding_lots WHERE user_id = ?"
  ).get(userId);
  const summary = {
    totalValueBase,
    costBasisBase: roundMoney(sum(positionList.map((position) => position.costBasisBase))),
    dayChangeBase: dayChangeAmountBase,
    dayChangePercent: priorSessionValueBase ? roundPercent(((dayChangeAmountBase || 0) / priorSessionValueBase) * 100) : null,
    priorSessionValueBase,
    dayChangeCovered,
    dayChangeExcluded,
    dayChangeCoveragePercent,
    unrealizedBase: roundMoney(sum(positionList.map((position) => position.unrealizedBase))),
    realizedBase: roundMoney(realizedGainLossBase + dividendIncomeBase),
    realizedGainLossBase,
    dividendIncomeBase,
    cashAvailableBase,
    activeAlerts: alerts.filter((alert) => alert.active && !alert.archived_at).length,
    triggeredAlerts: alerts.filter((alert) => alert.triggered && !alert.acknowledged_at && !alert.archived_at).length,
    holdingsCount: positionList.length,
    lotCount: lots.length,
    watchlistCount: watchlist.length,
    watchlistGroupCount: watchlistGroupCount || watchlists.length,
    firstLotDate: firstLotRow?.firstLotDate || null
  };

  const userView = { id: user.id, email: user.email, baseCurrency };
  const intelligence = buildIntelligence({
    positions: positionList,
    watchlist,
    allocation,
    cashBalances,
    summary,
    user: userView
  });
  const rules = getRules(userId, database);
  const dashboardIntelligence = buildDashboardIntelligence({
    positions: positionList,
    watchlist,
    allocation,
    cashBalances,
    alerts,
    events,
    intelligence,
    summary,
    user: userView,
    rules
  });

  return {
    user: userView,
    summary,
    allocation,
    positions: positionList,
    cashBalances,
    watchlists,
    watchlist,
    marketPulse,
    alerts,
    events,
    dividends,
    externalTransactions,
    notifications,
    rules,
    notificationDelivery: {
      emailProvider: config.emailProvider,
      emailConfigured: config.emailProvider === "brevo"
        ? Boolean(config.brevoApiKey && config.brevoFromEmail)
        : Boolean(config.sendgridApiKey && config.sendgridFromEmail)
    },
    intelligence,
    dashboardIntelligence,
    imports: listImportBatches(database, userId),
    warnings
  };
}

export function updateBaseCurrency(userId, currency) {
  const normalized = assertCurrency(currency);
  getDb().prepare("UPDATE users SET base_currency = ? WHERE id = ?").run(normalized, userId);
  return normalized;
}

export function updateCategoryTarget(categoryId, targetPercent) {
  const percent = clampPercent(targetPercent);
  const result = getDb().prepare("UPDATE categories SET target_percent = ? WHERE id = ?").run(percent, categoryId);
  if (!result.changes) throw new InputError("Category not found", 404);
}

export function listCategories() {
  const database = getDb();
  return database.prepare(`
    SELECT c.id, c.name, c.target_percent AS targetPercent, c.sort_order AS sortOrder,
      c.color, c.active,
      COUNT(DISTINCT e.ticker) AS equityCount,
      COUNT(DISTINCT w.id) AS watchlistCount
    FROM categories c
    LEFT JOIN equities e ON e.category_id = c.id
    LEFT JOIN watchlist_items w ON w.category_id = c.id
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `).all();
}

function categoryById(database, categoryId) {
  const category = database.prepare(`
    SELECT id, name, target_percent AS targetPercent, sort_order AS sortOrder, color, active
    FROM categories
    WHERE id = ?
  `).get(categoryId);
  if (!category) throw new InputError("Category not found", 404);
  return category;
}

function assertUniqueCategoryName(database, name, categoryId = "") {
  const duplicate = database.prepare("SELECT id FROM categories WHERE lower(name) = lower(?) AND id <> ?").get(name, categoryId);
  if (duplicate) throw new InputError("A group with this name already exists");
}

function normalizeCategoryDraft(input = {}, index = 0) {
  const name = String(input.name || "").trim();
  if (!name) throw new InputError("Group name is required");
  return {
    clientId: String(input.id || "").trim(),
    name,
    targetPercent: clampPercent(input.targetPercent ?? 0),
    color: normalizeGroupColor(input.color),
    sortOrder: toNumber(input.sortOrder, index + 1) ?? index + 1,
    active: normalizeCategoryActive(input.active, true)
  };
}

export function createCategory(input = {}) {
  const database = getDb();
  const name = String(input.name || "").trim();
  if (!name) throw new InputError("Group name is required");
  assertUniqueCategoryName(database, name);
  const targetPercent = clampPercent(input.targetPercent ?? 0);
  const color = normalizeGroupColor(input.color);
  const sortOrder = toNumber(input.sortOrder, null)
    ?? ((database.prepare("SELECT MAX(sort_order) AS maxSort FROM categories").get()?.maxSort || 0) + 1);
  const categoryId = id("cat");
  database.prepare(`
    INSERT INTO categories (id, name, target_percent, sort_order, color, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(categoryId, name, targetPercent, sortOrder, color);
  return categoryById(database, categoryId);
}

export function updateCategory(categoryId, input = {}) {
  const database = getDb();
  const existing = categoryById(database, categoryId);
  const name = String(input.name ?? existing.name).trim();
  if (!name) throw new InputError("Group name is required");
  assertUniqueCategoryName(database, name, categoryId);
  const targetPercent = input.targetPercent == null ? existing.targetPercent : clampPercent(input.targetPercent);
  const color = normalizeGroupColor(input.color, existing.color || "#C9A86A");
  const sortOrder = toNumber(input.sortOrder, existing.sortOrder);
  const active = normalizeCategoryActive(input.active, Boolean(existing.active));
  database.prepare(`
    UPDATE categories
    SET name = ?, target_percent = ?, sort_order = ?, color = ?, active = ?
    WHERE id = ?
  `).run(name, targetPercent, sortOrder, color, active ? 1 : 0, categoryId);
  return categoryById(database, categoryId);
}

export function saveCategoryChanges(input = {}) {
  const database = getDb();
  const rawGroups = Array.isArray(input.groups) ? input.groups : [];
  const rawDeleted = Array.isArray(input.deleted) ? input.deleted : [];
  if (!rawGroups.length) throw new InputError("At least one group is required");

  const groups = rawGroups.map((group, index) => normalizeCategoryDraft(group, index));
  const deleted = rawDeleted
    .map((row) => ({
      id: String(row?.id || "").trim(),
      moveToCategoryId: String(row?.moveToCategoryId || row?.reassignToCategoryId || "").trim()
    }))
    .filter((row) => row.id);
  const deletedIds = new Set(deleted.map((row) => row.id));
  const finalGroups = groups.filter((group) => !deletedIds.has(group.clientId));
  const nameLookup = new Map();
  for (const group of finalGroups) {
    const key = group.name.toLowerCase();
    if (nameLookup.has(key)) throw new InputError("Group names must be unique");
    nameLookup.set(key, group.clientId || group.name);
  }
  if (finalGroups.every((group) => !normalizeCategoryActive(group.active, true))) {
    throw new InputError("At least one group must remain active");
  }

  const idMap = new Map();
  const now = nowIso();
  transaction((tx) => {
    const existingRows = tx.prepare("SELECT id FROM categories").all();
    const existingIds = new Set(existingRows.map((row) => row.id));
    for (const row of deleted) {
      const categoryId = idMap.get(row.id) || row.id;
      if (existingIds.has(categoryId)) {
        tx.prepare("UPDATE categories SET name = ? WHERE id = ?")
          .run(`__deleting_${categoryId}_${now}`, categoryId);
      }
    }
    const insert = tx.prepare(`
      INSERT INTO categories (id, name, target_percent, sort_order, color, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const update = tx.prepare(`
      UPDATE categories
      SET name = ?, target_percent = ?, sort_order = ?, color = ?, active = ?
      WHERE id = ?
    `);

    for (const group of finalGroups) {
      const isDraft = !group.clientId || group.clientId.startsWith("draft_") || group.clientId.startsWith("new_");
      const categoryId = isDraft ? id("cat") : group.clientId;
      if (!isDraft && !existingIds.has(categoryId)) throw new InputError(`Group not found: ${categoryId}`, 404);
      const duplicate = tx.prepare("SELECT id FROM categories WHERE lower(name) = lower(?) AND id <> ?").get(group.name, categoryId);
      if (duplicate && !deletedIds.has(duplicate.id)) throw new InputError("A group with this name already exists");
      idMap.set(group.clientId || categoryId, categoryId);
      if (isDraft) {
        insert.run(categoryId, group.name, group.targetPercent, group.sortOrder, group.color, group.active ? 1 : 0);
        existingIds.add(categoryId);
      } else {
        update.run(group.name, group.targetPercent, group.sortOrder, group.color, group.active ? 1 : 0, categoryId);
      }
    }

    for (const row of deleted) {
      const categoryId = idMap.get(row.id) || row.id;
      if (!existingIds.has(categoryId)) continue;
      const category = tx.prepare("SELECT id, name FROM categories WHERE id = ?").get(categoryId);
      if (!category) continue;
      if (category.id === "cat_cash") throw new InputError("Cash group cannot be deleted. Rename it or set target to 0 instead.");
      const equityCount = tx.prepare("SELECT COUNT(*) AS count FROM equities WHERE category_id = ?").get(categoryId).count;
      const watchlistCount = tx.prepare("SELECT COUNT(*) AS count FROM watchlist_items WHERE category_id = ?").get(categoryId).count;
      const references = equityCount + watchlistCount;
      const moveToCategoryId = idMap.get(row.moveToCategoryId) || row.moveToCategoryId || "";
      if (references > 0 && !moveToCategoryId) {
        throw new InputError("Choose another group to move assigned tickers before deleting this group", 409, {
          requiresMove: true,
          equityCount,
          watchlistCount
        });
      }
      if (references > 0) {
        if (moveToCategoryId === categoryId || deletedIds.has(moveToCategoryId) || !tx.prepare("SELECT id FROM categories WHERE id = ?").get(moveToCategoryId)) {
          throw new InputError("Destination group is required");
        }
        tx.prepare("UPDATE equities SET category_id = ?, updated_at = ? WHERE category_id = ?")
          .run(moveToCategoryId, now, categoryId);
        tx.prepare("UPDATE watchlist_items SET category_id = ?, updated_at = ? WHERE category_id = ?")
          .run(moveToCategoryId, now, categoryId);
      }
      tx.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
    }
  });

  return {
    ok: true,
    idMap: Object.fromEntries(idMap),
    categories: listCategories()
  };
}

export function deleteCategory(categoryId, input = {}) {
  const database = getDb();
  const category = categoryById(database, categoryId);
  if (category.id === "cat_cash") throw new InputError("Cash group cannot be deleted. Rename it or set target to 0 instead.");
  const equityCount = database.prepare("SELECT COUNT(*) AS count FROM equities WHERE category_id = ?").get(categoryId).count;
  const watchlistCount = database.prepare("SELECT COUNT(*) AS count FROM watchlist_items WHERE category_id = ?").get(categoryId).count;
  const references = equityCount + watchlistCount;
  const moveToCategoryId = input.moveToCategoryId || input.reassignToCategoryId || "";
  if (references > 0 && !moveToCategoryId) {
    throw new InputError("Choose another group to move assigned tickers before deleting this group", 409, {
      requiresMove: true,
      equityCount,
      watchlistCount
    });
  }
  transaction((tx) => {
    if (references > 0) {
      if (moveToCategoryId === categoryId || !tx.prepare("SELECT id FROM categories WHERE id = ?").get(moveToCategoryId)) {
        throw new InputError("Destination group is required");
      }
      tx.prepare("UPDATE equities SET category_id = ?, updated_at = ? WHERE category_id = ?")
        .run(moveToCategoryId, nowIso(), categoryId);
      tx.prepare("UPDATE watchlist_items SET category_id = ?, updated_at = ? WHERE category_id = ?")
        .run(moveToCategoryId, nowIso(), categoryId);
    }
    tx.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
  });
  return { ok: true, moved: references };
}

export function updateEquityCategory(tickerInput, categoryId) {
  const ticker = normalizeTicker(tickerInput);
  const database = getDb();
  if (!database.prepare("SELECT id FROM categories WHERE id = ? AND active = 1").get(categoryId)) {
    throw new InputError("Category not found", 404);
  }
  const result = database.prepare("UPDATE equities SET category_id = ?, updated_at = ? WHERE ticker = ?")
    .run(categoryId, nowIso(), ticker);
  if (!result.changes) throw new InputError("Ticker not found", 404);
}

export function upsertCashBalance(userId, currencyInput, amountInput) {
  const currency = assertFxCurrency(currencyInput);
  const amount = toNumber(amountInput, null);
  if (amount == null) throw new InputError("Cash amount is required");
  const now = nowIso();
  getDb().prepare(`
    INSERT INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, currency) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(id("cash"), userId, currency, amount, now);
}

export function deleteCashBalance(userId, currencyInput) {
  const currency = assertFxCurrency(currencyInput);
  const result = getDb().prepare("DELETE FROM cash_balances WHERE user_id = ? AND currency = ?")
    .run(userId, currency);
  if (!result.changes) throw new InputError("Cash balance not found", 404);
  return { ok: true };
}

export function addMarketPulseItem(userId, input = {}) {
  const database = getDb();
  const symbol = normalizeTicker(input.symbol || input.ticker);
  const displayName = String(input.displayName || input.name || symbol).trim();
  if (!symbol) throw new InputError("Market Pulse symbol is required");
  if (!displayName) throw new InputError("Market Pulse display name is required");
  const category = normalizeMarketPulseCategory(input.category);
  const sortOrder = toNumber(input.sortOrder, null)
    ?? ((database.prepare("SELECT MAX(sort_order) AS maxSort FROM market_pulse_items WHERE user_id = ?").get(userId)?.maxSort || 0) + 1);
  const now = nowIso();
  const pulseId = id("pulse");
  database.prepare(`
    INSERT INTO market_pulse_items (
      id, user_id, symbol, display_name, category, sort_order, active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id, symbol) DO UPDATE SET
      display_name = excluded.display_name,
      category = excluded.category,
      active = 1,
      updated_at = excluded.updated_at
  `).run(pulseId, userId, symbol, displayName, category, sortOrder, now, now);
  return { ok: true };
}

export function updateMarketPulseItem(userId, itemId, input = {}) {
  const database = getDb();
  const existing = database.prepare("SELECT * FROM market_pulse_items WHERE id = ? AND user_id = ?").get(itemId, userId);
  if (!existing) throw new InputError("Market Pulse item not found", 404);
  const symbol = input.symbol == null ? existing.symbol : normalizeTicker(input.symbol);
  const displayName = String(input.displayName ?? existing.display_name).trim();
  if (!symbol) throw new InputError("Market Pulse symbol is required");
  if (!displayName) throw new InputError("Market Pulse display name is required");
  const category = normalizeMarketPulseCategory(input.category ?? existing.category);
  const sortOrder = toNumber(input.sortOrder, existing.sort_order);
  const active = input.active == null ? Boolean(existing.active) : Boolean(input.active);
  const result = database.prepare(`
    UPDATE market_pulse_items
    SET symbol = ?, display_name = ?, category = ?, sort_order = ?, active = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(symbol, displayName, category, sortOrder, active ? 1 : 0, nowIso(), itemId, userId);
  if (!result.changes) throw new InputError("Market Pulse item not found", 404);
  return { ok: true };
}

export function deleteMarketPulseItem(userId, itemId) {
  const result = getDb().prepare("DELETE FROM market_pulse_items WHERE id = ? AND user_id = ?").run(itemId, userId);
  if (!result.changes) throw new InputError("Market Pulse item not found", 404);
  return { ok: true };
}

export function addManualLot(userId, input) {
  const ticker = normalizeTicker(input.ticker);
  const quantity = toNumber(input.quantity, null);
  const purchasePrice = toNumber(input.purchasePrice, null);
  const purchaseCurrency = normalizeFxCurrency(input.purchaseCurrency || input.currency, "USD");
  const purchaseDate = String(input.purchaseDate || "").slice(0, 10);
  if (!ticker) throw new InputError("Ticker is required");
  if (quantity == null || quantity <= 0) throw new InputError("Quantity must be greater than zero");
  if (purchasePrice == null || purchasePrice < 0) throw new InputError("Purchase price is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new InputError("Purchase date is required");

  const database = getDb();
  const now = nowIso();
  const categoryId = input.categoryId || portfolioGroupIdForTicker(ticker);
  if (!database.prepare("SELECT id FROM categories WHERE id = ?").get(categoryId)) {
    throw new InputError("Category not found", 404);
  }

  database.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      currency = excluded.currency,
      category_id = COALESCE(equities.category_id, excluded.category_id),
      status = 'ACTIVE',
      updated_at = excluded.updated_at
  `).run(ticker, input.name || null, purchaseCurrency, categoryId, now, now);

  const lotId = id("lot");
  database.prepare(`
    INSERT INTO holding_lots (
      id, user_id, ticker, original_quantity, quantity, purchase_price,
      purchase_currency, purchase_date, source, notes, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
  `).run(
    lotId,
    userId,
    ticker,
    quantity,
    quantity,
    purchasePrice,
    purchaseCurrency,
    purchaseDate,
    input.notes || null,
    now,
    now
  );
  return lotId;
}

export function addOrUpdateWatchlistItem(userId, input) {
  const ticker = normalizeTicker(input.ticker);
  if (!ticker) throw new InputError("Ticker is required");
  const database = getDb();
  const now = nowIso();
  const watchlist = resolveWatchlist(database, userId, {
    watchlistId: input.watchlistId || input.watchlist_id,
    watchlistName: input.watchlistName || input.watchlist_name || input.listName
  });
  const categoryId = input.categoryId || portfolioGroupIdForTicker(ticker);
  const currency = normalizeFxCurrency(input.currency, "USD");
  const zones = watchlistZonesFromInput(input);
  database.prepare(`
    INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
    VALUES (?, NULL, ?, ?, 'ACTIVE', ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET updated_at = excluded.updated_at
  `).run(ticker, currency, categoryId, now, now);
  database.prepare(`
    INSERT INTO watchlist_items (
      id, user_id, watchlist_id, ticker, target_price, buy_zone_low, buy_zone_high,
      add_zone_low, add_zone_high, fair_value, trim_price, currency, category_id,
      note, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, watchlist_id, ticker) DO UPDATE SET
      target_price = excluded.target_price,
      buy_zone_low = excluded.buy_zone_low,
      buy_zone_high = excluded.buy_zone_high,
      add_zone_low = excluded.add_zone_low,
      add_zone_high = excluded.add_zone_high,
      fair_value = excluded.fair_value,
      trim_price = excluded.trim_price,
      currency = excluded.currency,
      category_id = excluded.category_id,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(
    id("watch"),
    userId,
    watchlist.id,
    ticker,
    zones.targetPrice,
    zones.buyZoneLow,
    zones.buyZoneHigh,
    zones.addZoneLow,
    zones.addZoneHigh,
    zones.fairValue,
    zones.trimPrice,
    currency,
    categoryId,
    input.note || null,
    now,
    now
  );
}

function optionalMoney(input, fieldName) {
  if (input == null || input === "") return null;
  const value = toNumber(input, null);
  if (value == null || value < 0) throw new InputError(`${fieldName} must be zero or greater`);
  return roundMoney(value);
}

function watchlistZonesFromInput(input = {}) {
  const zones = {
    targetPrice: optionalMoney(input.targetPrice, "Target price"),
    buyZoneLow: optionalMoney(input.buyZoneLow, "Buy low"),
    buyZoneHigh: optionalMoney(input.buyZoneHigh, "Buy high"),
    addZoneLow: optionalMoney(input.addZoneLow, "Add low"),
    addZoneHigh: optionalMoney(input.addZoneHigh, "Add high"),
    fairValue: optionalMoney(input.fairValue, "Fair value"),
    trimPrice: optionalMoney(input.trimPrice, "Trim price")
  };
  if (zones.buyZoneLow != null && zones.buyZoneHigh != null && zones.buyZoneLow > zones.buyZoneHigh) {
    throw new InputError("Buy low cannot be higher than buy high");
  }
  if (zones.addZoneLow != null && zones.addZoneHigh != null && zones.addZoneLow > zones.addZoneHigh) {
    throw new InputError("Add low cannot be higher than add high");
  }
  if (zones.buyZoneHigh != null && zones.addZoneLow != null && zones.buyZoneHigh > zones.addZoneLow) {
    throw new InputError("Buy high should not be higher than add low");
  }
  if (zones.addZoneHigh != null && zones.trimPrice != null && zones.addZoneHigh > zones.trimPrice) {
    throw new InputError("Add high should not be higher than trim price");
  }
  return zones;
}

export function updateWatchlistItem(userId, itemId, input = {}) {
  const database = getDb();
  const existing = database.prepare(`
    SELECT id, currency, category_id AS categoryId
    FROM watchlist_items
    WHERE id = ? AND user_id = ?
  `).get(itemId, userId);
  if (!existing) throw new InputError("Watchlist item not found", 404);
  const zones = watchlistZonesFromInput(input);
  const currency = normalizeFxCurrency(input.currency, existing.currency || "USD");
  const categoryId = input.categoryId || existing.categoryId;
  const result = database.prepare(`
    UPDATE watchlist_items
    SET target_price = ?,
      buy_zone_low = ?,
      buy_zone_high = ?,
      add_zone_low = ?,
      add_zone_high = ?,
      fair_value = ?,
      trim_price = ?,
      currency = ?,
      category_id = ?,
      note = ?,
      updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    zones.targetPrice,
    zones.buyZoneLow,
    zones.buyZoneHigh,
    zones.addZoneLow,
    zones.addZoneHigh,
    zones.fairValue,
    zones.trimPrice,
    currency,
    categoryId,
    input.note || null,
    nowIso(),
    itemId,
    userId
  );
  if (!result.changes) throw new InputError("Watchlist item not found", 404);
  return { ok: true };
}

export function removeWatchlistItem(userId, itemId) {
  const result = getDb().prepare("DELETE FROM watchlist_items WHERE user_id = ? AND id = ?").run(userId, itemId);
  if (!result.changes) throw new InputError("Watchlist item not found", 404);
}

export async function recordSale(userId, input) {
  const ticker = normalizeTicker(input.ticker);
  const quantityToSell = toNumber(input.quantity, null);
  const salePrice = toNumber(input.salePrice, null);
  const saleCurrency = normalizeFxCurrency(input.saleCurrency, "USD");
  const requestedLotId = String(input.lotId || input.lot_id || "").trim();
  const soldAt = input.soldAt || nowIso().slice(0, 10);
  if (!ticker || quantityToSell == null || quantityToSell <= 0 || salePrice == null || salePrice < 0) {
    throw new InputError("Ticker, positive quantity, and sale price are required");
  }

  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const lots = database.prepare(`
    SELECT * FROM holding_lots
    WHERE user_id = ? AND ticker = ? AND quantity > 0
    ORDER BY purchase_date, created_at
  `).all(userId, ticker);

  const saleLots = requestedLotId ? lots.filter((lot) => lot.id === requestedLotId) : lots;
  if (requestedLotId && saleLots.length === 0) {
    throw new InputError("Selected lot was not found or has already been fully sold");
  }

  if (requestedLotId && saleLots[0].quantity + 1e-8 < quantityToSell) {
    throw new InputError("Sale quantity exceeds the selected lot");
  }

  if (sum(saleLots.map((lot) => lot.quantity)) + 1e-8 < quantityToSell) {
    throw new InputError("Sale quantity exceeds open holdings");
  }

  let remaining = quantityToSell;
  const matches = [];
  for (const lot of saleLots) {
    if (remaining <= 0) break;
    const matchedQuantity = Math.min(lot.quantity, remaining);
    const costBasis = await convertAmount(matchedQuantity * lot.purchase_price, lot.purchase_currency, user.base_currency);
    const proceeds = await convertAmount(matchedQuantity * salePrice, saleCurrency, user.base_currency);
    const gainLossBase = roundMoney(proceeds.amount - costBasis.amount);
    const gainLossPercent = costBasis.amount ? roundPercent((gainLossBase / costBasis.amount) * 100) : 0;
    matches.push({ lot, matchedQuantity, costBasis, proceeds, gainLossBase, gainLossPercent });
    remaining -= matchedQuantity;
  }

  transaction((tx) => {
    const now = nowIso();
    for (const match of matches) {
      tx.prepare(`
        INSERT INTO realized_lots (
          id, user_id, ticker, lot_id, quantity, sale_price, sale_currency, sold_at,
          cost_basis_base, proceeds_base, gain_loss_base, gain_loss_percent,
          source, buy_price, buy_currency, bought_at, notes, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
      `).run(
        id("realized"),
        userId,
        ticker,
        match.lot.id,
        match.matchedQuantity,
        salePrice,
        saleCurrency,
        soldAt,
        match.costBasis.amount,
        match.proceeds.amount,
        match.gainLossBase,
        match.gainLossPercent,
        match.lot.purchase_price,
        match.lot.purchase_currency,
        match.lot.purchase_date,
        input.notes || null,
        now
      );
      const newQuantity = roundShares(match.lot.quantity - match.matchedQuantity);
      tx.prepare(`
        UPDATE holding_lots
        SET quantity = ?, updated_at = ?, closed_at = CASE WHEN ? <= 0.000001 THEN ? ELSE closed_at END
        WHERE id = ?
      `).run(Math.max(0, newQuantity), now, newQuantity, now, match.lot.id);
    }
  });

  return {
    ticker,
    soldQuantity: quantityToSell,
    realizedGainLossBase: roundMoney(sum(matches.map((match) => match.gainLossBase))),
    matches: matches.length,
    saleMethod: requestedLotId ? "SPECIFIC_LOT" : "FIFO"
  };
}

export async function recordExternalClosedTransaction(userId, input = {}) {
  const ticker = normalizeTicker(input.ticker);
  const quantity = toNumber(input.quantity, null);
  const buyPrice = toNumber(input.buyPrice ?? input.purchasePrice, null);
  const salePrice = toNumber(input.salePrice ?? input.sellPrice, null);
  const buyCurrency = normalizeFxCurrency(input.buyCurrency || input.purchaseCurrency || input.currency, "");
  const saleCurrency = normalizeFxCurrency(input.saleCurrency || input.sellCurrency || input.currency, "");
  const boughtAt = String(input.buyDate || input.boughtAt || input.purchaseDate || "").slice(0, 10);
  const soldAt = String(input.sellDate || input.soldAt || input.saleDate || "").slice(0, 10);

  if (!ticker) throw new InputError("Ticker is required");
  if (quantity == null || quantity <= 0) throw new InputError("Quantity must be greater than zero");
  if (buyPrice == null || buyPrice < 0) throw new InputError("Buy price is required");
  if (salePrice == null || salePrice < 0) throw new InputError("Sell price is required");
  if (!buyCurrency) throw new InputError("Buy currency is required");
  if (!saleCurrency) throw new InputError("Sell currency is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(boughtAt)) throw new InputError("Buy date is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(soldAt)) throw new InputError("Sell date is required");
  if (soldAt < boughtAt) throw new InputError("Sell date cannot be before buy date");

  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const costBasis = await convertAmount(quantity * buyPrice, buyCurrency, user.base_currency);
  const proceeds = await convertAmount(quantity * salePrice, saleCurrency, user.base_currency);
  const gainLossBase = roundMoney(proceeds.amount - costBasis.amount);
  const gainLossPercent = costBasis.amount ? roundPercent((gainLossBase / costBasis.amount) * 100) : 0;
  const now = nowIso();
  const categoryId = portfolioGroupIdForTicker(ticker);
  const transactionId = id("external_tx");

  transaction((tx) => {
    tx.prepare(`
      INSERT INTO equities (ticker, name, currency, category_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'CLOSED', ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        currency = COALESCE(equities.currency, excluded.currency),
        category_id = COALESCE(equities.category_id, excluded.category_id),
        updated_at = excluded.updated_at
    `).run(ticker, input.name || null, saleCurrency, categoryId, now, now);

    tx.prepare(`
      INSERT INTO realized_lots (
        id, user_id, ticker, lot_id, quantity, buy_price, buy_currency, bought_at,
        sale_price, sale_currency, sold_at, cost_basis_base, proceeds_base,
        gain_loss_base, gain_loss_percent, source, source_event_id, notes, created_at
      )
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external', ?, ?, ?)
    `).run(
      transactionId,
      userId,
      ticker,
      quantity,
      buyPrice,
      buyCurrency,
      boughtAt,
      salePrice,
      saleCurrency,
      soldAt,
      costBasis.amount,
      proceeds.amount,
      gainLossBase,
      gainLossPercent,
      transactionId,
      input.notes || input.broker || null,
      now
    );
  });

  return {
    id: transactionId,
    ticker,
    quantity: roundShares(quantity),
    costBasisBase: roundMoney(costBasis.amount),
    proceedsBase: roundMoney(proceeds.amount),
    gainLossBase,
    gainLossPercent
  };
}

export function deleteExternalClosedTransaction(userId, transactionId) {
  const result = getDb().prepare(`
    DELETE FROM realized_lots
    WHERE user_id = ? AND id = ? AND source = 'external'
  `).run(userId, transactionId);
  if (!result.changes) throw new InputError("Closed transaction not found", 404);
  return { ok: true };
}
