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
      reason: `Position is ${roundPercent(exposure)}% of the portfolio.`
    };
  }
  if (exposure >= limits.positionHardPercent) {
    return {
      state: "HARD_LIMIT",
      fitScore: 15,
      reasonCode: "POSITION_ABOVE_HARD_LIMIT",
      reason: `Position is above the ${limits.positionHardPercent}% hard limit.`
    };
  }
  if (exposure >= limits.positionSoftPercent) {
    return {
      state: "SOFT_LIMIT",
      fitScore: 45,
      reasonCode: "POSITION_ABOVE_SOFT_LIMIT",
      reason: `Position is above the ${limits.positionSoftPercent}% soft limit.`
    };
  }
  if (exposure >= limits.positionNormalPercent) {
    return {
      state: "NEAR_LIMIT",
      fitScore: 62,
      reasonCode: "POSITION_NEAR_LIMIT",
      reason: `Position is near the normal ${limits.positionNormalPercent}% size limit.`
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
      reason: `${group.name} is ${roundPercent(variance)} percentage points above target.`
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
      reason: `${group.name} is above target.`
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
      reason: `${group.name} is below target.`
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
      reason: `${theme} exposure is above the hard limit.`
    };
  }
  if (exposure >= limits.themeSoftPercent) {
    return {
      state: "SOFT_OVER_LIMIT",
      fitScore: 48,
      theme,
      exposurePercent: roundPercent(exposure),
      reasonCode: "THEME_SOFT_LIMIT",
      reason: `${theme} exposure is elevated.`
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
      reason: "Trading volume looks low."
    };
  }
  if (reference < 500000) {
    return {
      state: "THIN",
      score: 58,
      reasonCode: "THIN_TRADING_VOLUME",
      reason: "Trading volume is usable but thin."
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
      explanation: "Review because price data is missing."
    };
  }
  if (["CRITICAL_CONCENTRATION", "HARD_LIMIT"].includes(parts.position.state)) {
    return {
      finalAction: "TRIM",
      primaryReasonCode: parts.position.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: "Position size overrides valuation attractiveness."
    };
  }
  if (parts.tradeEligibility.state === "BLOCKED" && ["BUY", "ADD"].includes(underlying)) {
    return {
      finalAction: "REVIEW",
      primaryReasonCode: parts.tradeEligibility.blockers[0],
      secondaryReasonCodes: reasonCodes,
      explanation: "The stock signal is attractive, but portfolio rules block adding."
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
    return {
      finalAction: "REVIEW",
      primaryReasonCode: parts.tradeEligibility.warnings[0] || parts.valuation.reasonCode,
      secondaryReasonCodes: reasonCodes,
      explanation: parts.tradeEligibility.reason
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

export function buildRulesEngineComparison(dashboard) {
  const positionsByTicker = new Map((dashboard?.positions || []).map((position) => [position.ticker, position]));
  const watchlistByTicker = new Map();
  for (const item of dashboard?.watchlist || []) {
    if (!watchlistByTicker.has(item.ticker)) watchlistByTicker.set(item.ticker, item);
  }
  const oldDecisions = [
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
