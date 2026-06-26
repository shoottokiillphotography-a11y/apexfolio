import { roundMoney, roundPercent } from "../utils.js";

export const RULES_ENGINE_V2_VERSION = "rules-v2-readonly-2026-06-26";

const DEFAULT_LIMITS = {
  positionNormalPercent: 10,
  positionSoftPercent: 12,
  positionHardPercent: 15,
  positionCriticalPercent: 20,
  groupOnTargetBandPP: 2,
  groupHardVariancePP: 15,
  themeSoftPercent: 15,
  themeHardPercent: 22
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stateClass(value) {
  const text = String(value || "").toLowerCase();
  if (/(blocked|critical|hard|trim|missing|avoid|over_limit)/.test(text)) return "negative";
  if (/(review|partial|soft|under|over|caution|thin|unknown)/.test(text)) return "warning";
  if (/(buy|add|eligible|ok|normal|on_target|stable|live)/.test(text)) return "live";
  return "neutral";
}

function priorityRank(priority) {
  return { Critical: 0, High: 1, Medium: 2, Low: 3 }[priority] ?? 4;
}

function actionRank(action) {
  return { TRIM: 0, REVIEW: 1, BUY: 2, ADD: 3, HOLD: 4, AVOID: 5 }[action] ?? 9;
}

function formatLargeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}

function signedPp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0 pp";
  return `${number >= 0 ? "+" : ""}${roundPercent(number)} pp`;
}

function priceFor(decision) {
  return finite(decision?.price?.price ?? decision?.price?.regularMarketPrice);
}

function priceStatusFor(decision) {
  return String(decision?.price?.status || "UNKNOWN").toUpperCase();
}

function hasLivePrice(decision) {
  return priceFor(decision) != null && priceStatusFor(decision) === "LIVE";
}

function dataStateFor(decision) {
  if (!decision?.price || priceFor(decision) == null) {
    return {
      state: "MISSING_PRICE",
      confidence: 25,
      reason: "No usable price is available, so the engine cannot trust valuation."
    };
  }
  if (priceStatusFor(decision) !== "LIVE") {
    return {
      state: "PARTIAL_PRICE",
      confidence: 55,
      reason: `Price exists but provider status is ${priceStatusFor(decision)}.`
    };
  }
  return {
    state: "OK",
    confidence: 92,
    reason: "Live price is available."
  };
}

function valuationStateFor(decision) {
  const price = priceFor(decision);
  const zones = decision?.zones;
  if (!price || !zones) {
    return {
      state: "NO_ANCHOR",
      opportunityScore: 35,
      underlyingSignal: "REVIEW",
      reasonCode: "VALUATION_ANCHOR_MISSING",
      reason: "No reliable valuation anchor or price zone is available."
    };
  }

  const buyLow = finite(zones.buy?.[0]);
  const buyHigh = finite(zones.buy?.[1]);
  const addHigh = finite(zones.add?.[1]);
  const fairHigh = finite(zones.fair?.[1]);
  const reviewHigh = finite(zones.review?.[1]);
  const trim = finite(zones.trim);

  if (buyLow != null && price < buyLow) {
    return {
      state: "DEEP_DISCOUNT_REVIEW",
      opportunityScore: 90,
      underlyingSignal: "BUY",
      reasonCode: "PRICE_BELOW_BUY_ZONE",
      reason: "Price is below the normal buy zone, so the opportunity looks attractive but should be checked for thesis risk."
    };
  }
  if (buyHigh != null && price <= buyHigh) {
    return {
      state: "BUY_ZONE",
      opportunityScore: 85,
      underlyingSignal: "BUY",
      reasonCode: "PRICE_IN_BUY_ZONE",
      reason: "Price is inside the buy zone."
    };
  }
  if (addHigh != null && price <= addHigh) {
    return {
      state: "ADD_ZONE",
      opportunityScore: 72,
      underlyingSignal: "ADD",
      reasonCode: "PRICE_IN_ADD_ZONE",
      reason: "Price is inside the add zone."
    };
  }
  if (fairHigh != null && price <= fairHigh) {
    return {
      state: "FAIR_VALUE",
      opportunityScore: 52,
      underlyingSignal: "HOLD",
      reasonCode: "PRICE_NEAR_FAIR_VALUE",
      reason: "Price is near fair value."
    };
  }
  if ((trim != null && price >= trim) || (reviewHigh != null && price > reviewHigh)) {
    return {
      state: "TRIM_REVIEW",
      opportunityScore: 15,
      underlyingSignal: "TRIM",
      reasonCode: "PRICE_ABOVE_TRIM_ZONE",
      reason: "Price is above the trim or upper review zone."
    };
  }
  return {
    state: "VALUATION_REVIEW",
    opportunityScore: 32,
    underlyingSignal: "REVIEW",
    reasonCode: "PRICE_IN_REVIEW_ZONE",
    reason: "Price is above fair value but not clearly past the trim zone."
  };
}

function thesisStateFor(decision) {
  if (decision?.riskLevel === "High" && decision?.status === "AVOID") {
    return {
      state: "BROKEN_OR_UNPROVEN",
      score: 25,
      reasonCode: "THESIS_HIGH_RISK",
      reason: "Current rule output marks this as high risk."
    };
  }
  const moat = finite(decision?.moatScore) ?? 4;
  const ai = finite(decision?.aiExposureScore) ?? 1;
  const score = Math.max(0, Math.min(100, Math.round((moat * 7) + (ai * 3))));
  if (score >= 75) {
    return {
      state: "STRONG",
      score,
      reasonCode: "THESIS_STRONG",
      reason: "Business quality and theme exposure score strongly."
    };
  }
  if (score >= 55) {
    return {
      state: "STABLE",
      score,
      reasonCode: "THESIS_STABLE",
      reason: "Business quality is acceptable."
    };
  }
  return {
    state: "REVIEW_THESIS",
    score,
    reasonCode: "THESIS_NEEDS_REVIEW",
    reason: "Business quality, moat, or theme exposure needs review."
  };
}

function positionStateFor(decision, limits = DEFAULT_LIMITS) {
  if (!decision?.isHeld) {
    return {
      state: "WATCHLIST_ONLY",
      fitScore: 75,
      reasonCode: "NOT_CURRENTLY_OWNED",
      reason: "Ticker is not currently owned."
    };
  }
  const exposure = finite(decision.exposurePercent) ?? 0;
  if (exposure >= limits.positionCriticalPercent) {
    return {
      state: "CRITICAL_CONCENTRATION",
      fitScore: 5,
      reasonCode: "POSITION_ABOVE_CRITICAL_LIMIT",
      reason: `Position is ${roundPercent(exposure)}% of the portfolio versus a ${limits.positionCriticalPercent}% critical limit. Reduce concentration before adding capital.`
    };
  }
  if (exposure >= limits.positionHardPercent) {
    return {
      state: "HARD_LIMIT",
      fitScore: 15,
      reasonCode: "POSITION_ABOVE_HARD_LIMIT",
      reason: `Position is ${roundPercent(exposure)}% of the portfolio, above the ${limits.positionHardPercent}% hard limit.`
    };
  }
  if (exposure >= limits.positionSoftPercent) {
    return {
      state: "SOFT_LIMIT",
      fitScore: 45,
      reasonCode: "POSITION_ABOVE_SOFT_LIMIT",
      reason: `Position is ${roundPercent(exposure)}% of the portfolio, above the ${limits.positionSoftPercent}% soft limit.`
    };
  }
  if (exposure >= limits.positionNormalPercent) {
    return {
      state: "NEAR_LIMIT",
      fitScore: 62,
      reasonCode: "POSITION_NEAR_LIMIT",
      reason: `Position is ${roundPercent(exposure)}% of the portfolio, close to the normal ${limits.positionNormalPercent}% size limit.`
    };
  }
  return {
    state: "NORMAL",
    fitScore: 88,
    reasonCode: "POSITION_SIZE_NORMAL",
    reason: "Position size is inside normal limits."
  };
}

function groupStateFor(decision, dashboard, limits = DEFAULT_LIMITS) {
  const groupName = decision?.position?.categoryName || decision?.watchlistItem?.categoryName || decision?.categoryName || decision?.theme;
  const group = (dashboard?.allocation || []).find((item) => item.name === groupName);
  if (!group) {
    return {
      state: "UNKNOWN",
      fitScore: 55,
      groupName: groupName || "Unclassified",
      reasonCode: "GROUP_NOT_MAPPED",
      reason: "No matching allocation group was found."
    };
  }
  const actual = finite(group.actualPercent) ?? 0;
  const target = finite(group.targetPercent) ?? 0;
  const variance = actual - target;
  const absVariance = Math.abs(variance);
  if (variance > limits.groupHardVariancePP) {
    return {
      state: "HARD_OVERWEIGHT",
      fitScore: 20,
      groupName: group.name,
      actualPercent: roundPercent(actual),
      targetPercent: roundPercent(target),
      variancePP: roundPercent(variance),
      reasonCode: "GROUP_HARD_OVERWEIGHT",
      reason: `${group.name} is ${roundPercent(actual)}% versus a ${roundPercent(target)}% target (${signedPp(variance)}). This is a hard overweight, so adding here is blocked until the group is rebalanced.`
    };
  }
  if (variance > limits.groupOnTargetBandPP) {
    return {
      state: "OVERWEIGHT",
      fitScore: 50,
      groupName: group.name,
      actualPercent: roundPercent(actual),
      targetPercent: roundPercent(target),
      variancePP: roundPercent(variance),
      reasonCode: "GROUP_OVERWEIGHT",
      reason: `${group.name} is ${roundPercent(actual)}% versus a ${roundPercent(target)}% target (${signedPp(variance)}). New buys in this group need review.`
    };
  }
  if (variance < -limits.groupOnTargetBandPP) {
    return {
      state: "UNDERWEIGHT",
      fitScore: 78,
      groupName: group.name,
      actualPercent: roundPercent(actual),
      targetPercent: roundPercent(target),
      variancePP: roundPercent(variance),
      reasonCode: "GROUP_UNDERWEIGHT",
      reason: `${group.name} is ${roundPercent(actual)}% versus a ${roundPercent(target)}% target (${signedPp(variance)}). It is under target, so sizing room exists if the stock-specific case is strong.`
    };
  }
  return {
    state: "ON_TARGET",
    fitScore: 90,
    groupName: group.name,
    actualPercent: roundPercent(actual),
    targetPercent: roundPercent(target),
    variancePP: roundPercent(variance),
    reasonCode: "GROUP_ON_TARGET",
    reason: `${group.name} is close to target.`
  };
}

function themeStateFor(decision, dashboard, limits = DEFAULT_LIMITS) {
  const theme = decision?.theme || "Unclassified";
  const exposure = (dashboard?.intelligence?.themeExposure || []).find((item) => item.name === theme)?.exposurePercent || 0;
  if (!decision?.isHeld) {
    return {
      state: "WATCHLIST_ONLY",
      fitScore: 70,
      theme,
      exposurePercent: 0,
      reasonCode: "THEME_NOT_OWNED",
      reason: "Theme exposure does not apply until owned."
    };
  }
  if (exposure >= limits.themeHardPercent) {
    return {
      state: "HARD_OVER_LIMIT",
      fitScore: 20,
      theme,
      exposurePercent: roundPercent(exposure),
      reasonCode: "THEME_HARD_LIMIT",
      reason: `${theme} exposure is ${roundPercent(exposure)}%, above the ${limits.themeHardPercent}% hard theme limit.`
    };
  }
  if (exposure >= limits.themeSoftPercent) {
    return {
      state: "SOFT_OVER_LIMIT",
      fitScore: 48,
      theme,
      exposurePercent: roundPercent(exposure),
      reasonCode: "THEME_SOFT_LIMIT",
      reason: `${theme} exposure is ${roundPercent(exposure)}%, above the ${limits.themeSoftPercent}% soft theme limit.`
    };
  }
  return {
    state: "OK",
    fitScore: 85,
    theme,
    exposurePercent: roundPercent(exposure),
    reasonCode: "THEME_OK",
    reason: `${theme} exposure is inside broad limits.`
  };
}

function liquidityStateFor(decision) {
  const volume = finite(decision?.price?.volume);
  const averageVolume = finite(decision?.price?.averageVolume);
  const reference = averageVolume || volume;
  if (reference == null) {
    return {
      state: "UNKNOWN",
      score: 55,
      reasonCode: "LIQUIDITY_DATA_MISSING",
      reason: "Volume data is unavailable."
    };
  }
  if (reference < 100000) {
    return {
      state: "LOW_LIQUIDITY",
      score: 30,
      reasonCode: "LOW_TRADING_VOLUME",
      reason: `Trading volume is low: ${formatLargeNumber(reference)} shares versus the 100,000 normal minimum.`
    };
  }
  if (reference < 500000) {
    return {
      state: "THIN",
      score: 58,
      reasonCode: "THIN_TRADING_VOLUME",
      reason: `Trading volume is thin: ${formatLargeNumber(reference)} shares versus the 500,000 preferred threshold.`
    };
  }
  return {
    state: "OK",
    score: 88,
    reasonCode: "LIQUIDITY_OK",
    reason: "Trading volume is sufficient for normal monitoring."
  };
}

function tradeEligibilityFor(parts) {
  const blockers = [];
  const warnings = [];
  if (parts.data.state === "MISSING_PRICE") blockers.push("DATA_MISSING");
  if (["CRITICAL_CONCENTRATION", "HARD_LIMIT"].includes(parts.position.state)) blockers.push(parts.position.reasonCode);
  if (parts.group.state === "HARD_OVERWEIGHT") blockers.push(parts.group.reasonCode);
  if (parts.theme.state === "HARD_OVER_LIMIT") blockers.push(parts.theme.reasonCode);
  if (parts.thesis.state === "BROKEN_OR_UNPROVEN") blockers.push(parts.thesis.reasonCode);

  if (parts.data.state === "PARTIAL_PRICE") warnings.push("DATA_PARTIAL");
  if (parts.position.state === "SOFT_LIMIT") warnings.push(parts.position.reasonCode);
  if (parts.group.state === "OVERWEIGHT") warnings.push(parts.group.reasonCode);
  if (parts.theme.state === "SOFT_OVER_LIMIT") warnings.push(parts.theme.reasonCode);
  if (["LOW_LIQUIDITY", "THIN", "UNKNOWN"].includes(parts.liquidity.state)) warnings.push(parts.liquidity.reasonCode);

  if (blockers.length) {
    return {
      state: "BLOCKED",
      blockers,
      warnings,
      reason: "One or more hard rules block new buying."
    };
  }
  if (warnings.length) {
    return {
      state: "CAUTION",
      blockers,
      warnings,
      reason: "No hard block, but one or more risk checks need review."
    };
  }
  return {
    state: "ELIGIBLE",
    blockers,
    warnings,
    reason: "No blocking rules are active."
  };
}

function partForReasonCode(parts, reasonCode) {
  return [
    parts.position,
    parts.group,
    parts.theme,
    parts.data,
    parts.thesis,
    parts.liquidity,
    parts.valuation
  ].find((part) => part?.reasonCode === reasonCode) || null;
}

function explanationForIssue(parts, reasonCode, fallback) {
  return partForReasonCode(parts, reasonCode)?.reason || fallback;
}

function finalActionFor(decision, parts) {
  const underlying = parts.valuation.underlyingSignal;
  const reasonCodes = [
    parts.valuation.reasonCode,
    parts.position.reasonCode,
    parts.group.reasonCode,
    parts.theme.reasonCode,
    parts.data.reasonCode,
    parts.thesis.reasonCode,
    parts.liquidity.reasonCode
  ].filter(Boolean);

  if (parts.data.state === "MISSING_PRICE") {
    return {
      finalAction: "REVIEW",
      primaryReasonCode: "DATA_MISSING",
      secondaryReasonCodes: reasonCodes,
      explanation: parts.data.reason
    };
  }
  if (["CRITICAL_CONCENTRATION", "HARD_LIMIT"].includes(parts.position.state)) {
    return {
      finalAction: "TRIM",
      primaryReasonCode: parts.position.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: `${parts.position.reason} Position size overrides valuation attractiveness.`
    };
  }
  if (parts.tradeEligibility.state === "BLOCKED" && ["BUY", "ADD"].includes(underlying)) {
    const blocker = parts.tradeEligibility.blockers[0];
    return {
      finalAction: "REVIEW",
      primaryReasonCode: blocker,
      secondaryReasonCodes: reasonCodes,
      explanation: `The valuation signal is ${underlying}, but ${explanationForIssue(parts, blocker, "a hard portfolio rule blocks adding.")}`
    };
  }
  if (parts.tradeEligibility.state === "CAUTION" && ["BUY", "ADD"].includes(underlying)) {
    const warning = parts.tradeEligibility.warnings[0] || parts.valuation.reasonCode;
    return {
      finalAction: "REVIEW",
      primaryReasonCode: warning,
      secondaryReasonCodes: reasonCodes,
      explanation: `${explanationForIssue(parts, warning, parts.tradeEligibility.reason)} The signal is attractive, but this needs review before acting.`
    };
  }
  if (underlying === "TRIM") {
    return {
      finalAction: "TRIM",
      primaryReasonCode: parts.valuation.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: parts.valuation.reason
    };
  }
  if (underlying === "BUY") {
    return {
      finalAction: decision.isHeld ? "ADD" : "BUY",
      primaryReasonCode: parts.valuation.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: decision.isHeld ? "Attractive valuation; owned position can be considered for adding if sizing permits." : "Attractive valuation for a watchlist candidate."
    };
  }
  if (underlying === "ADD" && decision.isHeld) {
    return {
      finalAction: "ADD",
      primaryReasonCode: parts.valuation.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: "Held position is in the add zone."
    };
  }
  if (underlying === "REVIEW" || parts.tradeEligibility.state === "CAUTION") {
    const warning = parts.tradeEligibility.warnings[0] || parts.valuation.reasonCode;
    return {
      finalAction: "REVIEW",
      primaryReasonCode: warning,
      secondaryReasonCodes: reasonCodes,
      explanation: explanationForIssue(parts, warning, parts.valuation.reason)
    };
  }
  return {
    finalAction: "HOLD",
    primaryReasonCode: "NO_ACTION_REQUIRED",
    secondaryReasonCodes: reasonCodes,
    explanation: "No urgent buy, add, trim, or data review signal."
  };
}

function priorityFor(finalAction, parts) {
  if (parts.position.state === "CRITICAL_CONCENTRATION") return "Critical";
  if (parts.tradeEligibility.state === "BLOCKED" || finalAction === "TRIM") return "High";
  if (finalAction === "REVIEW" || parts.tradeEligibility.state === "CAUTION") return "Medium";
  return "Low";
}

function evaluateDecision(decision, dashboard) {
  const data = dataStateFor(decision);
  const valuation = valuationStateFor(decision);
  const thesis = thesisStateFor(decision);
  const position = positionStateFor(decision);
  const group = groupStateFor(decision, dashboard);
  const theme = themeStateFor(decision, dashboard);
  const liquidity = liquidityStateFor(decision);
  const parts = { data, valuation, thesis, position, group, theme, liquidity };
  const tradeEligibility = tradeEligibilityFor(parts);
  parts.tradeEligibility = tradeEligibility;
  const action = finalActionFor(decision, parts);
  const portfolioFitScore = Math.round((position.fitScore + group.fitScore + theme.fitScore + liquidity.score) / 4);
  const evaluatedAt = new Date().toISOString();
  const priority = priorityFor(action.finalAction, parts);

  return {
    ticker: decision.ticker,
    name: decision.name || "",
    scope: decision.scope || (decision.isHeld ? "PORTFOLIO" : "WATCHLIST"),
    isHeld: Boolean(decision.isHeld),
    watchlistItemId: decision.watchlistItemId || decision.watchlistItem?.id || null,
    watchlistId: decision.watchlistId || decision.watchlistItem?.watchlistId || null,
    watchlistName: decision.watchlistName || decision.watchlistItem?.watchlistName || null,
    oldAction: decision.status || "UNKNOWN",
    valuationState: valuation.state,
    thesisState: thesis.state,
    positionState: position.state,
    groupState: group.state,
    themeState: theme.state,
    liquidityState: liquidity.state,
    dataState: data.state,
    tradeEligibility: tradeEligibility.state,
    underlyingSignal: valuation.underlyingSignal,
    finalAction: action.finalAction,
    primaryReasonCode: action.primaryReasonCode,
    secondaryReasonCodes: action.secondaryReasonCodes,
    priority,
    rulesVersion: RULES_ENGINE_V2_VERSION,
    evaluatedAt,
    explanation: action.explanation,
    scores: {
      thesisConviction: thesis.score,
      valuationOpportunity: valuation.opportunityScore,
      portfolioFit: portfolioFitScore,
      dataConfidence: data.confidence
    },
    context: {
      price: priceFor(decision),
      currency: decision?.price?.currency || null,
      exposurePercent: roundPercent(decision.exposurePercent || 0),
      groupName: group.groupName || null,
      groupActualPercent: group.actualPercent ?? null,
      groupTargetPercent: group.targetPercent ?? null,
      groupVariancePP: group.variancePP ?? null,
      theme: theme.theme || decision.theme || "Unclassified",
      themeExposurePercent: theme.exposurePercent ?? null,
      liquidityVolume: finite(decision?.price?.averageVolume) || finite(decision?.price?.volume) || null
    },
    classes: {
      priority: priority === "Critical" || priority === "High" ? "negative" : priority === "Medium" ? "warning" : "live",
      finalAction: stateClass(action.finalAction),
      eligibility: stateClass(tradeEligibility.state),
      data: stateClass(data.state),
      position: stateClass(position.state),
      group: stateClass(group.state),
      valuation: stateClass(valuation.state)
    }
  };
}

function enrichedOldDecisions(dashboard) {
  const positionsByTicker = new Map((dashboard?.positions || []).map((position) => [position.ticker, position]));
  const watchlistByTicker = new Map();
  for (const item of dashboard?.watchlist || []) {
    if (!watchlistByTicker.has(item.ticker)) watchlistByTicker.set(item.ticker, item);
  }
  return [
    ...(dashboard?.intelligence?.portfolioDecisions || []),
    ...(dashboard?.intelligence?.watchlistDecisions || [])
  ].map((decision) => {
    const position = positionsByTicker.get(decision.ticker) || null;
    const watchlistItem = watchlistByTicker.get(decision.ticker) || null;
    return {
      ...decision,
      position,
      watchlistItem,
      categoryName: position?.categoryName || watchlistItem?.categoryName || decision.categoryName || decision.theme
    };
  });
}

export function buildRulesEngineComparison(dashboard) {
  const oldDecisions = enrichedOldDecisions(dashboard);
  const evaluations = oldDecisions.map((decision) => evaluateDecision(decision, dashboard));
  const changed = evaluations.filter((item) => item.oldAction !== item.finalAction);
  const blockers = evaluations.filter((item) => item.tradeEligibility === "BLOCKED");
  const caution = evaluations.filter((item) => item.tradeEligibility === "CAUTION");
  const byAction = evaluations.reduce((map, item) => {
    map[item.finalAction] = (map[item.finalAction] || 0) + 1;
    return map;
  }, {});

  const sorted = [...evaluations].sort((a, b) => (
    priorityRank(a.priority) - priorityRank(b.priority)
    || a.scope.localeCompare(b.scope)
    || a.ticker.localeCompare(b.ticker)
  ));

  return {
    version: RULES_ENGINE_V2_VERSION,
    evaluatedAt: new Date().toISOString(),
    summary: {
      total: evaluations.length,
      portfolio: evaluations.filter((item) => item.scope === "PORTFOLIO").length,
      watchlist: evaluations.filter((item) => item.scope === "WATCHLIST").length,
      changedCount: changed.length,
      blockedCount: blockers.length,
      cautionCount: caution.length,
      byAction
    },
    notice: "Read-only comparison. Current dashboard and alerts still use the existing engine until you approve V2.",
    evaluations: sorted.map((item) => ({
      ...item,
      context: {
        ...item.context,
        price: roundMoney(item.context.price),
        liquidityVolume: item.context.liquidityVolume == null ? null : Math.round(item.context.liquidityVolume)
      }
    }))
  };
}

function evaluationKey(item) {
  return [
    item.scope || "",
    item.ticker || "",
    item.watchlistItemId || ""
  ].join("|");
}

function activeConviction(evaluation) {
  const scores = evaluation?.scores || {};
  return Math.max(0, Math.min(100, Math.round(
    (Number(scores.thesisConviction) || 0) * 0.34
    + (Number(scores.valuationOpportunity) || 0) * 0.28
    + (Number(scores.portfolioFit) || 0) * 0.26
    + (Number(scores.dataConfidence) || 0) * 0.12
  )));
}

function riskLevelFromPriority(priority) {
  if (priority === "Critical" || priority === "High") return "High";
  if (priority === "Medium") return "Medium";
  return "Low";
}

function activateDecision(decision, evaluation) {
  if (!evaluation) return decision;
  return {
    ...decision,
    oldStatus: decision.status,
    status: evaluation.finalAction,
    reason: evaluation.explanation || decision.reason,
    riskLevel: riskLevelFromPriority(evaluation.priority),
    convictionScore: activeConviction(evaluation),
    tradeEligibility: evaluation.tradeEligibility,
    underlyingSignal: evaluation.underlyingSignal,
    valuationState: evaluation.valuationState,
    thesisState: evaluation.thesisState,
    positionState: evaluation.positionState,
    groupState: evaluation.groupState,
    themeState: evaluation.themeState,
    liquidityState: evaluation.liquidityState,
    dataState: evaluation.dataState,
    primaryReasonCode: evaluation.primaryReasonCode,
    secondaryReasonCodes: evaluation.secondaryReasonCodes,
    rulesVersion: evaluation.rulesVersion,
    evaluatedAt: evaluation.evaluatedAt,
    v2: evaluation
  };
}

function sortActiveDecisions(items) {
  return [...items].sort((a, b) => (
    priorityRank(a.v2?.priority) - priorityRank(b.v2?.priority)
    || actionRank(a.status) - actionRank(b.status)
    || (b.convictionScore || 0) - (a.convictionScore || 0)
    || String(a.ticker || "").localeCompare(String(b.ticker || ""))
  ));
}

function summarizeBy(items, field) {
  const totals = new Map();
  for (const item of items) {
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

function activeSummary(decisions, portfolioDecisions, watchlistDecisions) {
  const count = (status, items = decisions) => items.filter((item) => item.status === status).length;
  return {
    monitoredCount: decisions.length,
    portfolioCount: portfolioDecisions.length,
    watchlistCount: watchlistDecisions.length,
    buyCount: count("BUY"),
    addCount: count("ADD"),
    reviewCount: count("REVIEW"),
    trimCount: count("TRIM"),
    portfolioReviewCount: count("REVIEW", portfolioDecisions),
    portfolioTrimCount: count("TRIM", portfolioDecisions),
    watchlistBuyCount: count("BUY", watchlistDecisions),
    watchlistAddCount: count("ADD", watchlistDecisions),
    averageConviction: decisions.length
      ? Math.round(decisions.reduce((total, item) => total + (item.convictionScore || 0), 0) / decisions.length)
      : 0
  };
}

function activeRisks(portfolioDecisions, fallbackRisks = []) {
  const v2Risks = portfolioDecisions
    .filter((item) => ["Critical", "High", "Medium"].includes(item.v2?.priority))
    .slice(0, 6)
    .map((item) => ({
      kind: item.primaryReasonCode || "Rules V2",
      severity: riskLevelFromPriority(item.v2?.priority),
      text: `${item.ticker}: ${item.reason}`,
      ticker: item.ticker
    }));
  return v2Risks.length ? v2Risks : fallbackRisks;
}

function activeCapitalPlan(decisions, oldPlan = {}, user = {}) {
  const candidates = decisions
    .filter((item) => ["BUY", "ADD"].includes(item.status) && item.tradeEligibility !== "BLOCKED")
    .sort((a, b) => (b.convictionScore || 0) - (a.convictionScore || 0))
    .slice(0, 6);
  const cashBase = roundMoney(oldPlan.cashBase || 0);
  const totalScore = candidates.reduce((total, item) => total + (item.convictionScore || 0), 0) || 1;
  return {
    ...oldPlan,
    cashBase,
    currency: oldPlan.currency || user.baseCurrency || "AUD",
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

function activeWatchlistLists(watchlistDecisions) {
  const lists = new Map();
  for (const item of watchlistDecisions) {
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
    if (!list.priority || priorityRank(item.v2?.priority) < priorityRank(list.priority.v2?.priority) || item.convictionScore > list.priority.convictionScore) {
      list.priority = item;
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
    priority: list.priority ? {
      ticker: list.priority.ticker,
      status: list.priority.status,
      theme: list.priority.theme,
      convictionScore: list.priority.convictionScore,
      reason: list.priority.reason,
      v2: list.priority.v2
    } : null,
    convictionTotal: undefined
  })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
}

export function buildActiveRulesEngineV2({ dashboard, oldIntelligence }) {
  const comparison = buildRulesEngineComparison({
    ...dashboard,
    intelligence: oldIntelligence
  });
  const evaluationByKey = new Map((comparison.evaluations || []).map((item) => [evaluationKey(item), item]));
  const activate = (decision) => activateDecision(
    decision,
    evaluationByKey.get(evaluationKey(decision))
      || evaluationByKey.get(`${decision.scope || ""}|${decision.ticker || ""}|`)
  );
  const portfolioDecisions = sortActiveDecisions((oldIntelligence.portfolioDecisions || []).map(activate));
  const watchlistDecisions = sortActiveDecisions((oldIntelligence.watchlistDecisions || []).map(activate));
  const decisions = sortActiveDecisions([...portfolioDecisions, ...watchlistDecisions]);
  const intelligence = {
    ...oldIntelligence,
    mode: "rules-v2",
    rulesVersion: RULES_ENGINE_V2_VERSION,
    disclaimer: "Research support only. Rules V2 is active decision support, not personal financial advice.",
    oldEngineSummary: oldIntelligence.summary,
    summary: activeSummary(decisions, portfolioDecisions, watchlistDecisions),
    decisions,
    decisionQueue: decisions.slice(0, 18),
    portfolioDecisions,
    watchlistDecisions,
    portfolioQueue: portfolioDecisions.slice(0, 18),
    watchlistQueue: watchlistDecisions.slice(0, 18),
    watchlistLists: activeWatchlistLists(watchlistDecisions),
    themeExposure: summarizeBy(portfolioDecisions, "theme"),
    watchlistThemeExposure: summarizeBy(watchlistDecisions, "theme"),
    geographyExposure: summarizeBy(portfolioDecisions, "geography"),
    watchlistGeographyExposure: summarizeBy(watchlistDecisions, "geography"),
    risks: activeRisks(portfolioDecisions, oldIntelligence.risks || []),
    capitalPlan: activeCapitalPlan(decisions, oldIntelligence.capitalPlan || {}, dashboard.user || {})
  };
  return { intelligence, comparison };
}
