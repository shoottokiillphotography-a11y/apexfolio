import { config } from "../config.js";
import { getDb } from "../db.js";
import { fetchJson, InputError, roundMoney, roundPercent } from "../utils.js";

const THEME_RULES = [
  ["AI Compute", ["NVDA", "AMD", "AVGO", "ARM", "QCOM", "INTC"]],
  ["AI Memory", ["MU", "WDC", "STX", "SNDK", "RMBS"]],
  ["AI Networking", ["MRVL", "ANET", "CRDO", "CIEN"]],
  ["AI Opticals", ["LITE", "COHR", "AAOI", "GLW"]],
  ["Power & Grid", ["VRT", "PWR", "ETN", "GEV", "TT", "JCI", "MOD", "BE"]],
  ["Data Center Infrastructure", ["CCI", "DLR", "EQIX"]],
  ["Software Beneficiaries", ["MSFT", "META", "ORCL", "NOW", "SNOW", "PLTR", "CRM", "ADBE", "TEAM", "CRWS"]],
  ["Compounders", ["GOOG", "GOOGL", "AMZN", "CME", "ICE", "COST", "V", "MA", "AZO", "SPGI", "BRK-B", "RACE", "NFLX"]],
  ["Healthcare", ["LLY", "NVO", "NOVO-B.CO", "HIMS", "DXCM", "UNH"]],
  ["International Growth", ["BABA", "PDD", "JD", "BYDDY", "0700.HK", "MELI", "WISE.L", "MFG.AX", "MTO.AX", "LNW.AX"]],
  ["Crypto", ["BTC-USD", "ETH-USD", "SOL-USD", "IBIT", "ETHA"]],
  ["Special Situations", ["WISE", "WISE.L", "QBTS", "QUBT", "RGTI", "IONQ", "SMCI"]]
];

const THEME_AI_SCORE = {
  "AI Compute": 10,
  "AI Memory": 9,
  "AI Networking": 9,
  "AI Opticals": 8,
  "Power & Grid": 8,
  "Data Center Infrastructure": 7,
  "Software Beneficiaries": 7,
  "Compounders": 5,
  "Healthcare": 2,
  "International Growth": 3,
  "Crypto": 2,
  "Special Situations": 4,
  "Unclassified": 1
};

const THEME_MOAT_SCORE = {
  "AI Compute": 8,
  "AI Memory": 5,
  "AI Networking": 7,
  "AI Opticals": 6,
  "Power & Grid": 7,
  "Data Center Infrastructure": 7,
  "Software Beneficiaries": 8,
  "Compounders": 9,
  "Healthcare": 7,
  "International Growth": 6,
  "Crypto": 3,
  "Special Situations": 4,
  "Unclassified": 4
};

const THEME_LIMITS = {
  "AI Compute": 18,
  "AI Memory": 10,
  "AI Networking": 10,
  "AI Opticals": 8,
  "Power & Grid": 10,
  "Data Center Infrastructure": 12,
  "Software Beneficiaries": 18,
  "Compounders": 25,
  "Healthcare": 12,
  "International Growth": 12,
  "Crypto": 5,
  "Special Situations": 7,
  "Unclassified": 8
};

function byTicker(items) {
  return new Map(items.map((item) => [item.ticker, item]));
}

function classifyTheme(ticker, fallback = "Unclassified") {
  for (const [theme, tickers] of THEME_RULES) {
    if (tickers.includes(ticker)) return theme;
  }
  return fallback || "Unclassified";
}

function geographyForTicker(ticker) {
  if (ticker.endsWith(".AX")) return "Australia";
  if (ticker.endsWith(".HK")) return "Hong Kong/China";
  if (ticker.endsWith(".L")) return "United Kingdom";
  if (ticker.endsWith(".CO")) return "Denmark/Europe";
  if (["BABA", "PDD", "JD", "BYDDY"].includes(ticker)) return "China";
  if (ticker.endsWith("-USD")) return "Crypto";
  return "United States";
}

function currentPriceFor(item) {
  return Number.isFinite(item.price?.price) ? item.price.price : null;
}

function targetForTicker(watchlistItems, ticker) {
  const targets = watchlistItems
    .filter((item) => item.ticker === ticker && Number.isFinite(item.targetPrice))
    .map((item) => item.targetPrice);
  if (!targets.length) return null;
  return targets.reduce((total, value) => total + value, 0) / targets.length;
}

function valuationAnchor(item, targetPrice) {
  const price = currentPriceFor(item);
  if (targetPrice) return { value: targetPrice, source: "target price" };
  if (price) return { value: price, source: "current price placeholder" };
  return { value: null, source: "missing price" };
}

function finiteMoney(value) {
  return Number.isFinite(value) ? roundMoney(value) : null;
}

function priceZones(anchor) {
  if (!anchor.value) return null;
  const value = anchor.value;
  return {
    buy: [roundMoney(value * 0.82), roundMoney(value * 0.9)],
    add: [roundMoney(value * 0.9), roundMoney(value * 0.98)],
    fair: [roundMoney(value * 0.98), roundMoney(value * 1.12)],
    review: [roundMoney(value * 1.12), roundMoney(value * 1.25)],
    trim: roundMoney(value * 1.25),
    source: anchor.source
  };
}

function manualPriceZones(item, anchor) {
  const source = item.watchlistItem;
  if (!source) return null;
  const fields = [
    source.buyZoneLow,
    source.buyZoneHigh,
    source.addZoneLow,
    source.addZoneHigh,
    source.fairValue,
    source.trimPrice
  ];
  if (!fields.some(Number.isFinite)) return null;
  const anchorValue = source.fairValue || source.targetPrice || anchor.value || currentPriceFor(item);
  const buyHigh = finiteMoney(source.buyZoneHigh ?? source.buyZoneLow ?? (anchorValue ? anchorValue * 0.9 : null));
  const buyLow = finiteMoney(source.buyZoneLow ?? (buyHigh ? buyHigh * 0.95 : null));
  const addLow = finiteMoney(source.addZoneLow ?? buyHigh);
  const addHigh = finiteMoney(source.addZoneHigh ?? source.fairValue ?? source.targetPrice);
  const fairValue = finiteMoney(source.fairValue ?? source.targetPrice ?? addHigh);
  const trim = finiteMoney(source.trimPrice);
  return {
    buy: buyLow != null && buyHigh != null ? [buyLow, buyHigh] : null,
    add: addLow != null && addHigh != null ? [addLow, addHigh] : null,
    fair: addHigh != null && fairValue != null ? [addHigh, fairValue] : null,
    review: fairValue != null && trim != null ? [fairValue, trim] : null,
    trim,
    source: "manual watchlist zones"
  };
}

function zoneCeiling(zones, name) {
  const value = zones?.[name]?.[1];
  return Number.isFinite(value) ? value : null;
}

function zoneFloor(zones, name) {
  const value = zones?.[name]?.[0];
  return Number.isFinite(value) ? value : null;
}

function exposureOf(position, totalValueBase) {
  if (!position || !totalValueBase) return 0;
  return roundPercent(((position.currentValueBase || 0) / totalValueBase) * 100) || 0;
}

function decisionFor({ item, targetPrice, totalValueBase }) {
  const ticker = item.ticker;
  const theme = classifyTheme(ticker, item.categoryName || "Unclassified");
  const aiExposureScore = THEME_AI_SCORE[theme] ?? 1;
  const moatScore = THEME_MOAT_SCORE[theme] ?? 4;
  const price = currentPriceFor(item);
  const exposurePercent = exposureOf(item.position, totalValueBase);
  const anchor = valuationAnchor(item, targetPrice);
  const zones = manualPriceZones(item, anchor) || priceZones(anchor);
  const isHeld = Boolean(item.position && item.position.quantity > 0);
  const isWatchOnly = !isHeld;
  const scope = item.scope || (item.watchlistItem ? "WATCHLIST" : "PORTFOLIO");
  const priceStatus = item.price?.status || "UNKNOWN";

  let status = "HOLD";
  let reason = "Good candidate to monitor; valuation anchor needs refinement.";
  let riskLevel = "Medium";
  const buyCeiling = zoneCeiling(zones, "buy");
  const addCeiling = zoneCeiling(zones, "add");
  const reviewFloor = zoneFloor(zones, "review") ?? zones?.trim;
  const trimFloor = Number.isFinite(zones?.trim) ? zones.trim : null;

  if (!price || priceStatus !== "LIVE") {
    status = "REVIEW";
    reason = "Price data is unavailable or stale, so valuation discipline cannot be trusted yet.";
    riskLevel = "High";
  } else if (theme === "Crypto") {
    status = "REVIEW";
    reason = "High volatility instrument; keep sizing small and thesis-specific.";
    riskLevel = "High";
  } else if (exposurePercent >= 12) {
    status = "TRIM";
    reason = `Position is large at ${exposurePercent}% of portfolio; concentration risk comes before upside.`;
    riskLevel = "High";
  } else if (trimFloor != null && price >= trimFloor) {
    status = "TRIM";
    reason = `Price is above the trim zone from the ${zones.source}.`;
    riskLevel = "High";
  } else if (buyCeiling != null && price <= buyCeiling && (isWatchOnly || exposurePercent < 8)) {
    status = "BUY";
    reason = `Price is in the buy zone and portfolio exposure is not excessive.`;
    riskLevel = "Medium";
  } else if (addCeiling != null && price <= addCeiling && isHeld && exposurePercent < 10) {
    status = "ADD";
    reason = `Held position is still inside the add zone without major concentration risk.`;
    riskLevel = "Medium";
  } else if (reviewFloor != null && price >= reviewFloor) {
    status = "REVIEW";
    reason = `Excellent or interesting business, but price is in the review zone.`;
    riskLevel = "Medium";
  } else if (isWatchOnly) {
    status = "HOLD";
    reason = "Watchlist candidate: wait for a clearer buy zone or stronger evidence.";
  } else {
    status = "HOLD";
    reason = "Position fits the portfolio for now; no urgent buy or trim signal.";
  }

  const valuationDenominator = trimFloor || anchor.value || price;
  const valuationScore = zones && price && valuationDenominator
    ? Math.max(0, Math.min(100, Math.round(100 - ((price / valuationDenominator) * 55))))
    : 35;
  const sizingScore = exposurePercent >= 12 ? 25 : exposurePercent >= 8 ? 55 : 75;
  const qualityScore = Math.round(((moatScore * 8) + (aiExposureScore * 4)) / 1.2);
  const convictionScore = Math.max(0, Math.min(100, Math.round(
    qualityScore * 0.42 + valuationScore * 0.32 + sizingScore * 0.2 + (priceStatus === "LIVE" ? 6 : -10)
  )));

  return {
    ticker,
    name: item.name || item.equityName || "",
    scope,
    isHeld,
    alreadyOwned: scope === "WATCHLIST" && isHeld,
    watchlistItemId: item.watchlistItem?.id || null,
    watchlistId: item.watchlistItem?.watchlistId || null,
    watchlistName: item.watchlistItem?.watchlistName || null,
    watchlistSortOrder: item.watchlistItem?.watchlistSortOrder || 0,
    theme,
    geography: geographyForTicker(ticker),
    status,
    reason,
    riskLevel,
    aiExposureScore,
    aiExposureType: aiExposureScore >= 8 ? "Direct AI winner" : aiExposureScore >= 5 ? "Indirect AI winner" : "Low AI relevance",
    moatScore,
    convictionScore,
    exposurePercent,
    currentValueBase: item.position?.currentValueBase || 0,
    price: item.price || null,
    targetPrice: targetPrice || null,
    zones,
    valuationNotes: zones?.source === "current price placeholder"
      ? "Set a target price to turn this from a placeholder zone into a true valuation zone."
      : zones?.source === "manual watchlist zones"
        ? "Zone anchored to your saved buy/add/trim levels."
        : "Zone anchored to the saved target price."
  };
}

function portfolioDecisionItems(positions, watchlist) {
  const watchByTicker = byTicker(watchlist);
  return positions
    .filter((position) => !position.closed && position.quantity > 0)
    .map((position) => ({
      scope: "PORTFOLIO",
      ticker: position.ticker,
      name: position.name,
      categoryName: position.categoryName,
      price: position.price,
      position,
      watchlistItem: watchByTicker.get(position.ticker) || null
    }));
}

function watchlistDecisionItems(watchlist, positions) {
  const positionsByTicker = byTicker(positions.filter((position) => !position.closed && position.quantity > 0));
  return watchlist.map((item) => ({
      scope: "WATCHLIST",
      ticker: item.ticker,
      name: item.name,
      categoryName: item.categoryName,
      price: item.price,
      position: positionsByTicker.get(item.ticker) || null,
      watchlistItem: item
  }));
}

function summarizeBy(decisions, field) {
  const totals = new Map();
  for (const item of decisions) {
    const key = item[field] || "Unknown";
    const existing = totals.get(key) || { name: key, count: 0, exposurePercent: 0 };
    existing.count += 1;
    existing.exposurePercent += item.exposurePercent || 0;
    totals.set(key, existing);
  }
  return [...totals.values()]
    .map((item) => ({ ...item, exposurePercent: roundPercent(item.exposurePercent) || 0 }))
    .sort((a, b) => (b.exposurePercent || 0) - (a.exposurePercent || 0) || b.count - a.count);
}

function risksFrom(decisions, allocation, summary) {
  const risks = [];
  const largest = decisions
    .filter((item) => item.exposurePercent > 0)
    .sort((a, b) => b.exposurePercent - a.exposurePercent)[0];
  if (largest?.exposurePercent >= 12) {
    risks.push({
      kind: "Concentration Risk",
      severity: "High",
      text: `${largest.ticker} is ${largest.exposurePercent}% of the portfolio. Review sizing before adding more.`
    });
  }
  const themeTotals = summarizeBy(decisions, "theme");
  for (const theme of themeTotals.slice(0, 3)) {
    const limit = THEME_LIMITS[theme.name] ?? 12;
    if (theme.exposurePercent > limit) {
      risks.push({
        kind: "Theme Risk",
        severity: theme.exposurePercent > limit + 5 ? "High" : "Medium",
        text: `${theme.name} exposure is ${theme.exposurePercent}% versus a suggested soft limit near ${limit}%.`
      });
    }
  }
  const speculative = allocation.find((item) => item.name === "Speculative");
  if (speculative?.actualPercent > 25) {
    risks.push({
      kind: "Portfolio Construction",
      severity: "High",
      text: `Speculative allocation is ${speculative.actualPercent}%. This can dominate drawdowns.`
    });
  }
  if ((summary.totalValueBase || 0) > 0 && !risks.length) {
    risks.push({
      kind: "No Major Risk Flag",
      severity: "Low",
      text: "No single risk threshold is currently dominating, but valuation anchors still need refinement."
    });
  }
  return risks;
}

function capitalPlan(decisions, cashBalances, userCurrency) {
  const cashBase = cashBalances.reduce((total, item) => total + (item.amountBase || 0), 0);
  const candidates = decisions
    .filter((item) => ["BUY", "ADD"].includes(item.status))
    .sort((a, b) => b.convictionScore - a.convictionScore)
    .slice(0, 6);
  const totalScore = candidates.reduce((total, item) => total + item.convictionScore, 0) || 1;
  return {
    cashBase: roundMoney(cashBase),
    currency: userCurrency,
    priorityBuys: candidates.map((item) => ({
      ticker: item.ticker,
      status: item.status,
      theme: item.theme,
      convictionScore: item.convictionScore,
      suggestedPercent: roundPercent((item.convictionScore / totalScore) * 100),
      suggestedAmountBase: roundMoney(cashBase * (item.convictionScore / totalScore)),
      reason: item.reason
    }))
  };
}

function decisionQueue(decisions) {
  const rank = { BUY: 0, ADD: 1, REVIEW: 2, TRIM: 3, HOLD: 4, AVOID: 5 };
  return [...decisions]
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.convictionScore - a.convictionScore)
    .slice(0, 18);
}

function watchlistListsFrom(decisions) {
  const lists = new Map();
  for (const item of decisions) {
    const id = item.watchlistId || "default";
    const list = lists.get(id) || {
      id,
      name: item.watchlistName || "Default",
      sortOrder: item.watchlistSortOrder || 0,
      count: 0,
      ownedCount: 0,
      buyCount: 0,
      addCount: 0,
      reviewCount: 0,
      trimCount: 0,
      averageConviction: 0,
      convictionTotal: 0,
      themes: new Map(),
      priority: null
    };
    list.count += 1;
    list.ownedCount += item.alreadyOwned ? 1 : 0;
    list.buyCount += item.status === "BUY" ? 1 : 0;
    list.addCount += item.status === "ADD" ? 1 : 0;
    list.reviewCount += item.status === "REVIEW" ? 1 : 0;
    list.trimCount += item.status === "TRIM" ? 1 : 0;
    list.convictionTotal += item.convictionScore || 0;
    list.themes.set(item.theme, (list.themes.get(item.theme) || 0) + 1);
    if (!list.priority || (item.status === "BUY" && list.priority.status !== "BUY") || item.convictionScore > list.priority.convictionScore) {
      list.priority = {
        ticker: item.ticker,
        status: item.status,
        theme: item.theme,
        convictionScore: item.convictionScore,
        reason: item.reason
      };
    }
    lists.set(id, list);
  }
  return [...lists.values()].map((list) => ({
    ...list,
    averageConviction: list.count ? Math.round(list.convictionTotal / list.count) : 0,
    themes: [...list.themes.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
    convictionTotal: undefined
  })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
}

export function buildIntelligence({ positions, watchlist, allocation, cashBalances, summary, user }) {
  const portfolioDecisions = portfolioDecisionItems(positions, watchlist).map((item) => decisionFor({
    item,
    targetPrice: targetForTicker(watchlist, item.ticker),
    totalValueBase: summary.totalValueBase || 0
  }));
  const watchlistDecisions = watchlistDecisionItems(watchlist, positions).map((item) => decisionFor({
    item,
    targetPrice: item.watchlistItem?.targetPrice || targetForTicker(watchlist, item.ticker),
    totalValueBase: summary.totalValueBase || 0
  }));
  const decisions = [...portfolioDecisions, ...watchlistDecisions];
  const buyCount = decisions.filter((item) => item.status === "BUY").length;
  const addCount = decisions.filter((item) => item.status === "ADD").length;
  const reviewCount = decisions.filter((item) => item.status === "REVIEW").length;
  const trimCount = decisions.filter((item) => item.status === "TRIM").length;
  const portfolioQueue = decisionQueue(portfolioDecisions);
  const watchlistQueue = decisionQueue(watchlistDecisions);

  return {
    disclaimer: "Research support only. This is not personal financial advice.",
    summary: {
      monitoredCount: decisions.length,
      portfolioCount: portfolioDecisions.length,
      watchlistCount: watchlistDecisions.length,
      buyCount,
      addCount,
      reviewCount,
      trimCount,
      portfolioReviewCount: portfolioDecisions.filter((item) => item.status === "REVIEW").length,
      portfolioTrimCount: portfolioDecisions.filter((item) => item.status === "TRIM").length,
      watchlistBuyCount: watchlistDecisions.filter((item) => item.status === "BUY").length,
      watchlistAddCount: watchlistDecisions.filter((item) => item.status === "ADD").length,
      averageConviction: decisions.length
        ? Math.round(decisions.reduce((total, item) => total + item.convictionScore, 0) / decisions.length)
        : 0
    },
    decisionQueue: decisionQueue(decisions),
    portfolioQueue,
    watchlistQueue,
    portfolioDecisions,
    watchlistDecisions,
    watchlistLists: watchlistListsFrom(watchlistDecisions),
    themeExposure: summarizeBy(portfolioDecisions, "theme"),
    watchlistThemeExposure: summarizeBy(watchlistDecisions, "theme"),
    geographyExposure: summarizeBy(portfolioDecisions, "geography"),
    watchlistGeographyExposure: summarizeBy(watchlistDecisions, "geography"),
    risks: risksFrom(portfolioDecisions, allocation, summary),
    capitalPlan: capitalPlan(decisions, cashBalances, user.baseCurrency),
    decisions
  };
}

function responseText(payload) {
  if (payload?.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) chunks.push(part.text);
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function zoneRangeText(label, range) {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return null;
  return `${label} ${range[0]}-${range[1]}`;
}

function zoneSummaryText(zones) {
  if (!zones) return "No reliable price zone because live price or target price is missing.";
  const parts = [
    zoneRangeText("Buy", zones.buy),
    zoneRangeText("add", zones.add),
    zoneRangeText("fair", zones.fair),
    zoneRangeText("review", zones.review),
    Number.isFinite(zones.trim) ? `trim above ${zones.trim}` : null
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "No reliable price zone because live price or target price is missing.";
}

function fallbackMemo(decision) {
  return [
    `# ${decision.ticker} Investment Memo`,
    "",
    `**Decision:** ${decision.status}`,
    `**Conviction:** ${decision.convictionScore}/100`,
    `**Theme:** ${decision.theme}`,
    `**AI exposure:** ${decision.aiExposureScore}/10 (${decision.aiExposureType})`,
    `**Moat:** ${decision.moatScore}/10`,
    "",
    "## Thesis",
    decision.reason,
    "",
    "## Valuation Discipline",
    zoneSummaryText(decision.zones),
    "",
    "## Key Risk",
    decision.riskLevel === "High"
      ? "Risk level is high; prioritize downside review before adding capital."
      : "Risk level is manageable, but the thesis should be checked against upcoming earnings and valuation."
  ].join("\n");
}

export function aiSettingsForUser(database, userId) {
  const saved = database.prepare(`
    SELECT provider, api_key AS apiKey, model
    FROM user_ai_settings
    WHERE user_id = ?
  `).get(userId);
  if (saved) return saved;
  if (config.openaiApiKey) {
    return { provider: "openai", apiKey: config.openaiApiKey, model: config.openaiModel };
  }
  if (config.geminiApiKey) {
    return { provider: "gemini", apiKey: config.geminiApiKey, model: config.geminiModel };
  }
  return null;
}

export function saveAiSettings(userId, input = {}) {
  const provider = String(input.provider || input.aiProvider || "openai").trim().toLowerCase();
  if (!["openai", "gemini"].includes(provider)) throw new InputError("AI provider must be OpenAI or Gemini");
  const apiKey = String(input.apiKey || input.key || input.openaiApiKey || input.geminiApiKey || "").trim();
  const model = String(input.model || (provider === "gemini" ? config.geminiModel : config.openaiModel)).trim();
  if (apiKey.length < 8) throw new InputError("AI API key looks too short");
  if (!model) throw new InputError("AI model is required");
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO user_ai_settings (user_id, provider, api_key, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider = excluded.provider,
      api_key = excluded.api_key,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(userId, provider, apiKey, model, now, now);
  return { provider, model };
}

function memoPrompt(decision) {
  return [
    "Generate a concise institutional-style investment memo with sections:",
    "Business Overview, Thesis, Valuation Discipline, Catalysts, Risks, Competition, Management Quality, Final Rating.",
    "Use only these portfolio facts. Do not invent fundamentals.",
    JSON.stringify(decision, null, 2)
  ].join("\n\n");
}

async function generateWithOpenAi(settings, decision) {
  const payload = await fetchJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      instructions: [
        "You are an investment research assistant for a long-term investor.",
        "Use only the supplied portfolio facts. Do not invent fundamentals.",
        "Separate company quality from price discipline.",
        "Lead with risks before opportunities.",
        "Do not present this as personal financial advice."
      ].join(" "),
      input: memoPrompt(decision),
      max_output_tokens: 1400
    })
  });
  return responseText(payload);
}

async function generateWithGemini(settings, decision) {
  const model = settings.model.startsWith("models/") ? settings.model : `models/${settings.model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
  const payload = await fetchJson(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": settings.apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: [
            "You are an investment research assistant for a long-term investor.",
            "Use only supplied portfolio facts and do not invent fundamentals.",
            "Separate company quality from price discipline. Lead with risks. Do not give personal financial advice."
          ].join(" ")
        }]
      },
      contents: [{
        parts: [{ text: memoPrompt(decision) }]
      }],
      generationConfig: {
        maxOutputTokens: 1400
      }
    })
  });
  return payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("\n")
    .trim();
}

export async function generateResearchMemo({ intelligence, ticker, userId }) {
  const decision = intelligence.decisions.find((item) => item.ticker === ticker);
  if (!decision) throw new InputError("Ticker not found in portfolio or watchlists", 404);
  const settings = aiSettingsForUser(getDb(), userId);
  if (!settings) return { provider: "rules", memo: fallbackMemo(decision) };
  const memo = settings.provider === "gemini"
    ? await generateWithGemini(settings, decision)
    : await generateWithOpenAi(settings, decision);
  return { provider: settings.provider, model: settings.model, memo: memo || fallbackMemo(decision) };
}
