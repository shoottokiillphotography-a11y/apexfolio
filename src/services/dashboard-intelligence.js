import { roundMoney, roundPercent } from "../utils.js";

function exposure(position, totalValueBase) {
  return totalValueBase && position?.currentValueBase
    ? roundPercent((position.currentValueBase / totalValueBase) * 100)
    : 0;
}

function statusForVariance(variancePercent = 0, band = 2) {
  if (variancePercent > band) return "Underweight";
  if (variancePercent < -band) return "Overweight";
  return "On target";
}

function decisionCandidates(intelligence = {}, statuses = ["BUY", "ADD"]) {
  return (intelligence.decisions || [])
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => (b.convictionScore || 0) - (a.convictionScore || 0));
}

export function buildDashboardIntelligence({
  positions = [],
  watchlist = [],
  allocation = [],
  cashBalances = [],
  alerts = [],
  events = [],
  intelligence = {},
  summary = {},
  user = {},
  rules = {}
}) {
  const concentrationRules = rules.concentration || {};
  const allocationRules = rules.allocation || {};
  const cashRules = rules.cash || {};
  const concWarn = Number.isFinite(concentrationRules.warnAtPercent) ? concentrationRules.warnAtPercent : 15;
  const concHigh = Number.isFinite(concentrationRules.highAtPercent) ? concentrationRules.highAtPercent : 20;
  const allocWarn = Number.isFinite(allocationRules.warnAtVariancePP) ? allocationRules.warnAtVariancePP : 5;
  const allocHigh = Number.isFinite(allocationRules.highAtVariancePP) ? allocationRules.highAtVariancePP : 15;
  const allocBand = Number.isFinite(allocationRules.onTargetBandPP) ? allocationRules.onTargetBandPP : 2;
  const cashWarn = Number.isFinite(cashRules.elevatedAtPercent) ? cashRules.elevatedAtPercent : 12;
  const cashHigh = Number.isFinite(cashRules.highAtPercent) ? cashRules.highAtPercent : 20;
  const totalValueBase = summary.totalValueBase || 0;
  const openPositions = positions.filter((position) => !position.closed && (position.quantity || 0) > 0);
  const largest = [...openPositions].sort((a, b) => (b.currentValueBase || 0) - (a.currentValueBase || 0))[0] || null;
  const largestExposure = exposure(largest, totalValueBase);
  const triggeredAlerts = alerts.filter((alert) => alert.triggered && !alert.acknowledged_at && !alert.archived_at);
  const cashBase = summary.cashAvailableBase ?? roundMoney(cashBalances.reduce((total, item) => total + (Number(item.amountBase) || 0), 0));
  const cashPercent = totalValueBase ? roundPercent((cashBase / totalValueBase) * 100) : 0;
  const buyCandidates = decisionCandidates(intelligence);
  const portfolioCandidates = buyCandidates.filter((item) => item.scope === "PORTFOLIO");
  const watchlistCandidates = buyCandidates.filter((item) => item.scope === "WATCHLIST" && !item.alreadyOwned);
  const allocationPressure = [...allocation]
    .filter((item) => item.active !== 0)
    .sort((a, b) => Math.abs(b.variancePercent || 0) - Math.abs(a.variancePercent || 0))[0] || null;

  const risks = [];
  if (largest && largestExposure >= concWarn) {
    risks.push({
      type: "Concentration",
      severity: largestExposure >= concHigh ? "High" : "Medium",
      title: `${largest.ticker} concentration`,
      text: `${largest.ticker} is ${largestExposure}% of portfolio value. Avoid adding unless the target sizing is intentional.`,
      ticker: largest.ticker
    });
  }
  if (allocationPressure && Math.abs(allocationPressure.variancePercent || 0) >= allocWarn) {
    risks.push({
      type: "Allocation",
      severity: Math.abs(allocationPressure.variancePercent) >= allocHigh ? "High" : "Medium",
      title: `${allocationPressure.name} ${statusForVariance(allocationPressure.variancePercent, allocBand)}`,
      text: `${allocationPressure.name} is ${Math.abs(allocationPressure.variancePercent)} percentage points away from target.`,
      categoryId: allocationPressure.id
    });
  }
  if (cashPercent >= cashWarn) {
    risks.push({
      type: "Cash drag",
      severity: cashPercent >= cashHigh ? "High" : "Medium",
      title: "Cash is elevated",
      text: `${cashPercent}% of the portfolio is cash. Deploy only into valid buy/add zones.`,
      cashBase
    });
  }
  if (triggeredAlerts.length) {
    risks.push({
      type: "Alerts",
      severity: "High",
      title: `${triggeredAlerts.length} alert${triggeredAlerts.length === 1 ? "" : "s"} need review`,
      text: "Review triggered alerts before making new allocation decisions.",
      count: triggeredAlerts.length
    });
  }

  const opportunities = [
    ...portfolioCandidates.slice(0, 3).map((item) => ({
      scope: "Portfolio",
      ticker: item.ticker,
      status: item.status,
      title: `${item.status} ${item.ticker}`,
      text: item.reason,
      priority: item.convictionScore || 0
    })),
    ...watchlistCandidates.slice(0, 3).map((item) => ({
      scope: "Watchlist",
      ticker: item.ticker,
      status: item.status,
      title: `${item.status} ${item.ticker}`,
      text: item.reason,
      priority: item.convictionScore || 0
    }))
  ].sort((a, b) => b.priority - a.priority);

  let command = {
    priority: "Normal",
    title: "Hold course",
    text: "No urgent portfolio action is required from current rules-based signals.",
    confidence: "Medium"
  };
  if (risks[0]?.type === "Concentration") {
    command = {
      priority: risks[0].severity,
      title: `Do not add ${risks[0].ticker}`,
      text: risks[0].text,
      confidence: "High"
    };
  } else if (triggeredAlerts.length) {
    command = {
      priority: "High",
      title: "Review triggered alerts first",
      text: `${triggeredAlerts.length} triggered alert${triggeredAlerts.length === 1 ? "" : "s"} need a decision before new buys.`,
      confidence: "High"
    };
  } else if (opportunities[0]) {
    command = {
      priority: opportunities[0].status === "BUY" ? "High" : "Medium",
      title: `${opportunities[0].status} candidate: ${opportunities[0].ticker}`,
      text: opportunities[0].text,
      confidence: "Medium"
    };
  }

  const cashPlan = {
    cashBase,
    cashPercent,
    action: cashBase <= 0 ? "No cash available" : opportunities[0] ? `Review ${opportunities[0].ticker}` : "Hold cash",
    reason: cashBase <= 0
      ? "No saved cash balance is available for deployment."
      : opportunities[0]
        ? "Rules engine found a buy/add candidate. Confirm thesis and sizing before acting."
        : "No current buy/add signal is attractive enough from available price zones.",
    candidates: opportunities.slice(0, 4)
  };

  const newsSummary = events.slice(0, 6).map((event) => ({
    ticker: event.ticker,
    title: event.title,
    eventType: event.eventType,
    tag: event.eventType?.includes("EARN") ? "Earnings" : watchlist.some((item) => item.ticker === event.ticker) ? "Watchlist" : "Portfolio",
    sourceUrl: event.sourceUrl,
    date: event.eventDate
  }));

  return {
    mode: "rules",
    aiReady: true,
    command,
    risks: risks.slice(0, 5),
    opportunities: opportunities.slice(0, 6),
    cashPlan,
    newsSummary,
    playbook: typeof rules.playbook === "string" ? rules.playbook : "",
    thresholds: {
      concentrationWarnPercent: concWarn,
      concentrationHighPercent: concHigh,
      allocationWarnPP: allocWarn,
      allocationHighPP: allocHigh,
      cashElevatedPercent: cashWarn,
      cashHighPercent: cashHigh
    }
  };
}
