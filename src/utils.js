import crypto from "node:crypto";

export const SUPPORTED_CURRENCIES = ["USD", "AUD", "GBP"];
export const SUPPORTED_FX_CURRENCIES = [
  "USD",
  "AUD",
  "GBP",
  "EUR",
  "DKK",
  "HKD",
  "CHF",
  "CAD",
  "JPY",
  "SEK",
  "NOK",
  "NZD",
  "SGD",
  "IDR"
];
export const PORTFOLIO_GROUPS = [
  {
    id: "cat_core",
    name: "Core AI Platforms & Mega-Cap Compounders",
    targetPercent: 30,
    sortOrder: 1,
    color: "#8B7CFF"
  },
  {
    id: "cat_ai_infrastructure",
    name: "AI Infrastructure / Semis / Bottleneck",
    targetPercent: 23,
    sortOrder: 2,
    color: "#5B8DEF"
  },
  {
    id: "cat_cash",
    name: "Cash",
    targetPercent: 15,
    sortOrder: 3,
    color: "#00C27A"
  },
  {
    id: "cat_defensive",
    name: "Defensive / Quality Market Infrastructure",
    targetPercent: 12,
    sortOrder: 4,
    color: "#28C7A0"
  },
  {
    id: "cat_international_growth",
    name: "International Growth",
    targetPercent: 12,
    sortOrder: 5,
    color: "#FFB547"
  },
  {
    id: "cat_speculative",
    name: "Speculative / Special Situations",
    targetPercent: 8,
    sortOrder: 6,
    color: "#FF6B4A"
  }
];

export const CATEGORY_NAMES = PORTFOLIO_GROUPS.map((group) => group.name);

export const DEFAULT_PORTFOLIO_CATEGORY_ID = "cat_speculative";

export const PORTFOLIO_GROUP_TICKERS = {
  cat_core: ["AMZN", "MSFT", "GOOG", "META", "NFLX"],
  cat_ai_infrastructure: ["MU", "AVGO", "NVDA", "QCOM", "WDC", "AMD", "GLW", "GEV", "LITE", "VRT"],
  cat_defensive: ["CME", "ICE", "CCI", "PEP", "NOVO-B.CO"],
  cat_international_growth: ["WISE.L", "MELI"],
  cat_speculative: ["LNW.AX", "MTO.AX", "INTC"]
};

export const PORTFOLIO_GROUP_WATCHLIST_CANDIDATES = {
  cat_core: ["ORCL", "NOW", "SNOW", "PLTR", "CRM", "ADBE", "TEAM", "CRWD"],
  cat_ai_infrastructure: [
    "MRVL", "ANET", "CRDO", "ARM", "ASML", "KLAC", "AMAT", "LRCX", "SNDK", "STX", "RMBS", "TSM", "TSEM",
    "COHR", "CIEN", "AAOI", "ETN", "PWR", "TT", "JCI", "MOD", "BE", "EME", "FIX", "HUBB", "DELL", "HPE",
    "CLS", "SMCI"
  ],
  cat_defensive: ["COST", "V", "MA", "SPGI", "BRK-B", "AZO", "RACE", "LLY", "UNH", "DXCM", "EQIX", "DLR", "MSCI", "MCO"],
  cat_international_growth: ["BABA", "0700.HK", "PDD", "JD", "BYDDY", "ASML", "TSM", "NOVO-B.CO", "LNW.AX"],
  cat_speculative: ["IBIT", "ETHA", "BTC-USD", "ETH-USD", "SOL-USD", "IONQ", "RGTI", "QBTS", "QUBT", "SMCI", "AAOI", "HIMS", "OPEN", "PYPL", "AMBA"]
};

const PORTFOLIO_GROUP_ALIASES = {
  "core": "cat_core",
  "ai platform": "cat_core",
  "ai platforms": "cat_core",
  "core ai platforms & mega-cap compounders": "cat_core",
  "core ai platforms and mega-cap compounders": "cat_core",
  "core ai platforms & mega cap compounders": "cat_core",
  "core ai platforms and mega cap compounders": "cat_core",
  "ai": "cat_ai_infrastructure",
  "ai infrastructure": "cat_ai_infrastructure",
  "ai infrastructure / semis / bottleneck": "cat_ai_infrastructure",
  "ai infrastructure semis bottleneck": "cat_ai_infrastructure",
  "semis": "cat_ai_infrastructure",
  "semiconductors": "cat_ai_infrastructure",
  "bottleneck": "cat_ai_infrastructure",
  "cash": "cat_cash",
  "defensive": "cat_defensive",
  "quality": "cat_defensive",
  "defensive / quality market infrastructure": "cat_defensive",
  "defensive quality market infrastructure": "cat_defensive",
  "international": "cat_international_growth",
  "international growth": "cat_international_growth",
  "speculative": "cat_speculative",
  "special situations": "cat_speculative",
  "speculative / special situations": "cat_speculative",
  "speculative special situations": "cat_speculative"
};

export function id(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeTicker(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/\s+/g, "");
}

function normalizeGroupAlias(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function portfolioGroupIdForName(input, fallback = DEFAULT_PORTFOLIO_CATEGORY_ID) {
  const key = normalizeGroupAlias(input);
  if (!key) return fallback;
  return PORTFOLIO_GROUP_ALIASES[key] || fallback;
}

export function portfolioGroupIdForTicker(input, fallback = DEFAULT_PORTFOLIO_CATEGORY_ID) {
  const ticker = normalizeTicker(input);
  if (!ticker) return fallback;
  for (const [categoryId, tickers] of Object.entries(PORTFOLIO_GROUP_TICKERS)) {
    if (tickers.map(normalizeTicker).includes(ticker)) return categoryId;
  }
  return fallback;
}

export function normalizeCurrency(input, fallback = "USD") {
  const value = String(input || fallback).trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(value) ? value : fallback;
}

export function normalizeFxCurrency(input, fallback = "USD") {
  const value = String(input || fallback).trim().toUpperCase();
  return SUPPORTED_FX_CURRENCIES.includes(value) ? value : fallback;
}

export function toNumber(input, fallback = null) {
  if (input == null || input === "") return fallback;
  if (typeof input === "number") return Number.isFinite(input) ? input : fallback;
  const cleaned = String(input)
    .replace(/[$,£A-Z\s]/gi, "")
    .replace(/[()]/g, "")
    .trim();
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return fallback;
  return String(input).includes("(") && String(input).includes(")") ? -value : value;
}

export function assertCurrency(value) {
  const currency = normalizeCurrency(value, "");
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new InputError("Currency must be USD, AUD, or GBP", 400);
  }
  return currency;
}

export function assertFxCurrency(value) {
  const currency = normalizeFxCurrency(value, "");
  if (!SUPPORTED_FX_CURRENCIES.includes(currency)) {
    throw new InputError(`Currency must be one of ${SUPPORTED_FX_CURRENCIES.join(", ")}`, 400);
  }
  return currency;
}

export function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new InputError("Percent must be between 0 and 100", 400);
  }
  return numeric;
}

export function roundMoney(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export function roundShares(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100000000) / 100000000;
}

export function roundPercent(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export class InputError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.name = "InputError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    const payload = text ? safeJsonParse(text, text) : null;
    if (!response.ok) {
      const message = typeof payload === "string" ? payload : payload?.message || response.statusText;
      throw new Error(`${response.status} ${message}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.lastRun = 0;
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.then(async () => {
      const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRun));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastRun = Date.now();
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
