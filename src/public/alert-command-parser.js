const DEFAULT_CURRENCIES = ["USD", "AUD", "GBP", "EUR", "DKK", "HKD", "CHF", "CAD", "JPY", "SEK", "NOK", "NZD", "SGD", "IDR"];

const BUILT_IN_ALIASES = {
  MU: ["micron", "micron technology"],
  MSFT: ["microsoft"],
  ORCL: ["oracle"],
  "WISE.L": ["wise", "wise plc"],
  NVDA: ["nvidia"],
  WDC: ["western digital"],
  GOOG: ["google", "alphabet"],
  GOOGL: ["alphabet class a"],
  AMZN: ["amazon"],
  META: ["meta", "facebook"],
  AVGO: ["broadcom"],
  AMD: ["advanced micro devices"],
  "NOVO-B.CO": ["novo", "novo nordisk"],
  "LNW.AX": ["light & wonder", "light and wonder"],
  "MTO.AX": ["motorcycle holdings", "motorcycle"]
};

const ACTION_OPTIONS = [
  "Buy",
  "Add",
  "Trim",
  "Sell",
  "Review",
  "Re-analyse",
  "Hold",
  "Watch",
  "Take profit",
  "Risk review",
  "Custom"
];

function normalizeTicker(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueByTicker(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const ticker = normalizeTicker(item.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    unique.push({ ...item, ticker });
  }
  return unique;
}

function securityAliases(security) {
  const ticker = normalizeTicker(security.ticker);
  const pieces = new Set([ticker, ticker.replace(/\.(AX|L|CO|HK)$/i, "")]);
  for (const alias of BUILT_IN_ALIASES[ticker] || []) pieces.add(alias);
  const name = normalizeSearchText(security.name || security.companyName || security.company_name || "");
  if (name) {
    pieces.add(name);
    const short = name
      .replace(/\b(inc|incorporated|corp|corporation|plc|limited|ltd|class|ordinary|cdi|adr|holdings|group|company|co)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (short && short.length >= 3) pieces.add(short);
  }
  return [...pieces]
    .map((alias) => normalizeSearchText(alias))
    .filter((alias) => alias.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function buildSecurityIndex(securities = []) {
  const unique = uniqueByTicker(securities);
  const byTicker = new Map(unique.map((item) => [normalizeTicker(item.ticker), item]));
  for (const [ticker, aliases] of Object.entries(BUILT_IN_ALIASES)) {
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, {
        ticker,
        name: aliases[0].replace(/\b\w/g, (letter) => letter.toUpperCase()),
        currency: ticker.endsWith(".AX") ? "AUD" : ticker.endsWith(".L") ? "GBP" : ticker.endsWith(".CO") ? "DKK" : "USD",
        group: "Unassigned",
        source: "alias"
      });
    }
  }
  const indexed = [...byTicker.values()].map((security) => ({
    ...security,
    ticker: normalizeTicker(security.ticker),
    aliases: securityAliases(security)
  }));
  return { securities: indexed, byTicker: new Map(indexed.map((item) => [item.ticker, item])) };
}

function findAliasMentions(text, securities) {
  const normalized = normalizeSearchText(text);
  const mentions = [];
  for (const security of securities) {
    for (const alias of security.aliases || []) {
      const pattern = new RegExp(`(^|[^a-z0-9.])(${escapeRegExp(alias)})(?=$|[^a-z0-9.])`, "gi");
      let match;
      while ((match = pattern.exec(normalized))) {
        mentions.push({
          index: match.index + match[1].length,
          alias,
          security
        });
      }
    }
  }
  mentions.sort((a, b) => a.index - b.index || b.alias.length - a.alias.length);
  return mentions;
}

function bestSecurityBefore(index, mentions, fallback) {
  const before = mentions.filter((mention) => mention.index <= index);
  if (before.length) return before[before.length - 1].security;
  if (fallback) return fallback;
  if (mentions.length === 1) return mentions[0].security;
  return null;
}

function ambiguousOptionsBefore(index, mentions) {
  const nearby = mentions.filter((mention) => mention.index <= index);
  if (!nearby.length) return [];
  const lastAlias = nearby[nearby.length - 1].alias;
  return uniqueByTicker(nearby.filter((mention) => mention.alias === lastAlias).map((mention) => mention.security));
}

function splitNotes(text) {
  const original = String(text || "");
  const noteStart = original.search(/\b(?:add\s+)?(?:a\s+)?note\s+that\b|\b(?:at|for|around)\s+(?:a\$|us\$|\$|£)?\s*\d+(?:\.\d+)?\s*(?:[A-Z]{3})?\s+(?:level\s+)?note\s+that\b/i);
  if (noteStart < 0) return { commandText: original, notes: [] };
  const commandText = original.slice(0, noteStart).trim().replace(/[,.]+$/, "");
  const noteText = original.slice(noteStart).trim();
  const bodyMatch = noteText.match(/\bnote\s+that\s+(.+)$/i);
  const body = (bodyMatch?.[1] || noteText).trim().replace(/^the\s+/i, "").replace(/[.]+$/, "");
  const priceMatch = noteText.match(/(?:at|for|around|the)?\s*(?:a\$|us\$|\$|£)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)/i);
  return {
    commandText,
    notes: [{
      targetPrice: priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null,
      text: body
    }]
  };
}

function normalizeCurrency(symbol, code, fallbackCurrency = "USD") {
  const raw = String(code || "").trim().toUpperCase();
  if (symbol === "£" || raw === "POUNDS" || raw === "POUND") return "GBP";
  if (symbol === "A$") return "AUD";
  if (symbol === "$" || symbol === "US$" || raw === "DOLLARS" || raw === "DOLLAR") return raw === "AUD" ? "AUD" : "USD";
  return raw || fallbackCurrency || "USD";
}

function mapPriority(text) {
  const raw = normalizeSearchText(text);
  if (/\b(highly urgent|critical|immediate|emergency)\b/.test(raw)) {
    return { priority: "high", label: "Critical" };
  }
  if (/\b(urgent|high priority)\b/.test(raw)) return { priority: "high", label: "High" };
  if (/\b(important|medium priority|medium)\b/.test(raw)) return { priority: "medium", label: "Medium" };
  if (/\b(low priority|monitor|low)\b/.test(raw)) return { priority: "low", label: "Low" };
  return { priority: "medium", label: "Medium" };
}

function mapAction(text) {
  const raw = normalizeSearchText(text);
  if (/\b(take profit|taking profit|lock in profit|lock in profits)\b/.test(raw)) return "Take profit";
  if (/\b(risk review|risk check|thesis risk)\b/.test(raw)) return "Risk review";
  if (/\b(reanalyse|re-analyse|reanalyze|re-analyze|re assess|re-assess|reassessment|re-analysis|thesis)\b/.test(raw)) return "Re-analyse";
  if (/\b(trim|reduce|rebalance)\b/.test(raw)) return "Trim";
  if (/\b(sell|exit)\b/.test(raw)) return "Sell";
  if (/\b(start position|buy|consider buying)\b/.test(raw)) return "Buy";
  if (/\b(add|increase|buy more)\b/.test(raw)) return "Add";
  if (/\b(review|check)\b/.test(raw)) return "Review";
  if (/\b(hold)\b/.test(raw)) return "Hold";
  if (/\b(watch|monitor)\b/.test(raw)) return "Watch";
  return "Review";
}

function hasActionKeyword(text) {
  return /\b(take profit|taking profit|lock in profits?|risk review|risk check|thesis risk|reanalyse|re-analyse|reanalyze|re-analyze|re assess|re-assess|reassessment|re-analysis|thesis|trim|reduce|rebalance|sell|exit|start position|buy|consider buying|add|increase|buy more|review|check|hold|watch|monitor)\b/.test(normalizeSearchText(text));
}

function alertTypeForAction(action) {
  const map = {
    Buy: "BUY_STARTER",
    Add: "BUY_ADD",
    Trim: "REVIEW_TRIM",
    Sell: "REVIEW_REDUCE",
    Review: "PRICE_ALERT",
    "Re-analyse": "RISK_REVIEW",
    Hold: "REVIEW_ONLY",
    Watch: "PRICE_ALERT",
    "Take profit": "REVIEW_TRIM",
    "Risk review": "RISK_REVIEW",
    Custom: "PRICE_ALERT"
  };
  return map[action] || "PRICE_ALERT";
}

function inferTriggerDirection(targetPrice, currentPrice, wording) {
  const raw = normalizeSearchText(wording);
  if (/\b(below|under|falls? to|drops? to|lower than|less than|down to)\b/.test(raw)) return { direction: "BELOW", inferred: false };
  if (/\b(above|over|reaches?|rises? to|higher than|greater than|up to)\b/.test(raw)) return { direction: "ABOVE", inferred: false };
  if (Number.isFinite(Number(currentPrice)) && Number.isFinite(Number(targetPrice))) {
    return { direction: Number(targetPrice) >= Number(currentPrice) ? "ABOVE" : "BELOW", inferred: true };
  }
  return { direction: "", inferred: false, ambiguous: true };
}

function noteForPrice(notes, targetPrice) {
  const exact = notes.find((note) => note.targetPrice != null && Math.abs(Number(note.targetPrice) - Number(targetPrice)) < 0.0001);
  if (exact) return exact.text;
  const global = notes.find((note) => note.targetPrice == null);
  return global?.text || "";
}

function duplicateForAlert(alert, existingAlerts = []) {
  return (existingAlerts || []).find((existing) => {
    const active = existing.active !== false && existing.active !== 0 && !existing.archived_at;
    const price = Number(existing.threshold_price ?? existing.thresholdPrice ?? existing.targetPrice);
    const sameAction = !alert.action
      || String(existing.label || existing.note || existing.alert_type || "").toLowerCase().includes(alert.action.toLowerCase())
      || String(existing.alert_type || "").toUpperCase() === alert.alertType;
    return active
      && normalizeTicker(existing.ticker) === alert.ticker
      && String(existing.direction || "").toUpperCase() === alert.direction
      && Number.isFinite(price)
      && Math.abs(price - Number(alert.targetPrice)) < 0.0001
      && sameAction;
  });
}

function priceMatches(commandText) {
  const pattern = /(?:(a\$|us\$|\$|£)\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(USD|AUD|GBP|EUR|DKK|HKD|CHF|CAD|JPY|SEK|NOK|NZD|SGD|IDR|dollars?|pounds?))?/gi;
  const matches = [];
  let match;
  while ((match = pattern.exec(commandText))) {
    matches.push({
      index: match.index,
      end: pattern.lastIndex,
      symbol: match[1] || "",
      value: Number(match[2].replace(/,/g, "")),
      currencyCode: match[3] || ""
    });
  }
  return matches;
}

export function parseAlertCommand(text, context = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) return { alerts: [], errors: ["Type an alert instruction first."] };
  const currencies = context.currencies || DEFAULT_CURRENCIES;
  const { commandText, notes } = splitNotes(rawText);
  const { securities } = buildSecurityIndex(context.securities || []);
  const mentions = findAliasMentions(commandText, securities);
  const fallbackSecurity = mentions.length ? mentions[0].security : null;
  const matches = priceMatches(commandText);
  if (!matches.length) return { alerts: [], errors: ["No target price found. Add a price like 150 USD or £8.50."] };

  const alerts = matches.map((match, index) => {
    const next = matches[index + 1];
    const segmentBefore = commandText.slice(Math.max(0, match.index - 110), match.index);
    const segmentAfter = commandText.slice(match.end, next?.index ?? commandText.length);
    const segment = `${segmentBefore} ${segmentAfter}`;
    const actionContext = hasActionKeyword(segmentAfter) ? segmentAfter : segment;
    const candidates = ambiguousOptionsBefore(match.index, mentions);
    const security = bestSecurityBefore(match.index, mentions, fallbackSecurity);
    const fallbackCurrency = security?.currency || context.defaultCurrency || "USD";
    const currency = normalizeCurrency(match.symbol, match.currencyCode, fallbackCurrency);
    const priority = mapPriority(`${segment} ${commandText}`);
    const action = mapAction(actionContext || commandText);
    const direction = inferTriggerDirection(match.value, security?.currentPrice, segment || commandText);
    const specificNote = noteForPrice(notes, match.value);
    const observationParts = [
      action && action !== "Review" ? action : "",
      priority.label === "Critical" ? "Critical review" : "",
      specificNote
    ].filter(Boolean);
    const draft = {
      id: `cmd_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      companyName: security?.name || "",
      ticker: security?.ticker || "",
      targetPrice: match.value,
      currency,
      direction: direction.direction,
      directionInferred: Boolean(direction.inferred),
      priority: priority.priority,
      priorityLabel: priority.label,
      action,
      alertType: alertTypeForAction(action),
      group: security?.group || "Unassigned",
      groupId: security?.groupId || "",
      source: security?.source || "",
      observation: observationParts.join(". "),
      duplicatePolicy: "skip",
      errors: [],
      candidateOptions: candidates.length > 1 ? candidates.map((item) => ({
        ticker: item.ticker,
        name: item.name || item.companyName || item.ticker,
        group: item.group || "Unassigned"
      })) : []
    };
    if (!draft.ticker) draft.errors.push("Choose a ticker.");
    if (draft.candidateOptions.length > 1) draft.errors.push("More than one ticker may match. Choose the exact ticker.");
    if (!Number.isFinite(match.value) || match.value <= 0) draft.errors.push("Target price must be greater than zero.");
    if (!currencies.includes(currency)) draft.errors.push(`Unsupported currency ${currency}.`);
    if (!draft.direction) draft.errors.push("Choose Above or Below.");
    const duplicate = duplicateForAlert(draft, context.existingAlerts || []);
    if (duplicate) {
      draft.duplicateId = duplicate.id;
      draft.duplicateMessage = `An active ${draft.ticker} alert already exists ${draft.direction === "ABOVE" ? "at or above" : "at or below"} ${currency} ${match.value}.`;
    }
    return draft;
  });

  return { alerts, errors: [] };
}

export function validateParsedAlert(alert, currencies = DEFAULT_CURRENCIES) {
  const errors = [];
  if (!normalizeTicker(alert.ticker)) errors.push("Choose a ticker.");
  if (!Number.isFinite(Number(alert.targetPrice)) || Number(alert.targetPrice) <= 0) errors.push("Target price must be greater than zero.");
  if (!currencies.includes(String(alert.currency || "").toUpperCase())) errors.push("Choose a supported currency.");
  if (!["ABOVE", "BELOW"].includes(String(alert.direction || "").toUpperCase())) errors.push("Choose Above or Below.");
  if (!ACTION_OPTIONS.includes(alert.action)) errors.push("Choose an action.");
  return errors;
}

export { ACTION_OPTIONS, DEFAULT_CURRENCIES, alertTypeForAction };
