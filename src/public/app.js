import { ACTION_OPTIONS, alertTypeForAction, parseAlertCommand, validateParsedAlert } from "./alert-command-parser.js";

function loadHoldingsView() {
  try {
    return JSON.parse(localStorage.getItem("holdingsView") || "{}");
  } catch {
    return {};
  }
}

const savedHoldingsView = loadHoldingsView();
const urlParams = new URLSearchParams(location.search);
const ROUTED_VIEWS = new Set(["dashboard", "portfolio", "research", "alerts", "rules-v2", "operations"]);

function routeStateFromLocation() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const routeView = path === "/" ? null : path.slice(1);
  const view = path === "/"
    ? "dashboard"
    : ROUTED_VIEWS.has(routeView)
      ? routeView
      : localStorage.getItem("currentView") || "dashboard";
  const query = new URLSearchParams(location.search);
  return {
    view,
    alertTab: query.get("tab") === "triggered" ? "triggered" : "all",
    routeTab: query.get("tab") || ""
  };
}

function pathForView(view, options = {}) {
  const normalized = ROUTED_VIEWS.has(view) ? view : "dashboard";
  const path = normalized === "dashboard" ? "/" : `/${normalized}`;
  const query = new URLSearchParams();
  if (normalized === "alerts" && options.alertTab === "triggered") query.set("tab", "triggered");
  if (normalized === "research" && options.routeTab) query.set("tab", options.routeTab);
  if (normalized === "portfolio" && options.routeTab) query.set("tab", options.routeTab);
  if (urlParams.get("noAuto") === "1") query.set("noAuto", "1");
  const queryString = query.toString();
  return `${path}${queryString ? `?${queryString}` : ""}`;
}

function syncBrowserRoute(view, options = {}) {
  const nextPath = pathForView(view, options);
  const currentPath = `${location.pathname}${location.search}`;
  if (nextPath !== currentPath) history.pushState({ view, alertTab: options.alertTab || "all" }, "", nextPath);
}

const initialRouteState = routeStateFromLocation();

const MARKET_PULSE_CATEGORIES = ["Index", "FX", "Crypto", "Rate", "Commodity", "Other"];
const MARKET_PULSE_PRESETS = [
  { symbol: "^IXIC", displayName: "Nasdaq Composite", category: "Index" },
  { symbol: "^GSPC", displayName: "S&P 500", category: "Index" },
  { symbol: "^DJI", displayName: "Dow Jones Industrial Average", category: "Index" },
  { symbol: "^RUT", displayName: "Russell 2000", category: "Index" },
  { symbol: "^AXJO", displayName: "ASX 200", category: "Index" },
  { symbol: "^FTSE", displayName: "FTSE 100", category: "Index" },
  { symbol: "^GDAXI", displayName: "DAX", category: "Index" },
  { symbol: "^STOXX50E", displayName: "Euro Stoxx 50", category: "Index" },
  { symbol: "^FCHI", displayName: "CAC 40", category: "Index" },
  { symbol: "^N225", displayName: "Nikkei 225", category: "Index" },
  { symbol: "^HSI", displayName: "Hang Seng", category: "Index" },
  { symbol: "^VIX", displayName: "VIX", category: "Index" },
  { symbol: "^TNX", displayName: "US 10Y Yield", category: "Rate" },
  { symbol: "DX-Y.NYB", displayName: "US Dollar Index", category: "FX" },
  { symbol: "AUDUSD=X", displayName: "AUD/USD", category: "FX" },
  { symbol: "USDAUD=X", displayName: "USD/AUD", category: "FX" },
  { symbol: "GBPUSD=X", displayName: "GBP/USD", category: "FX" },
  { symbol: "EURUSD=X", displayName: "EUR/USD", category: "FX" },
  { symbol: "USDJPY=X", displayName: "USD/JPY", category: "FX" },
  { symbol: "BTC-USD", displayName: "Bitcoin", category: "Crypto" },
  { symbol: "ETH-USD", displayName: "Ethereum", category: "Crypto" },
  { symbol: "GC=F", displayName: "Gold Futures", category: "Commodity" },
  { symbol: "SI=F", displayName: "Silver Futures", category: "Commodity" },
  { symbol: "CL=F", displayName: "Crude Oil WTI", category: "Commodity" },
  { symbol: "BZ=F", displayName: "Brent Crude Oil", category: "Commodity" }
];
function normalizePulseSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function localPulseId(symbol) {
  return `local_${normalizePulseSymbol(symbol).replace(/[^A-Z0-9]/g, "_")}`;
}

function defaultMarketPulseItems() {
  return MARKET_PULSE_PRESETS.map((item, index) => ({
    ...item,
    id: localPulseId(item.symbol),
    sortOrder: index + 1,
    source: "local",
    price: null
  }));
}

function loadLocalMarketPulse() {
  try {
    const raw = localStorage.getItem("marketPulseLocal");
    if (!raw) return defaultMarketPulseItems();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultMarketPulseItems();
    return parsed.map((item, index) => ({
      id: item.id || localPulseId(item.symbol),
      symbol: normalizePulseSymbol(item.symbol),
      displayName: String(item.displayName || item.symbol || "").trim(),
      category: MARKET_PULSE_CATEGORIES.includes(item.category) ? item.category : "Other",
      sortOrder: Number(item.sortOrder) || index + 1,
      source: "local",
      price: item.price || null
    })).filter((item) => item.symbol && item.displayName);
  } catch {
    return defaultMarketPulseItems();
  }
}

function saveLocalMarketPulse(items) {
  localStorage.setItem("marketPulseLocal", JSON.stringify(items.map((item, index) => ({
    id: item.id || localPulseId(item.symbol),
    symbol: normalizePulseSymbol(item.symbol),
    displayName: String(item.displayName || item.symbol || "").trim(),
    category: MARKET_PULSE_CATEGORIES.includes(item.category) ? item.category : "Other",
    sortOrder: Number(item.sortOrder) || index + 1
  }))));
}

function loadCachedDashboardSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem("lastDashboardSnapshot") || "{}");
    if (!parsed?.dashboard?.summary || !parsed?.dashboard?.user) return {};
    return {
      dashboard: parsed.dashboard,
      categories: Array.isArray(parsed.categories) ? parsed.categories : parsed.dashboard.allocation || [],
      news: parsed.news || null
    };
  } catch {
    return {};
  }
}

function saveCachedDashboardSnapshot() {
  if (!state.dashboard?.summary) return;
  try {
    localStorage.setItem("lastDashboardSnapshot", JSON.stringify({
      dashboard: state.dashboard,
      categories: state.categories || [],
      news: state.news || null,
      savedAt: Date.now()
    }));
  } catch {
    // Cache is only for fast startup; live data remains in the database.
  }
}

const cachedDashboardSnapshot = loadCachedDashboardSnapshot();
const savedPerformanceMode = localStorage.getItem("portfolioPerformanceMode");
const initialPerformanceMode = ["withCash", "withoutCash"].includes(savedPerformanceMode)
  ? savedPerformanceMode
  : "withoutCash";
const savedRealizedIncomeMode = localStorage.getItem("realizedIncomeMode");
const realizedIncomeModeAliases = {
  investment_growth: "book_value",
  realized_income: "realized_growth",
  cumulative_income: "realized_growth"
};
const initialRealizedIncomeMode = [
  "realized_growth",
  "book_value",
  "portfolio_value",
].includes(savedRealizedIncomeMode)
  ? savedRealizedIncomeMode
  : realizedIncomeModeAliases[savedRealizedIncomeMode] || "realized_growth";

const state = {
  session: null,
  authMode: "login",
  dashboard: cachedDashboardSnapshot.dashboard || null,
  categories: cachedDashboardSnapshot.categories || [],
  groupEditor: null,
  localMarketPulse: loadLocalMarketPulse(),
  expandedLots: new Set(),
  currentView: initialRouteState.view,
  alertTab: initialRouteState.alertTab,
  routeTab: initialRouteState.routeTab,
  holdingsSort: savedHoldingsView.sort || "alphabetical",
  holdingsGroup: savedHoldingsView.group || "none",
  holdingsViewMode: savedHoldingsView.viewMode || "current",
  dashboardChartCollapsed: localStorage.getItem("dashboardChartCollapsed") !== "false",
  portfolioChartCollapsed: localStorage.getItem("portfolioChartCollapsed") === "true",
  allocationCollapsed: localStorage.getItem("allocationCollapsed") === "true",
  cashCollapsed: localStorage.getItem("cashCollapsed") === "true",
  watchlistFilter: localStorage.getItem("watchlistFilter") || "all",
  autoPrices: urlParams.get("noAuto") === "1" ? false : localStorage.getItem("autoPrices") !== "false",
  importHistoryOpen: localStorage.getItem("importHistoryOpen") === "true",
  portfolioPerformanceRange: localStorage.getItem("portfolioPerformanceRange") || "1y",
  portfolioPerformanceMode: initialPerformanceMode,
  portfolioPerformance: null,
  realizedIncome: null,
  portfolioWealth: null,
  realizedIncomeRange: localStorage.getItem("realizedIncomeRange") || "all",
  realizedIncomeFilter: localStorage.getItem("realizedIncomeFilter") || "all",
  realizedIncomeMode: initialRealizedIncomeMode,
  realizedIncomeView: localStorage.getItem("realizedIncomeView") || "timeline",
  realizedIncomeChartEvents: [],
  news: cachedDashboardSnapshot.news || null,
  portfolioPerformanceLoading: false,
  stockPerformanceRange: localStorage.getItem("stockPerformanceRange") || "1y",
  currentStockTicker: "",
  stockPreviousView: localStorage.getItem("currentView") || "dashboard",
  stockDetail: null,
  stockPerformance: null,
  stockLoading: false,
  refreshTimer: null,
  quoteRefreshTimer: null,
  dashboardLoading: false,
  quoteRefreshRunning: false,
  schedulerEnabled: false,
  lastPrices: new Map(),
  priceMoves: new Map(),
  marketPulseQuotes: {},
  marketPulseQuotesLoading: new Set(),
  marketPulseAutocompleteIndex: 0,
  alertCommandDrafts: [],
  lastAlertCommandText: "",
  rulesV2: null,
  rulesV2Loading: false,
  rulesV2Error: ""
};

const $ = (selector) => document.querySelector(selector);
const money = (value, currency) => value == null ? "n/a" : new Intl.NumberFormat(undefined, {
  style: "currency",
  currency,
  maximumFractionDigits: 2
}).format(value);
const compactMoney = (value, currency) => value == null ? "n/a" : new Intl.NumberFormat(undefined, {
  style: "currency",
  currency,
  notation: "compact",
  maximumFractionDigits: 2
}).format(value);
const number = (value, digits = 2) => value == null ? "n/a" : new Intl.NumberFormat(undefined, {
  maximumFractionDigits: digits
}).format(value);
const percent = (value) => value == null ? "n/a" : `${number(value, 2)}%`;
const signedMoney = (value, currency) => value == null ? "n/a" : `${value > 0 ? "+" : ""}${money(value, currency)}`;
const signedPercent = (value) => value == null ? "n/a" : `${value > 0 ? "+" : ""}${percent(value)}`;
const roundCurrency = (value) => Math.round(Number(value || 0) * 100) / 100;
const roundDisplayPercent = (value) => value == null ? null : Math.round(Number(value) * 100) / 100;
const cssSegment = (name) => name.toLowerCase().replaceAll(" ", "-");

function normalizeMarketCap(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const num = Number(value);
  // Finnhub reports market cap in millions; real caps are >= ~$10M, so a value
  // below 10 million almost certainly arrived in millions and needs scaling up.
  return num > 0 && num < 1e7 ? num * 1e6 : num;
}

function concentrationChipClass(value, warn, danger) {
  if (value == null) return "";
  if (value >= danger) return "chip-danger";
  if (value >= warn) return "chip-warn";
  return "chip-ok";
}
const statusIcon = {
  BUY: "BUY",
  ADD: "ADD",
  HOLD: "HOLD",
  REVIEW: "REVIEW",
  TRIM: "TRIM",
  AVOID: "AVOID"
};
const CHART_COLORS = [
  "#CBAE70",
  "#EDE8DF",
  "#B8915A",
  "#8A6E86",
  "#6E8AA0",
  "#B7B0A4",
  "#C98F5A",
  "#5C5650",
  "#D8C9A0",
  "#7E7A72"
];
const PERFORMANCE_RANGES = [
  ["1d", "1D"],
  ["1mo", "1M"],
  ["ytd", "YTD"],
  ["1y", "1Y"],
  ["3y", "3Y"],
  ["5y", "5Y"],
  ["all", "ALL"]
];
const MARKET_CURRENCIES = [
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

const REPUTABLE_NEWS_SOURCES = new Set([
  "associated press",
  "ap",
  "barron's",
  "barrons",
  "bloomberg",
  "business wire",
  "cnbc",
  "financial times",
  "ft",
  "globenewswire",
  "marketwatch",
  "morningstar",
  "nasdaq",
  "pr newswire",
  "reuters",
  "sec",
  "the wall street journal",
  "wall street journal",
  "wsj",
  "yahoo",
  "yahoo finance"
]);

const PRIMARY_SOURCE_TERMS = [
  "sec",
  "edgar",
  "asx",
  "lse",
  "nasdaq nordic",
  "nasdaqomxnordic",
  "hkex",
  "company announcements",
  "investor relations",
  "official event feed",
  "regulatory",
  "filing"
];

const BUY_ALERT_TYPES = new Set([
  "BUY_STARTER",
  "BUY_ADD",
  "BUY_STRONG",
  "SPECULATIVE_STARTER",
  "SPECULATIVE_ADD",
  "SPECULATIVE_STRONG"
]);

const ALERT_TYPE_LABELS = {
  PRICE_ALERT: "Price Alert",
  BUY_STARTER: "Buy Starter",
  BUY_ADD: "Buy Add",
  BUY_STRONG: "Buy Strong",
  SPECULATIVE_STARTER: "Speculative Starter",
  SPECULATIVE_ADD: "Speculative Add",
  SPECULATIVE_STRONG: "Speculative Strong",
  REVIEW_TRIM: "Review Trim",
  REVIEW_REDUCE: "Review Reduce",
  RISK_REVIEW: "Risk Review",
  DELETE_OR_IGNORE: "Delete / Ignore",
  REVIEW_ONLY: "Review Only"
};

const ALERT_ACTIONS = {
  BUY_STARTER: "First small tranche only. Check news, market tone, and thesis before acting.",
  BUY_ADD: "Possible add only if thesis, fundamentals, and valuation remain intact.",
  BUY_STRONG: "Deep buy-zone review. Check earnings, guidance, margins, and balance sheet first.",
  SPECULATIVE_STARTER: "Tiny speculative starter only. Do not build a large position from this alert.",
  SPECULATIVE_ADD: "Speculative add only if the current position is tiny and thesis is intact.",
  SPECULATIVE_STRONG: "High-risk review level. Full thesis check required.",
  REVIEW_TRIM: "Review position size and valuation. Consider trimming or rebalancing.",
  REVIEW_REDUCE: "Review reducing exposure if risk, valuation, or thesis quality has worsened.",
  RISK_REVIEW: "Risk review only. Check news, earnings, guidance, regulation, and thesis.",
  DELETE_OR_IGNORE: "Not aligned with strategy. Do not suggest buying.",
  REVIEW_ONLY: "Review only. Buying is blocked by portfolio-weight safety.",
  PRICE_ALERT: "Review before taking any action."
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function quoteTimeLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isFreshExtendedSession(iso) {
  if (!iso) return false;
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const ageHours = (Date.now() - timestamp) / 36e5;
  return ageHours >= -0.25 && ageHours <= 12;
}

function sessionChange(quote, value) {
  const base = quote?.regularMarketPrice ?? quote?.price;
  if (base == null || value == null) return { amount: null, percentValue: null };
  const amount = roundCurrency(value - base);
  return {
    amount,
    percentValue: base ? roundDisplayPercent((amount / base) * 100) : null
  };
}

function extendedPriceHtml(quote) {
  if (!quote || quote.price == null) return "";
  const stateValue = String(quote.marketState || "").toUpperCase();
  // During regular trading hours, show only the live regular price.
  if (["REGULAR", "OPEN"].includes(stateValue)) return "";
  const currency = quote.currency || state.dashboard?.user?.baseCurrency || "USD";
  let sessions = [];
  if (quote.preMarketPrice != null) sessions.push(["pre", "Pre-market", quote.preMarketPrice, quote.preMarketTime]);
  if (quote.postMarketPrice != null) sessions.push(["post", "After-hours", quote.postMarketPrice, quote.postMarketTime]);
  // Drop anything older than 5 days (covers weekends) or far in the future.
  sessions = sessions.filter(([, , , time]) => {
    if (!time) return true;
    const age = (Date.now() - new Date(time).getTime()) / 36e5;
    return age >= -1 && age <= 120;
  });
  if (["PRE", "PREPRE", "PRE_MARKET"].includes(stateValue)) {
    sessions = sessions.filter(([type]) => type === "pre");
  } else if (["POST", "POSTPOST", "AFTER_HOURS"].includes(stateValue)) {
    sessions = sessions.filter(([type]) => type === "post");
  } else {
    // Closed: show only the most recent extended session.
    sessions = sessions.sort((a, b) => new Date(b[3] || 0) - new Date(a[3] || 0)).slice(0, 1);
  }
  if (!sessions.length) return "";
  return `
    <span class="extended-price">
      ${sessions.map(([type, label, value, time]) => {
        const change = sessionChange(quote, value);
        const changeClass = change.amount > 0 ? "positive" : change.amount < 0 ? "negative" : "";
        const symbol = type === "pre" ? "\u2600" : "\u263E";
        return `
          <span class="extended-session ${type}">
            <b>${symbol} ${label}</b>
            <strong>${money(value, currency)}</strong>
            <em class="session-change ${changeClass}">
              ${signedMoney(change.amount, currency)} / ${signedPercent(change.percentValue)}
            </em>
            ${time ? `<small>${quoteTimeLabel(time)}</small>` : ""}
          </span>
        `;
      }).join("")}
    </span>
  `;
}

function marketClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    isWeekday: ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(map.weekday),
    minutes: Number(map.hour) * 60 + Number(map.minute)
  };
}

function sessionStatus(date, timeZone, sessions) {
  const clock = marketClock(date, timeZone);
  if (!clock.isWeekday) return "CLOSED";
  const match = sessions.find((session) => clock.minutes >= session.start && clock.minutes < session.end);
  return match?.status || "CLOSED";
}

function tickerExchange(ticker = "", quote = {}) {
  const symbol = String(ticker || quote?.ticker || "").toUpperCase();
  const exchange = String(quote?.exchangeName || "").toUpperCase();
  if (symbol.endsWith(".AX") || exchange.includes("ASX")) return "ASX";
  if (symbol.endsWith(".L") || exchange.includes("LONDON") || exchange === "LSE") return "LSE";
  if (symbol.endsWith(".CO") || exchange.includes("COPENHAGEN") || exchange.includes("NASDAQ NORDIC")) return "CPH";
  if (!symbol.includes(".") || exchange.includes("NASDAQ") || exchange.includes("NYSE") || exchange.includes("AMEX")) return "US";
  return "UNKNOWN";
}

function priceDayChangeHtml(quote, currency) {
  if (!quote || (quote.changeAmount == null && quote.changePercent == null)) return "";
  const cls = valueClass(quote.changePercent ?? quote.changeAmount ?? 0);
  const dir = quote.changePercent ?? quote.changeAmount ?? 0;
  const arrow = dir > 0 ? "\u25B2" : dir < 0 ? "\u25BC" : "";
  return `<span class="price-day-change ${cls}">${arrow} ${nullableSignedMoney(quote.changeAmount, currency)} (${nullableSignedPercent(quote.changePercent)})</span>`;
}

function priceAsOfLabel(asOf) {
  if (!asOf) return "";
  const when = new Date(asOf);
  if (Number.isNaN(when.getTime())) return "";
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return when.toLocaleString([], opts);
  } catch {
    return "";
  }
}

// One price cell, used in every table: the live/regular price coloured by the day
// move, a small status pill, the day change, any real pre/after-hours price as a
// small secondary line, and an "as of" time so a stale quote is obvious.
function priceCellHtml(quote, ticker = "", extraClass = "") {
  const currency = quote?.currency || state.dashboard?.user?.baseCurrency || "USD";
  if (!quote || quote.price == null) {
    return `<span class="price-stack ${extraClass}"><span class="close-price"><strong class="live-price">n/a</strong></span></span>`;
  }
  const marketStatus = quotePriceLabel(quote, ticker);
  const statusClass = statusClassForMarket(marketStatus);
  const priceClass = valueClass(quote.changePercent ?? 0);
  const mainPrice = quote.regularMarketPrice ?? quote.price;
  const asOf = priceAsOfLabel(quote.asOf);
  return `
    <span class="price-stack ${extraClass}">
      <span class="close-price">
        <strong class="live-price ${priceClass}">${money(mainPrice, currency)}</strong>
        <span class="status-pill ${statusClass}">${marketStatus}</span>
      </span>
      ${priceDayChangeHtml(quote, currency)}
      ${extendedPriceHtml(quote)}
      ${asOf ? `<small class="price-asof">as of ${asOf}</small>` : ""}
    </span>
  `;
}

function fallbackMarketStatus(ticker, quote, now = new Date()) {
  const exchange = tickerExchange(ticker, quote);
  if (exchange === "ASX") return sessionStatus(now, "Australia/Sydney", [{ start: 600, end: 970, status: "OPEN" }]);
  if (exchange === "LSE") return sessionStatus(now, "Europe/London", [{ start: 480, end: 990, status: "OPEN" }]);
  if (exchange === "CPH") return sessionStatus(now, "Europe/Copenhagen", [{ start: 540, end: 1020, status: "OPEN" }]);
  if (exchange === "US") return sessionStatus(now, "America/New_York", [
    { start: 240, end: 570, status: "PRE" },
    { start: 570, end: 960, status: "OPEN" },
    { start: 960, end: 1200, status: "POST" }
  ]);
  return "UNKNOWN";
}

function marketStatusFor(ticker, quote = {}) {
  const stateValue = String(quote?.marketState || "").toUpperCase();
  const fallback = fallbackMarketStatus(ticker, quote);
  if (["REGULAR", "OPEN"].includes(stateValue)) return "OPEN";
  if (["PRE", "PREPRE", "PRE_MARKET"].includes(stateValue)) return "PRE";
  if (["POST", "POSTPOST", "AFTER_HOURS"].includes(stateValue)) return "POST";
  if (quote?.preMarketPrice != null && isFreshExtendedSession(quote.preMarketTime)) return "PRE";
  if (quote?.postMarketPrice != null && isFreshExtendedSession(quote.postMarketTime)) return "POST";
  if (!quote || quote.price == null) return "UNKNOWN";
  if (["CLOSED", "CLOSE"].includes(stateValue)) return fallback === "UNKNOWN" ? "CLOSED" : fallback;
  return fallback;
}

function quotePriceLabel(quote, ticker = "") {
  if (!quote) return "UNKNOWN";
  if (quote.status !== "LIVE") return quote.status || "UNKNOWN";
  return marketStatusFor(ticker, quote);
}

function statusClassForMarket(status) {
  if (status === "OPEN") return "live";
  if (status === "PRE") return "pre";
  if (status === "POST") return "post";
  if (status === "CLOSED") return "closed";
  if (["24H", "UPDATED"].includes(status)) return "live";
  if (["STALE", "UNKNOWN", "PENDING", "LOADING", "SAVED", "UNAVAILABLE", "DATA_GAP"].includes(status)) return "unknown";
  return "";
}

// The small caption above a price: "Live" while the market is trading, otherwise
// the last regular-session close.
function priceStackLabel(marketStatus) {
  if (marketStatus === "OPEN") return "Live";
  if (marketStatus === "PRE") return "Pre-market";
  if (marketStatus === "POST") return "After-hours";
  return "Latest close";
}

function valueClass(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}

function nullableNumber(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? "--" : number(Number(value), digits);
}

function nullableMoney(value, currency) {
  return value == null || !Number.isFinite(Number(value)) ? "--" : money(Number(value), currency);
}

function nullableSignedMoney(value, currency) {
  return value == null || !Number.isFinite(Number(value)) ? "--" : signedMoney(Number(value), currency);
}

function nullableSignedPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? "--" : signedPercent(Number(value));
}

function compactNumber(value) {
  return value == null || !Number.isFinite(Number(value))
    ? "--"
    : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(Number(value));
}

function nullableCompactMoney(value, currency) {
  return value == null || !Number.isFinite(Number(value)) ? "--" : compactMoney(Number(value), currency);
}

function safeExternalHref(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function tickerButton(ticker, label = ticker) {
  return `<button class="ticker-link" data-open-stock="${escapeHtml(ticker)}" type="button">${escapeHtml(label)}</button>`;
}

function rangeTabsHtml(activeRange, scope, ranges = PERFORMANCE_RANGES) {
  return ranges.map(([range, label]) => `
    <button class="range-tab ${range === activeRange ? "active" : ""}" data-performance-range="${range}" data-performance-scope="${scope}" type="button">
      ${label}
    </button>
  `).join("");
}

function renderRangeTabs() {
  const dashboardRanges = $("#portfolioPerformanceRanges");
  if (dashboardRanges) dashboardRanges.innerHTML = rangeTabsHtml(state.portfolioPerformanceRange, "portfolio");
  const portfolioRanges = $("#portfolioPerformanceRangesPortfolio");
  if (portfolioRanges) portfolioRanges.innerHTML = rangeTabsHtml(state.portfolioPerformanceRange, "portfolio");
  const stockRanges = $("#stockPerformanceRanges");
  if (stockRanges) stockRanges.innerHTML = rangeTabsHtml(state.stockPerformanceRange, "stock");
}

function normalizePerformancePoints(points = []) {
  const valid = points
    .filter((point) => point?.value != null && Number.isFinite(Number(point.value)))
    .map((point) => ({
      ...point,
      value: Number(point.value),
      rawValue: point.rawValue == null ? Number(point.value) : Number(point.rawValue),
      adjustedValue: point.adjustedValue == null ? null : Number(point.adjustedValue),
      investedCapital: point.investedCapital == null ? null : Number(point.investedCapital),
      realizedValue: point.realizedValue == null ? null : Number(point.realizedValue),
      dividendValue: point.dividendValue == null ? null : Number(point.dividendValue),
      returnPercent: point.returnPercent == null ? null : Number(point.returnPercent)
    }));
  return valid.length >= 2 ? valid : valid;
}

function performancePointsForMode(performance, mode = "withCash") {
  const points = normalizePerformancePoints(performance?.points || []);
  return points.map((point) => ({
    ...point,
    value: mode === "withoutCash" && point.adjustedValue != null
      ? point.adjustedValue
      : point.rawValue
  }));
}

function chartScales(points, dims) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span0 = max - min;
  const pad = span0 ? span0 * 0.08 : Math.max(1, Math.abs(max) || 1) * 0.08;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo || 1;
  const plotW = dims.width - dims.left - dims.right;
  const plotH = dims.height - dims.top - dims.bottom;
  const xAt = (index) => dims.left + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const yAt = (value) => dims.top + (1 - (value - lo) / span) * plotH;
  return { lo, hi, xAt, yAt };
}

function renderPerformanceChart(selector, performance, emptyMessage = "Loading performance history...", mode = "withCash") {
  const svg = $(selector);
  if (!svg) return;
  const points = performancePointsForMode(performance, mode);
  if (!points.length) {
    svg.innerHTML = `
      <text x="450" y="145" text-anchor="middle" class="chart-empty">${escapeHtml(emptyMessage)}</text>
    `;
    return;
  }
  const viewBox = (svg.getAttribute("viewBox") || "0 0 900 280").split(/\s+/).map(Number);
  const vbW = viewBox[2] || 900;
  const vbH = viewBox[3] || 280;
  const dims = { width: vbW, height: vbH, left: 70, right: 18, top: 16, bottom: 30 };
  const positive = (performance?.changeValue || 0) >= 0;
  const stroke = positive ? "#22C55E" : "#E5394E";
  const gid = `${selector.replace(/[^a-zA-Z0-9]/g, "")}Fill`;
  const { lo, hi, xAt, yAt } = chartScales(points, dims);
  const fmtAxis = (value) => money(value, performance.currency);

  const ticks = 4;
  let grid = "";
  let yLabels = "";
  for (let t = 0; t <= ticks; t += 1) {
    const value = lo + ((hi - lo) * t) / ticks;
    const y = yAt(value);
    grid += `<line x1="${dims.left}" y1="${y.toFixed(1)}" x2="${dims.width - dims.right}" y2="${y.toFixed(1)}" class="chart-grid-line"></line>`;
    yLabels += `<text x="${dims.left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="chart-label">${escapeHtml(fmtAxis(value))}</text>`;
  }
  const zeroLine = lo < 0 && hi > 0
    ? `<line x1="${dims.left}" y1="${yAt(0).toFixed(1)}" x2="${dims.width - dims.right}" y2="${yAt(0).toFixed(1)}" class="chart-zero-line"></line>`
    : "";

  const xCount = Math.min(5, points.length);
  let xLabels = "";
  for (let i = 0; i < xCount; i += 1) {
    const idx = xCount <= 1 ? 0 : Math.round((i / (xCount - 1)) * (points.length - 1));
    const x = xAt(idx);
    const anchor = i === 0 ? "start" : i === xCount - 1 ? "end" : "middle";
    xLabels += `<text x="${x.toFixed(1)}" y="${dims.height - 10}" text-anchor="${anchor}" class="chart-label">${escapeHtml(points[idx].date)}</text>`;
  }

  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`).join(" ");
  const baseY = yAt(lo).toFixed(2);
  const area = `${line} L${xAt(points.length - 1).toFixed(2)},${baseY} L${xAt(0).toFixed(2)},${baseY} Z`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.22"></stop>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"></stop>
      </linearGradient>
    </defs>
    ${grid}
    ${zeroLine}
    <path d="${area}" fill="url(#${gid})"></path>
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    ${yLabels}
    ${xLabels}
    <g class="chart-hover" style="display:none">
      <line class="chart-crosshair" y1="${dims.top}" y2="${dims.height - dims.bottom}"></line>
      <circle class="chart-dot" r="4" style="stroke:${stroke}"></circle>
      <g class="chart-tip">
        <rect class="chart-tip-bg" rx="8" width="170" height="76"></rect>
        <text class="chart-tip-date" x="10" y="16"></text>
        <text class="chart-tip-val" x="10" y="34"></text>
        <text class="chart-tip-sub" x="10" y="52"></text>
        <text class="chart-tip-sub2" x="10" y="68"></text>
      </g>
    </g>
    <rect class="chart-hit" x="${dims.left}" y="${dims.top}" width="${dims.width - dims.left - dims.right}" height="${dims.height - dims.top - dims.bottom}" fill="transparent"></rect>
  `;
  attachChartHover(svg, points, dims, xAt, yAt, performance, mode);
}

function attachChartHover(svg, points, dims, xAt, yAt, performance, mode) {
  const hover = svg.querySelector(".chart-hover");
  const cross = svg.querySelector(".chart-crosshair");
  const dot = svg.querySelector(".chart-dot");
  const tip = svg.querySelector(".chart-tip");
  const tipBg = svg.querySelector(".chart-tip-bg");
  const tipDate = svg.querySelector(".chart-tip-date");
  const tipVal = svg.querySelector(".chart-tip-val");
  const tipSub = svg.querySelector(".chart-tip-sub");
  const tipSub2 = svg.querySelector(".chart-tip-sub2");
  const hit = svg.querySelector(".chart-hit");
  if (!hover || !hit) return;
  const fmtVal = (value) => money(value, performance.currency);
  const svgPoint = svg.createSVGPoint ? svg.createSVGPoint() : null;

  const toSvgX = (evt) => {
    if (svgPoint && svg.getScreenCTM && svg.getScreenCTM()) {
      svgPoint.x = evt.clientX;
      svgPoint.y = evt.clientY;
      return svgPoint.matrixTransform(svg.getScreenCTM().inverse()).x;
    }
    const rect = svg.getBoundingClientRect();
    return ((evt.clientX - rect.left) / rect.width) * dims.width;
  };

  const move = (evt) => {
    const sx = toSvgX(evt);
    const innerW = dims.width - dims.left - dims.right;
    const frac = Math.min(1, Math.max(0, (sx - dims.left) / innerW));
    const idx = points.length <= 1 ? 0 : Math.round(frac * (points.length - 1));
    const point = points[idx];
    const x = xAt(idx);
    const y = yAt(point.value);
    cross.setAttribute("x1", x.toFixed(1));
    cross.setAttribute("x2", x.toFixed(1));
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
    tipDate.textContent = point.date;
    tipVal.textContent = `${mode === "withoutCash" ? "Investment" : "Portfolio"}: ${fmtVal(point.value)}`;
    tipSub.textContent = `Raw value: ${fmtVal(point.rawValue ?? point.value)}`;
    const returnText = point.returnPercent == null ? "n/a" : `${number(point.returnPercent, 2)}%`;
    tipSub2.textContent = `Return: ${returnText}`;
    const textW = Math.max(
      tipDate.getComputedTextLength ? tipDate.getComputedTextLength() : 0,
      tipVal.getComputedTextLength ? tipVal.getComputedTextLength() : 0,
      tipSub.getComputedTextLength ? tipSub.getComputedTextLength() : 0,
      tipSub2.getComputedTextLength ? tipSub2.getComputedTextLength() : 0
    );
    const boxW = Math.max(170, textW + 20);
    tipBg.setAttribute("width", boxW.toFixed(0));
    let tx = x + 12;
    if (tx + boxW > dims.width - dims.right) tx = x - 12 - boxW;
    const ty = Math.max(dims.top, Math.min(y - 38, dims.height - dims.bottom - 80));
    tip.setAttribute("transform", `translate(${tx.toFixed(1)},${ty.toFixed(1)})`);
    hover.style.display = "";
  };

  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseenter", move);
  hit.addEventListener("mouseleave", () => { hover.style.display = "none"; });
  hit.addEventListener("touchstart", (evt) => { if (evt.touches[0]) move(evt.touches[0]); }, { passive: true });
  hit.addEventListener("touchmove", (evt) => { if (evt.touches[0]) move(evt.touches[0]); }, { passive: true });
}

function performanceStatsHtml(performance, options = {}) {
  if (!performance?.points?.length) return `<p class="muted">No performance data loaded yet.</p>`;
  const mode = options.portfolio ? state.portfolioPerformanceMode : "withCash";
  const plotted = performancePointsForMode(performance, mode);
  const first = plotted[0] || {};
  const last = plotted[plotted.length - 1] || {};
  const changeValue = last.value != null && first.value != null ? roundCurrency(last.value - first.value) : null;
  const changePercent = first.value ? roundDisplayPercent((changeValue / first.value) * 100) : null;
  const latestLabel = mode === "withoutCash" ? "Investment Value" : "Latest Value";
  const changeLabel = mode === "withoutCash" ? "Investment Return" : `${performance.label || performance.range || "Range"} Change`;
  const changeClass = valueClass(changeValue || 0);
  const updatedAt = last.date || "latest";
  const returnText = mode === "withoutCash"
    ? (last.returnPercent == null ? "--" : `${number(last.returnPercent, 2)}%`)
    : signedPercent(changePercent);
  const providerNote = mode === "withoutCash"
    ? "unitized return; deposits and withdrawals neutralized"
    : "total portfolio value: holdings plus cash";
  const warningRows = (performance.warnings || []).slice(0, 3).map((warning) => `
    <div class="performance-warning-row">${escapeHtml(warning)}</div>
  `).join("");
  return `
    <div class="performance-metric-strip">
    <div class="performance-stat">
      <span>${escapeHtml(latestLabel)}</span>
      <strong class="${mode === "withoutCash" ? valueClass(last.value || 0) : ""}">${money(last.value, performance.currency)}</strong>
    </div>
    <div class="performance-stat">
      <span>${escapeHtml(changeLabel)}</span>
      <strong class="${changeClass}">${signedMoney(changeValue, performance.currency)} / ${signedPercent(changePercent)}</strong>
    </div>
    <div class="performance-stat">
      <span>Starting Value</span>
      <strong>${money(first.value, performance.currency)}</strong>
    </div>
    <div class="performance-stat">
      <span>Return</span>
      <strong class="${changeClass}">${escapeHtml(returnText)}</strong>
    </div>
    <div class="performance-stat">
      <span>Realized + Dividends</span>
      <strong>${money((last.realizedValue || 0) + (last.dividendValue || 0), performance.currency)}</strong>
    </div>
    </div>
    <div class="performance-provider-row">${escapeHtml(performance.provider || "historical prices")} · ${escapeHtml(providerNote)} · updated ${escapeHtml(updatedAt)}${performance.warnings?.length ? ` · ${performance.warnings.length} data warnings` : ""}</div>
    ${warningRows}
  `;
}

function currentPortfolioPerformance(performance) {
  const summary = state.dashboard?.summary || {};
  const currentTotal = summary.totalValueBase;
  const baseCurrency = state.dashboard?.user?.baseCurrency;
  if (!performance?.points?.length || currentTotal == null || !baseCurrency) return performance;
  const points = performance.points.map((point) => ({ ...point }));
  const last = points[points.length - 1];
  const latestChartValue = Number(last.rawValue ?? last.value);
  const discrepancy = Number.isFinite(latestChartValue) ? roundCurrency(currentTotal - latestChartValue) : 0;
  const discrepancyPercent = currentTotal ? Math.abs(discrepancy / currentTotal) * 100 : 0;
  points[points.length - 1] = {
    ...last,
    value: roundCurrency(currentTotal),
    rawValue: roundCurrency(currentTotal),
    adjustedValue: last.adjustedValue,
    realizedValue: last.realizedValue ?? roundCurrency(summary.realizedGainLossBase || 0),
    dividendValue: last.dividendValue ?? roundCurrency(summary.dividendIncomeBase || 0),
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString()
  };
  const startValue = points[0]?.rawValue ?? points[0]?.value ?? null;
  const endValue = roundCurrency(currentTotal);
  const changeValue = startValue != null ? roundCurrency(endValue - startValue) : null;
  const changePercent = startValue ? roundDisplayPercent((changeValue / startValue) * 100) : null;
  const adjustedStart = points[0]?.adjustedValue ?? null;
  const adjustedEnd = points[points.length - 1]?.adjustedValue ?? null;
  const adjustedChange = adjustedStart != null && adjustedEnd != null ? roundCurrency(adjustedEnd - adjustedStart) : null;
  const provider = String(performance.provider || "historical prices").replace(/\s+\+\s+live.*$/i, "");
  const warnings = [...(performance.warnings || [])];
  if (discrepancyPercent > 0.5) {
    warnings.unshift(`Latest chart/dashboard reconciliation gap is ${signedMoney(discrepancy, baseCurrency)} (${number(discrepancyPercent, 2)}%).`);
  }
  return {
    ...performance,
    points,
    currency: baseCurrency,
    endValue,
    changeValue,
    changePercent,
    startAdjustedValue: adjustedStart,
    endAdjustedValue: adjustedEnd,
    adjustedChangeValue: adjustedChange,
    adjustedChangePercent: adjustedStart ? roundDisplayPercent((adjustedChange / adjustedStart) * 100) : null,
    performanceReliable: performance.performanceReliable && discrepancyPercent <= 0.5,
    provider: `${provider} + live dashboard value`,
    warnings
  };
}

function readableFeedSource(event) {
  const source = String(event.newsSource || event.source || "").trim();
  if (!source) return event.source === "finnhub_news" ? "Company news" : "Official event feed";
  if (source === "finnhub") return "Official event feed";
  if (source === "finnhub_news") return "Company news";
  return source;
}

function normalizedFeedSource(event) {
  return readableFeedSource(event).toLowerCase().replace(/^the\s+/, "");
}

function hasVerifiedSource(event) {
  return Boolean(safeExternalHref(event?.sourceUrl));
}

function isPrimarySource(event) {
  if (!hasVerifiedSource(event)) return false;
  const source = normalizedFeedSource(event);
  const href = safeExternalHref(event.sourceUrl).toLowerCase();
  return PRIMARY_SOURCE_TERMS.some((term) => source.includes(term) || href.includes(term.replace(/\s+/g, "")) || href.includes(term));
}

function isOfficialEvent(event) {
  return isPrimarySource(event);
}

function isReputableFeedSource(event) {
  return hasVerifiedSource(event) && (isPrimarySource(event) || REPUTABLE_NEWS_SOURCES.has(normalizedFeedSource(event)));
}

function sourcePill(event) {
  const credibility = sourceCredibility(event);
  const className = credibility.label === "Unverified" ? "source" : "reputable";
  const label = credibility.label === "Primary" ? "Official" : credibility.label === "Unverified" ? "Unverified source" : readableFeedSource(event);
  return `<span class="source-pill ${className}">${escapeHtml(label)}</span>`;
}

function sourceLink(event, label = "Open") {
  const href = safeExternalHref(event.sourceUrl);
  if (!href) return "";
  return `<a class="button secondary external-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function saveHoldingsView() {
  localStorage.setItem("holdingsView", JSON.stringify({
    sort: state.holdingsSort,
    group: state.holdingsGroup,
    viewMode: state.holdingsViewMode
  }));
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.timeout);
  node.timeout = setTimeout(() => node.classList.remove("show"), 3500);
}

function friendlyErrorMessage(error) {
  const message = error?.message || String(error || "Something went wrong");
  if (/api route not found|request failed: 404/i.test(message)) {
    return "This button needs the updated local server. Quit and reopen Portfolio Tracker, then try again.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The local app server is not responding. Reopen Portfolio Tracker, then refresh this page.";
  }
  return message;
}

function toastError(error) {
  toast(friendlyErrorMessage(error));
}

function setView(view, { scroll = true, updateRoute = true, alertTab = "all", routeTab = "" } = {}) {
  const nextView = ["dashboard", "portfolio", "research", "alerts", "rules-v2", "operations", "stock"].includes(view) ? view : "dashboard";
  state.currentView = nextView;
  if (nextView === "alerts") state.alertTab = alertTab;
  state.routeTab = routeTab;
  if (nextView !== "stock") localStorage.setItem("currentView", nextView);
  if (updateRoute && nextView !== "stock") syncBrowserRoute(nextView, { alertTab: state.alertTab, routeTab });
  document.querySelectorAll("[data-view-tab]").forEach((button) => {
    const active = button.dataset.viewTab === nextView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === nextView);
  });
  if (scroll) {
    const scrollTarget = nextView === "research" && routeTab === "watchlists"
      ? $("#watchlistsBand")
      : nextView === "portfolio" && routeTab === "holdings"
        ? $("#holdingsBand")
        : null;
    if (scrollTarget) {
      requestAnimationFrame(() => scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  if (nextView === "rules-v2" && !state.rulesV2 && !state.rulesV2Loading) {
    loadRulesV2().catch(toastError);
  }
}

function openAlertCenter({ tab = "all", scroll = false } = {}) {
  setView("alerts", { scroll, alertTab: tab });
  requestAnimationFrame(() => {
    const alertsBand = tab === "triggered" ? document.querySelector('[data-alert-section="triggered"]') || $("#alertsBand") : $("#alertsBand");
    if (alertsBand) alertsBand.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.details = payload.details || null;
    if (response.status === 401 && !options.skipAuthRedirect) {
      showAuthGate(payload.needsSetup ? "setup" : "login", payload.error);
    }
    throw error;
  }
  return payload;
}

function showAuthGate(mode = "login", message = "") {
  state.authMode = mode;
  const gate = $("#authGate");
  const title = $("#authTitle");
  const eyebrow = $("#authEyebrow");
  const description = $("#authDescription");
  const nameField = $("#authNameField");
  const currencyField = $("#authCurrencyField");
  const submit = $("#authSubmit");
  const switchLine = $("#authSwitchLine");
  const switchText = $("#authSwitchText");
  const switchButton = $("#authModeSwitch");
  if (!gate) return;
  gate.hidden = false;
  document.body.classList.add("auth-active");
  if (mode === "setup") {
    eyebrow.textContent = "Owner Setup";
    title.textContent = "Secure ApexFolio";
    description.textContent = message || "Create your owner login. Your existing portfolio data stays attached to this account.";
    nameField.hidden = false;
    if (currencyField) currencyField.hidden = true;
    submit.textContent = "Create Owner Login";
    if (switchLine) switchLine.hidden = true;
    const emailInput = gate.querySelector('input[name="email"]');
    if (emailInput && !emailInput.value && state.dashboard?.user?.email) emailInput.value = state.dashboard.user.email;
  } else if (mode === "register") {
    eyebrow.textContent = "New Account";
    title.textContent = "Create your ApexFolio login";
    description.textContent = message || "Start with a private empty workspace. Your account will not share another user’s portfolio.";
    nameField.hidden = false;
    if (currencyField) currencyField.hidden = false;
    submit.textContent = "Create Account";
    if (switchLine) switchLine.hidden = false;
    if (switchText) switchText.textContent = "Already have an account?";
    if (switchButton) switchButton.textContent = "Sign in";
  } else {
    eyebrow.textContent = "Portfolio Intelligence";
    title.textContent = "Sign in to ApexFolio";
    description.textContent = message || "Enter your email and password to continue.";
    nameField.hidden = true;
    if (currencyField) currencyField.hidden = true;
    submit.textContent = "Sign In";
    if (switchLine) switchLine.hidden = false;
    if (switchText) switchText.textContent = "No account yet?";
    if (switchButton) switchButton.textContent = "Create account";
  }
  const passwordInput = gate.querySelector('input[name="password"]');
  if (passwordInput) {
    passwordInput.autocomplete = mode === "login" ? "current-password" : "new-password";
  }
}

function hideAuthGate() {
  const gate = $("#authGate");
  if (gate) gate.hidden = true;
  document.body.classList.remove("auth-active");
}

async function loadSession() {
  const session = await api("/api/session", { skipAuthRedirect: true });
  state.session = session;
  if (!session.authenticated) {
    showAuthGate(session.needsSetup ? "setup" : "login");
    return false;
  }
  hideAuthGate();
  renderAccountState();
  return true;
}

function renderAccountState() {
  const user = state.session?.user || state.dashboard?.user;
  const emailNode = $("#topUserEmail");
  if (emailNode) emailNode.textContent = user?.email || "";
  const isOwner = (user?.role || "member") === "owner";
  document.querySelectorAll(".owner-only").forEach((node) => {
    node.hidden = !isOwner;
  });
  if (isOwner) loadUsers().catch(() => undefined);
}

async function loadUsers() {
  const table = $("#usersTable");
  if (!table) return;
  const payload = await api("/api/users");
  table.innerHTML = (payload.users || []).map((user) => `
    <div class="mini-user-row">
      <div>
        <strong>${escapeHtml(user.name || user.email)}</strong>
        <span>${escapeHtml(user.email)} · ${escapeHtml(user.role || "member")}</span>
      </div>
      <span>${escapeHtml(user.baseCurrency || "")}</span>
    </div>
  `).join("");
}

async function loadDashboard(refresh = false) {
  if (state.dashboardLoading) return;
  state.dashboardLoading = true;
  const suffix = refresh ? "?refresh=true" : "";
  try {
    const dashboard = await api(`/api/dashboard${suffix}`);
    const categoryPayload = await api("/api/categories").catch(() => null);
    const newsPromise = api(`/api/news${refresh ? "?refresh=true" : ""}`).catch((error) => ({
      items: [],
      diagnostics: { status: "ERROR", message: error.message }
    }));
    detectPriceMoves(dashboard);
    state.dashboard = dashboard;
    state.categories = mergeCategories(categoryPayload?.categories || [], state.dashboard.allocation || []);
    if (state.session?.user && dashboard.user) state.session.user = { ...state.session.user, ...dashboard.user };
    saveCachedDashboardSnapshot();
    render();
    renderAccountState();
    if (!state.portfolioPerformance) loadPortfolioPerformance().catch(() => undefined);
    loadRealizedIncome().catch(() => undefined);
    newsPromise.then((newsPayload) => {
      state.news = newsPayload;
      saveCachedDashboardSnapshot();
      renderNewsIntelligence();
    });
  } finally {
    state.dashboardLoading = false;
  }
}

async function loadRealizedIncome() {
  const incomeQuery = new URLSearchParams({
    range: state.realizedIncomeRange,
    filter: state.realizedIncomeFilter
  });
  const wealthQuery = new URLSearchParams({ range: state.realizedIncomeRange });
  const [incomePayload, wealthPayload] = await Promise.all([
    api(`/api/realized-income?${incomeQuery}`),
    api(`/api/portfolio-wealth?${wealthQuery}`)
  ]);
  state.realizedIncome = incomePayload;
  state.portfolioWealth = wealthPayload;
  const validModes = new Set(REALIZED_MODES.map(([value]) => value));
  if (!validModes.has(state.realizedIncomeMode)) {
    state.realizedIncomeMode = wealthPayload?.recommendedMode || "realized_growth";
    localStorage.setItem("realizedIncomeMode", state.realizedIncomeMode);
  }
  if (state.realizedIncomeMode === "portfolio_value" && !(wealthPayload?.actualPortfolioValue?.points || []).length) {
    state.realizedIncomeMode = wealthPayload?.recommendedMode || "realized_growth";
    localStorage.setItem("realizedIncomeMode", state.realizedIncomeMode);
  }
  renderRealizedIncome();
}

function mergeCategories(categoryRows = [], allocationRows = []) {
  const byId = new Map();
  for (const row of allocationRows) byId.set(row.id, { ...row });
  for (const row of categoryRows) {
    const existing = byId.get(row.id) || {};
    const active = row.active ?? existing.active ?? 1;
    byId.set(row.id, {
      ...row,
      ...existing,
      active: active === 0 || active === "0" || active === false ? 0 : 1
    });
  }
  return [...byId.values()].sort((a, b) => (Number(a.sortOrder) || 999) - (Number(b.sortOrder) || 999) || String(a.name).localeCompare(String(b.name)));
}

function isActiveGroup(group) {
  return !(group?.active === 0 || group?.active === "0" || group?.active === false);
}

function detectPriceMoves(dashboard) {
  const nextPrices = new Map();
  for (const position of dashboard?.positions || []) {
    const price = Number(position.price?.price);
    if (!Number.isFinite(price)) continue;
    nextPrices.set(position.ticker, price);
    const previous = state.lastPrices.get(position.ticker);
    if (previous == null || previous === price) continue;
    state.priceMoves.set(position.ticker, price > previous ? "up" : "down");
    window.setTimeout(() => {
      if (!state.priceMoves.has(position.ticker)) return;
      state.priceMoves.delete(position.ticker);
      if (state.dashboard) {
        renderHoldingsSnapshot();
        renderHoldings();
      }
    }, 1300);
  }
  state.lastPrices = nextPrices;
}

function renderSummary() {
  const { summary, user } = state.dashboard;
  const rows = [
    { label: "Total Value", value: money(summary.totalValueBase, user.baseCurrency) },
    { label: "Day Change", value: signedMoney(summary.dayChangeBase, user.baseCurrency), sub: signedPercent(summary.dayChangePercent), delta: summary.dayChangeBase },
    { label: "Unrealized", value: signedMoney(summary.unrealizedBase, user.baseCurrency), delta: summary.unrealizedBase },
    { label: "Realized", value: signedMoney(summary.realizedGainLossBase, user.baseCurrency), delta: summary.realizedGainLossBase },
    { label: "Cash", value: money(summary.cashAvailableBase || 0, user.baseCurrency), delta: summary.cashAvailableBase },
    { label: "Open Alerts", value: `${summary.activeAlerts}`, delta: summary.triggeredAlerts ? 1 : 0, action: "openAlerts", routeTab: "all" },
    { label: "Holdings", value: `${summary.holdingsCount}`, action: "openHoldings", routeTab: "holdings" },
    { label: "Watchlist", value: `${summary.watchlistCount}`, action: "openWatchlists", routeTab: "watchlists" }
  ];

  $("#summaryGrid").innerHTML = rows.map(({ label, value, sub, delta, action, routeTab }) => `
    <div class="metric-tile ${action ? "clickable-metric" : ""}" ${action ? `role="button" tabindex="0" data-action="${action}" data-alert-route-tab="${routeTab}" data-route-tab="${routeTab}" aria-label="Open ${escapeHtml(label)}"` : ""}>
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}" class="metric-value ${String(value).length >= 15 ? "dense" : String(value).length >= 12 ? "compact" : ""} ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${escapeHtml(value)}</strong>
      ${sub ? `<small class="metric-sub ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${escapeHtml(sub)}</small>` : ""}
    </div>
  `).join("");
  $("#baseCurrency").value = user.baseCurrency;
  if ($("#portfolioTabCount")) $("#portfolioTabCount").textContent = summary.holdingsCount || "";
  if ($("#researchTabCount")) $("#researchTabCount").textContent = summary.watchlistCount || "";
  if (!$("#dividendFromDate").value) {
    if (summary.firstLotDate) {
      $("#dividendFromDate").value = String(summary.firstLotDate).slice(0, 10);
    } else {
      const date = new Date();
      date.setFullYear(date.getFullYear() - 1);
      $("#dividendFromDate").value = date.toISOString().slice(0, 10);
    }
  }
  $("#holdingCount").textContent = `${summary.holdingsCount} positions, ${summary.lotCount} lots`;
  $("#watchlistCount").textContent = `${summary.watchlistCount} tickers, ${summary.watchlistGroupCount || watchlistGroups().length} lists`;
  renderAutoPriceControl();
}

function renderAutoPriceControl() {
  const button = $("#autoPricesToggle");
  if (!button) return;
  button.textContent = state.autoPrices ? "Auto Prices On" : "Auto Prices Off";
  button.setAttribute("aria-pressed", String(state.autoPrices));
}

function renderSchedulerControl() {
  const button = $("#schedulerToggle");
  const status = $("#schedulerStatus");
  if (!button || !status) return;
  button.textContent = state.schedulerEnabled ? "Turn Scheduler Off" : "Turn Scheduler On";
  button.classList.toggle("secondary", state.schedulerEnabled);
  button.classList.toggle("primary", !state.schedulerEnabled);
  button.setAttribute("aria-pressed", String(state.schedulerEnabled));
  status.textContent = state.schedulerEnabled
    ? "Background checks are running"
    : "Manual refresh only";
}

async function refreshQuotesSafely() {
  if (state.quoteRefreshRunning || document.hidden) return;
  state.quoteRefreshRunning = true;
  try {
    await api("/api/prices/refresh", {
      method: "POST",
      body: JSON.stringify({ force: false, scope: "fast" })
    });
    await loadDashboard();
  } catch {
    // A background quote refresh should never interrupt the main dashboard.
  } finally {
    state.quoteRefreshRunning = false;
  }
}

function renderPortfolioPerformance() {
  renderRangeTabs();
  const performance = currentPortfolioPerformance(state.portfolioPerformance);
  document.querySelectorAll("[data-performance-card]").forEach((card) => {
    const dashboardCard = card.dataset.performanceCard === "dashboard";
    const collapsed = dashboardCard ? state.dashboardChartCollapsed : state.portfolioChartCollapsed;
    card.classList.toggle("collapsed", collapsed);
    const button = card.querySelector('[data-action="togglePortfolioChart"]');
    if (button) button.textContent = collapsed ? "Show chart" : "Hide chart";
  });
  const modeToggle = $("#performanceModeToggle");
  if (modeToggle) {
    modeToggle.textContent = state.portfolioPerformanceMode === "withCash" ? "Portfolio Value" : "Investment Return";
    modeToggle.title = state.portfolioPerformanceMode === "withCash"
      ? "Total portfolio value: holdings plus transaction-aware cash"
      : "Unitized investment return; deposits and withdrawals are neutralized";
  }
  const loadingText = state.portfolioPerformanceLoading ? "Loading performance history..." : "Choose a range to load performance.";
  const statusText = performance?.points?.length
    ? `${performance.points.length} points | ${performance.warnings?.length ? `${performance.warnings.length} data gaps` : (performance.provider || "historical prices")}`
    : loadingText;
  ["#portfolioPerformanceStatus", "#portfolioPerformanceStatusPortfolio"].forEach((selector) => {
    const node = $(selector);
    if (node) node.textContent = statusText;
  });
  ["#portfolioPerformanceStats", "#portfolioPerformanceStatsPortfolio"].forEach((selector) => {
    const node = $(selector);
    if (node) node.innerHTML = performanceStatsHtml(performance, { portfolio: true });
  });
  const emptyMessage = state.portfolioPerformanceLoading
    ? "Loading performance history..."
    : performance?.warnings?.some((warning) => !/cash-flow/i.test(warning))
      ? "Some historical prices are unavailable for this range"
      : "Choose a range to load performance";
  if (!state.dashboardChartCollapsed) renderPerformanceChart("#portfolioPerformanceChart", performance, emptyMessage, state.portfolioPerformanceMode);
  if (!state.portfolioChartCollapsed) renderPerformanceChart("#portfolioPerformanceChartPortfolio", performance, emptyMessage, state.portfolioPerformanceMode);
}

async function loadPortfolioPerformance(range = state.portfolioPerformanceRange, { force = false } = {}) {
  if (state.portfolioPerformanceLoading) return;
  if (!force && state.portfolioPerformance?.range === range) {
    renderPortfolioPerformance();
    return;
  }
  state.portfolioPerformanceLoading = true;
  renderPortfolioPerformance();
  try {
    state.portfolioPerformance = await api(`/api/performance/portfolio?range=${encodeURIComponent(range)}`);
  } catch (error) {
    state.portfolioPerformance = {
      range,
      currency: state.dashboard?.user?.baseCurrency || "USD",
      points: [],
      warnings: [error.message]
    };
  } finally {
    state.portfolioPerformanceLoading = false;
    renderPortfolioPerformance();
  }
}

function configureAutoPrices() {
  clearInterval(state.refreshTimer);
  clearInterval(state.quoteRefreshTimer);
  state.refreshTimer = null;
  state.quoteRefreshTimer = null;
  renderAutoPriceControl();
  if (!state.autoPrices) return;

  state.refreshTimer = setInterval(() => {
    if (!document.hidden) loadDashboard().catch(() => undefined);
  }, 20000);
  state.quoteRefreshTimer = setInterval(() => {
    refreshQuotesSafely();
  }, 60000);
  setTimeout(() => refreshQuotesSafely(), 500);
}

function chartGradient(items) {
  let cursor = 0;
  const parts = items.filter((item) => item.value > 0).map((item) => {
    const start = cursor;
    cursor += item.percent;
    return `${item.color} ${start}% ${cursor}%`;
  });
  return parts.length ? `conic-gradient(${parts.join(", ")})` : "conic-gradient(#2A2F38 0 100%)";
}

function renderDonut(selector, {
  items,
  centerValue,
  centerLabel,
  emptyLabel = "No value"
}) {
  const total = items.reduce((sumValue, item) => sumValue + Math.max(0, item.value || 0), 0);
  const chartItems = items.map((item, index) => ({
    ...item,
    color: item.color || CHART_COLORS[index % CHART_COLORS.length],
    percent: total ? (Math.max(0, item.value || 0) / total) * 100 : 0
  }));
  const visibleItems = chartItems.filter((item) => item.value > 0 || item.alwaysShow);
  $(selector).innerHTML = `
    <div class="donut" style="background:${chartGradient(chartItems)}" role="img" aria-label="${centerLabel}">
      <div class="donut-hole">
        <strong>${total ? centerValue : "n/a"}</strong>
        <span>${total ? centerLabel : emptyLabel}</span>
      </div>
    </div>
    <div class="donut-legend">
      ${visibleItems.map((item) => `
        <div class="legend-row">
          <span class="swatch" style="background:${item.color}"></span>
          <strong title="${item.label}">${item.label}</strong>
          <span>${percent(item.percent)}</span>
          <span>${money(item.value, state.dashboard.user.baseCurrency)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function allocationDisplayRows() {
  return [...(state.dashboard?.allocation || [])]
    .filter((row) => isActiveGroup(row) || (Number(row.subtotalBase) || 0) > 0)
    .sort((a, b) => (Number(a.sortOrder) || 999) - (Number(b.sortOrder) || 999) || String(a.name).localeCompare(String(b.name)));
}

function allocationStatus(row) {
  const difference = roundDisplayPercent((Number(row.actualPercent) || 0) - (Number(row.targetPercent) || 0));
  if (!Number.isFinite(difference)) return { label: "No target", className: "neutral", difference: 0 };
  if (difference > 2) return { label: "Overweight", className: "negative", difference };
  if (difference < -2) return { label: "Underweight", className: "warning", difference };
  return { label: "On target", className: "live", difference };
}

function signedPp(value) {
  const numeric = Number(value) || 0;
  return `${numeric > 0 ? "+" : ""}${number(numeric, 2)} pp`;
}

function concentrationData() {
  const { positions = [], cashBalances = [], summary = {} } = state.dashboard || {};
  const total = Number(summary.totalValueBase) || 0;
  const openPositions = positions
    .filter((position) => !position.closed && (Number(position.currentValueBase) || 0) > 0)
    .sort((a, b) => (b.currentValueBase || 0) - (a.currentValueBase || 0));
  const topFive = openPositions.slice(0, 5);
  const topTen = openPositions.slice(0, 10);
  const allPositionValue = openPositions.reduce((sumValue, position) => sumValue + (Number(position.currentValueBase) || 0), 0);
  const cashValue = cashBalances.reduce((sumValue, cash) => sumValue + (Number(cash.amountBase) || 0), 0);
  const topFiveValue = topFive.reduce((sumValue, position) => sumValue + (Number(position.currentValueBase) || 0), 0);
  const rows = [
    ...topFive.map((position) => ({
      label: position.ticker,
      value: Number(position.currentValueBase) || 0,
      percent: total ? roundDisplayPercent(((Number(position.currentValueBase) || 0) / total) * 100) : 0
    })),
    {
      label: "Other holdings",
      value: Math.max(0, allPositionValue - topFiveValue),
      percent: total ? roundDisplayPercent((Math.max(0, allPositionValue - topFiveValue) / total) * 100) : 0
    },
    {
      label: "Cash",
      value: cashValue,
      percent: total ? roundDisplayPercent((cashValue / total) * 100) : 0
    }
  ].filter((row) => row.value > 0 || row.label === "Cash");
  const largestPercent = topFive[0] && total ? roundDisplayPercent(((topFive[0].currentValueBase || 0) / total) * 100) : 0;
  const top3Percent = total ? roundDisplayPercent((openPositions.slice(0, 3).reduce((sumValue, position) => sumValue + (position.currentValueBase || 0), 0) / total) * 100) : 0;
  const top5Percent = total ? roundDisplayPercent((topFiveValue / total) * 100) : 0;
  const top10Percent = total ? roundDisplayPercent((topTen.reduce((sumValue, position) => sumValue + (position.currentValueBase || 0), 0) / total) * 100) : 0;
  const above5 = openPositions.filter((position) => total && ((position.currentValueBase || 0) / total) * 100 > 5).length;
  const above10 = openPositions.filter((position) => total && ((position.currentValueBase || 0) / total) * 100 > 10).length;
  const risk = largestPercent > 15 ? "High" : largestPercent > 10 ? "Elevated" : "Normal";
  return {
    rows,
    largest: topFive[0]?.ticker || "n/a",
    largestValue: topFive[0]?.currentValueBase || 0,
    largestPercent,
    top3Percent,
    top5Percent,
    top10Percent,
    above5,
    above10,
    risk
  };
}

function renderConcentrationSummary() {
  const node = $("#concentrationSummary");
  if (!node) return;
  const data = concentrationData();
  const riskClass = data.risk === "High" ? "negative" : data.risk === "Elevated" ? "warning" : "live";
  const reason = data.largest === "n/a"
    ? "No open holding concentration yet."
    : `${data.risk} concentration risk - ${data.largest} represents ${percent(data.largestPercent)} of portfolio value.`;
  node.innerHTML = `
    <div class="concentration-head">
      <div>
        <strong>Portfolio Concentration</strong>
        <span>${escapeHtml(reason)}</span>
      </div>
      <span class="status-pill ${riskClass}">${data.risk}</span>
    </div>
    <div class="concentration-bars">
      ${data.rows.map((row) => `
        <div class="concentration-row">
          <span>${escapeHtml(row.label)}</span>
          <div class="concentration-track"><div style="width:${Math.min(100, Math.max(0, row.percent))}%"></div></div>
          <strong>${percent(row.percent)}</strong>
          <strong>${money(row.value, state.dashboard.user.baseCurrency)}</strong>
        </div>
      `).join("")}
    </div>
    <div class="concentration-metrics">
      <span class="${concentrationChipClass(data.largestPercent, 15, 20)}">Largest ${escapeHtml(data.largest)} ${percent(data.largestPercent)}</span>
      <span class="${concentrationChipClass(data.top3Percent, 45, 60)}">Top 3 ${percent(data.top3Percent)}</span>
      <span class="${concentrationChipClass(data.top5Percent, 60, 75)}">Top 5 ${percent(data.top5Percent)}</span>
      <span class="${concentrationChipClass(data.top10Percent, 80, 90)}">Top 10 ${percent(data.top10Percent)}</span>
      <span class="${concentrationChipClass(data.above5, 5, 8)}">>5% ${data.above5}</span>
      <span class="${concentrationChipClass(data.above10, 1, 3)}">>10% ${data.above10}</span>
    </div>
  `;
}

function renderPortfolioCharts() {
  const { summary, user } = state.dashboard;
  const allocationCard = document.querySelector(".dashboard-allocation-card");
  if (allocationCard) {
    allocationCard.classList.toggle("collapsed", state.allocationCollapsed);
    const button = allocationCard.querySelector('[data-action="toggleAllocation"]');
    if (button) button.textContent = state.allocationCollapsed ? "Show" : "Hide";
  }
  const allocation = allocationDisplayRows();
  const groupTotalNode = $("#groupDonutTotal");
  if (groupTotalNode) groupTotalNode.textContent = `Total ${money(summary.totalValueBase, user.baseCurrency)}`;
  const summaryNode = $("#dashboardAllocationSummary");
  if (summaryNode) {
    const overweight = allocation.map((row) => ({ ...row, status: allocationStatus(row) }))
      .filter((row) => row.status.label === "Overweight")
      .sort((a, b) => b.status.difference - a.status.difference)[0];
    summaryNode.innerHTML = `
      <span>${allocation.length} groups</span>
      <span>${overweight ? `Largest variance ${escapeHtml(overweight.name)} ${signedPp(overweight.status.difference)}` : "No major variance"}</span>
      <span>Concentration risk ${concentrationData().risk}</span>
    `;
  }

  const allocationItems = allocation.map((row, index) => ({
    label: row.name,
    value: row.subtotalBase || 0,
    alwaysShow: true,
    color: row.color || CHART_COLORS[index % CHART_COLORS.length]
  }));
  renderDonut("#groupDonut", {
    items: allocationItems,
    centerValue: compactMoney(summary.totalValueBase, user.baseCurrency),
    centerLabel: "total portfolio"
  });
  const allocationTable = $("#dashboardAllocationTable");
  if (allocationTable) {
    allocationTable.innerHTML = `
      <div class="allocation-target-head">
        <span></span><span>Group</span><span>Current</span><span>Target</span><span>Difference</span><span>Value</span><span>Status</span>
      </div>
      ${allocation.map((row) => {
        const status = allocationStatus(row);
        return `
          <div class="allocation-target-row">
            <span class="swatch" style="background:${escapeHtml(row.color || "#C9A86A")}"></span>
            <strong title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</strong>
            <span class="num">${percent(row.actualPercent)}</span>
            <span class="num">${percent(row.targetPercent)}</span>
            <span class="num ${status.className === "negative" ? "negative" : status.className === "warning" ? "warning-text" : "positive"}">${signedPp(status.difference)}</span>
            <span class="num">${money(row.subtotalBase, user.baseCurrency)}</span>
            <span><span class="status-pill ${status.className}">${status.label}</span></span>
          </div>
        `;
      }).join("")}
    `;
  }
  renderConcentrationSummary();
}

async function renderProviderStatus() {
  const health = await api("/api/health");
  state.schedulerEnabled = Boolean(health.schedulerEnabled);
  const emailLabel = health.emailProvider === "sendgrid" ? "SendGrid" : "Brevo";
  const aiLabel = health.aiConfigured
    ? `${health.aiProvider === "gemini" ? "Gemini" : "OpenAI"} memos connected`
    : "Rules engine active";
  const parts = [
    health.providerStatus.finnhubConfigured ? "Finnhub connected" : "Finnhub missing",
    health.providerStatus.alphaVantageConfigured ? "Alpha Vantage connected" : "Alpha Vantage missing",
    health.emailConfigured ? `${emailLabel} email connected` : `${emailLabel} email missing`,
    health.aiConfigured ? aiLabel : "AI memos optional",
    health.schedulerEnabled ? "scheduler on" : "scheduler off"
  ];
  $("#providerStatus").textContent = parts.join(" | ");
  if ($("#emailProvider")) $("#emailProvider").value = health.emailProvider || "brevo";
  if ($("#aiProvider")) $("#aiProvider").value = health.aiProvider === "gemini" ? "gemini" : "openai";
  if ($("#aiModel") && health.aiModel) $("#aiModel").value = health.aiModel;
  renderSchedulerControl();
  const aiStatusBadge = $("#aiStatusBadge");
  if (aiStatusBadge) {
    aiStatusBadge.textContent = aiLabel;
    aiStatusBadge.className = "status-pill live";
  }
}

function renderImports() {
  const imports = state.dashboard.imports || [];
  $("#importHistoryCount").textContent = imports.length ? `${imports.length} files` : "No uploads yet";
  $("#toggleImportHistory").textContent = state.importHistoryOpen ? "Hide" : "Show";
  $("#toggleImportHistory").setAttribute("aria-expanded", String(state.importHistoryOpen));
  $("#toggleImportHistory").disabled = imports.length === 0;
  $("#importHistory").hidden = !state.importHistoryOpen;
  $("#importHistory").innerHTML = imports.length ? imports.map((item) => `
    <div class="import-item">
      <span><strong>${item.kind}</strong> ${item.filename}</span>
      <span>${item.createdCount} added, ${item.updatedCount} matched, ${item.errorCount} errors</span>
    </div>
  `).join("") : `<p class="muted">No uploaded files yet</p>`;
}

function updateImportControls() {
  const form = $("#uploadForm");
  if (!form) return;
  const kind = form.elements.kind.value;
  const replaceLabel = $("#replaceImportLabel");
  const note = $("#importReplaceNote");
  const watchlistName = form.elements.watchlistName;
  if (replaceLabel) {
    replaceLabel.textContent = kind === "watchlist" ? "Replace selected watchlist" : "Replace portfolio";
  }
  if (note) {
    note.textContent = kind === "netwealth_transactions"
      ? "Netwealth replace rebuilds lots, sales, dividends, and cash. Watchlists stay separate."
      : kind === "watchlist"
        ? "Watchlist replace only clears the selected watchlist."
        : "Portfolio replace clears existing lots, sales, and dividends before importing.";
  }
  if (watchlistName) {
    watchlistName.hidden = kind !== "watchlist";
    watchlistName.disabled = kind !== "watchlist";
  }
}

function priceLine(item) {
  return item.price?.price == null
    ? "n/a"
    : money(item.price.price, item.price.currency);
}

function actionLabel(item) {
  const suffix = item.alreadyOwned ? "Already owned" : item.watchlistName || item.theme;
  return suffix || item.theme || "";
}

function bestAction(items, preferredStatuses = ["TRIM", "REVIEW", "ADD", "BUY"]) {
  return items.find((item) => preferredStatuses.includes(item.status)) || items[0];
}

function renderDecisionRows(items, emptyText) {
  return items.length ? items.slice(0, 8).map((item) => `
    <div class="decision-card">
      <div class="decision-card-head">
        <div>
          <span class="decision-pill ${item.status.toLowerCase()}">${statusIcon[item.status] || item.status}</span>
          ${tickerButton(item.ticker)}
          <span class="muted">${actionLabel(item)}</span>
        </div>
        <div class="decision-score">
          <strong>${item.convictionScore}</strong>
          <span>Conviction</span>
        </div>
      </div>
      <div class="decision-card-body">
        <div class="decision-metric">
          <span>Price</span>
          <strong>${priceLine(item)}</strong>
        </div>
        <div class="decision-metric">
          <span>AI Exposure</span>
          <strong>${item.aiExposureType}</strong>
        </div>
        <p>${item.reason}</p>
      </div>
    </div>
  `).join("") : `<p class="muted">${emptyText}</p>`;
}

function renderMemoTickerOptions(intelligence) {
  const memoTicker = $("#memoTicker");
  if (!memoTicker) return;
  const selected = memoTicker.value;
  const unique = new Map();
  for (const item of intelligence?.decisions || []) {
    if (!unique.has(item.ticker)) unique.set(item.ticker, item);
  }
  memoTicker.innerHTML = [...unique.values()].map((item) => `
    <option value="${item.ticker}" ${item.ticker === selected ? "selected" : ""}>${item.ticker} - ${item.status}</option>
  `).join("");
}

function renderIntelligence() {
  const { intelligence, user } = state.dashboard;
  if (!intelligence) return;
  renderMemoTickerOptions(intelligence);
  if (!$("#portfolioDecisionBrief")) return;
  const summary = intelligence.summary || {};
  const portfolioQueue = intelligence.portfolioQueue || (intelligence.decisions || []).filter((item) => item.scope === "PORTFOLIO");
  const watchlistQueue = intelligence.watchlistQueue || (intelligence.decisions || []).filter((item) => item.scope === "WATCHLIST");
  const portfolioAction = bestAction(portfolioQueue);
  const watchlistAction = bestAction(watchlistQueue.filter((item) => !item.alreadyOwned), ["BUY", "ADD", "REVIEW", "TRIM"]) || bestAction(watchlistQueue);
  const primaryRisk = intelligence.risks?.[0];
  const plan = intelligence.capitalPlan || {};

  $("#portfolioIntelligenceStatus").textContent = [
    `${summary.portfolioCount || portfolioQueue.length || 0} owned positions monitored`,
    `${summary.portfolioTrimCount || 0} trim`,
    `${summary.portfolioReviewCount || 0} review`,
    `rules engine active`
  ].join(" | ");

  $("#watchlistIntelligenceStatus").textContent = [
    `${summary.watchlistCount || watchlistQueue.length || 0} watchlist tickers`,
    `${(intelligence.watchlistLists || []).length || state.dashboard.summary.watchlistGroupCount || 0} lists`,
    `${summary.watchlistBuyCount || 0} buy zones`,
    `${summary.watchlistAddCount || 0} add zones`
  ].join(" | ");

  const watchlistStatusBadge = $("#watchlistStatusBadge");
  if (watchlistStatusBadge) {
    watchlistStatusBadge.textContent = "Watchlists separated";
    watchlistStatusBadge.className = "status-pill ai";
  }

  $("#portfolioDecisionBrief").innerHTML = portfolioAction ? `
    <div class="brief-primary">
      <span class="decision-pill ${portfolioAction.status.toLowerCase()}">${statusIcon[portfolioAction.status] || portfolioAction.status}</span>
      <div>
        <strong>${portfolioAction.ticker}</strong>
        <span>${portfolioAction.theme} | ${portfolioAction.convictionScore}/100 conviction</span>
      </div>
      <div>
        <p>${portfolioAction.reason}</p>
        <div class="brief-actions">
          <button class="button secondary" data-view-jump="portfolio" type="button">Open Portfolio</button>
          <button class="button" data-open-alert="${portfolioAction.ticker}" data-scope="EQUITY" type="button">Alert</button>
        </div>
      </div>
    </div>
    <div class="brief-side">
      <span class="section-title">Risk Signal</span>
      <strong>${primaryRisk?.kind || "No major risk flag"}</strong>
      <p>${primaryRisk?.text || "No single risk threshold is currently dominating."}</p>
    </div>
    <div class="brief-side">
      <span class="section-title">Cash Plan</span>
      <strong>${money(plan.cashBase || 0, user.baseCurrency)}</strong>
      <p>${(plan.priorityBuys || []).length ? "Priority buy list is ready below." : "No buy/add candidates while current price zones are not attractive."}</p>
    </div>
  ` : `
    <div class="brief-primary">
      <span class="decision-pill hold">HOLD</span>
      <div>
        <strong>No owned positions yet</strong>
        <span>Import your portfolio or add a lot to activate Portfolio Command.</span>
      </div>
    </div>
  `;

  $("#watchlistDecisionBrief").innerHTML = watchlistAction ? `
    <div class="brief-primary">
      <span class="decision-pill ${watchlistAction.status.toLowerCase()}">${statusIcon[watchlistAction.status] || watchlistAction.status}</span>
      <div>
        <strong>${watchlistAction.ticker}</strong>
        <span>${watchlistAction.watchlistName || "Watchlist"} | ${watchlistAction.theme}</span>
      </div>
      <div>
        <p>${watchlistAction.alreadyOwned ? "This ticker is already owned, so it is marked separately from new ideas. " : ""}${watchlistAction.reason}</p>
        <div class="brief-actions">
          <button class="button secondary" data-view-jump="research" type="button">Open Watchlists</button>
          <button class="button" data-open-alert="${watchlistAction.ticker}" data-scope="WATCHLIST" data-watchlist-item-id="${watchlistAction.watchlistItemId || ""}" type="button">Alert</button>
        </div>
      </div>
    </div>
    <div class="brief-side">
      <span class="section-title">Theme</span>
      <strong>${watchlistAction.theme}</strong>
      <p>${watchlistAction.aiExposureType}; AI exposure ${watchlistAction.aiExposureScore}/10, moat ${watchlistAction.moatScore}/10.</p>
    </div>
    <div class="brief-side">
      <span class="section-title">Price Discipline</span>
      <strong>${priceLine(watchlistAction)}</strong>
      <p>${watchlistAction.zones ? `Buy zone ${money(watchlistAction.zones.buy[0], watchlistAction.price?.currency || user.baseCurrency)} to ${money(watchlistAction.zones.buy[1], watchlistAction.price?.currency || user.baseCurrency)}.` : "Set a target price to create a useful buy/add zone."}</p>
    </div>
  ` : `
    <div class="brief-primary">
      <span class="decision-pill hold">HOLD</span>
      <div>
        <strong>No watchlist ideas yet</strong>
        <span>Import or add watchlist tickers to activate Watchlist Radar.</span>
      </div>
    </div>
  `;

  $("#portfolioActions").innerHTML = renderDecisionRows(portfolioQueue, "No portfolio actions yet");
  $("#watchlistActions").innerHTML = renderDecisionRows(watchlistQueue, "No watchlist actions yet");

  $("#portfolioRisks").innerHTML = intelligence.risks?.length ? intelligence.risks.map((risk) => `
    <div class="compact-row risk-row">
      <div><strong>${risk.kind}</strong><br><span class="status-pill ${risk.severity === "High" ? "warning" : "live"}">${risk.severity}</span></div>
      <div>${risk.text}</div>
    </div>
  `).join("") : `<p class="muted">No major risk flags</p>`;

  $("#capitalPlan").innerHTML = `
    <div class="cash-item">
      <span>Cash available</span>
      <strong>${money(plan.cashBase || 0, user.baseCurrency)}</strong>
    </div>
    ${(plan.priorityBuys || []).length ? plan.priorityBuys.map((item) => `
      <div class="compact-row capital-row">
        <div>${tickerButton(item.ticker)}<br><span class="muted">${item.theme}</span></div>
        <div>${item.status}<br><span class="muted">${item.convictionScore}/100</span></div>
        <div class="num">${percent(item.suggestedPercent)}<br><span class="muted">${money(item.suggestedAmountBase, user.baseCurrency)}</span></div>
      </div>
    `).join("") : `<p class="muted">No buy/add candidates while price zones are not attractive.</p>`}
  `;

  $("#watchlistThemeRadar").innerHTML = intelligence.watchlistThemeExposure?.length ? intelligence.watchlistThemeExposure.slice(0, 8).map((item) => `
    <div class="compact-row theme-row">
      <div><strong>${item.name}</strong><br><span class="muted">${item.count} tickers</span></div>
      <div class="num">${percent(item.exposurePercent)}</div>
    </div>
  `).join("") : `<p class="muted">No watchlist themes yet</p>`;

  $("#watchlistListRadar").innerHTML = intelligence.watchlistLists?.length ? intelligence.watchlistLists.slice(0, 8).map((list) => `
    <div class="compact-row watchlist-list-row">
      <div><strong>${list.name}</strong><br><span class="muted">${list.count} tickers, ${list.ownedCount} owned</span></div>
      <div><span class="decision-pill ${list.priority?.status?.toLowerCase() || "hold"}">${list.priority?.status || "HOLD"}</span><br><span class="muted">${list.averageConviction}/100 avg</span></div>
      <div>${(list.themes || []).slice(0, 2).map((theme) => theme.name).join(", ") || "Unclassified"}</div>
    </div>
  `).join("") : `<p class="muted">No watchlists yet</p>`;

  const themeExposure = $("#themeExposure");
  if (themeExposure) {
    themeExposure.innerHTML = intelligence.themeExposure?.length ? intelligence.themeExposure.slice(0, 12).map((item) => `
      <div class="compact-row theme-row">
        <div><strong>${item.name}</strong><br><span class="muted">${item.count} owned tickers</span></div>
        <div class="num">${percent(item.exposurePercent)}</div>
      </div>
    `).join("") : `<p class="muted">No owned theme exposure yet</p>`;
  }

  renderMemoTickerOptions(intelligence);
}

function renderDashboardIntelligence() {
  const data = state.dashboard.dashboardIntelligence;
  if (!data || !$("#dashboardCommand")) return;
  const { user } = state.dashboard;
  const priorityClass = data.command.priority === "High" ? "negative" : data.command.priority === "Medium" ? "warning" : "live";
  const modeLabel = data.mode === "rules-v2"
    ? `Rules V2 active${data.rulesVersion ? ` | ${data.rulesVersion}` : ""}`
    : data.mode === "rules"
      ? "Rules engine active"
      : "AI intelligence active";
  $("#dashboardIntelligenceStatus").textContent = `${modeLabel} | Decision support only`;
  const t = data.thresholds || {};
  const playbook = data.playbook || "";
  $("#dashboardCommand").innerHTML = `
    <div class="command-main">
      <span class="status-pill ${priorityClass}">${escapeHtml(data.command.priority)}</span>
      <h2>${escapeHtml(data.command.title)}</h2>
      <p>${escapeHtml(data.command.text)}</p>
      ${playbook ? `<div class="command-playbook"><span class="command-playbook-label">Playbook</span><p>${escapeHtml(playbook)}</p></div>` : ""}
      <div class="command-rules-summary">
        <span>Concentration ${number(t.concentrationWarnPercent ?? 15, 0)}% warn / ${number(t.concentrationHighPercent ?? 20, 0)}% high</span>
        <span>Allocation drift ${number(t.allocationWarnPP ?? 5, 0)}pp warn / ${number(t.allocationHighPP ?? 15, 0)}pp high</span>
        <span>Cash ${number(t.cashElevatedPercent ?? 12, 0)}% elevated / ${number(t.cashHighPercent ?? 20, 0)}% high</span>
      </div>
    </div>
    <div class="decision-score">
      <strong>${escapeHtml(data.command.confidence)}</strong>
      <span>Confidence</span>
      <button class="button secondary command-edit-rules" data-action="openRulesEditor" type="button">Edit Rules</button>
    </div>
  `;
  $("#dashboardRisks").innerHTML = data.risks?.length ? data.risks.map((risk) => `
    <div class="compact-row dashboard-signal-row">
      <div><strong>${escapeHtml(risk.title)}</strong><br><span class="status-pill ${risk.severity === "High" ? "negative" : "warning"}">${escapeHtml(risk.severity)}</span></div>
      <div>${escapeHtml(risk.text)}</div>
    </div>
  `).join("") : `<p class="muted">No major risk flags from current rules.</p>`;
  $("#dashboardOpportunities").innerHTML = data.opportunities?.length ? data.opportunities.map((item) => `
    <div class="compact-row dashboard-signal-row">
      <div>${tickerButton(item.ticker)}<br><span class="decision-pill ${item.status.toLowerCase()}">${escapeHtml(item.status)}</span></div>
      <div>${escapeHtml(item.text)}</div>
    </div>
  `).join("") : `<p class="muted">No current buy/add opportunities from available zones.</p>`;
  $("#dashboardCashPlan").innerHTML = `
    <div class="cash-item">
      <span>Cash available</span>
      <strong>${money(data.cashPlan.cashBase || 0, user.baseCurrency)}</strong>
    </div>
    <div class="compact-row dashboard-signal-row">
      <div><strong>${escapeHtml(data.cashPlan.action)}</strong><br><span class="muted">${percent(data.cashPlan.cashPercent || 0)} cash</span></div>
      <div>${escapeHtml(data.cashPlan.reason)}</div>
    </div>
  `;
}

function ruleV2Pill(value, className = "neutral") {
  return `<span class="status-pill ${escapeHtml(className || "neutral")}">${escapeHtml(value || "n/a")}</span>`;
}

function renderRulesV2Summary() {
  const node = $("#rulesV2Summary");
  if (!node) return;
  const payload = state.rulesV2;
  const rows = payload?.evaluations || [];
  const buckets = rulesCenterBuckets(rows);
  const baseCurrency = state.dashboard?.user?.baseCurrency || "AUD";
  if (state.rulesV2Loading) {
    node.innerHTML = `<div class="summary-card"><span>Loading</span><strong>Checking rules...</strong><small>Read-only comparison</small></div>`;
    return;
  }
  if (!payload) {
    node.innerHTML = `
      <div class="summary-card">
        <span>Rules V2</span>
        <strong>Not loaded</strong>
        <small>${escapeHtml(state.rulesV2Error || "Open or refresh the Rules Center.")}</small>
      </div>
    `;
    return;
  }
  node.innerHTML = [
    ["Urgent", buckets.urgent.length, "Critical or high-priority rules", "negative"],
    ["Needs Review", buckets.review.length, "Thesis, valuation, sizing, or group checks", "warning"],
    ["Buy/Add Eligible", buckets.eligible.length, "Attractive and not blocked", "live"],
    ["Blocked Ideas", buckets.blocked.length, "Attractive signal blocked by portfolio rules", "ai"],
    ["Portfolio value", money(state.dashboard?.summary?.totalValueBase || 0, baseCurrency), "Current dashboard total", "neutral"]
  ].map(([label, value, detail, tone]) => `
    <div class="summary-card rules-summary-card ${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `).join("");
}

function rulesCenterBuckets(rows = []) {
  const buckets = {
    urgent: [],
    blocked: [],
    trim: [],
    review: [],
    eligible: [],
    data: [],
    monitor: []
  };
  const seenPrimary = new Set();
  const keyFor = (item) => `${item.scope || ""}:${item.ticker || ""}:${item.watchlistItemId || ""}:${item.primaryReasonCode || ""}`;
  const add = (bucket, item) => {
    const key = keyFor(item);
    if (seenPrimary.has(key)) return;
    seenPrimary.add(key);
    bucket.push(item);
  };

  for (const item of rows) {
    const hasDataIssue = item.dataState && item.dataState !== "OK";
    const isBlockedOpportunity = ["BUY", "ADD"].includes(item.underlyingSignal) && item.tradeEligibility === "BLOCKED";
    const isUrgent = ["Critical", "High"].includes(item.priority);
    if (hasDataIssue) buckets.data.push(item);
    if (isBlockedOpportunity) {
      add(buckets.blocked, item);
    } else if (item.finalAction === "TRIM") {
      add(buckets.trim, item);
    } else if (isUrgent) {
      add(buckets.urgent, item);
    } else if (item.finalAction === "REVIEW" || item.tradeEligibility === "CAUTION") {
      add(buckets.review, item);
    } else if (["BUY", "ADD"].includes(item.finalAction) && item.tradeEligibility !== "BLOCKED") {
      add(buckets.eligible, item);
    } else {
      add(buckets.monitor, item);
    }
  }
  return buckets;
}

function rulesCenterPrimaryAction(buckets) {
  if (buckets.trim.length) return {
    tone: "negative",
    title: "Review trim signals first",
    text: `${buckets.trim.length} position${buckets.trim.length === 1 ? "" : "s"} triggered trim or concentration rules. Check sizing before considering new buys.`,
    cta: "Open Portfolio",
    view: "portfolio",
    scrollTarget: "holdingsBand"
  };
  if (buckets.blocked.length) return {
    tone: "warning",
    title: "Blocked opportunities need judgment",
    text: `${buckets.blocked.length} attractive signal${buckets.blocked.length === 1 ? " is" : "s are"} blocked by portfolio construction rules.`,
    cta: "Review Blocked",
    view: "rules-v2"
  };
  if (buckets.data.length) return {
    tone: "warning",
    title: "Fix data confidence before acting",
    text: `${buckets.data.length} ticker${buckets.data.length === 1 ? "" : "s"} have stale, partial, or missing data.`,
    cta: "Refresh Prices",
    action: "refreshPrices"
  };
  if (buckets.eligible.length) return {
    tone: "live",
    title: "Eligible buy/add candidates found",
    text: `${buckets.eligible.length} idea${buckets.eligible.length === 1 ? "" : "s"} passed V2 eligibility checks. Review thesis before acting.`,
    cta: "Open Research",
    view: "research",
    scrollTarget: "watchlistsBand"
  };
  return {
    tone: "neutral",
    title: "Hold course",
    text: "No urgent V2 rule needs action from the current data. Keep monitoring alerts and data quality.",
    cta: "Open Dashboard",
    view: "dashboard"
  };
}

function ruleActionButton(config) {
  if (config.action) {
    return `<button class="button primary" data-action="${escapeHtml(config.action)}" type="button">${escapeHtml(config.cta)}</button>`;
  }
  return `<button class="button primary" data-view-jump="${escapeHtml(config.view || "dashboard")}" ${config.scrollTarget ? `data-scroll-target="${escapeHtml(config.scrollTarget)}"` : ""} type="button">${escapeHtml(config.cta)}</button>`;
}

function renderRulesV2Command() {
  const node = $("#rulesV2Command");
  if (!node) return;
  if (state.rulesV2Loading) {
    node.innerHTML = `<p class="muted">Loading today’s rules command...</p>`;
    return;
  }
  if (!state.rulesV2) {
    node.innerHTML = `<p class="muted">Rules Center has not loaded yet.</p>`;
    return;
  }
  const buckets = rulesCenterBuckets(state.rulesV2.evaluations || []);
  const command = rulesCenterPrimaryAction(buckets);
  node.innerHTML = `
    <div class="rules-command-card ${escapeHtml(command.tone)}">
      <span class="status-pill ${escapeHtml(command.tone === "negative" ? "negative" : command.tone === "warning" ? "warning" : command.tone === "live" ? "live" : "neutral")}">${escapeHtml(command.tone === "negative" ? "High priority" : command.tone === "warning" ? "Review" : command.tone === "live" ? "Opportunity" : "Stable")}</span>
      <h3>${escapeHtml(command.title)}</h3>
      <p>${escapeHtml(command.text)}</p>
      <div class="button-row">
        ${ruleActionButton(command)}
        <button class="button secondary" data-view-jump="alerts" data-scroll-target="alertsBand" type="button">Open Alerts</button>
      </div>
    </div>
  `;
}

function renderRulesV2Radar() {
  const node = $("#rulesV2Radar");
  if (!node) return;
  const rows = state.rulesV2?.evaluations || [];
  if (!rows.length) {
    node.innerHTML = `<p class="muted">No radar data yet.</p>`;
    return;
  }
  const buckets = rulesCenterBuckets(rows);
  const metrics = [
    ["Trim pressure", buckets.trim.length, "negative"],
    ["Blocked adds", buckets.blocked.length, "warning"],
    ["Data issues", buckets.data.length, "warning"],
    ["Eligible", buckets.eligible.length, "live"],
    ["Monitor", buckets.monitor.length, "neutral"]
  ];
  node.innerHTML = `
    <div class="rules-radar-bars">
      ${metrics.map(([label, value, tone]) => {
        const width = Math.max(5, Math.min(100, rows.length ? (Number(value) / rows.length) * 100 : 0));
        return `
          <div class="rules-radar-row">
            <span>${escapeHtml(label)}</span>
            <div class="rules-radar-track"><span class="${escapeHtml(tone)}" style="width:${width}%"></span></div>
            <strong>${escapeHtml(String(value))}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function rulesCenterDestination(item) {
  if (item.scope === "WATCHLIST") {
    return `<button class="button secondary" data-view-jump="research" data-scroll-target="watchlistsBand" type="button">Watchlist</button>`;
  }
  return `<button class="button secondary" data-view-jump="portfolio" data-scroll-target="holdingsBand" type="button">Portfolio</button>`;
}

function rulesCenterCard(item, tone = "neutral") {
  const price = item.context?.price == null
    ? "Price n/a"
    : money(item.context.price, item.context.currency || state.dashboard?.user?.baseCurrency || "USD");
  const scores = item.scores || {};
  const scoreLine = [
    `Thesis ${scores.thesisConviction ?? "n/a"}`,
    `Value ${scores.valuationOpportunity ?? "n/a"}`,
    `Fit ${scores.portfolioFit ?? "n/a"}`,
    `Data ${scores.dataConfidence ?? "n/a"}`
  ].join(" / ");
  const alertScope = item.scope === "WATCHLIST" ? "WATCHLIST" : "EQUITY";
  return `
    <article class="rules-action-card ${escapeHtml(tone)}">
      <div class="rules-action-head">
        <div>
          ${tickerButton(item.ticker)}
          <span class="muted">${escapeHtml(item.name || item.context?.theme || item.scope || "")}</span>
        </div>
        ${ruleV2Pill(item.finalAction, item.classes?.finalAction)}
      </div>
      <div class="rules-action-meta">
        ${ruleV2Pill(item.priority, item.classes?.priority)}
        ${ruleV2Pill(item.tradeEligibility, item.classes?.eligibility)}
        ${ruleV2Pill(item.underlyingSignal, item.classes?.valuation)}
      </div>
      <h3>${escapeHtml(item.primaryReasonCode || "RULE_TRIGGERED")}</h3>
      <p>${escapeHtml(item.explanation || "Review this rule output.")}</p>
      <div class="rules-action-context">
        <span>${escapeHtml(price)}</span>
        <span>${escapeHtml(item.context?.groupName || item.context?.theme || "Unclassified")}</span>
        <span>${escapeHtml(scoreLine)}</span>
      </div>
      <div class="rules-action-links">
        <button class="button secondary" data-open-stock="${escapeHtml(item.ticker)}" type="button">Stock Page</button>
        ${rulesCenterDestination(item)}
        <button class="button" data-open-alert="${escapeHtml(item.ticker)}" data-scope="${escapeHtml(alertScope)}" data-watchlist-item-id="${escapeHtml(item.watchlistItemId || "")}" type="button">Create Alert</button>
      </div>
    </article>
  `;
}

function rulesCenterSection(title, subtitle, items, tone, emptyText, limit = 8) {
  return `
    <section class="rules-queue-section ${escapeHtml(tone)}">
      <div class="rules-queue-head">
        <div>
          <span class="eyebrow">${escapeHtml(title)}</span>
          <h3>${escapeHtml(subtitle)}</h3>
        </div>
        <strong>${items.length}</strong>
      </div>
      <div class="rules-card-grid">
        ${items.length ? items.slice(0, limit).map((item) => rulesCenterCard(item, tone)).join("") : `<p class="muted">${escapeHtml(emptyText)}</p>`}
      </div>
    </section>
  `;
}

function renderRulesV2Queues() {
  const node = $("#rulesV2Queues");
  if (!node) return;
  if (state.rulesV2Loading) {
    node.innerHTML = `<p class="muted">Building V2 action queues...</p>`;
    return;
  }
  const rows = state.rulesV2?.evaluations || [];
  if (!rows.length) {
    node.innerHTML = `<p class="muted">No V2 rules loaded yet.</p>`;
    return;
  }
  const buckets = rulesCenterBuckets(rows);
  node.innerHTML = [
    rulesCenterSection("Critical / Trim", "Review before adding capital", [...buckets.trim, ...buckets.urgent], "negative", "No critical or trim rules are triggered."),
    rulesCenterSection("Blocked Opportunities", "Good signal, portfolio says no", buckets.blocked, "warning", "No attractive ideas are blocked by hard rules."),
    rulesCenterSection("Needs Review", "Caution before action", buckets.review, "ai", "No medium-priority review rules are active."),
    rulesCenterSection("Buy / Add Eligible", "Allowed candidates", buckets.eligible, "live", "No buy/add candidates are currently eligible."),
    rulesCenterSection("Data Problems", "Fix confidence first", buckets.data, "warning", "No data confidence issues found."),
    rulesCenterSection("Monitor", "No immediate action", buckets.monitor, "neutral", "Nothing sitting in monitor.")
  ].join("");
}

function renderRulesV2AuditTable() {
  const tableNode = $("#rulesV2Table");
  if (!tableNode) return;
  const rows = state.rulesV2?.evaluations || [];
  tableNode.innerHTML = rows.length ? rows.map((item) => {
    const price = item.context?.price == null
      ? "n/a"
      : money(item.context.price, item.context.currency || state.dashboard?.user?.baseCurrency || "USD");
    const scoreLine = [
      `Thesis ${item.scores?.thesisConviction ?? "n/a"}`,
      `Value ${item.scores?.valuationOpportunity ?? "n/a"}`,
      `Fit ${item.scores?.portfolioFit ?? "n/a"}`,
      `Data ${item.scores?.dataConfidence ?? "n/a"}`
    ].join(" / ");
    return `
      <div class="compact-row rules-v2-row">
        <div>
          ${tickerButton(item.ticker)}
          <br><span class="muted">${escapeHtml(item.scope)} | ${escapeHtml(item.context?.groupName || item.context?.theme || "Unclassified")}</span>
        </div>
        <div>
          <span class="muted">Old</span><br>
          ${ruleV2Pill(item.oldAction, item.oldAction === item.finalAction ? "neutral" : "warning")}
        </div>
        <div>
          <span class="muted">V2 final</span><br>
          ${ruleV2Pill(item.finalAction, item.classes?.finalAction)}
        </div>
        <div>
          <span class="muted">Underlying</span><br>
          ${ruleV2Pill(item.underlyingSignal, item.classes?.valuation)}
        </div>
        <div>
          <span class="muted">Eligibility</span><br>
          ${ruleV2Pill(item.tradeEligibility, item.classes?.eligibility)}
        </div>
        <div>
          <strong>${escapeHtml(item.primaryReasonCode || "NO_REASON")}</strong>
          <br><span class="muted">${escapeHtml(item.explanation || "")}</span>
          <br><span class="muted">${escapeHtml(price)} | ${escapeHtml(scoreLine)}</span>
        </div>
        <details class="rules-v2-details">
          <summary>States</summary>
          <div>
            ${ruleV2Pill(item.dataState, item.classes?.data)}
            ${ruleV2Pill(item.valuationState, item.classes?.valuation)}
            ${ruleV2Pill(item.positionState, item.classes?.position)}
            ${ruleV2Pill(item.groupState, item.classes?.group)}
            ${ruleV2Pill(item.themeState, "neutral")}
            ${ruleV2Pill(item.liquidityState, "neutral")}
            ${ruleV2Pill(item.priority, item.classes?.priority)}
          </div>
        </details>
      </div>
    `;
  }).join("") : `<p class="muted">No rules data found yet.</p>`;
}

function renderRulesV2() {
  const statusNode = $("#rulesV2Status");
  if (!statusNode) return;
  renderRulesV2Summary();
  renderRulesV2Command();
  renderRulesV2Radar();
  renderRulesV2Queues();
  if (state.rulesV2Loading) {
    statusNode.textContent = "Building today’s V2 action board...";
    renderRulesV2AuditTable();
    return;
  }
  if (!state.rulesV2) {
    statusNode.textContent = state.rulesV2Error || "Rules V2 is active. Press Refresh Rules to load today’s action board.";
    renderRulesV2AuditTable();
    return;
  }
  const payload = state.rulesV2;
  statusNode.textContent = `${payload.version} | Rules V2 active. Review signals only; the app never places trades.`;
  renderRulesV2AuditTable();
}

async function loadRulesV2({ refresh = false } = {}) {
  state.rulesV2Loading = true;
  state.rulesV2Error = "";
  renderRulesV2();
  try {
    state.rulesV2 = await api(`/api/rules/v2/compare${refresh ? "?refresh=true" : ""}`);
  } catch (error) {
    state.rulesV2 = null;
    state.rulesV2Error = friendlyErrorMessage(error);
    throw error;
  } finally {
    state.rulesV2Loading = false;
    renderRulesV2();
  }
}

function rulesEditorTemplate(rules) {
  return JSON.stringify(rules || {}, null, 2);
}

async function openRulesEditor() {
  const errorNode = $("#rulesError");
  if (errorNode) { errorNode.hidden = true; errorNode.textContent = ""; }
  try {
    const payload = await api("/api/rules");
    const rules = payload.rules || payload.defaults || {};
    $("#rulesEditor").value = rulesEditorTemplate(rules);
    $("#rulesDialog").showModal();
  } catch (error) {
    toastError(error);
  }
}

async function saveRulesFromEditor() {
  const editor = $("#rulesEditor");
  const errorNode = $("#rulesError");
  let parsed;
  try {
    parsed = JSON.parse(editor.value);
  } catch (error) {
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = "That is not valid JSON. Check for a missing comma or quote, or press Reset to defaults and start again.";
    }
    return;
  }
  try {
    await api("/api/rules", { method: "PUT", body: JSON.stringify({ rules: parsed }) });
    $("#rulesDialog").close();
    toast("Rules saved");
    await loadDashboard();
  } catch (error) {
    if (errorNode) {
      errorNode.hidden = false;
      errorNode.textContent = error.message || "Could not save rules.";
    }
  }
}

async function resetRulesInEditor() {
  try {
    const payload = await api("/api/rules/reset", { method: "POST" });
    $("#rulesEditor").value = rulesEditorTemplate(payload.rules);
    const errorNode = $("#rulesError");
    if (errorNode) { errorNode.hidden = true; errorNode.textContent = ""; }
    toast("Rules reset to defaults");
    await loadDashboard();
  } catch (error) {
    toastError(error);
  }
}


function addPulseSuggestion(map, item, source = "preset") {
  const symbol = normalizePulseSymbol(item.symbol || item.ticker);
  if (!symbol) return;
  const displayName = String(item.displayName || item.name || item.companyName || item.company_name || symbol).trim();
  const category = MARKET_PULSE_CATEGORIES.includes(item.category) ? item.category : "Other";
  const key = symbol.toUpperCase();
  if (!map.has(key)) map.set(key, { symbol, displayName, category, source });
}

function marketPulseSuggestions() {
  const map = new Map();
  MARKET_PULSE_PRESETS.forEach((item) => addPulseSuggestion(map, item, "preset"));
  (state.localMarketPulse || []).forEach((item) => addPulseSuggestion(map, item, "local"));
  (state.dashboard?.marketPulse || []).forEach((item) => addPulseSuggestion(map, item, "server"));
  (state.dashboard?.positions || []).forEach((position) => addPulseSuggestion(map, {
    symbol: position.ticker,
    displayName: position.name || position.ticker,
    category: "Other"
  }, "portfolio"));
  (state.dashboard?.watchlist || []).forEach((item) => addPulseSuggestion(map, {
    symbol: item.ticker,
    displayName: item.name || item.companyName || item.ticker,
    category: "Other"
  }, "watchlist"));
  return [...map.values()].sort((a, b) => `${a.displayName} ${a.symbol}`.localeCompare(`${b.displayName} ${b.symbol}`));
}

function findPulseSuggestion(value) {
  const query = String(value || "").trim().toLowerCase();
  if (!query) return null;
  return marketPulseSuggestions().find((item) => (
    item.symbol.toLowerCase() === query
    || item.displayName.toLowerCase() === query
    || `${item.symbol} ${item.displayName}`.toLowerCase() === query
  )) || null;
}

function resolveMarketPulseBody(body = {}) {
  const symbolInput = String(body.symbol || "").trim();
  const nameInput = String(body.displayName || "").trim();
  const suggestion = findPulseSuggestion(symbolInput) || findPulseSuggestion(nameInput);
  const symbol = normalizePulseSymbol(suggestion?.symbol || symbolInput);
  const displayName = nameInput || suggestion?.displayName || symbol;
  const category = MARKET_PULSE_CATEGORIES.includes(body.category)
    ? body.category
    : suggestion?.category || "Other";
  return {
    symbol,
    displayName,
    category,
    sortOrder: Number(body.sortOrder) || marketPulseItems().length + 1
  };
}

function marketPulseItems() {
  const map = new Map();
  (state.localMarketPulse || []).forEach((item) => {
    const key = normalizePulseSymbol(item.symbol);
    if (!key) return;
    map.set(key, { ...item, symbol: key, source: "local" });
  });
  (state.dashboard?.marketPulse || []).forEach((item) => {
    const key = normalizePulseSymbol(item.symbol);
    if (!key) return;
    map.set(key, { ...item, symbol: key, source: "server" });
  });
  return [...map.values()].sort((a, b) => {
    const order = (Number(a.sortOrder) || 999) - (Number(b.sortOrder) || 999);
    return order || String(a.displayName).localeCompare(String(b.displayName));
  });
}

function renderMarketPulseSuggestions() {
  const list = $("#marketPulseSuggestions");
  if (!list) return;
  list.innerHTML = marketPulseSuggestions().flatMap((item) => [
    `<option value="${escapeHtml(item.symbol)}" label="${escapeHtml(item.displayName)}"></option>`,
    `<option value="${escapeHtml(item.displayName)}" label="${escapeHtml(item.symbol)}"></option>`
  ]).join("");
}

function marketPulseAutocompleteMatches(value, limit = 10) {
  const query = String(value || "").trim().toLowerCase();
  const suggestions = marketPulseSuggestions();
  const scored = suggestions
    .map((item) => {
      const symbol = item.symbol.toLowerCase();
      const name = item.displayName.toLowerCase();
      const category = item.category.toLowerCase();
      if (!query) return { item, score: 5 };
      if (symbol === query || name === query) return { item, score: 0 };
      if (symbol.startsWith(query)) return { item, score: 1 };
      if (name.startsWith(query)) return { item, score: 2 };
      if (symbol.includes(query)) return { item, score: 3 };
      if (name.includes(query) || category.includes(query)) return { item, score: 4 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || `${a.item.displayName} ${a.item.symbol}`.localeCompare(`${b.item.displayName} ${b.item.symbol}`));
  return scored.slice(0, limit).map((entry) => entry.item);
}

function hideMarketPulseAutocomplete() {
  const panel = $("#marketPulseAutocomplete");
  const input = pulseFormField($("#marketPulseForm"), "symbol");
  if (panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }
  if (input) input.setAttribute("aria-expanded", "false");
  state.marketPulseAutocompleteIndex = 0;
}

function selectMarketPulseSuggestion(item) {
  const form = $("#marketPulseForm");
  if (!form || !item) return;
  pulseFormField(form, "symbol").value = item.symbol;
  pulseFormField(form, "displayName").value = item.displayName;
  pulseFormField(form, "category").value = item.category;
  hideMarketPulseAutocomplete();
}

function renderMarketPulseAutocomplete(input) {
  const panel = $("#marketPulseAutocomplete");
  if (!panel || !input) return;
  const matches = marketPulseAutocompleteMatches(input.value);
  if (!matches.length) {
    hideMarketPulseAutocomplete();
    return;
  }
  state.marketPulseAutocompleteIndex = Math.min(state.marketPulseAutocompleteIndex, matches.length - 1);
  panel.innerHTML = matches.map((item, index) => `
    <button class="autocomplete-option ${index === state.marketPulseAutocompleteIndex ? "active" : ""}" type="button" role="option" aria-selected="${index === state.marketPulseAutocompleteIndex}" data-pulse-autocomplete-index="${index}">
      <strong>${escapeHtml(item.symbol)}</strong>
      <span>${escapeHtml(item.displayName)}</span>
      <em>${escapeHtml(item.category)}</em>
    </button>
  `).join("");
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function currentMarketPulseAutocompleteMatch(input) {
  return marketPulseAutocompleteMatches(input?.value || "")[state.marketPulseAutocompleteIndex] || null;
}

function pulseFormField(form, name) {
  return form?.elements?.namedItem(name) || form?.querySelector(`[name="${name}"]`) || null;
}

function syncMarketPulseFormFromSuggestion(form, { rewriteSymbol = false } = {}) {
  const symbolInput = pulseFormField(form, "symbol");
  const displayNameInput = pulseFormField(form, "displayName");
  const categoryInput = pulseFormField(form, "category");
  if (!symbolInput || !displayNameInput || !categoryInput) return;
  const match = findPulseSuggestion(symbolInput.value);
  if (!match) return;
  if (rewriteSymbol) symbolInput.value = match.symbol;
  displayNameInput.value = match.displayName;
  categoryInput.value = match.category;
}

function upsertLocalMarketPulse(body, existingId = "") {
  const item = resolveMarketPulseBody(body);
  if (!item.symbol || !item.displayName) throw new Error("Choose an index, ticker, FX pair, or name first");
  const nextId = existingId && String(existingId).startsWith("local_") ? existingId : localPulseId(item.symbol);
  const normalizedSymbol = normalizePulseSymbol(item.symbol);
  const nextItems = (state.localMarketPulse || [])
    .filter((current) => current.id !== nextId && normalizePulseSymbol(current.symbol) !== normalizedSymbol);
  nextItems.push({
    ...item,
    id: nextId,
    symbol: normalizedSymbol,
    source: "local",
    price: null
  });
  state.localMarketPulse = nextItems.sort((a, b) => (Number(a.sortOrder) || 999) - (Number(b.sortOrder) || 999));
  saveLocalMarketPulse(state.localMarketPulse);
  renderMarketPulseSuggestions();
  renderMarketPulse();
  renderMarketPulseSettings();
}

function deleteLocalMarketPulse(id) {
  state.localMarketPulse = (state.localMarketPulse || []).filter((item) => item.id !== id);
  saveLocalMarketPulse(state.localMarketPulse);
  renderMarketPulseSuggestions();
  renderMarketPulse();
  renderMarketPulseSettings();
}

function shouldUsePulseLocalFallback(error) {
  return /api route not found|request failed: 404|failed to fetch/i.test(error?.message || "");
}

function trackedQuoteForSymbol(symbolInput) {
  const symbol = normalizePulseSymbol(symbolInput);
  const position = (state.dashboard?.positions || []).find((item) => item.ticker === symbol);
  if (position?.price) return position.price;
  const watchlistItem = (state.dashboard?.watchlist || []).find((item) => item.ticker === symbol);
  if (watchlistItem?.price) return watchlistItem.price;
  return null;
}

function pulseQuoteForItem(item) {
  const symbol = normalizePulseSymbol(item.symbol);
  return item.price || state.marketPulseQuotes[symbol] || trackedQuoteForSymbol(symbol) || null;
}

function pulseQuoteStatus(item, quote) {
  const symbol = normalizePulseSymbol(item.symbol);
  if (state.marketPulseQuotesLoading.has(symbol)) return "LOADING";
  if (!quote) return item.source === "local" ? "PENDING" : "UNKNOWN";
  if (quote.price == null) return quote.status || "UNAVAILABLE";
  if (pulseQuoteIsStale(quote)) return "STALE";
  if (["FX", "Crypto", "Commodity"].includes(item.category)) return "24H";
  return quotePriceLabel(quote, item.symbol);
}

function pulseQuoteIsStale(quote) {
  if (!quote?.asOf) return false;
  const timestamp = new Date(quote.asOf).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const ageHours = (Date.now() - timestamp) / 36e5;
  return ageHours > 36;
}

function pulseQuoteAgeLabel(quote) {
  if (!quote?.asOf) return "--";
  const timestamp = new Date(quote.asOf).getTime();
  if (!Number.isFinite(timestamp)) return "--";
  const ageMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (ageMinutes < 2) return "just updated";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.round(ageMinutes / 60);
  if (ageHours < 48) return `${ageHours}h ago`;
  return quoteTimeLabel(quote.asOf) || "--";
}

function pulseDecimals(item, quote) {
  const category = item.category;
  if (category === "FX") return String(item.symbol || "").includes("JPY") ? 3 : 4;
  if (category === "Rate") return 2;
  if (category === "Crypto") return Number(quote?.price) >= 1000 ? 2 : 4;
  return 2;
}

function pulsePriceText(item, quote) {
  if (quote?.price == null || !Number.isFinite(Number(quote.price))) return "--";
  const digits = pulseDecimals(item, quote);
  if (item.category === "FX") return number(quote.price, digits);
  if (item.category === "Rate") return `${number(quote.price, digits)}%`;
  if (["Index", "Commodity"].includes(item.category)) return number(quote.price, digits);
  return money(quote.price, quote.currency || "USD");
}

function pulseChangeText(item, quote) {
  if (quote?.changeAmount == null && quote?.changePercent == null) return "--";
  const digits = pulseDecimals(item, quote);
  const amount = quote?.changeAmount == null || !Number.isFinite(Number(quote.changeAmount))
    ? "--"
    : `${Number(quote.changeAmount) > 0 ? "+" : ""}${number(Number(quote.changeAmount), digits)}`;
  return `${amount} / ${nullableSignedPercent(quote.changePercent)}`;
}

function quoteFromPerformance(symbol, payload = {}) {
  const points = (payload.points || []).filter((point) => Number.isFinite(Number(point.value)));
  const latest = points[points.length - 1];
  if (!latest) return null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const previousClose = previous?.value ?? payload.startValue ?? null;
  const changeAmount = previousClose == null ? null : latest.value - previousClose;
  return {
    ticker: symbol,
    price: latest.value,
    currency: payload.currency || state.dashboard?.user?.baseCurrency || "USD",
    previousClose,
    changeAmount,
    changePercent: previousClose ? ((changeAmount / previousClose) * 100) : null,
    provider: payload.provider || "yahoo_history",
    status: "LIVE",
    asOf: latest.time || new Date().toISOString(),
    error: null
  };
}

async function fetchPulseHistoryQuote(symbol) {
  const payload = await api(`/api/performance/ticker/${encodeURIComponent(symbol)}?range=1d`);
  return quoteFromPerformance(symbol, payload);
}

async function fetchPulseQuote(symbol, { force = false } = {}) {
  const encoded = encodeURIComponent(symbol);
  const refreshParam = force ? "true" : "false";
  try {
    const payload = await api(`/api/quotes/${encoded}?refresh=${refreshParam}`);
    const quote = payload.quote || payload;
    if (quote?.price != null) return quote;
    return await fetchPulseHistoryQuote(symbol) || quote;
  } catch (error) {
    if (!shouldUsePulseLocalFallback(error)) throw error;
    return await fetchPulseHistoryQuote(symbol);
  }
}

async function loadMarketPulseQuotes({ force = false } = {}) {
  const symbols = [...new Set(marketPulseItems()
    .map((item) => normalizePulseSymbol(item.symbol))
    .filter(Boolean))]
    .filter((symbol) => (
      force
      || (!Object.hasOwn(state.marketPulseQuotes, symbol) && !trackedQuoteForSymbol(symbol) && !state.marketPulseQuotesLoading.has(symbol))
    ));
  if (!symbols.length) return;
  symbols.forEach((symbol) => state.marketPulseQuotesLoading.add(symbol));
  renderMarketPulse();
  const concurrency = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor];
      cursor += 1;
      try {
        state.marketPulseQuotes[symbol] = await fetchPulseQuote(symbol, { force });
      } catch (error) {
        state.marketPulseQuotes[symbol] = {
          ticker: symbol,
          price: null,
          currency: state.dashboard?.user?.baseCurrency || "USD",
          provider: "none",
          status: "UNAVAILABLE",
          asOf: new Date().toISOString(),
          error: error.message
        };
      } finally {
        state.marketPulseQuotesLoading.delete(symbol);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()));
  renderMarketPulse();
}

function renderMarketPulse() {
  const pulse = marketPulseItems();
  const grid = $("#marketPulseGrid");
  if (!grid) return;
  grid.innerHTML = pulse.length ? pulse.map((item) => {
    const quote = pulseQuoteForItem(item) || {};
    const status = pulseQuoteStatus(item, quote);
    const statusClass = statusClassForMarket(status);
    return `
      <article class="market-pulse-tile">
        <div>
          <strong>${escapeHtml(item.displayName)}</strong>
          <span>${escapeHtml(item.symbol)} | ${escapeHtml(item.category)}</span>
        </div>
        <div class="market-pulse-price">
          <strong>${escapeHtml(pulsePriceText(item, quote))}</strong>
          <span class="${valueClass(quote.changeAmount ?? quote.changePercent ?? 0)}">${escapeHtml(pulseChangeText(item, quote))}</span>
        </div>
        <div class="market-pulse-footer">
          <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
          <span>${escapeHtml(pulseQuoteAgeLabel(quote))}</span>
          <span>${escapeHtml(quote.provider || (status === "LOADING" ? "loading price" : "provider pending"))}</span>
        </div>
      </article>
    `;
  }).join("") : `<p class="muted">No Market Pulse instruments saved.</p>`;
  loadMarketPulseQuotes().catch(() => undefined);
}

function paletteOptions(selectedColor = "#C9A86A") {
  return CHART_COLORS.slice(0, 9).map((color) => `
    <option value="${color}" ${color.toUpperCase() === String(selectedColor).toUpperCase() ? "selected" : ""}>${color}</option>
  `).join("");
}

function categoryUsageStats() {
  const stats = new Map();
  const ensure = (categoryId) => {
    const existing = stats.get(categoryId) || {
      holdingsCount: 0,
      watchlistCount: 0,
      valueBase: 0,
      tickers: []
    };
    stats.set(categoryId, existing);
    return existing;
  };
  for (const position of state.dashboard?.positions || []) {
    if (!position.categoryId || position.closed || (Number(position.currentValueBase) || 0) <= 0) continue;
    const row = ensure(position.categoryId);
    row.holdingsCount += 1;
    row.valueBase += Number(position.currentValueBase) || 0;
    row.tickers.push(position.ticker);
  }
  for (const item of state.dashboard?.watchlist || []) {
    if (!item.categoryId) continue;
    ensure(item.categoryId).watchlistCount += 1;
  }
  return stats;
}

function renderGroupSettings() {
  const table = $("#groupSettingsTable");
  if (!table) return;
  const groups = state.categories || [];
  const totalTarget = groups
    .filter(isActiveGroup)
    .reduce((total, group) => total + (Number(group.targetPercent) || 0), 0);
  const warning = $("#groupTargetWarning");
  if (warning) {
    warning.textContent = Math.abs(totalTarget - 100) <= 0.01
      ? "Targets total 100%."
      : `Targets total ${number(totalTarget)}%. Save is allowed, but review allocation math.`;
    warning.className = Math.abs(totalTarget - 100) <= 0.01 ? "muted positive" : "muted warning-text";
  }
  const stats = categoryUsageStats();
  table.innerHTML = groups.length ? `
    <div class="group-summary-list">
      ${groups.map((group) => {
        const stat = stats.get(group.id) || { holdingsCount: 0, watchlistCount: 0, valueBase: 0, tickers: [] };
        const active = isActiveGroup(group);
        return `
          <div class="group-summary-row ${active ? "" : "inactive"}">
            <span class="swatch" style="background:${escapeHtml(group.color || "#C9A86A")}"></span>
            <div>
              <strong>${escapeHtml(group.name)}</strong>
              <span>${stat.holdingsCount} holdings, ${stat.watchlistCount} watchlist</span>
            </div>
            <div class="group-summary-metric">
              <span>Target</span>
              <strong>${percent(Number(group.targetPercent) || 0)}</strong>
            </div>
            <div class="group-summary-metric">
              <span>Current</span>
              <strong>${percent(Number(group.actualPercent) || 0)}</strong>
            </div>
            <div class="group-summary-metric">
              <span>Value</span>
              <strong>${money(stat.valueBase || group.subtotalBase || 0, state.dashboard?.user?.baseCurrency || "USD")}</strong>
            </div>
            <span class="status-pill ${active ? "live" : "unknown"}">${active ? "Active" : "Inactive"}</span>
          </div>
        `;
      }).join("")}
    </div>
  ` : `<p class="muted">No groups saved.</p>`;
}

function groupEditorColours() {
  return [
    "#C9A86A",
    "#8B7CFF",
    "#00C27A",
    "#FFB547",
    "#FF5A67",
    "#5B8DEF",
    "#3FA7D6",
    "#28C7A0",
    "#B8BDC7",
    "#7D8592",
    "#D6D3CC",
    "#A78BFA"
  ];
}

function normalizeGroupDraft(group = {}, index = 0) {
  return {
    id: String(group.id || `draft_${Date.now().toString(36)}_${index}`),
    name: String(group.name || "").trim(),
    targetPercent: Number(group.targetPercent) || 0,
    sortOrder: Number(group.sortOrder) || index + 1,
    color: /^#[0-9a-f]{6}$/i.test(String(group.color || "")) ? String(group.color).toUpperCase() : "#C9A86A",
    active: isActiveGroup(group),
    actualPercent: Number(group.actualPercent) || 0,
    subtotalBase: Number(group.subtotalBase) || 0,
    variancePercent: Number(group.variancePercent) || 0,
    missingOrExcessBase: Number(group.missingOrExcessBase) || 0,
    equityCount: Number(group.equityCount) || 0,
    watchlistCount: Number(group.watchlistCount) || 0,
    pendingDelete: false,
    moveToCategoryId: ""
  };
}

function startGroupEditor() {
  const groups = state.categories || [];
  if (!groups.length) {
    toast("Groups are still loading. Try again in a moment.");
    return false;
  }
  state.groupEditor = {
    drafts: groups.map(normalizeGroupDraft),
    deleted: [],
    draggedId: "",
    saving: false,
    error: ""
  };
  renumberGroupDrafts();
  renderGroupManager();
  return true;
}

function groupEditor() {
  if (!state.groupEditor) startGroupEditor();
  return state.groupEditor;
}

async function waitForDashboardReady() {
  const startedAt = Date.now();
  while (state.dashboardLoading && Date.now() - startedAt < 6000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function renumberGroupDrafts() {
  const editor = state.groupEditor;
  if (!editor) return;
  editor.drafts.forEach((group, index) => {
    group.sortOrder = index + 1;
  });
}

function updateGroupManagerSummary() {
  const editor = state.groupEditor;
  const summary = $("#groupManagerSummary");
  if (!editor || !summary) return;
  const activeGroups = editor.drafts.filter((group) => !group.pendingDelete && group.active);
  const totalTarget = activeGroups.reduce((total, group) => total + (Number(group.targetPercent) || 0), 0);
  summary.textContent = Math.abs(totalTarget - 100) <= 0.01
    ? `Targets total 100%. ${activeGroups.length} active groups.`
    : `Targets total ${number(totalTarget)}%. Saving is allowed, but review the allocation.`;
  summary.className = Math.abs(totalTarget - 100) <= 0.01 ? "muted positive" : "muted warning-text";
}

function updateGroupDraft(groupId, field, value) {
  const editor = groupEditor();
  const group = editor.drafts.find((item) => item.id === groupId);
  if (!group) return;
  if (field === "active") group.active = Boolean(value);
  else if (field === "targetPercent") group.targetPercent = value === "" ? "" : Number(value);
  else if (field === "sortOrder") group.sortOrder = value === "" ? "" : Number(value);
  else if (field === "moveToCategoryId") group.moveToCategoryId = String(value || "");
  else if (field === "color") group.color = String(value || "#C9A86A").toUpperCase();
  else group[field] = String(value || "");
  editor.error = "";
}

function sortedDraftsByOrder() {
  const editor = groupEditor();
  editor.drafts.sort((a, b) => (Number(a.sortOrder) || 999) - (Number(b.sortOrder) || 999) || String(a.name).localeCompare(String(b.name)));
  renumberGroupDrafts();
}

function moveGroupDraft(groupId, direction) {
  const editor = groupEditor();
  const index = editor.drafts.findIndex((group) => group.id === groupId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= editor.drafts.length) return;
  [editor.drafts[index], editor.drafts[nextIndex]] = [editor.drafts[nextIndex], editor.drafts[index]];
  renumberGroupDrafts();
  renderGroupManager();
}

function moveGroupDraftBefore(draggedId, targetId) {
  const editor = groupEditor();
  if (!draggedId || !targetId || draggedId === targetId) return;
  const fromIndex = editor.drafts.findIndex((group) => group.id === draggedId);
  const toIndex = editor.drafts.findIndex((group) => group.id === targetId);
  if (fromIndex < 0 || toIndex < 0) return;
  const [item] = editor.drafts.splice(fromIndex, 1);
  editor.drafts.splice(toIndex, 0, item);
  renumberGroupDrafts();
  renderGroupManager();
}

function addGroupDraft() {
  const editor = groupEditor();
  const names = new Set(editor.drafts.map((group) => String(group.name || "").trim().toLowerCase()));
  let name = "New Group";
  let index = 2;
  while (names.has(name.toLowerCase())) {
    name = `New Group ${index}`;
    index += 1;
  }
  const colours = groupEditorColours();
  editor.drafts.push({
    id: `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    targetPercent: 0,
    sortOrder: editor.drafts.length + 1,
    color: colours[editor.drafts.length % colours.length],
    active: true,
    equityCount: 0,
    watchlistCount: 0,
    pendingDelete: false,
    moveToCategoryId: ""
  });
  editor.error = "";
  renderGroupManager();
}

function removeGroupDraft(groupId) {
  const editor = groupEditor();
  const group = editor.drafts.find((item) => item.id === groupId);
  if (!group) return;
  const isCash = group.id === "cat_cash" || group.name.toLowerCase() === "cash";
  if (isCash) {
    toast("Cash is protected. Rename it or set target to 0 instead.");
    return;
  }
  if (group.id.startsWith("draft_")) {
    editor.drafts = editor.drafts.filter((item) => item.id !== groupId);
    renumberGroupDrafts();
    renderGroupManager();
    return;
  }
  const stats = categoryUsageStats().get(group.id) || { holdingsCount: 0, watchlistCount: 0, valueBase: 0, tickers: [] };
  const assignedCount = stats.holdingsCount + stats.watchlistCount;
  if (assignedCount > 0) {
    group.pendingDelete = true;
    group.moveToCategoryId = "";
    editor.error = "";
    toast("Choose where to move assigned holdings, then Save Changes");
    renderGroupManager();
    return;
  }
  if (!window.confirm(`Delete empty group "${group.name}"?`)) return;
  editor.deleted.push({ id: group.id, moveToCategoryId: "" });
  editor.drafts = editor.drafts.filter((item) => item.id !== groupId);
  renumberGroupDrafts();
  renderGroupManager();
}

function undoGroupDelete(groupId) {
  const editor = groupEditor();
  const group = editor.drafts.find((item) => item.id === groupId);
  if (!group) return;
  group.pendingDelete = false;
  group.moveToCategoryId = "";
  editor.error = "";
  renderGroupManager();
}

function validateGroupDraftsForSave() {
  const editor = groupEditor();
  const finalGroups = editor.drafts.filter((group) => !group.pendingDelete);
  if (!finalGroups.length) throw new Error("At least one group must remain");
  const names = new Map();
  for (const group of finalGroups) {
    const name = String(group.name || "").trim();
    if (!name) throw new Error("Group name cannot be empty");
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("Group names must be unique");
    names.set(key, group.id);
    const target = Number(group.targetPercent);
    if (!Number.isFinite(target)) throw new Error(`Target allocation for ${name} must be a number`);
    if (target < 0 || target > 100) throw new Error(`Target allocation for ${name} must be between 0 and 100`);
    if (!/^#[0-9a-f]{6}$/i.test(String(group.color || ""))) throw new Error(`Choose a valid colour for ${name}`);
  }
  for (const group of editor.drafts.filter((item) => item.pendingDelete)) {
    const stats = categoryUsageStats().get(group.id) || { holdingsCount: 0, watchlistCount: 0 };
    const assignedCount = stats.holdingsCount + stats.watchlistCount;
    if (assignedCount > 0 && !group.moveToCategoryId) {
      throw new Error(`Choose where to move holdings from ${group.name} before deleting it`);
    }
    if (group.moveToCategoryId === group.id) throw new Error("Destination group must be different");
    const destination = finalGroups.find((item) => item.id === group.moveToCategoryId);
    if (assignedCount > 0 && !destination) throw new Error(`Choose a valid destination group for ${group.name}`);
  }
}

function groupSavePayload() {
  const editor = groupEditor();
  const groups = editor.drafts
    .filter((group) => !group.pendingDelete)
    .map((group, index) => ({
      id: group.id,
      name: String(group.name || "").trim(),
      targetPercent: Number(group.targetPercent),
      color: group.color,
      sortOrder: index + 1,
      active: Boolean(group.active)
    }));
  const deleted = [
    ...editor.deleted,
    ...editor.drafts
      .filter((group) => group.pendingDelete)
      .map((group) => ({ id: group.id, moveToCategoryId: group.moveToCategoryId || "" }))
  ];
  return { groups, deleted };
}

async function saveCategoryBatch(payload) {
  try {
    return await api("/api/categories", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error.status !== 404 || !/api route not found/i.test(error.message || "")) throw error;
    const idMap = new Map();
    for (const group of payload.groups.filter((item) => String(item.id).startsWith("draft_"))) {
      const created = await api("/api/categories", {
        method: "POST",
        body: JSON.stringify(group)
      });
      idMap.set(group.id, created.id);
    }
    for (const group of payload.groups.filter((item) => !String(item.id).startsWith("draft_"))) {
      await api(`/api/categories/${encodeURIComponent(group.id)}`, {
        method: "PATCH",
        body: JSON.stringify(group)
      });
    }
    for (const row of payload.deleted) {
      await api(`/api/categories/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ moveToCategoryId: idMap.get(row.moveToCategoryId) || row.moveToCategoryId || "" })
      });
    }
    return { ok: true };
  }
}

async function saveGroupChanges() {
  const editor = groupEditor();
  sortedDraftsByOrder();
  validateGroupDraftsForSave();
  const pendingDeletes = editor.drafts.filter((group) => group.pendingDelete);
  if (pendingDeletes.length) {
    const confirmed = window.confirm(`Save changes and delete ${pendingDeletes.length} group${pendingDeletes.length === 1 ? "" : "s"}? Assigned holdings will be moved to the selected group.`);
    if (!confirmed) return;
  }
  const payload = groupSavePayload();
  editor.saving = true;
  editor.error = "";
  renderGroupManager();
  try {
    const result = await saveCategoryBatch(payload);
    if (result.categories) state.categories = mergeCategories(result.categories, state.dashboard?.allocation || []);
    state.groupEditor = null;
    await loadDashboard();
    toast("Group changes saved");
    $("#groupManagerDialog")?.close();
  } catch (error) {
    editor.saving = false;
    editor.error = error.message || "Group changes could not be saved";
    renderGroupManager();
    throw error;
  }
}

function groupEditorRowsHtml() {
  const editor = groupEditor();
  const stats = categoryUsageStats();
  const destinationGroups = editor.drafts.filter((group) => !group.pendingDelete);
  return editor.drafts.map((group, index) => {
    const stat = stats.get(group.id) || { holdingsCount: 0, watchlistCount: 0, valueBase: 0, tickers: [] };
    const isCash = group.id === "cat_cash" || String(group.name).toLowerCase() === "cash";
    const assignedCount = stat.holdingsCount + stat.watchlistCount;
    const moveOptions = destinationGroups
      .filter((item) => item.id !== group.id)
      .map((item) => `<option value="${item.id}" ${item.id === group.moveToCategoryId ? "selected" : ""}>${escapeHtml(item.name)}</option>`)
      .join("");
    const palette = groupEditorColours().map((color) => `
      <button
        class="colour-swatch ${color.toUpperCase() === String(group.color).toUpperCase() ? "selected" : ""}"
        data-group-color-choice="${group.id}"
        data-group-color="${color}"
        style="background:${color}"
        type="button"
        aria-label="Choose ${color}"
      ></button>
    `).join("");
    return `
      <div class="group-editor-row ${group.pendingDelete ? "pending-delete" : ""}" data-group-draft-row="${group.id}" draggable="${group.pendingDelete ? "false" : "true"}">
        <div class="drag-cell">
          <span class="drag-handle" title="Drag to reorder">::</span>
          <button class="icon-button" data-action="moveGroupDraft" data-group-draft-id="${group.id}" data-move-direction="-1" type="button" aria-label="Move up">↑</button>
          <button class="icon-button" data-action="moveGroupDraft" data-group-draft-id="${group.id}" data-move-direction="1" type="button" aria-label="Move down">↓</button>
        </div>
        <label class="field compact">
          <span>Order</span>
          <input data-group-draft-id="${group.id}" data-group-draft-field="sortOrder" type="number" min="1" step="1" value="${Number(group.sortOrder) || index + 1}" aria-label="Group order">
        </label>
        <div class="group-color-cell" style="--group-preview:${escapeHtml(group.color || "#C9A86A")}">
          <span class="swatch" style="background:${escapeHtml(group.color || "#C9A86A")}"></span>
          <div class="colour-palette">${palette}</div>
        </div>
        <label class="field compact group-name-field">
          <span>Name</span>
          <input data-group-draft-id="${group.id}" data-group-draft-field="name" value="${escapeHtml(group.name)}" aria-label="Group name" ${group.pendingDelete ? "disabled" : ""}>
        </label>
        <label class="field compact">
          <span>Target %</span>
          <input data-group-draft-id="${group.id}" data-group-draft-field="targetPercent" type="number" min="0" max="100" step="0.5" value="${group.targetPercent}" aria-label="Target percent" ${group.pendingDelete ? "disabled" : ""}>
        </label>
        <div class="group-stat-cell">
          <strong>${stat.holdingsCount}</strong>
          <span>${stat.tickers.slice(0, 4).join(", ")}${stat.tickers.length > 4 ? "..." : ""}</span>
        </div>
        <div class="group-stat-cell">
          <strong>${percent(group.actualPercent || 0)}</strong>
          <span>${money(stat.valueBase || group.subtotalBase || 0, state.dashboard.user.baseCurrency)}</span>
        </div>
        <label class="switch-line">
          <input data-group-draft-id="${group.id}" data-group-draft-field="active" type="checkbox" ${group.active ? "checked" : ""} ${group.pendingDelete ? "disabled" : ""}>
          <span>${group.active ? "Active" : "Inactive"}</span>
        </label>
        ${group.pendingDelete ? `
          <div class="delete-transfer-panel">
            <strong>Marked for deletion</strong>
            ${assignedCount ? `
              <select data-group-draft-id="${group.id}" data-group-draft-field="moveToCategoryId" aria-label="Move assigned holdings before delete">
                <option value="">Move holdings to...</option>
                ${moveOptions}
              </select>
            ` : `<span>Empty group</span>`}
            <button class="button secondary" data-action="undoGroupDelete" data-group-draft-id="${group.id}" type="button">Undo</button>
          </div>
        ` : `
          <div class="button-row">
            <button class="button danger" data-action="deleteGroupDraft" data-group-draft-id="${group.id}" type="button" ${isCash ? "disabled title=\"Cash is protected\"" : ""}>Delete</button>
          </div>
        `}
      </div>
    `;
  }).join("");
}

function renderGroupManager() {
  const rows = $("#groupManagerRows");
  if (!rows || !state.dashboard || !state.groupEditor) return;
  rows.innerHTML = groupEditorRowsHtml();
  updateGroupManagerSummary();
  const colourWarning = $("#groupColourWarning");
  if (colourWarning) {
    const colours = new Map();
    for (const group of state.groupEditor.drafts.filter((item) => !item.pendingDelete)) {
      const color = String(group.color || "").toUpperCase();
      if (!color) continue;
      colours.set(color, (colours.get(color) || 0) + 1);
    }
    const duplicates = [...colours.entries()].filter(([, count]) => count > 1).map(([color]) => color);
    colourWarning.textContent = duplicates.length ? `Similar colours: ${duplicates.join(", ")}` : "";
  }
  const error = $("#groupManagerError");
  if (error) {
    error.textContent = state.groupEditor.error || "";
    error.hidden = !state.groupEditor.error;
  }
  const saveButton = $("#saveGroupChangesButton");
  if (saveButton) saveButton.disabled = Boolean(state.groupEditor.saving);
}

async function openGroupManager() {
  await waitForDashboardReady();
  if (!state.dashboard || !(state.categories || []).length) {
    await loadDashboard().catch((error) => {
      throw new Error(`Could not load groups: ${error.message}`);
    });
  }
  await waitForDashboardReady();
  if (!(state.categories || []).length) {
    throw new Error("Groups are still loading. Please wait a moment and open Group Manager again.");
  }
  if (!startGroupEditor()) return;
  $("#groupManagerDialog")?.showModal();
}

function renderMarketPulseSettings() {
  const table = $("#marketPulseSettingsTable");
  if (!table) return;
  const pulse = marketPulseItems();
  table.innerHTML = pulse.length ? pulse.map((item) => `
    <div class="market-pulse-editor-row" data-pulse-row="${item.id}">
      <input data-pulse-symbol="${item.id}" list="marketPulseSuggestions" value="${escapeHtml(item.symbol)}" aria-label="Symbol">
      <input data-pulse-name="${item.id}" value="${escapeHtml(item.displayName)}" aria-label="Display name">
      <select data-pulse-category="${item.id}" aria-label="Category">
        ${MARKET_PULSE_CATEGORIES.map((category) => `
          <option value="${category}" ${category === item.category ? "selected" : ""}>${category}</option>
        `).join("")}
      </select>
      <input data-pulse-order="${item.id}" type="number" step="1" value="${item.sortOrder}" aria-label="Sort order">
      <div class="button-row">
        <button class="button secondary" data-save-pulse="${item.id}" type="button">Save</button>
        <button class="button danger" data-delete-pulse="${item.id}" type="button">Delete</button>
      </div>
    </div>
  `).join("") : `<p class="muted">No Market Pulse instruments saved.</p>`;
}

function renderAllocation() {
  const { allocation, user, summary } = state.dashboard;
  const card = $("#allocationCard");
  if (card) {
    card.classList.toggle("collapsed", state.allocationCollapsed);
    const button = card.querySelector('[data-action="toggleAllocation"]');
    if (button) button.textContent = state.allocationCollapsed ? "Show" : "Hide";
  }
  $("#allocationTotal").textContent = money(summary.totalValueBase, user.baseCurrency);
  const cashRow = allocation.find((row) => row.name === "Cash");
  const mostOver = [...allocation].sort((a, b) => (a.missingOrExcessBase || 0) - (b.missingOrExcessBase || 0))[0];
  const mostUnder = [...allocation].sort((a, b) => (b.missingOrExcessBase || 0) - (a.missingOrExcessBase || 0))[0];
  const pressure = mostOver?.missingOrExcessBase < 0
    ? `Over ${mostOver.name} ${signedMoney(mostOver.missingOrExcessBase, user.baseCurrency)}`
    : mostUnder?.missingOrExcessBase > 0
      ? `Under ${mostUnder.name} ${signedMoney(mostUnder.missingOrExcessBase, user.baseCurrency)}`
      : "On target";
  $("#allocationSummary").innerHTML = `
    <span>Total ${money(summary.totalValueBase, user.baseCurrency)}</span>
    <span>Cash ${percent(cashRow?.actualPercent || 0)}</span>
    <span>${escapeHtml(pressure)}</span>
  `;
  $("#allocationTable").innerHTML = allocation.map((row) => {
    const width = Math.min(100, Math.max(0, row.actualPercent || 0));
    const statusClass = row.missingOrExcessBase > 0 ? "missing" : row.missingOrExcessBase < 0 ? "excess" : "";
    return `
      <div class="allocation-row" data-category-id="${row.id}">
        <div>
          <strong>${row.name}</strong>
          <div class="bar-track"><div class="bar-fill ${cssSegment(row.name)}" style="width:${width}%;background:${escapeHtml(row.color || "#C9A86A")}"></div></div>
        </div>
        <input class="target-input" data-category-target="${row.id}" type="number" min="0" max="100" step="0.5" value="${row.targetPercent}" disabled>
        <span class="num">${percent(row.actualPercent)}</span>
        <span class="num hide-sm">${money(row.subtotalBase, user.baseCurrency)}</span>
        <span class="num hide-sm ${statusClass}">${signedMoney(row.missingOrExcessBase, user.baseCurrency)}</span>
        <span class="num hide-sm ${statusClass}">${signedPercent(row.variancePercent)}</span>
      </div>
    `;
  }).join("");
}

function categorySelect(selectedId, attrs = "") {
  return `
    <select ${attrs}>
      ${state.categories.filter((category) => isActiveGroup(category) && category.name !== "Cash").map((category) => `
        <option value="${category.id}" ${category.id === selectedId ? "selected" : ""}>${category.name}</option>
      `).join("")}
    </select>
  `;
}

function categoryOptions(selectedId = "") {
  return state.categories.filter((category) => isActiveGroup(category) && category.name !== "Cash").map((category) => `
    <option value="${category.id}" ${category.id === selectedId ? "selected" : ""}>${category.name}</option>
  `).join("");
}

function marketCurrencyOptions(selectedCurrency = "") {
  const selected = String(selectedCurrency || state.dashboard?.user?.baseCurrency || "USD").toUpperCase();
  return MARKET_CURRENCIES.map((currency) => `
    <option value="${currency}" ${currency === selected ? "selected" : ""}>${currency}</option>
  `).join("");
}

function categoryNameFor(position) {
  return position.categoryName
    || state.categories.find((category) => category.id === position.categoryId)?.name
    || "Ungrouped";
}

function categoryOrderFor(position) {
  const index = state.categories.findIndex((category) => category.id === position.categoryId);
  return index < 0 ? 999 : index;
}

function positionExposure(position) {
  const total = state.dashboard.summary.totalValueBase || 0;
  return total && position.currentValueBase ? (position.currentValueBase / total) * 100 : 0;
}

function sortPositions(positions) {
  const sorted = [...positions];
  const compareTicker = (a, b) => a.ticker.localeCompare(b.ticker);
  sorted.sort((a, b) => {
    if (state.holdingsGroup === "category") {
      const orderDelta = categoryOrderFor(a) - categoryOrderFor(b);
      if (orderDelta !== 0) return orderDelta;
    }
    if (state.holdingsSort === "exposureDesc") {
      return (b.currentValueBase || 0) - (a.currentValueBase || 0) || compareTicker(a, b);
    }
    if (state.holdingsSort === "exposureAsc") {
      return (a.currentValueBase || 0) - (b.currentValueBase || 0) || compareTicker(a, b);
    }
    if (state.holdingsSort === "unrealizedDesc") {
      return (b.unrealizedBase || 0) - (a.unrealizedBase || 0) || compareTicker(a, b);
    }
    if (state.holdingsSort === "realizedDesc") {
      return (b.realizedBase || 0) - (a.realizedBase || 0) || compareTicker(a, b);
    }
    if (state.holdingsSort === "dayChangeDesc") {
      return (b.price?.changePercent || -Infinity) - (a.price?.changePercent || -Infinity) || compareTicker(a, b);
    }
    if (state.holdingsSort === "marketCapDesc") {
      return (b.price?.marketCap || b.fundamentals?.marketCap || 0) - (a.price?.marketCap || a.fundamentals?.marketCap || 0) || compareTicker(a, b);
    }
    if (state.holdingsSort === "volumeDesc") {
      return (b.price?.volume || 0) - (a.price?.volume || 0) || compareTicker(a, b);
    }
    return compareTicker(a, b);
  });
  return sorted;
}

function groupedPositions(positions) {
  if (state.holdingsGroup !== "category") return [{ name: "", positions }];
  const groups = [];
  for (const position of positions) {
    const name = categoryNameFor(position);
    let group = groups.find((item) => item.name === name);
    if (!group) {
      group = { name, positions: [] };
      groups.push(group);
    }
    group.positions.push(position);
  }
  return groups;
}

function renderGroupHeader(group, user, colSpan = 10) {
  if (!group.name) return "";
  const value = group.positions.reduce((total, position) => total + (position.currentValueBase || 0), 0);
  const unrealized = group.positions.reduce((total, position) => total + (position.unrealizedBase || 0), 0);
  const realized = group.positions.reduce((total, position) => total + (position.realizedBase || 0), 0);
  const total = state.dashboard.summary.totalValueBase || 0;
  const exposure = total ? (value / total) * 100 : 0;
  return `
    <tr class="group-row">
      <td colspan="${colSpan}">
        <div class="group-summary">
          <strong>${group.name}</strong>
          <span>${group.positions.length} positions</span>
          <span>${money(value, user.baseCurrency)}</span>
          <span>${percent(exposure)} exposure</span>
          <span class="${unrealized > 0 ? "positive" : unrealized < 0 ? "negative" : ""}">${signedMoney(unrealized, user.baseCurrency)} unrealized</span>
          <span class="${realized > 0 ? "positive" : realized < 0 ? "negative" : ""}">${signedMoney(realized, user.baseCurrency)} realized</span>
        </div>
      </td>
    </tr>
  `;
}

function renderPositionRows(position, user) {
  const gainClass = position.unrealizedBase > 0 ? "positive" : position.unrealizedBase < 0 ? "negative" : "";
  const marketStatus = quotePriceLabel(position.price, position.ticker);
  const priceStatus = statusClassForMarket(marketStatus);
  const moveClass = state.priceMoves.get(position.ticker) ? `price-flash-${state.priceMoves.get(position.ticker)}` : "";
  const expanded = state.expandedLots.has(position.ticker);
  const exposure = positionExposure(position);
  const priceValue = priceCellHtml(position.price, position.ticker, moveClass);
  const statusText = position.closed ? "Closed" : position.equityStatus === "CLOSED" ? "Closed" : "";
  const lots = position.lots.map((lot) => {
    const soldQuantity = lot.soldQuantity ?? Math.max(0, (Number(lot.originalQuantity) || 0) - (Number(lot.quantity) || 0));
    const saleHistory = (lot.sales || []).map((sale) => `
      <div class="lot-event sale">
        <strong>Sold ${escapeHtml(sale.soldAt || "")}</strong>
        <span>${number(sale.quantity, 4)} shares @ ${money(sale.salePrice, sale.saleCurrency)}</span>
        <span>${money(sale.proceedsBase, user.baseCurrency)} proceeds</span>
        <span class="${sale.gainLossBase > 0 ? "positive" : sale.gainLossBase < 0 ? "negative" : ""}">
          ${signedMoney(sale.gainLossBase, user.baseCurrency)} (${signedPercent(sale.gainLossPercent)})
        </span>
      </div>
    `).join("");
    return `
      <div class="lot-line">
        <div class="lot-main">
          <strong>${escapeHtml(lot.purchaseDate || "")}</strong>
          <span>Bought ${number(lot.originalQuantity, 4)} @ ${money(lot.purchasePrice, lot.purchaseCurrency)}</span>
          <span>${number(lot.quantity, 4)} open${soldQuantity ? ` · ${number(soldQuantity, 4)} sold` : ""}</span>
        </div>
        <div class="lot-metric">
          <span>Open basis</span>
          <strong>${money(lot.costBasisBase, user.baseCurrency)}</strong>
        </div>
        <div class="lot-metric">
          <span>Unrealized</span>
          <strong class="${lot.unrealizedBase > 0 ? "positive" : lot.unrealizedBase < 0 ? "negative" : ""}">
            ${signedMoney(lot.unrealizedBase, user.baseCurrency)} (${signedPercent(lot.unrealizedPercent)})
          </strong>
        </div>
        <div class="lot-actions">
          ${lot.quantity > 0 ? `<button class="button" data-open-sale="${position.ticker}" data-lot-id="${lot.id}" data-quantity="${lot.quantity}" data-price="${position.price?.price || ""}" data-currency="${position.price?.currency || lot.purchaseCurrency || user.baseCurrency}" type="button">Sell</button>` : ""}
          <button class="button" data-open-alert="${position.ticker}" data-scope="LOT" data-lot-id="${lot.id}" type="button">Alert</button>
        </div>
        <div class="lot-events">
          <div class="lot-event buy">
            <strong>Buy</strong>
            <span>${number(lot.originalQuantity, 4)} shares</span>
            <span>${money(lot.purchasePrice, lot.purchaseCurrency)}</span>
            <span>${escapeHtml(lot.purchaseDate || "")}</span>
          </div>
          ${saleHistory || `<div class="lot-event muted"><strong>No sales yet</strong><span>This lot is still fully open.</span></div>`}
        </div>
      </div>
    `;
  }).join("");
  return `
    <tr class="${position.closed ? "closed-position" : ""}">
      <td>${tickerButton(position.ticker)}<br><span class="muted">${statusText || position.name || ""}</span></td>
      <td>
        ${categorySelect(position.categoryId, `data-equity-category="${position.ticker}"`)}
        ${position.closed ? `<br><span class="status-pill warning">CLOSED</span>` : ""}
      </td>
      <td class="num">${number(position.quantity, 4)}</td>
      <td class="num">${position.lotCount}</td>
      <td class="num">${money(position.averagePurchasePriceBase, user.baseCurrency)}</td>
      <td class="num">${priceValue}</td>
      <td class="num">${money(position.currentValueBase, user.baseCurrency)}<br><span class="muted">${percent(exposure)} exposure</span></td>
      <td class="num ${gainClass}">${signedMoney(position.unrealizedBase, user.baseCurrency)}<br><span>${signedPercent(position.unrealizedPercent)}</span></td>
      <td class="num">
        <span class="${valueClass(position.realizedBase || 0)}">${signedMoney(position.realizedBase, user.baseCurrency)}</span>
        <br><span class="muted">Div ${money(position.dividendIncomeBase || 0, user.baseCurrency)}</span>
      </td>
      <td class="num">
        <div class="row-actions">
          <button class="button" data-toggle-lots="${position.ticker}" aria-expanded="${expanded}" type="button">
            ${expanded ? "Hide lots" : `Lots (${position.lotCount})`}
          </button>
          ${position.quantity > 0 ? `<button class="button" data-open-sale="${position.ticker}" data-quantity="${position.quantity}" data-price="${position.price?.price || ""}" data-currency="${position.price?.currency || user.baseCurrency}" type="button">Sell</button>` : ""}
          <button class="button" data-open-alert="${position.ticker}" data-scope="EQUITY" type="button">Alert</button>
        </div>
      </td>
    </tr>
    <tr class="lot-row ${expanded ? "open" : ""}" ${expanded ? "" : "hidden"}>
      <td colspan="10"><div class="lot-list">${lots}</div></td>
    </tr>
  `;
}

function rangeText(low, high, currency = "") {
  if (low == null || high == null) return "--";
  return currency ? `${money(low, currency)} - ${money(high, currency)}` : `${number(low)} - ${number(high)}`;
}

function rangeBar(value, low, high) {
  if (value == null || low == null || high == null || high <= low) return "";
  const pct = Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
  return `<span class="range-bar" style="--range-position:${pct}%"><i></i></span>`;
}

function marketDataRows(position, user) {
  const quote = position.price || {};
  const currency = quote.currency || user.baseCurrency;
  const exposure = positionExposure(position);
  const changeClass = valueClass(quote.changePercent || 0);
  const marketStatus = quotePriceLabel(quote, position.ticker);
  const statusClass = statusClassForMarket(marketStatus);
  const moveClass = state.priceMoves.get(position.ticker) ? `price-flash-${state.priceMoves.get(position.ticker)}` : "";
  const marketCap = normalizeMarketCap(quote.marketCap ?? position.fundamentals?.marketCap);
  return `
    <tr class="market-data-row">
      <td>${tickerButton(position.ticker)}<br><span class="muted">${escapeHtml(position.name || quote.exchangeName || "")}</span></td>
      <td class="num">${priceCellHtml(quote, position.ticker, moveClass)}</td>
      <td class="num ${changeClass}">${nullableSignedPercent(quote.changePercent)}</td>
      <td class="num ${valueClass(quote.changeAmount || 0)}">${nullableSignedMoney(quote.changeAmount, currency)}</td>
      <td>${rangeText(quote.dayLow, quote.dayHigh, currency)}${rangeBar(quote.price, quote.dayLow, quote.dayHigh)}</td>
      <td class="num">${nullableCompactMoney(marketCap, currency)}</td>
      <td class="num">${compactNumber(quote.volume)}</td>
      <td class="num">${compactNumber(quote.averageVolume)}</td>
      <td>${rangeText(quote.fiftyTwoWeekLow, quote.fiftyTwoWeekHigh, currency)}${rangeBar(quote.price, quote.fiftyTwoWeekLow, quote.fiftyTwoWeekHigh)}</td>
      <td class="num">${nullableMoney(quote.fiftyDayAverage, currency)}</td>
      <td class="num">${nullableMoney(quote.twoHundredDayAverage, currency)}</td>
      <td class="num">${money(position.currentValueBase, user.baseCurrency)}</td>
      <td class="num">${percent(exposure)}</td>
    </tr>
  `;
}

function currentHoldingsHead() {
  return `
    <tr>
      <th>Ticker</th>
      <th>Group</th>
      <th class="num">Qty</th>
      <th class="num">Lots</th>
      <th class="num">Avg Cost</th>
      <th class="num">Latest Price</th>
      <th class="num">Value</th>
      <th class="num">Unrealized</th>
      <th class="num">Realized</th>
      <th></th>
    </tr>
  `;
}

function marketHoldingsHead() {
  return `
    <tr>
      <th>Ticker</th>
      <th class="num">Latest</th>
      <th class="num">Day %</th>
      <th class="num">Day Amt</th>
      <th>Day Range</th>
      <th class="num">Market Cap</th>
      <th class="num">Volume</th>
      <th class="num">Avg Volume</th>
      <th>52W Range</th>
      <th class="num">50D MA</th>
      <th class="num">200D MA</th>
      <th class="num">Value</th>
      <th class="num">Exposure</th>
    </tr>
  `;
}

function renderHoldings() {
  const { positions, user } = state.dashboard;
  $("#holdingsSort").value = state.holdingsSort;
  $("#holdingsGroup").value = state.holdingsGroup;
  $("#holdingsViewMode").value = state.holdingsViewMode;
  $("#holdingsTable").classList.toggle("market-data-table", state.holdingsViewMode === "market");
  $("#holdingsHead").innerHTML = state.holdingsViewMode === "market" ? marketHoldingsHead() : currentHoldingsHead();
  const rows = groupedPositions(sortPositions(positions)).map((group) => (
    `${renderGroupHeader(group, user, state.holdingsViewMode === "market" ? 13 : 10)}${group.positions.map((position) => (
      state.holdingsViewMode === "market" ? marketDataRows(position, user) : renderPositionRows(position, user)
    )).join("")}`
  ));
  $("#holdingsBody").innerHTML = rows.join("");
}

function renderHoldingsSnapshot() {
  const { positions, user, summary } = state.dashboard;
  const openPositions = positions
    .filter((position) => !position.closed && position.quantity > 0)
    .sort((a, b) => (b.currentValueBase || 0) - (a.currentValueBase || 0));
  $("#holdingsSnapshotStatus").textContent = `${summary.holdingsCount} positions, ${summary.lotCount} lots`;
  if (!openPositions.length) {
    $("#holdingsSnapshot").innerHTML = `
      <div class="empty-state">
        <strong>No open holdings</strong>
        <span>Add a lot or import your portfolio to start tracking positions.</span>
      </div>
    `;
    return;
  }
  $("#holdingsSnapshot").innerHTML = openPositions.slice(0, 8).map((position) => {
    const exposure = positionExposure(position);
    const gainClass = position.unrealizedBase > 0 ? "positive" : position.unrealizedBase < 0 ? "negative" : "";
    const marketStatus = quotePriceLabel(position.price, position.ticker);
    const priceStatus = statusClassForMarket(marketStatus);
    return `
      <article class="holding-card">
        <div class="holding-card-head">
          <div>
            ${tickerButton(position.ticker)}
            <span>${categoryNameFor(position)}</span>
          </div>
          <span class="status-pill ${priceStatus}">${marketStatus}</span>
        </div>
        <div class="holding-card-value">${money(position.currentValueBase, user.baseCurrency)}</div>
        <div class="holding-card-meta">
          <span>${percent(exposure)} exposure</span>
          <span>${position.lotCount} lots</span>
        </div>
        <div class="holding-card-gain ${gainClass}">
          ${signedMoney(position.unrealizedBase, user.baseCurrency)}
          <span>${signedPercent(position.unrealizedPercent)}</span>
        </div>
        <div class="holding-card-actions">
          <button class="button secondary" data-open-stock="${position.ticker}" type="button">Open</button>
          <button class="button" data-open-alert="${position.ticker}" data-scope="EQUITY" type="button">Alert</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderCash() {
  const { cashBalances, user } = state.dashboard;
  const totalCashBase = cashBalances.reduce((total, cash) => total + (Number(cash.amountBase) || 0), 0);
  const card = $("#cashCard");
  if (card) {
    card.classList.toggle("collapsed", state.cashCollapsed);
    const button = card.querySelector('[data-action="toggleCash"]');
    if (button) button.textContent = state.cashCollapsed ? "Show" : "Hide";
  }
  $("#cashSummary").textContent = `${money(totalCashBase, user.baseCurrency)} | ${cashBalances.length} currencies`;
  $("#cashBalances").innerHTML = cashBalances.length ? cashBalances.map((cash) => `
    <div class="cash-item editable-cash-row">
      <span>${cash.currency}</span>
      <input data-cash-amount="${cash.currency}" type="number" step="0.01" value="${cash.amount}">
      <strong>${money(cash.amountBase, user.baseCurrency)}</strong>
      <div class="button-row">
        <button class="button secondary" data-save-cash="${cash.currency}" type="button">Save</button>
        <button class="button danger" data-delete-cash="${cash.currency}" type="button">Delete</button>
      </div>
    </div>
  `).join("") : `<p class="muted">No cash balances saved.</p>`;
}

function watchlistGroups() {
  const lists = state.dashboard.watchlists || [];
  if (lists.length) {
    const nonEmpty = lists.filter((list) => list.itemCount > 0 || list.name !== "Default");
    return nonEmpty.length ? nonEmpty : lists;
  }
  const byId = new Map();
  for (const item of state.dashboard.watchlist || []) {
    const watchlistId = item.watchlistId || "default";
    if (!byId.has(watchlistId)) {
      byId.set(watchlistId, {
        id: watchlistId,
        name: item.watchlistName || "Default",
        sortOrder: item.watchlistSortOrder || 0
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
}

function selectedWatchlist() {
  const lists = watchlistGroups();
  if (!lists.length) return null;
  if (state.watchlistFilter !== "all") {
    return lists.find((list) => list.id === state.watchlistFilter) || lists[0];
  }
  return lists[0];
}

function watchlistDecisionForItem(item) {
  const decisions = state.dashboard.intelligence?.watchlistDecisions || [];
  return decisions.find((decision) => decision.watchlistItemId === item.id)
    || decisions.find((decision) => decision.ticker === item.ticker && decision.watchlistId === item.watchlistId)
    || decisions.find((decision) => decision.ticker === item.ticker);
}

function watchlistItemById(itemId) {
  return state.dashboard.watchlist.find((item) => item.id === itemId);
}

function watchlistStatusRank(status) {
  return { BUY: 0, ADD: 1, REVIEW: 2, TRIM: 3, HOLD: 4, AVOID: 5 }[status] ?? 9;
}

function renderThemeChips(themes = []) {
  return themes.length ? `
    <div class="theme-chips">
      ${themes.slice(0, 4).map((theme) => `<span>${theme.name || theme}${theme.count ? ` ${theme.count}` : ""}</span>`).join("")}
    </div>
  ` : "";
}

function renderResearchMetrics() {
  const node = $("#researchMetrics");
  if (!node || !state.dashboard) return;
  const intelligence = state.dashboard.intelligence || {};
  const watchlistDecisions = intelligence.watchlistDecisions || [];
  const watchlistLists = intelligence.watchlistLists || [];
  const priority = bestAction(watchlistDecisions.filter((item) => !item.alreadyOwned), ["BUY", "ADD", "REVIEW", "TRIM"]) || bestAction(watchlistDecisions);
  const buyAddCount = watchlistDecisions.filter((item) => ["BUY", "ADD"].includes(item.status)).length;
  const reviewCount = watchlistDecisions.filter((item) => ["REVIEW", "TRIM"].includes(item.status)).length;
  const events = state.dashboard.events || [];
  const sourceLinks = events.filter((event) => event.sourceUrl).length;
  const missingFundamentals = monitoredFundamentalRows()
    .filter((row) => !fundamentalsCovered(row)).length;

  const metrics = [
    ["Watchlists", String(watchlistLists.length || state.dashboard.summary.watchlistGroupCount || 0), `${state.dashboard.summary.watchlistCount || 0} tickers`],
    ["Buy/Add Zones", String(buyAddCount), "Ideas closest to action"],
    ["Review Queue", String(reviewCount), "Trim or risk checks"],
    ["Priority Idea", priority?.ticker || "None", priority ? `${priority.status} | ${priority.convictionScore}/100` : "No ranked idea"],
    ["Source Links", String(sourceLinks), "News/events clickable"],
    ["Fundamentals", String(missingFundamentals), "Missing or stale"]
  ];

  node.innerHTML = metrics.map(([label, value, detail]) => `
    <div class="research-metric">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${detail}</small>
    </div>
  `).join("");
}

function zoneRange(item, lowKey, highKey) {
  const low = item[lowKey];
  const high = item[highKey];
  if (low == null && high == null) return null;
  if (low != null && high != null) return `${money(low, item.currency)}-${money(high, item.currency)}`;
  return money(low ?? high, item.currency);
}

function zoneSummary(item) {
  const parts = [
    zoneRange(item, "buyZoneLow", "buyZoneHigh") ? `Buy ${zoneRange(item, "buyZoneLow", "buyZoneHigh")}` : null,
    zoneRange(item, "addZoneLow", "addZoneHigh") ? `Add ${zoneRange(item, "addZoneLow", "addZoneHigh")}` : null,
    item.trimPrice != null ? `Trim ${money(item.trimPrice, item.currency)}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : "Zones not set";
}

function renderWatchlistOverview() {
  const lists = state.dashboard.intelligence?.watchlistLists || [];
  const node = $("#watchlistOverview");
  if (!node) return;
  if (!lists.length) {
    node.innerHTML = `<p class="muted">No watchlists imported yet</p>`;
    return;
  }
  node.innerHTML = lists.map((list) => `
    <button class="watchlist-overview-card" data-watchlist-select="${list.id}" type="button">
      <span class="section-title">${list.count} tickers | ${list.ownedCount} owned</span>
      <strong>${list.name}</strong>
      <span class="muted">${list.priority?.ticker || "No priority"} ${list.priority ? `- ${list.priority.status}` : ""} | avg conviction ${list.averageConviction}/100</span>
      ${renderThemeChips(list.themes)}
    </button>
  `).join("");
}

function renderWatchlistRows(items) {
  const enriched = items.map((item) => ({
    item,
    decision: watchlistDecisionForItem(item)
  })).sort((a, b) => {
    const themeDelta = (a.decision?.theme || "Unclassified").localeCompare(b.decision?.theme || "Unclassified");
    if (themeDelta !== 0) return themeDelta;
    const statusDelta = watchlistStatusRank(a.decision?.status) - watchlistStatusRank(b.decision?.status);
    if (statusDelta !== 0) return statusDelta;
    return a.item.ticker.localeCompare(b.item.ticker);
  });
  const grouped = new Map();
  for (const row of enriched) {
    const theme = row.decision?.theme || "Unclassified";
    if (!grouped.has(theme)) grouped.set(theme, []);
    grouped.get(theme).push(row);
  }

  return [...grouped.entries()].map(([theme, rows]) => `
    <div class="watchlist-theme-block">
      <div class="watchlist-theme-title">
        <strong>${theme}</strong>
        <span class="muted">${rows.length} tickers</span>
      </div>
      ${rows.map(({ item, decision }) => `
        <div class="watchlist-card-row">
          <div class="watchlist-identity">
            <span class="decision-pill ${(decision?.status || "HOLD").toLowerCase()}">${decision?.status || "HOLD"}</span>
            <div>
              ${tickerButton(item.ticker)}
              <span>${item.name || item.categoryName || "Research idea"}</span>
            </div>
          </div>
          <div class="watchlist-quote">
            <span>Price</span>
            ${priceCellHtml(item.price, item.ticker)}
            <small>${decision?.alreadyOwned ? "Already owned" : item.price?.status || "No live quote"}${item.targetPrice == null ? "" : ` | target ${money(item.targetPrice, item.currency)}`}</small>
          </div>
          <div class="watchlist-quote">
            <span>Discipline</span>
            <strong>${decision?.convictionScore ?? 0}/100</strong>
            <small>${zoneSummary(item)}</small>
          </div>
          <div class="button-row watchlist-actions">
            <button class="button secondary" data-open-zone="${item.id}" type="button">Zones</button>
            <button class="button" data-open-alert="${item.ticker}" data-scope="WATCHLIST" data-watchlist-item-id="${item.id}" type="button">Alert</button>
            <button class="button danger" data-delete-watch="${item.id}" type="button">Delete</button>
          </div>
        </div>
      `).join("")}
    </div>
  `).join("");
}

function renderWatchlist() {
  const { watchlist } = state.dashboard;
  const lists = watchlistGroups();
  renderWatchlistOverview();
  if (!lists.some((list) => list.id === state.watchlistFilter) && state.watchlistFilter !== "all") {
    state.watchlistFilter = "all";
  }
  $("#watchlistFilter").innerHTML = `
    <option value="all" ${state.watchlistFilter === "all" ? "selected" : ""}>All watchlists</option>
    ${lists.map((list) => `<option value="${list.id}" ${list.id === state.watchlistFilter ? "selected" : ""}>${list.name}</option>`).join("")}
  `;
  $("#watchlistAddList").innerHTML = lists.map((list) => `
    <option value="${list.id}" ${list.id === selectedWatchlist()?.id ? "selected" : ""}>${list.name}</option>
  `).join("");

  const renameForm = $("#renameWatchlistForm");
  const selected = state.watchlistFilter === "all" ? null : lists.find((list) => list.id === state.watchlistFilter);
  renameForm.elements.name.value = selected?.name || "";
  renameForm.elements.name.disabled = !selected;
  renameForm.querySelector("button").disabled = !selected;

  const visible = state.watchlistFilter === "all"
    ? watchlist
    : watchlist.filter((item) => item.watchlistId === state.watchlistFilter);
  if (!visible.length) {
    $("#watchlistTable").innerHTML = `<p class="muted">No watchlist items</p>`;
    return;
  }

  const grouped = lists
    .map((list) => ({
      ...list,
      items: visible.filter((item) => (item.watchlistId || "default") === list.id)
    }))
    .filter((list) => list.items.length);
  $("#watchlistTable").innerHTML = grouped.map((list) => `
    <div class="watchlist-group">
      <div class="watchlist-group-title">
        <div>
          <strong>${list.name}</strong>
          ${renderThemeChips((state.dashboard.intelligence?.watchlistLists || []).find((item) => item.id === list.id)?.themes || [])}
        </div>
        <span class="muted">${list.items.length} tickers</span>
      </div>
      ${renderWatchlistRows(list.items)}
    </div>
  `).join("");
}

function alertType(alert) {
  return alert.alertType || alert.alert_type || "PRICE_ALERT";
}

function alertTypeLabel(alert) {
  const type = alert.effectiveAlertType || alertType(alert);
  return ALERT_TYPE_LABELS[type] || type.replaceAll("_", " ");
}

function alertPortfolioSafety(alert) {
  const position = positionForTicker(alert.ticker);
  const total = Number(state.dashboard?.summary?.totalValueBase) || 0;
  const weight = total && position?.currentValueBase ? roundDisplayPercent((position.currentValueBase / total) * 100) : 0;
  const type = alertType(alert);
  const note = String(alert.note || alert.label || "").toLowerCase();
  const maxBuyWeight = position?.maxBuyWeightPercent == null ? null : Number(position.maxBuyWeightPercent);
  const savedBuyBlocked = Boolean(position?.buyBlocked) && (Number(position?.currentValueBase) || 0) > 0;
  const savedLimitReached = Number.isFinite(maxBuyWeight) && maxBuyWeight >= 0 && (Number(position?.currentValueBase) || 0) > 0 && weight >= maxBuyWeight;
  const markedOverweight = savedBuyBlocked
    || savedLimitReached
    || note.includes("overweight")
    || note.includes("oversized");
  const warnings = [];
  if (BUY_ALERT_TYPES.has(type) && (weight >= 10 || markedOverweight)) warnings.push("Check current portfolio weight before buying.");
  if (markedOverweight) warnings.push(position?.riskNote || "Overweight position - do not add unless deliberately overriding.");
  const effectiveType = BUY_ALERT_TYPES.has(type) && (markedOverweight || weight >= 15) ? "REVIEW_ONLY" : type;
  return { weight, warnings, effectiveType };
}

function suggestedAction(alert) {
  const safety = alertPortfolioSafety(alert);
  const action = ALERT_ACTIONS[safety.effectiveType] || ALERT_ACTIONS.PRICE_ALERT;
  return [action, ...safety.warnings].join(" ");
}

function alertStatus(alert) {
  if (alert.archived_at) return { label: "ARCHIVED", className: "negative", bucket: "archived" };
  if (alert.triggered && !alert.acknowledged_at) return { label: "TRIGGERED", className: "negative", bucket: "triggered" };
  if (alert.acknowledged_at) return { label: "REVIEWED", className: "warning", bucket: "acknowledged" };
  if (alert.active) return { label: "ACTIVE", className: "live", bucket: "active" };
  return { label: "PAUSED", className: "", bucket: "active" };
}

function alertPriceLine(alert) {
  const current = alert.currentPrice == null ? "n/a" : money(alert.currentPrice, alert.currentCurrency || alert.currency);
  const target = money(alert.threshold_price ?? alert.targetPrice, alert.currency);
  const direction = String(alert.direction || "").toLowerCase();
  return `
    <div class="alert-price-grid">
      <span>Current <strong>${current}</strong></span>
      <span>Target <strong>${direction} ${target}</strong></span>
    </div>
  `;
}

function alertCard(alert) {
  const status = alertStatus(alert);
  const safety = alertPortfolioSafety(alert);
  const effectiveType = safety.effectiveType;
  const note = alert.note || alert.label || "";
  const sourceLine = [alert.companyName || alert.company_name || alert.equityName, alert.strategyGroup || alert.strategy_group, alert.scope].filter(Boolean).join(" | ");
  const priorityClass = String(alert.priority || "medium").toLowerCase();
  const canReview = status.bucket === "triggered";
  const canArchive = status.bucket !== "archived";
  const canToggle = status.bucket === "active";
  return `
    <div class="alert-card ${status.bucket}">
      <div class="alert-card-head">
        <div>
          ${tickerButton(alert.ticker)}
          <span class="muted">${escapeHtml(sourceLine || "Equity alert")}</span>
        </div>
        <div class="alert-card-tags">
          <span class="status-pill ${status.className}">${status.label}</span>
          <span class="status-pill ai">${escapeHtml(ALERT_TYPE_LABELS[effectiveType] || alertTypeLabel(alert))}</span>
          <span class="status-pill priority-${priorityClass}">${escapeHtml(String(alert.priority || "medium").toUpperCase())}</span>
        </div>
      </div>
      ${alertPriceLine(alert)}
      <div class="alert-note">
        <strong>Note</strong>
        <span>${escapeHtml(note || "No note saved")}</span>
      </div>
      <div class="alert-action">
        <strong>Suggested review</strong>
        <span>${escapeHtml(suggestedAction(alert))}</span>
      </div>
      <div class="alert-meta">
        ${safety.weight ? `<span>Portfolio weight ${percent(safety.weight)}</span>` : ""}
        ${alert.quoteAsOf ? `<span>Price time ${new Date(alert.quoteAsOf).toLocaleString()}</span>` : ""}
        ${alert.snoozed_until ? `<span>Snoozed until ${new Date(alert.snoozed_until).toLocaleString()}</span>` : ""}
      </div>
      <div class="button-row alert-actions">
        <button class="button secondary" data-open-stock="${alert.ticker}" type="button">View Holding</button>
        <button class="button secondary" data-edit-alert="${alert.id}" type="button">Edit</button>
        ${canReview ? `<button class="button primary" data-review-alert="${alert.id}" type="button">Clear Executed</button>` : ""}
        ${canReview ? `<button class="button secondary" data-snooze-alert="${alert.id}" type="button">Snooze 24h</button>` : ""}
        ${canToggle ? `<button class="button secondary" data-toggle-alert="${alert.id}" data-active="${alert.active ? "0" : "1"}" type="button">${alert.active ? "Pause" : "Resume"}</button>` : ""}
        ${canArchive ? `<button class="button secondary" data-archive-alert="${alert.id}" type="button">Archive Rule</button>` : `<button class="button secondary" data-reactivate-alert="${alert.id}" type="button">Reactivate</button>`}
        <button class="button secondary" data-order-draft-alert="${alert.id}" type="button">Create Order Draft</button>
        <button class="button danger ghost" data-delete-alert="${alert.id}" type="button">Delete</button>
      </div>
    </div>
  `;
}

function alertSection(title, rows, emptyText) {
  const key = title.toLowerCase().split(" ")[0];
  return `
    <section class="alert-center-section" data-alert-section="${escapeHtml(key)}">
      <div class="alert-section-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${rows.length}</span>
      </div>
      ${rows.length ? rows.map(alertCard).join("") : `<p class="muted">${escapeHtml(emptyText)}</p>`}
    </section>
  `;
}

function triggeredAlerts() {
  return (state.dashboard?.alerts || []).filter((alert) => alert.triggered && !alert.acknowledged_at && !alert.archived_at);
}

function showDesktopNotifications(alerts) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const seen = new Set(JSON.parse(sessionStorage.getItem("desktopAlertIds") || "[]"));
  for (const alert of alerts) {
    if (seen.has(alert.id)) continue;
    new Notification(`Price alert triggered: ${alert.ticker}`, {
      body: `${alertTypeLabel(alert)} at ${money(alert.threshold_price, alert.currency)}. ${alert.note || alert.label || ""}`
    });
    seen.add(alert.id);
  }
  sessionStorage.setItem("desktopAlertIds", JSON.stringify([...seen]));
}

function showAlertToasts(alerts) {
  const seen = new Set(JSON.parse(sessionStorage.getItem("alertToastIds") || "[]"));
  const fresh = alerts.find((alert) => !seen.has(alert.id));
  if (!fresh) return;
  toast(`Price alert triggered: ${fresh.ticker} hit ${money(fresh.threshold_price, fresh.currency)}. ${alertTypeLabel(fresh)}. ${fresh.note || fresh.label || ""}`);
  for (const alert of alerts) seen.add(alert.id);
  sessionStorage.setItem("alertToastIds", JSON.stringify([...seen]));
}

function renderAlertBanner() {
  const alerts = triggeredAlerts();
  const node = $("#alertBanner");
  const countNode = $("#alertsTabCount");
  const topIndicator = $("#topAlertIndicator");
  const topText = $("#topAlertText");
  const clearTriggeredButton = $("#clearTriggeredAlerts");
  if (countNode) {
    countNode.textContent = alerts.length ? String(alerts.length) : "";
    countNode.hidden = alerts.length === 0;
  }
  if (topIndicator && topText) {
    topIndicator.hidden = alerts.length === 0;
    topIndicator.classList.toggle("has-alerts", alerts.length > 0);
    topIndicator.dataset.alertRouteTab = alerts.length ? "triggered" : "all";
    topText.textContent = alerts.length
      ? `${alerts.length} Triggered Alert${alerts.length === 1 ? "" : "s"}`
      : "No Triggered Alerts";
  }
  if (clearTriggeredButton) clearTriggeredButton.disabled = alerts.length === 0;
  if (!node) return;
  node.hidden = alerts.length === 0;
  if (!alerts.length) {
    node.innerHTML = "";
    return;
  }
  showDesktopNotifications(alerts);
  showAlertToasts(alerts);
  node.innerHTML = `
    <div class="alert-banner-copy">
      <strong>${alerts.length} alert${alerts.length === 1 ? "" : "s"} need review</strong>
      <span>${alerts.slice(0, 3).map((alert) => `${escapeHtml(alert.ticker)} ${escapeHtml(alertTypeLabel(alert))}`).join(" | ")}</span>
    </div>
    <div class="button-row">
      <button class="button primary" data-action="openAlerts" data-alert-route-tab="triggered" type="button">Open Alert Center</button>
      <button class="button secondary" data-review-alert="${alerts[0].id}" type="button">Clear First</button>
    </div>
  `;
}

function alertCommandHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem("alertCommandHistory") || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveAlertCommandHistory(command) {
  const clean = String(command || "").trim();
  if (!clean) return;
  const history = [clean, ...alertCommandHistory().filter((item) => item !== clean)].slice(0, 6);
  localStorage.setItem("alertCommandHistory", JSON.stringify(history));
}

function alertCommandSecurities() {
  const securities = new Map();
  const upsert = (ticker, data) => {
    const normalized = String(ticker || "").trim().toUpperCase();
    if (!normalized) return;
    const existing = securities.get(normalized) || {};
    securities.set(normalized, { ...existing, ...data, ticker: normalized });
  };
  for (const position of state.dashboard?.positions || []) {
    upsert(position.ticker, {
      name: position.name || position.companyName || position.equityName || position.ticker,
      group: categoryNameFor(position),
      groupId: position.categoryId || "",
      currency: position.price?.currency || position.lots?.[0]?.purchaseCurrency || state.dashboard?.user?.baseCurrency || "USD",
      currentPrice: position.price?.price,
      source: "Portfolio"
    });
  }
  for (const item of state.dashboard?.watchlist || []) {
    upsert(item.ticker, {
      name: item.name || item.companyName || item.equityName || item.ticker,
      group: item.categoryName || item.watchlistName || "Watchlist",
      groupId: item.categoryId || "",
      currency: item.price?.currency || item.currency || state.dashboard?.user?.baseCurrency || "USD",
      currentPrice: item.price?.price,
      source: securities.has(String(item.ticker || "").toUpperCase()) ? "Portfolio + Watchlist" : "Watchlist"
    });
  }
  for (const alert of state.dashboard?.alerts || []) {
    upsert(alert.ticker, {
      name: alert.companyName || alert.company_name || alert.equityName || alert.ticker,
      group: alert.strategyGroup || alert.strategy_group || "Alerts",
      currency: alert.currentCurrency || alert.currency || state.dashboard?.user?.baseCurrency || "USD",
      currentPrice: alert.currentPrice,
      source: securities.has(String(alert.ticker || "").toUpperCase()) ? securities.get(String(alert.ticker || "").toUpperCase()).source : "Alerts"
    });
  }
  return [...securities.values()];
}

function duplicateAlertForDraft(draft) {
  return (state.dashboard?.alerts || []).find((alert) => {
    const active = alert.active !== false && alert.active !== 0 && !alert.archived_at;
    const price = Number(alert.threshold_price ?? alert.thresholdPrice ?? alert.targetPrice);
    const labelText = String(`${alert.label || ""} ${alert.note || ""} ${alert.alert_type || ""}`).toLowerCase();
    const sameAction = !draft.action || labelText.includes(String(draft.action).toLowerCase()) || String(alert.alert_type || "").toUpperCase() === draft.alertType;
    return active
      && String(alert.ticker || "").toUpperCase() === String(draft.ticker || "").toUpperCase()
      && String(alert.direction || "").toUpperCase() === String(draft.direction || "").toUpperCase()
      && Number.isFinite(price)
      && Math.abs(price - Number(draft.targetPrice)) < 0.0001
      && sameAction;
  });
}

function refreshAlertCommandDraft(draft) {
  const security = alertCommandSecurities().find((item) => item.ticker === String(draft.ticker || "").toUpperCase());
  if (security) {
    draft.ticker = security.ticker;
    draft.companyName ||= security.name || "";
    draft.group ||= security.group || "Unassigned";
    draft.groupId ||= security.groupId || "";
    draft.currency ||= security.currency || state.dashboard?.user?.baseCurrency || "USD";
  }
  draft.alertType = alertTypeForAction(draft.action);
  draft.errors = validateParsedAlert(draft, MARKET_CURRENCIES);
  const duplicate = duplicateAlertForDraft(draft);
  draft.duplicateId = duplicate?.id || "";
  draft.duplicateMessage = duplicate
    ? `An active ${draft.ticker} alert already exists ${draft.direction === "ABOVE" ? "at or above" : "at or below"} ${draft.currency} ${draft.targetPrice}.`
    : "";
  if (!draft.duplicatePolicy) draft.duplicatePolicy = "skip";
}

function parseAlertCommandFromForm() {
  const input = $("#alertCommandInput");
  const command = String(input?.value || "").trim();
  const result = parseAlertCommand(command, {
    securities: alertCommandSecurities(),
    existingAlerts: state.dashboard?.alerts || [],
    currencies: MARKET_CURRENCIES,
    defaultCurrency: state.dashboard?.user?.baseCurrency || "USD"
  });
  state.lastAlertCommandText = command;
  state.alertCommandDrafts = result.alerts || [];
  for (const draft of state.alertCommandDrafts) refreshAlertCommandDraft(draft);
  renderAlertCommandPreview(result.errors || []);
  if (result.errors?.length) toast(result.errors[0]);
  else toast(`${state.alertCommandDrafts.length} alert${state.alertCommandDrafts.length === 1 ? "" : "s"} ready to review`);
}

function renderAlertCommandHistory() {
  const node = $("#alertCommandHistory");
  if (!node) return;
  const history = alertCommandHistory();
  node.innerHTML = history.length
    ? `<span class="command-history-label">Recent</span>${history.map((item) => `
        <button class="button secondary" data-alert-command-history="${escapeHtml(item)}" type="button" title="${escapeHtml(item)}">${escapeHtml(item)}</button>
      `).join("")}`
    : `<span class="muted">Recent commands will appear here after saving.</span>`;
}

function priorityChoice(draft) {
  return draft.priorityLabel === "Critical" ? "critical" : String(draft.priority || "medium");
}

function groupCommandOptions(selected = "") {
  const names = new Set((state.categories || []).filter((category) => isActiveGroup(category)).map((category) => category.name));
  if (selected) names.add(selected);
  if (!names.size) names.add("Unassigned");
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((name) => `
    <option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>
  `).join("");
}

function tickerFieldHtml(draft) {
  if (draft.candidateOptions?.length > 1) {
    return `
      <select data-alert-command-id="${draft.id}" data-alert-command-field="ticker" aria-label="Choose ticker">
        <option value="">Choose ticker</option>
        ${draft.candidateOptions.map((option) => `
          <option value="${escapeHtml(option.ticker)}" ${option.ticker === draft.ticker ? "selected" : ""}>${escapeHtml(option.ticker)} - ${escapeHtml(option.name || option.group || "")}</option>
        `).join("")}
      </select>
    `;
  }
  return `<input data-alert-command-id="${draft.id}" data-alert-command-field="ticker" value="${escapeHtml(draft.ticker || "")}" placeholder="Ticker">`;
}

function alertCommandCard(draft, index) {
  const errors = draft.errors || [];
  const duplicate = draft.duplicateMessage;
  const title = draft.ticker ? `${draft.ticker} ${draft.companyName ? `- ${draft.companyName}` : ""}` : "Choose ticker";
  return `
    <div class="command-alert-card ${errors.length ? "has-error" : ""} ${duplicate ? "has-duplicate" : ""}" data-alert-command-card="${escapeHtml(draft.id)}">
      <div class="command-card-top">
        <div class="command-card-title">
          <strong>${index + 1}. ${escapeHtml(title)}</strong>
          <span>${escapeHtml(draft.source || "Command")} ${draft.directionInferred ? " | Direction inferred from live price" : ""}</span>
        </div>
        <div class="command-card-actions">
          <button class="button secondary" data-action="focusAlertCommandDraft" data-alert-command-id="${escapeHtml(draft.id)}" type="button">Edit</button>
          <button class="button danger ghost" data-action="removeAlertCommandDraft" data-alert-command-id="${escapeHtml(draft.id)}" type="button">Remove</button>
        </div>
      </div>
      <div class="command-card-grid">
        <label>
          <span>Company / Ticker</span>
          ${tickerFieldHtml(draft)}
        </label>
        <label>
          <span>Target price</span>
          <input data-alert-command-id="${draft.id}" data-alert-command-field="targetPrice" type="number" min="0" step="0.01" value="${escapeHtml(draft.targetPrice ?? "")}">
        </label>
        <label>
          <span>Currency</span>
          <select data-alert-command-id="${draft.id}" data-alert-command-field="currency">
            ${MARKET_CURRENCIES.map((currency) => `<option value="${currency}" ${currency === draft.currency ? "selected" : ""}>${currency}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>Direction</span>
          <select data-alert-command-id="${draft.id}" data-alert-command-field="direction">
            <option value="" ${!draft.direction ? "selected" : ""}>Choose</option>
            <option value="ABOVE" ${draft.direction === "ABOVE" ? "selected" : ""}>Above / at or above</option>
            <option value="BELOW" ${draft.direction === "BELOW" ? "selected" : ""}>Below / at or below</option>
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select data-alert-command-id="${draft.id}" data-alert-command-field="priorityChoice">
            <option value="low" ${priorityChoice(draft) === "low" ? "selected" : ""}>Low</option>
            <option value="medium" ${priorityChoice(draft) === "medium" ? "selected" : ""}>Medium</option>
            <option value="high" ${priorityChoice(draft) === "high" ? "selected" : ""}>High</option>
            <option value="critical" ${priorityChoice(draft) === "critical" ? "selected" : ""}>Critical</option>
          </select>
        </label>
        <label>
          <span>Action</span>
          <select data-alert-command-id="${draft.id}" data-alert-command-field="action">
            ${ACTION_OPTIONS.map((action) => `<option value="${escapeHtml(action)}" ${action === draft.action ? "selected" : ""}>${escapeHtml(action)}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>Group</span>
          <select data-alert-command-id="${draft.id}" data-alert-command-field="group">
            ${groupCommandOptions(draft.group)}
          </select>
        </label>
        ${duplicate ? `
          <label>
            <span>Duplicate</span>
            <select data-alert-command-id="${draft.id}" data-alert-command-field="duplicatePolicy">
              <option value="skip" ${draft.duplicatePolicy === "skip" ? "selected" : ""}>Skip duplicate</option>
              <option value="update" ${draft.duplicatePolicy === "update" ? "selected" : ""}>Update existing</option>
              <option value="save" ${draft.duplicatePolicy === "save" ? "selected" : ""}>Save anyway</option>
            </select>
          </label>
        ` : ""}
        <label class="wide">
          <span>Observation</span>
          <textarea data-alert-command-id="${draft.id}" data-alert-command-field="observation" placeholder="Reason, thesis check, or risk warning">${escapeHtml(draft.observation || "")}</textarea>
        </label>
      </div>
      ${duplicate ? `<div class="command-duplicate">${escapeHtml(duplicate)}</div>` : ""}
      ${errors.length ? `<div class="command-card-errors">${errors.map((error) => `<span>${escapeHtml(error)}</span>`).join("")}</div>` : ""}
    </div>
  `;
}

function renderAlertCommandPreview(generalErrors = []) {
  const node = $("#alertCommandPreview");
  if (!node) return;
  renderAlertCommandHistory();
  const drafts = state.alertCommandDrafts || [];
  if (!drafts.length && !generalErrors.length) {
    node.innerHTML = "";
    return;
  }
  if (generalErrors.length) {
    node.innerHTML = `
      <div class="command-preview-panel">
        <div class="command-preview-head">
          <div>
            <p class="eyebrow">Preview</p>
            <h3>Needs more detail</h3>
          </div>
          <button class="button secondary" data-action="cancelAlertCommand" type="button">Cancel</button>
        </div>
        <div class="command-card-errors">${generalErrors.map((error) => `<span>${escapeHtml(error)}</span>`).join("")}</div>
      </div>
    `;
    return;
  }
  const invalid = drafts.some((draft) => draft.errors?.length);
  node.innerHTML = `
    <div class="command-preview-panel">
      <div class="command-preview-head">
        <div>
          <p class="eyebrow">Parsed Preview</p>
          <h3>${drafts.length} alert${drafts.length === 1 ? "" : "s"} ready for review</h3>
          <p class="muted">Edit any field below. Nothing is saved until you press Save all alerts.</p>
        </div>
        <div class="command-preview-actions">
          <button class="button secondary" data-action="cancelAlertCommand" type="button">Cancel</button>
          <button class="button primary" data-action="saveAlertCommandDrafts" type="button" ${invalid ? "disabled" : ""}>Save all alerts</button>
        </div>
      </div>
      <div class="command-preview-list">
        ${drafts.map(alertCommandCard).join("")}
      </div>
    </div>
  `;
}

function updateAlertCommandDraft(id, field, value, { render = true } = {}) {
  const draft = state.alertCommandDrafts.find((item) => item.id === id);
  if (!draft) return;
  if (field === "priorityChoice") {
    draft.priority = value === "critical" ? "high" : value;
    draft.priorityLabel = value === "critical" ? "Critical" : value.charAt(0).toUpperCase() + value.slice(1);
  } else if (field === "targetPrice") {
    draft.targetPrice = Number(value);
  } else if (field === "ticker") {
    draft.ticker = String(value || "").trim().toUpperCase();
    const security = alertCommandSecurities().find((item) => item.ticker === draft.ticker);
    if (security) {
      draft.companyName = security.name || draft.companyName || "";
      draft.group = security.group || draft.group || "Unassigned";
      draft.groupId = security.groupId || draft.groupId || "";
      draft.currency = security.currency || draft.currency || state.dashboard?.user?.baseCurrency || "USD";
      draft.source = security.source || draft.source || "";
    }
  } else {
    draft[field] = value;
  }
  refreshAlertCommandDraft(draft);
  if (render) renderAlertCommandPreview();
}

function alertCommandPayload(draft) {
  const priorityLabel = draft.priorityLabel === "Critical" ? "Critical " : "";
  const action = draft.action || "Review";
  const note = [draft.observation, draft.directionInferred ? "Direction inferred from current market price." : ""]
    .filter(Boolean)
    .join(" ");
  return {
    ticker: String(draft.ticker || "").trim().toUpperCase(),
    scope: "EQUITY",
    direction: draft.direction,
    thresholdPrice: Number(draft.targetPrice),
    currency: draft.currency,
    alertType: draft.alertType || alertTypeForAction(action),
    priority: draft.priority === "critical" ? "high" : draft.priority,
    label: `${priorityLabel}${action}`,
    note,
    companyName: draft.companyName || "",
    group: draft.group || "",
    source: "command_box"
  };
}

async function saveAlertCommandDrafts() {
  const drafts = state.alertCommandDrafts || [];
  if (!drafts.length) {
    toast("No parsed alerts to save");
    return;
  }
  for (const draft of drafts) refreshAlertCommandDraft(draft);
  const invalid = drafts.find((draft) => draft.errors?.length);
  if (invalid) {
    renderAlertCommandPreview();
    toast(invalid.errors[0]);
    return;
  }
  let saved = 0;
  let skipped = 0;
  let updated = 0;
  for (const draft of drafts) {
    const duplicate = duplicateAlertForDraft(draft);
    if (duplicate && draft.duplicatePolicy === "skip") {
      skipped += 1;
      continue;
    }
    const payload = alertCommandPayload(draft);
    if (duplicate && draft.duplicatePolicy === "update") {
      await api(`/api/alerts/${encodeURIComponent(duplicate.id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      updated += 1;
    } else {
      await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      saved += 1;
    }
  }
  saveAlertCommandHistory(state.lastAlertCommandText || $("#alertCommandInput")?.value || "");
  state.alertCommandDrafts = [];
  state.lastAlertCommandText = "";
  const input = $("#alertCommandInput");
  if (input) input.value = "";
  await loadDashboard();
  renderAlerts();
  const parts = [];
  if (saved) parts.push(`${saved} created`);
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped`);
  toast(parts.length ? `Alerts saved: ${parts.join(", ")}` : "No alerts changed");
}

function renderAlerts() {
  const alerts = state.dashboard.alerts || [];
  renderAlertBanner();
  renderAlertsTop(alerts);
  renderAlertCommandHistory();
  renderAlertCommandPreview();
  const tabsNode = $("#alertTabs");
  if (!alerts.length) {
    if (tabsNode) tabsNode.innerHTML = "";
    $("#alertsTable").innerHTML = `
      <div class="empty-state">
        <strong>No alerts yet</strong>
        <span>Create one manually or seed your strategy alert list.</span>
      </div>
    `;
    return;
  }
  const byTicker = (a, b) => String(a.ticker || "").localeCompare(String(b.ticker || ""), undefined, { sensitivity: "base" });
  const buckets = {
    triggered: alerts.filter((alert) => alertStatus(alert).bucket === "triggered").sort(byTicker),
    active: alerts.filter((alert) => alertStatus(alert).bucket === "active").sort(byTicker),
    acknowledged: alerts.filter((alert) => alertStatus(alert).bucket === "acknowledged").sort(byTicker),
    archived: alerts.filter((alert) => alertStatus(alert).bucket === "archived").sort(byTicker)
  };
  const tabCounts = {
    all: alerts.length,
    triggered: buckets.triggered.length,
    active: buckets.active.length,
    acknowledged: buckets.acknowledged.length,
    archived: buckets.archived.length
  };
  const currentTab = ["all", "triggered", "active", "acknowledged", "archived"].includes(state.alertTab) ? state.alertTab : "all";
  if (tabsNode) {
    tabsNode.innerHTML = [
      ["all", "All"],
      ["triggered", "Triggered"],
      ["active", "Active"],
      ["acknowledged", "Reviewed"],
      ["archived", "Archived"]
    ].map(([tab, label]) => `
      <button class="alert-tab ${currentTab === tab ? "active" : ""}" data-alert-tab="${tab}" type="button" role="tab" aria-selected="${currentTab === tab}">
        ${escapeHtml(label)} <span>${tabCounts[tab]}</span>
      </button>
    `).join("");
  }
  const sectionHtml = currentTab === "all"
    ? [
        alertSection("Triggered alerts", buckets.triggered, "No triggered alerts need review."),
        alertSection("Active alerts", buckets.active, "No active alerts."),
        alertSection("Acknowledged alerts", buckets.acknowledged, "Nothing reviewed yet."),
        alertSection("Archived alerts", buckets.archived, "No archived alerts.")
      ].join("")
    : alertSection(`${currentTab === "acknowledged" ? "Acknowledged" : currentTab[0].toUpperCase() + currentTab.slice(1)} alerts`, buckets[currentTab], `No ${currentTab} alerts.`);
  $("#alertsTable").innerHTML = `<div class="alert-center-grid">${sectionHtml}</div>`;
}

function alertChip(alert) {
  const status = alertStatus(alert);
  const dir = String(alert.direction || "").toUpperCase();
  const price = money(alert.threshold_price ?? alert.targetPrice, alert.currency);
  const arrow = dir === "ABOVE" ? "\u2265" : dir === "BELOW" ? "\u2264" : "";
  return `<button class="alert-chip ${status.bucket}" data-edit-alert="${alert.id}" type="button" title="Edit alert (${escapeHtml(dir.toLowerCase())} ${escapeHtml(price)})">
    <span class="alert-chip-dir">${escapeHtml(arrow || dir)}</span>
    <span class="alert-chip-price">${escapeHtml(price)}</span>
  </button>`;
}

function executedAlertRow(alert) {
  const price = money(alert.threshold_price ?? alert.targetPrice, alert.currency);
  const dir = String(alert.direction || "").toLowerCase();
  return `<div class="executed-row">
    <div class="executed-row-main">
      ${tickerButton(alert.ticker)}
      <span class="executed-row-detail">${escapeHtml(dir)} ${escapeHtml(price)}</span>
    </div>
    <div class="button-row">
      <button class="button secondary" data-edit-alert="${alert.id}" type="button">Edit</button>
      <button class="button primary" data-review-alert="${alert.id}" type="button">Clear</button>
    </div>
  </div>`;
}

function renderAlertsTop(alerts) {
  const executedNode = $("#alertsExecuted");
  const overviewNode = $("#alertsPortfolioOverview");
  const byTicker = (a, b) => String(a.ticker || "").localeCompare(String(b.ticker || ""), undefined, { sensitivity: "base" });
  const triggered = alerts.filter((alert) => alertStatus(alert).bucket === "triggered").sort(byTicker);
  if (executedNode) {
    executedNode.innerHTML = triggered.length
      ? triggered.map(executedAlertRow).join("")
      : `<p class="muted">No executed alerts right now.</p>`;
  }
  const block = $("#alertsExecutedBlock");
  if (block) block.classList.toggle("has-executed", triggered.length > 0);
  if (!overviewNode) return;
  const positions = (state.dashboard.positions || []).filter((p) => (p.quantity || p.openQuantity || 0) > 0);
  const alertsByTicker = new Map();
  for (const alert of alerts) {
    const t = String(alert.ticker || "").toUpperCase();
    if (!t) continue;
    if (!alertsByTicker.has(t)) alertsByTicker.set(t, []);
    alertsByTicker.get(t).push(alert);
  }
  const tickers = [...new Set(positions.map((p) => String(p.ticker || "").toUpperCase()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  overviewNode.innerHTML = tickers.length ? tickers.map((t) => {
    const pos = positions.find((p) => String(p.ticker || "").toUpperCase() === t);
    const priceVal = pos?.price?.price;
    const price = priceVal != null ? `${money(priceVal, pos.price.currency)}${extendedPriceHtml(pos.price)}` : "\u2014";
    const list = (alertsByTicker.get(t) || []).slice().sort((a, b) => {
      const pa = Number(a.threshold_price ?? a.targetPrice ?? 0);
      const pb = Number(b.threshold_price ?? b.targetPrice ?? 0);
      return pa - pb;
    });
    const chips = list.length
      ? list.map(alertChip).join("")
      : `<span class="muted portfolio-alert-empty">No alerts set</span>`;
    return `
      <div class="portfolio-alert-row">
        <div class="portfolio-alert-head">
          ${tickerButton(t)}
          <span class="portfolio-alert-price">${price}</span>
        </div>
        <div class="portfolio-alert-chips">${chips}</div>
        <button class="button secondary portfolio-alert-add" data-open-alert="${t}" data-scope="EQUITY" type="button">+ Alert</button>
      </div>`;
  }).join("") : `<p class="muted">No portfolio holdings to show.</p>`;
}

function notificationStatusView(status, { pendingLabel = "EMAIL QUEUED" } = {}) {
  if (status === "SENT") return { label: "EMAIL SENT", className: "live" };
  if (status === "WAITING_FOR_CONFIGURATION") return { label: "EMAIL SETUP NEEDED", className: "warning" };
  if (status === "FAILED") return { label: "EMAIL FAILED", className: "negative" };
  if (status === "PENDING") return { label: pendingLabel, className: "warning" };
  return { label: pendingLabel, className: "warning" };
}

function flattenNotificationResults(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  return [
    ...(result?.events || []).map((item) => item.notification).filter(Boolean),
    ...(result?.notifications || []).filter(Boolean)
  ];
}

function renderEvents() {
  const { events, notificationDelivery } = state.dashboard;
  $("#eventsTable").innerHTML = events.length ? events.map((event) => {
    const fallbackStatus = notificationDelivery?.emailConfigured === false ? "WAITING_FOR_CONFIGURATION" : "PENDING";
    const status = notificationStatusView(event.notificationStatus || (event.notifiedAt ? "SENT" : fallbackStatus), {
      pendingLabel: "PENDING EMAIL"
    });
    return `
      <div class="compact-row wide events-row">
        <div>${tickerButton(event.ticker)}<br><span class="muted">${escapeHtml(event.eventDate)}</span></div>
        <div>
          ${escapeHtml(event.title)}
          <br><span class="muted">${escapeHtml(event.details || "")}</span>
          <div class="news-source-row">${sourcePill(event)}${sourceLink(event, "Open")}</div>
        </div>
        <div>${escapeHtml(event.eventType)}</div>
        <div><span class="status-pill ${status.className}">${status.label}</span></div>
      </div>
    `;
  }).join("") : `<p class="muted">No corporate events</p>`;
}

function metricText(value, suffix = "") {
  if (value == null) return "n/a";
  return `${number(value, 2)}${suffix}`;
}

function renderStockLoading(ticker) {
  $("#stockTitle").textContent = ticker || "Loading stock";
  $("#stockSubtitle").textContent = "Loading quote, fundamentals, company profile, and historical performance...";
  $("#stockQuoteTiles").innerHTML = "";
  $("#stockBusinessSummary").textContent = "Loading company profile...";
  $("#stockProfileFacts").innerHTML = "";
  $("#stockFundamentalsGrid").innerHTML = "";
  $("#stockOwnershipTable").innerHTML = "";
  $("#stockEventsTable").innerHTML = "";
  $("#stockLotsTable").innerHTML = "";
  $("#stockPerformanceStatus").textContent = "Loading historical prices...";
  $("#stockPerformanceStats").innerHTML = performanceStatsHtml(null);
  renderPerformanceChart("#stockPerformanceChart", null);
  renderRangeTabs();
}

function renderStockQuoteTiles(detail) {
  const quote = detail.quote || {};
  const position = detail.position || {};
  const f = detail.fundamentals || {};
  const marketCapValue = f.marketCap == null ? null : f.marketCap < 10000000 ? f.marketCap * 1000000 : f.marketCap;
  const rows = [
    { label: "Latest Close", value: quote.price == null ? "n/a" : `${money(quote.price, quote.currency)}${extendedPriceHtml(quote)}`, delta: quote.changeAmount, html: true },
    { label: "Day Change", value: `${signedMoney(quote.changeAmount, quote.currency)} / ${signedPercent(quote.changePercent)}`, delta: quote.changeAmount },
    { label: "Position Value", value: money(position.currentValueBase, position.baseCurrency) },
    { label: "Open Shares", value: number(position.openQuantity, 4) },
    { label: "Market Cap", value: marketCapValue == null ? "n/a" : compactMoney(marketCapValue, "USD") },
    { label: "P/E", value: metricText(f.peRatio) }
  ];
  $("#stockQuoteTiles").innerHTML = rows.map(({ label, value, delta, html }) => `
    <div class="metric-tile">
      <span>${escapeHtml(label)}</span>
      <strong class="metric-value compact ${html ? "with-sessions" : ""} ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${html ? value : escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderStockProfile(detail) {
  const profile = detail.profile || {};
  $("#stockTitle").textContent = `${detail.ticker}${detail.name ? ` - ${detail.name}` : ""}`;
  $("#stockSubtitle").textContent = [profile.exchangeName, profile.sector, profile.industry].filter(Boolean).join(" | ");
  $("#stockBusinessSummary").textContent = profile.summary || "Business summary is not available yet. Press Refresh Stock Data to ask Yahoo Finance again.";
  const facts = [
    ["Sector", profile.sector],
    ["Industry", profile.industry],
    ["Country", profile.country],
    ["Employees", profile.employees ? number(profile.employees, 0) : null],
    ["Website", profile.website]
  ];
  $("#stockProfileFacts").innerHTML = facts.map(([label, value]) => `
    <div class="profile-fact">
      <span>${escapeHtml(label)}</span>
      <strong>${value ? escapeHtml(value) : "n/a"}</strong>
    </div>
  `).join("");
}

function renderStockFundamentals(detail) {
  const f = detail.fundamentals || {};
  $("#stockFundamentalsStatus").textContent = `${f.status || "MISSING"}${f.provider ? ` via ${f.provider}` : ""}${f.asOf ? ` | ${new Date(f.asOf).toLocaleString()}` : ""}`;
  const rows = [
    ["P/E", metricText(f.peRatio)],
    ["Forward P/E", metricText(f.forwardPe)],
    ["EV/EBITDA", metricText(f.evEbitda)],
    ["Price/Sales", metricText(f.priceSales)],
    ["FCF Yield", metricText(f.fcfYield, "%")],
    ["PEG", metricText(f.peg)],
    ["Revenue Growth", metricText(f.revenueGrowth, "%")],
    ["EPS Growth", metricText(f.epsGrowth, "%")],
    ["Gross Margin", metricText(f.grossMargin, "%")],
    ["Operating Margin", metricText(f.operatingMargin, "%")],
    ["Debt/Equity", metricText(f.debtEquity)],
    ["Beta", metricText(f.beta)]
  ];
  $("#stockFundamentalsGrid").innerHTML = rows.map(([label, value]) => `
    <div class="fundamental-tile">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderStockOwnership(detail) {
  const position = detail.position || {};
  const watchlist = detail.watchlistItems || [];
  const alerts = detail.alerts || [];
  const zoneText = watchlist.length ? watchlist.map((item) => [
    item.buyZoneLow != null || item.buyZoneHigh != null ? `Buy ${money(item.buyZoneLow, item.currency)}-${money(item.buyZoneHigh, item.currency)}` : null,
    item.addZoneLow != null || item.addZoneHigh != null ? `Add ${money(item.addZoneLow, item.currency)}-${money(item.addZoneHigh, item.currency)}` : null,
    item.trimPrice != null ? `Trim ${money(item.trimPrice, item.currency)}` : null
  ].filter(Boolean).join(" | ")).filter(Boolean).join("<br>") || "No zones" : "No zones";
  const alertText = alerts.length
    ? alerts.map((alert) => `${alert.direction} ${money(alert.thresholdPrice, alert.currency)} ${alert.triggered ? "(triggered)" : alert.active ? "(active)" : "(paused)"}`).join("<br>")
    : "No alerts";
  const rows = [
    ["Open position", `${number(position.openQuantity, 4)} shares | ${money(position.currentValueBase, position.baseCurrency)}`],
    ["Cost basis", money(position.costBasisBase, position.baseCurrency)],
    ["Realized", signedMoney(position.realizedBase, position.baseCurrency)],
    ["Watchlists", watchlist.length ? watchlist.map((item) => item.watchlistName).join(", ") : "Not on watchlist"],
    ["Price zones", zoneText],
    ["Alerts", alertText]
  ];
  $("#stockOwnershipTable").innerHTML = rows.map(([label, value]) => `
    <div class="ownership-row">
      <div class="ownership-label">${escapeHtml(label)}</div>
      <div class="ownership-value">${String(value).includes("<br>") ? value : escapeHtml(value)}</div>
    </div>
  `).join("");
}

function renderStockEvents(detail) {
  const events = detail.events || [];
  const isHttp = (url) => typeof url === "string" && /^https?:\/\//i.test(url);
  $("#stockEventsTable").innerHTML = events.length ? events.map((event) => {
    const sub = event.details || "";
    const source = event.newsSource || event.source || "";
    const titleText = escapeHtml(event.title || "");
    const titleHtml = isHttp(event.sourceUrl)
      ? `<a class="event-title" href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noopener noreferrer">${titleText}</a>`
      : `<span class="event-title">${titleText}</span>`;
    return `
    <div class="event-row">
      <div class="event-meta">
        <span class="event-type">${escapeHtml(event.eventType || "")}</span>
        <span class="event-date">${escapeHtml(event.eventDate || "")}</span>
      </div>
      <div>
        ${titleHtml}
        ${sub ? `<span class="event-sub">${escapeHtml(sub)}</span>` : ""}
        ${source ? `<span class="event-sub event-source">Source: ${escapeHtml(source)}${isHttp(event.sourceUrl) ? " · opens in new tab" : ""}</span>` : ""}
      </div>
    </div>`;
  }).join("") : `<p class="muted">No recent events stored for this ticker.</p>`;
}

function renderStockLots(detail) {
  const lots = detail.lots || [];
  const baseCurrency = detail.position?.baseCurrency || state.dashboard?.user?.baseCurrency || detail.quote?.currency || "USD";
  $("#stockLotsTable").innerHTML = lots.length ? lots.map((lot) => {
    const soldQuantity = lot.soldQuantity ?? Math.max(0, (Number(lot.originalQuantity) || 0) - (Number(lot.quantity) || 0));
    const sales = (lot.sales || []).map((sale) => `
      <div class="lot-event sale">
        <strong>Sold ${escapeHtml(sale.soldAt || "")}</strong>
        <span>${number(sale.quantity, 4)} shares @ ${money(sale.salePrice, sale.saleCurrency)}</span>
        <span>${money(sale.proceedsBase, baseCurrency)} proceeds</span>
        <span class="${sale.gainLossBase > 0 ? "positive" : sale.gainLossBase < 0 ? "negative" : ""}">${signedMoney(sale.gainLossBase, baseCurrency)}</span>
      </div>
    `).join("");
    return `
      <div class="compact-row wide lot-detail-row">
        <div><strong>${escapeHtml(lot.purchaseDate || "")}</strong><br><span class="muted">${number(lot.quantity, 4)} open / ${number(lot.originalQuantity, 4)} original${soldQuantity ? ` / ${number(soldQuantity, 4)} sold` : ""}</span></div>
        <div>${money(lot.purchasePrice, lot.purchaseCurrency)}</div>
        <div>${money(lot.costBasisBase, baseCurrency)} basis</div>
        <div class="button-row">
          ${lot.quantity > 0 ? `<button class="button" data-open-sale="${detail.ticker}" data-lot-id="${lot.id}" data-quantity="${lot.quantity}" data-price="${detail.quote?.price || ""}" data-currency="${detail.quote?.currency || lot.purchaseCurrency}" type="button">Sell</button>` : ""}
          <button class="button" data-open-alert="${detail.ticker}" data-scope="LOT" data-lot-id="${lot.id}" type="button">Alert</button>
        </div>
        <div class="lot-events compact">
          <div class="lot-event buy">
            <strong>Buy</strong>
            <span>${number(lot.originalQuantity, 4)} shares</span>
            <span>${money(lot.purchasePrice, lot.purchaseCurrency)}</span>
            <span>${escapeHtml(lot.purchaseDate || "")}</span>
          </div>
          ${sales || `<div class="lot-event muted"><strong>No sales yet</strong><span>This lot is still fully open.</span></div>`}
        </div>
      </div>
    `;
  }).join("") : `<p class="muted">No lots saved for this ticker.</p>`;
}

function renderStockPerformance() {
  renderRangeTabs();
  const performance = state.stockPerformance;
  $("#stockPerformanceTitle").textContent = state.currentStockTicker ? `${state.currentStockTicker} Performance` : "Ticker Performance";
  $("#stockPerformanceStatus").textContent = state.stockLoading
    ? "Loading historical prices..."
    : performance?.points?.length
      ? `${performance.points.length} historical points via ${performance.provider || "yahoo"}`
      : "No historical prices loaded yet.";
  $("#stockPerformanceStats").innerHTML = performanceStatsHtml(performance);
  renderPerformanceChart(
    "#stockPerformanceChart",
    performance,
    state.stockLoading ? "Loading performance history..." : "No historical performance available for this ticker"
  );
}

function renderStockPage() {
  const detail = state.stockDetail;
  if (!detail) {
    renderStockLoading(state.currentStockTicker);
    return;
  }
  renderStockProfile(detail);
  renderStockQuoteTiles(detail);
  renderStockFundamentals(detail);
  renderStockOwnership(detail);
  renderStockEvents(detail);
  renderStockLots(detail);
  renderStockPerformance();
}

async function openStockPage(tickerInput, { refresh = false } = {}) {
  const ticker = String(tickerInput || "").trim().toUpperCase();
  if (!ticker) return;
  if (state.currentView !== "stock") state.stockPreviousView = state.currentView;
  state.currentStockTicker = ticker;
  state.stockDetail = null;
  state.stockPerformance = null;
  state.stockLoading = true;
  setView("stock");
  renderStockLoading(ticker);
  try {
    const [detail, performance] = await Promise.all([
      api(`/api/stocks/${encodeURIComponent(ticker)}${refresh ? "?refresh=true" : ""}`),
      api(`/api/performance/ticker/${encodeURIComponent(ticker)}?range=${encodeURIComponent(state.stockPerformanceRange)}`)
    ]);
    state.stockDetail = detail;
    state.stockPerformance = performance;
  } catch (error) {
    toastError(error);
    state.stockDetail = {
      ticker,
      name: "",
      quote: null,
      fundamentals: null,
      profile: { summary: error.message },
      position: { baseCurrency: state.dashboard?.user?.baseCurrency || "USD" },
      lots: [],
      watchlistItems: [],
      alerts: [],
      events: []
    };
  } finally {
    state.stockLoading = false;
    renderStockPage();
  }
}

async function loadStockPerformance(range = state.stockPerformanceRange) {
  if (!state.currentStockTicker) return;
  state.stockLoading = true;
  renderStockPerformance();
  try {
    state.stockPerformance = await api(`/api/performance/ticker/${encodeURIComponent(state.currentStockTicker)}?range=${encodeURIComponent(range)}`);
  } catch (error) {
    state.stockPerformance = {
      range,
      currency: state.stockDetail?.quote?.currency || "USD",
      points: [],
      warnings: [error.message]
    };
  } finally {
    state.stockLoading = false;
    renderStockPerformance();
  }
}

function fundamentalsCovered(row) {
  return row?.fundamentals?.status === "LIVE" || row?.fundamentals?.status === "NOT_APPLICABLE";
}

function monitoredFundamentalRows() {
  const rows = new Map();
  for (const position of state.dashboard.positions || []) {
    if (position.closed || position.quantity <= 0) continue;
    rows.set(position.ticker, {
      ticker: position.ticker,
      name: position.name,
      group: categoryNameFor(position),
      owned: true,
      valueBase: position.currentValueBase || 0,
      fundamentals: position.fundamentals
    });
  }
  for (const item of state.dashboard.watchlist || []) {
    if (!rows.has(item.ticker)) {
      rows.set(item.ticker, {
        ticker: item.ticker,
        name: item.name,
        group: item.watchlistName,
        owned: false,
        valueBase: 0,
        fundamentals: item.fundamentals
      });
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.owned !== b.owned) return a.owned ? -1 : 1;
    return (b.valueBase || 0) - (a.valueBase || 0) || a.ticker.localeCompare(b.ticker);
  });
}

function renderValuationMonitor() {
  const rows = monitoredFundamentalRows();
  const covered = rows.filter(fundamentalsCovered);
  const staleOrMissing = rows.length - covered.length;
  const valuationStatus = $("#valuationStatus");
  if (valuationStatus) {
    valuationStatus.textContent = `${covered.length}/${rows.length} tickers covered${staleOrMissing ? ` | ${staleOrMissing} missing/stale` : ""}`;
  }
  $("#valuationTable").innerHTML = rows.length ? rows.slice(0, 12).map((row) => {
    const f = row.fundamentals || {};
    const statusClass = f.status === "LIVE" ? "live" : f.status === "NOT_APPLICABLE" ? "" : "warning";
    return `
      <div class="valuation-card-row">
        <div class="valuation-name">
          ${tickerButton(row.ticker)}
          <span>${row.owned ? "Portfolio" : "Watchlist"} | ${row.group || ""}</span>
        </div>
        <div class="valuation-metrics">
          <span>P/E <strong>${metricText(f.peRatio)}</strong></span>
          <span>Fwd <strong>${metricText(f.forwardPe)}</strong></span>
          <span>EV/EBITDA <strong>${metricText(f.evEbitda)}</strong></span>
          <span>P/S <strong>${metricText(f.priceSales)}</strong></span>
          <span>FCF <strong>${metricText(f.fcfYield, "%")}</strong></span>
          <span>PEG <strong>${metricText(f.peg)}</strong></span>
        </div>
        <div class="valuation-status">
          <span>Rev ${metricText(f.revenueGrowth, "%")}</span>
          <span class="status-pill ${statusClass}">${f.status || "MISSING"}</span>
        </div>
      </div>
    `;
  }).join("") : `<p class="muted">No monitored tickers yet</p>`;
}

function eventImportance(event) {
  const rank = {
    GUIDANCE_CHANGE: 0,
    REGULATORY_RISK: 1,
    EARNINGS_RESULT: 2,
    COMPETITIVE_THREAT: 3,
    ACQUISITION: 4,
    PRODUCT_LAUNCH: 5,
    REGULATORY_FILING: 6,
    EARNINGS: 7,
    DIVIDEND: 8,
    STOCK_SPLIT: 9
  };
  return rank[event.eventType] ?? 20;
}

function sourceCredibility(event) {
  if (isPrimarySource(event)) return { label: "Primary", className: "live" };
  if (isReputableFeedSource(event)) return { label: "Authoritative secondary", className: "ai" };
  return { label: "Unverified", className: "warning" };
}

function londonTimeLabel(value) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return `${date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  })} London`;
}

function publishedAtForEvent(event) {
  if (event.publishedAt) return event.publishedAt;
  if (event.createdAt && event.eventType !== "EARNINGS") return event.createdAt;
  if (event.eventDate && event.eventType !== "EARNINGS") return event.eventDate;
  return "";
}

function freshnessForEvent(event) {
  const published = publishedAtForEvent(event);
  if (!published) return { label: "Source date unavailable", className: "neutral", tooltip: "Publication timestamp was not supplied by the provider" };
  const time = new Date(published).getTime();
  if (!Number.isFinite(time) || time > Date.now() + 60 * 60 * 1000) {
    return { label: "Invalid date", className: "warning", tooltip: published };
  }
  const hours = (Date.now() - time) / 36e5;
  if (hours < 6) return { label: "Live", className: "live", tooltip: published };
  if (hours < 24) return { label: "Recent", className: "live", tooltip: published };
  if (hours < 24 * 7) return { label: "Current", className: "ai", tooltip: published };
  if (hours < 24 * 30) return { label: "Older", className: "warning", tooltip: published };
  return { label: "Stale", className: "negative", tooltip: published };
}

function signalConfidence(event) {
  const credibility = sourceCredibility(event).label;
  if (credibility === "Primary" && eventImportance(event) <= 4) return "High";
  if (credibility === "Authoritative secondary" || eventImportance(event) <= 7) return "Medium";
  return "Low";
}

function impactForEvent(event) {
  const text = `${event.title || ""} ${event.details || ""}`.toLowerCase();
  if (/cut|miss|risk|probe|lawsuit|warning|downgrade|delay|weak/.test(text)) return "Negative";
  if (/raise|beat|approval|upgrade|growth|record|strong|win/.test(text)) return "Positive";
  if (/mixed|offset|but|however/.test(text)) return "Mixed";
  return "Neutral";
}

function signalTypeLabel(event) {
  const map = {
    GUIDANCE_CHANGE: "Guidance changed",
    REGULATORY_RISK: "Regulatory risk",
    EARNINGS_RESULT: "Earnings revision",
    COMPETITIVE_THREAT: "Thesis weakened",
    ACQUISITION: "Capital allocation",
    PRODUCT_LAUNCH: "Thesis strengthened",
    REGULATORY_FILING: "Material filing",
    EARNINGS: "Earnings revision",
    DIVIDEND: "Capital allocation",
    STOCK_SPLIT: "Capital allocation"
  };
  return map[event.eventType] || "Risk escalation";
}

function ownedTickerSet() {
  return new Set((state.dashboard?.positions || [])
    .filter((position) => !position.closed && (Number(position.quantity) || 0) > 0)
    .map((position) => normalizePulseSymbol(position.ticker))
    .filter(Boolean));
}

function portfolioScopedEvent(event, ownedTickers) {
  const ticker = normalizePulseSymbol(event?.ticker);
  return ticker && ownedTickers.has(ticker);
}

function signalEligibleEvent(event, ownedTickers) {
  if (!portfolioScopedEvent(event, ownedTickers)) return false;
  if (!hasVerifiedSource(event)) return false;
  if (["EARNINGS", "EARNINGS_RESULT"].includes(event.eventType)) return false;
  return eventImportance(event) <= 7;
}

function marketNewsItemsFromState(events, ownedTickers) {
  const apiItems = Array.isArray(state.news?.items) ? state.news.items : [];
  const mappedApiItems = apiItems
    .filter((item) => portfolioScopedEvent(item, ownedTickers) && safeExternalHref(item.sourceUrl))
    .map((item) => ({
      ...item,
      eventType: item.eventType || "NEWS",
      eventDate: item.eventDate || (item.publishedAt ? String(item.publishedAt).slice(0, 10) : ""),
      source: item.source || "finnhub_news",
      newsSource: item.newsSource || item.sourceName || "Market news"
    }));
  const eventItems = events.filter((event) => (
    portfolioScopedEvent(event, ownedTickers)
    && safeExternalHref(event.sourceUrl)
    && event.eventType !== "EARNINGS_RESULT"
    && event.eventType !== "EARNINGS"
  ));
  const seen = new Set();
  return [...mappedApiItems, ...eventItems].filter((item) => {
    const key = item.sourceUrl || `${item.ticker}:${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function signalsFallbackHtml(newsEvents, ownedTickers) {
  const ownedNews = (newsEvents || [])
    .filter((item) => ownedTickers.has(normalizePulseSymbol(item.ticker || "")))
    .slice(0, 6);
  if (!ownedNews.length) {
    return `<p class="muted">No thesis-changing signals right now. Routine earnings events are excluded &mdash; new guidance, ratings, M&amp;A or analyst news on your holdings will appear here automatically.</p>`;
  }
  return ownedNews.map((event) => `
    <div class="signal-card-row">
      <div class="news-card-meta">
        ${tickerButton(event.ticker)}
        <span>${escapeHtml(londonTimeLabel(publishedAtForEvent(event)))}</span>
      </div>
      <div class="news-card-body">
        <strong>${escapeHtml(event.title || "")}</strong>
        <p>${escapeHtml(event.details || event.summary || "Owned-position news.")}</p>
        <div class="news-source-row">${sourcePill(event)}${sourceLink(event, "Open source")}</div>
      </div>
    </div>
  `).join("");
}

function renderNewsIntelligence() {
  const ownedTickers = ownedTickerSet();
  const events = [...(state.dashboard.events || [])]
    .sort((a, b) => eventImportance(a) - eventImportance(b)
      || Number(!isReputableFeedSource(a)) - Number(!isReputableFeedSource(b))
      || String(b.eventDate).localeCompare(String(a.eventDate)));
  const thesisEvents = events.filter((event) => signalEligibleEvent(event, ownedTickers));
  const newsEvents = marketNewsItemsFromState(events, ownedTickers);
  const signalStatus = $("#signalStatus");
  if (signalStatus) {
    const highConfidence = thesisEvents.filter((event) => signalConfidence(event) === "High").length;
    signalStatus.textContent = `${thesisEvents.length} owned-position signals | ${highConfidence} high confidence`;
  }
  const signalsNode = $("#signalsTable");
  if (signalsNode) signalsNode.innerHTML = thesisEvents.length ? thesisEvents.slice(0, 8).map((event) => {
    const credibility = sourceCredibility(event);
    const freshness = freshnessForEvent(event);
    const confidence = signalConfidence(event);
    return `
      <div class="signal-card-row">
        <div class="news-card-meta">
          ${tickerButton(event.ticker)}
          <span class="status-pill ${freshness.className}" title="${escapeHtml(freshness.tooltip)}">${freshness.label}</span>
        </div>
        <div class="news-card-body">
          <div class="news-card-tags">
            <span class="status-pill ${eventImportance(event) <= 2 ? "warning" : "ai"}">${escapeHtml(signalTypeLabel(event))}</span>
            <span class="status-pill ${credibility.className}">${credibility.label}</span>
            <span class="status-pill ${confidence === "High" ? "live" : confidence === "Medium" ? "ai" : "warning"}">${confidence}</span>
          </div>
          <strong>${escapeHtml(event.title)}</strong>
          <p>${escapeHtml(event.details || "Verified development may affect thesis, valuation, risk, or position sizing.")}</p>
          <div class="news-source-row">
            <span class="muted">Impact ${impactForEvent(event)} | Status New</span>
            ${sourcePill(event)}${sourceLink(event, "Open source")}
          </div>
        </div>
      </div>
    `;
  }).join("") : signalsFallbackHtml(newsEvents, ownedTickers);

  const newsStatus = $("#marketNewsStatus");
  if (newsStatus) {
    const reputable = newsEvents.filter(isReputableFeedSource).length;
    const status = state.news?.diagnostics?.status || "cached events";
    newsStatus.textContent = `${newsEvents.length} articles | ${reputable} official/reputable | ${status}`;
  }
  const newsNode = $("#marketNewsTable");
  if (newsNode) newsNode.innerHTML = newsEvents.length ? newsEvents.slice(0, 8).map((event) => {
    const freshness = freshnessForEvent(event);
    return `
      <div class="news-card-row">
        <div class="news-card-meta">
          ${tickerButton(event.ticker)}
          <span title="${escapeHtml(freshness.tooltip)}">${escapeHtml(londonTimeLabel(publishedAtForEvent(event)))}</span>
        </div>
        <div class="news-card-body">
          <div class="news-card-tags">
            <span class="status-pill ai">${escapeHtml(event.eventType || "Company")}</span>
            <span class="status-pill ${freshness.className}">${freshness.label}</span>
            <span class="status-pill neutral">Impact ${impactForEvent(event)}</span>
          </div>
          <strong>${escapeHtml(event.title)}</strong>
          <p>${escapeHtml(event.details || "Source-linked portfolio news item.")}</p>
          <div class="news-source-row">${sourcePill(event)}<span class="muted">${escapeHtml(readableFeedSource(event))}</span>${sourceLink(event, "Open source")}</div>
        </div>
      </div>
    `;
  }).join("") : `
    <div class="empty-state">
      <strong>No source-linked portfolio news yet</strong>
      <span>${escapeHtml(state.news?.diagnostics?.message || "Refresh News will check Finnhub company news for the equities you currently own.")}</span>
    </div>
  `;
}

function renderDividends() {
  const { dividends, user } = state.dashboard;
  $("#dividendCount").textContent = dividends?.length ? `${dividends.length} payments` : "";
  $("#dividendsTable").innerHTML = dividends?.length ? dividends.slice(0, 40).map((item) => {
    const detail = item.source === "netwealth" && (!item.eligibleQuantity || !item.amountPerShare)
      ? "Netwealth cash distribution"
      : `${number(item.eligibleQuantity, 4)} shares x ${money(item.amountPerShare, item.currency)}`;
    return `
      <div class="compact-row wide">
        <div>${tickerButton(item.ticker)}<br><span class="muted">Ex ${item.exDate}</span></div>
        <div>${detail}</div>
        <div>${money(item.grossAmount, item.currency)}</div>
        <div class="num">${money(item.grossAmountBase, user.baseCurrency)}</div>
      </div>
    `;
  }).join("") : `<p class="muted">No dividends synced yet</p>`;
}

function renderExternalTransactions() {
  const { externalTransactions = [], user } = state.dashboard;
  const countNode = $("#externalTransactionCount");
  const tableNode = $("#externalTransactionsTable");
  if (!countNode || !tableNode) return;
  countNode.textContent = externalTransactions.length ? `${externalTransactions.length} saved` : "None saved";
  tableNode.innerHTML = externalTransactions.length ? externalTransactions.map((item) => {
    const gainClass = item.gainLossBase > 0 ? "positive" : item.gainLossBase < 0 ? "negative" : "";
    return `
      <div class="compact-row closed-transaction-row">
        <div>${tickerButton(item.ticker)}<br><span class="muted">${escapeHtml(item.notes || "Outside broker")}</span></div>
        <div class="transaction-legs">
          <span><strong>Buy</strong> ${escapeHtml(item.boughtAt)} | ${number(item.quantity, 4)} @ ${money(item.buyPrice, item.buyCurrency)}</span>
          <span><strong>Sell</strong> ${escapeHtml(item.soldAt)} | ${number(item.quantity, 4)} @ ${money(item.salePrice, item.saleCurrency)}</span>
        </div>
        <div class="num ${gainClass}">
          ${signedMoney(item.gainLossBase, user.baseCurrency)}
          <br><span>${signedPercent(item.gainLossPercent)}</span>
        </div>
        <div class="button-row">
          <button class="button danger" data-delete-external-transaction="${escapeHtml(item.id)}" type="button">Delete</button>
        </div>
      </div>
    `;
  }).join("") : `
    <div class="empty-state">
      <strong>No outside-broker closed trades saved</strong>
      <span>Add older closed trades here so their realized gains or losses remain in the portfolio total.</span>
    </div>
  `;
}

const REALIZED_RANGES = [
  ["month", "Month"],
  ["ytd", "YTD"],
  ["1y", "1Y"],
  ["3y", "3Y"],
  ["5y", "5Y"],
  ["all", "All"]
];
const REALIZED_FILTERS = [
  ["all", "All"],
  ["sales", "Sales"],
  ["dividends", "Dividends"],
  ["external_income", "External income"],
  ["external_expense", "External expenses"]
];
const REALIZED_MODES = [
  ["realized_growth", "Realized Growth"],
  ["book_value", "Book Value"],
  ["portfolio_value", "Actual Value"]
];
const REALIZED_VIEWS = [
  ["timeline", "Timeline"],
  ["transactions", "Transactions"],
  ["dividends", "Dividends"],
  ["external", "External Income"]
];

function renderSegmentButtons(node, options, currentValue, dataName) {
  if (!node) return;
  node.innerHTML = options.map(([value, label]) => `
    <button class="range-tab ${value === currentValue ? "active" : ""}" data-${dataName}="${value}" aria-selected="${value === currentValue}" type="button">${escapeHtml(label)}</button>
  `).join("");
}

function realizedEventLabel(event) {
  const kind = event.transactionType || event.type;
  return {
    share_sale: Number(event.amountBase) >= 0 ? "Share gain" : "Share loss",
    dividend: "Dividend",
    external_income: "External income",
    external_expense: "External expense"
  }[kind] || "Realized event";
}

function realizedEventClass(event) {
  const kind = event.transactionType || event.type;
  if (kind === "external_expense") return "negative expense";
  if (kind === "share_sale" && Number(event.amountBase) < 0) return "negative sale";
  if (kind === "dividend") return "positive dividend";
  if (kind === "external_income") return "positive external";
  return "positive sale";
}

function realizedEventSource(event) {
  return event.ticker || event.source || event.details?.description || "Manual entry";
}

function realizedRows(events, { only = "all", externalActions = false } = {}) {
  const baseCurrency = state.realizedIncome?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  const filtered = events.filter((event) => {
    if (only === "dividends") return event.transactionType === "dividend";
    if (only === "external") return event.transactionType === "external_income" || event.transactionType === "external_expense";
    return true;
  });
  if (!filtered.length) {
    return `
      <div class="empty-state">
        <strong>No completed entries in this view</strong>
        <span>Change the filter or period to include more realized history.</span>
      </div>
    `;
  }
  return filtered.map((event) => {
    const details = event.details || {};
    const amountClass = Number(event.amountBase) < 0 ? "negative" : "positive";
    const original = `${money(event.amountOriginal, event.currency)} original`;
    const converted = event.conversionUnavailable
      ? "FX unavailable"
      : `${signedMoney(event.amountBase, baseCurrency)} base`;
    const sourceLabel = event.ticker ? tickerButton(event.ticker, realizedEventSource(event)) : escapeHtml(realizedEventSource(event));
    const quantity = details.quantity != null ? `${number(details.quantity, 4)} shares` : "";
    const tradeDetail = event.transactionType === "share_sale"
      ? `${quantity}${quantity ? " | " : ""}Sold @ ${money(details.salePrice, details.saleCurrency)} | Cost ${money(details.costBasisBase, baseCurrency)}`
      : event.transactionType === "dividend"
        ? `${number(details.eligibleQuantity, 4)} shares | ${money(details.amountPerShare, event.currency)} per share`
        : `${escapeHtml(details.category || "")}${details.feesTax ? ` | Fees/tax ${money(details.feesTax, event.currency)}` : ""}`;
    const actions = externalActions && (event.transactionType === "external_income" || event.transactionType === "external_expense")
      ? `
        <div class="button-row">
          <button class="button secondary" data-edit-external-income="${escapeHtml(event.id)}" type="button">Edit</button>
          <button class="button danger" data-delete-external-income="${escapeHtml(event.id)}" type="button">Delete</button>
        </div>
      `
      : "";
    return `
      <div class="compact-row realized-income-row">
        <div>
          <span class="income-dot ${realizedEventClass(event)}"></span>
          <strong>${escapeHtml(realizedEventLabel(event))}</strong>
          <br><span class="muted">${escapeHtml(event.date)} | ${sourceLabel}</span>
        </div>
        <div>${tradeDetail}<br><span class="muted">${escapeHtml(details.notes || details.description || "")}</span></div>
        <div class="num ${amountClass}">
          ${converted}
          <br><span class="muted">${original}</span>
        </div>
        ${actions}
      </div>
    `;
  }).join("");
}

function renderRealizedIncomeSummary() {
  const node = $("#realizedIncomeSummary");
  if (!node) return;
  const wealth = state.portfolioWealth;
  const baseCurrency = wealth?.baseCurrency || state.realizedIncome?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  const summary = wealth?.summary || {};
  const cards = [
    ["Net capital contributed", summary.netCapitalContributedBase, valueClass(summary.netCapitalContributedBase), "signed"],
    ["Open-lot cost basis", summary.currentOpenCostBasisBase, "", "money"],
    ["Net realized P&L", summary.netRealizedPnlBase, valueClass(summary.netRealizedPnlBase), "signed"],
    ["Dividends", summary.dividendsBase, "positive", "signed"],
    ["External income", summary.externalIncomeBase, "positive", "signed"],
    ["External expenses", summary.externalExpensesBase, "negative", "signed"],
    ["Current cash", summary.currentCashBase, "", "money"],
    ["Current portfolio market value", summary.currentPortfolioMarketValueBase, "", "money"],
    ["Current book value", summary.currentBookValueBase, "", "money"],
    ["Saved snapshots", summary.snapshotCount || 0, "", "number"]
  ];
  node.innerHTML = cards.map(([label, value, className, kind]) => `
    <div class="metric-card compact">
      <span>${escapeHtml(label)}</span>
      <strong class="${className}">
        ${kind === "number" ? number(value || 0, 0) : kind === "signed" ? signedMoney(value || 0, baseCurrency) : money(value || 0, baseCurrency)}
      </strong>
    </div>
  `).join("");
}

function realizedChartShape(event, x, y, index) {
  const cls = `realized-point ${realizedEventClass(event)}`;
  const label = escapeHtml(`${event.date} ${realizedEventLabel(event)} ${realizedEventSource(event)}`);
  if (event.transactionType === "dividend") {
    return `<rect class="${cls}" data-income-point="${index}" x="${x - 5}" y="${y - 5}" width="10" height="10" transform="rotate(45 ${x} ${y})" aria-label="${label}"></rect>`;
  }
  if (event.transactionType === "external_income") {
    return `<polygon class="${cls}" data-income-point="${index}" points="${x},${y - 7} ${x - 7},${y + 6} ${x + 7},${y + 6}" aria-label="${label}"></polygon>`;
  }
  if (event.transactionType === "external_expense") {
    return `<rect class="${cls}" data-income-point="${index}" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2" aria-label="${label}"></rect>`;
  }
  return `<circle class="${cls}" data-income-point="${index}" cx="${x}" cy="${y}" r="6" aria-label="${label}"></circle>`;
}

function wealthEventLabel(event) {
  return {
    opening_balance: "Opening balance",
    buy: "Buy",
    share_sale: Number(event.realizedGainLossBase) >= 0 ? "Sale gain" : "Sale loss",
    dividend: "Dividend",
    external_income: "External income",
    external_expense: "External expense",
    deposit: "Deposit / cash adjustment",
    withdrawal: "Withdrawal / cash adjustment"
  }[event.type] || "Portfolio event";
}

function wealthEventClass(event) {
  if (event.type === "share_sale") return Number(event.realizedGainLossBase) >= 0 ? "positive sale" : "negative sale";
  if (event.type === "dividend") return "positive dividend";
  if (event.type === "external_income") return "positive external";
  if (event.type === "external_expense") return "negative expense";
  if (event.type === "withdrawal") return "negative neutral";
  return "neutral";
}

function wealthEventAmount(event, baseCurrency) {
  if (event.type === "share_sale") return signedMoney(event.realizedGainLossBase || 0, baseCurrency);
  return signedMoney(event.amountBase || 0, baseCurrency);
}

function wealthEventShape(event, x, y, index) {
  const cls = `realized-point wealth-marker ${wealthEventClass(event)}`;
  const label = escapeHtml(`${event.date} ${wealthEventLabel(event)} ${event.source || event.ticker || ""}`);
  if (event.type === "dividend") {
    return `<rect class="${cls}" data-income-point="${index}" x="${x - 5}" y="${y - 5}" width="10" height="10" transform="rotate(45 ${x} ${y})" aria-label="${label}"></rect>`;
  }
  if (event.type === "external_income" || event.type === "external_expense") {
    return `<polygon class="${cls}" data-income-point="${index}" points="${x},${y - 8} ${x - 7},${y + 6} ${x + 7},${y + 6}" aria-label="${label}"></polygon>`;
  }
  if (event.type === "deposit" || event.type === "withdrawal" || event.type === "opening_balance" || event.type === "buy") {
    return `<rect class="${cls}" data-income-point="${index}" x="${x - 5}" y="${y - 5}" width="10" height="10" rx="3" aria-label="${label}"></rect>`;
  }
  return `<circle class="${cls}" data-income-point="${index}" cx="${x}" cy="${y}" r="6" aria-label="${label}"></circle>`;
}

function closestChartPoint(points, date) {
  if (!points.length) return null;
  let best = points[0];
  for (const point of points) {
    if (point.date <= date) best = point;
    else break;
  }
  return best;
}

function incomeChartScales(plotted, valueKeys, options = {}) {
  const width = 900;
  const height = 300;
  const pad = { left: 96, right: 34, top: 28, bottom: 54 };
  const values = plotted.flatMap((point) => valueKeys.map((key) => Number(point[key])).filter(Number.isFinite));
  if (options.includeZero) values.push(0);
  const minTime = Math.min(...plotted.map((point) => point.timestamp));
  const maxTime = Math.max(...plotted.map((point) => point.timestamp));
  const minValueRaw = Math.min(...values);
  const maxValueRaw = Math.max(...values);
  const spanValue = maxValueRaw - minValueRaw || Math.max(1, Math.abs(maxValueRaw || minValueRaw || 1));
  const minY = minValueRaw - spanValue * 0.12;
  const maxY = maxValueRaw + spanValue * 0.12;
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  return {
    width,
    height,
    pad,
    minTime,
    maxTime,
    minY,
    maxY,
    xFor: (timestamp) => pad.left + ((timestamp - minTime) / Math.max(1, maxTime - minTime)) * chartWidth,
    yFor: (value) => pad.top + ((maxY - value) / Math.max(1, maxY - minY)) * chartHeight
  };
}

function chartAxes(scales, plotted, baseCurrency) {
  const { width, height, pad, minTime, maxTime, minY, maxY, xFor, yFor } = scales;
  const yTicks = Array.from({ length: 5 }, (_, index) => minY + ((maxY - minY) * index) / 4);
  const xTickCount = Math.min(6, Math.max(2, plotted.length));
  const xTicks = Array.from({ length: xTickCount }, (_, index) => {
    const value = minTime + ((maxTime - minTime) * index) / Math.max(1, xTickCount - 1);
    return new Date(value);
  });
  return `
    ${yTicks.map((tick) => {
      const y = yFor(tick);
      return `
        <line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" class="grid-line"></line>
        <text x="${pad.left - 12}" y="${y + 4}" text-anchor="end" class="axis-label">${money(tick, baseCurrency)}</text>
      `;
    }).join("")}
    ${xTicks.map((tick) => {
      const x = xFor(tick.getTime());
      return `<text x="${x}" y="${height - 18}" text-anchor="middle" class="axis-label">${tick.toISOString().slice(0, 10)}</text>`;
    }).join("")}
  `;
}

function linePath(plotted, valueKey, scales) {
  return plotted.map((point, index) => `${index === 0 ? "M" : "L"} ${scales.xFor(point.timestamp).toFixed(2)} ${scales.yFor(point[valueKey]).toFixed(2)}`).join(" ");
}

function areaPath(plotted, valueKey, scales) {
  const path = linePath(plotted, valueKey, scales);
  if (!path) return "";
  const { height, pad, xFor } = scales;
  return `${path} L ${xFor(plotted.at(-1).timestamp).toFixed(2)} ${height - pad.bottom} L ${xFor(plotted[0].timestamp).toFixed(2)} ${height - pad.bottom} Z`;
}

function segmentedLinePaths(plotted, valueKey, scales, maxGapDays = 1.5) {
  const segments = [];
  let current = [];
  for (const point of plotted) {
    const previous = current.at(-1);
    const gapDays = previous ? (point.timestamp - previous.timestamp) / 86400000 : 0;
    if (previous && gapDays > maxGapDays) {
      if (current.length > 1) segments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
  }
  if (current.length > 1) segments.push(current);
  return segments.map((segment) => linePath(segment, valueKey, scales));
}

function renderEmptyIncomeChart(title, subtitle) {
  const svg = $("#realizedIncomeChart");
  if (!svg) return;
  state.realizedIncomeChartEvents = [];
  svg.innerHTML = `
    <rect width="900" height="300" rx="18" class="chart-empty-bg"></rect>
    <text x="450" y="142" text-anchor="middle" class="chart-empty-title">${escapeHtml(title)}</text>
    <text x="450" y="170" text-anchor="middle" class="chart-empty-subtitle">${escapeHtml(subtitle)}</text>
  `;
}

function renderRealizedGrowthChart() {
  const svg = $("#realizedIncomeChart");
  const payload = state.portfolioWealth;
  if (!svg) return;
  const baseCurrency = payload?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  const points = (payload?.realizedGrowth?.points || []).map((point) => ({
    ...point,
    chartKind: "realized_growth_point",
    chartValue: Number(point.cumulativeRealizedBase),
    timestamp: Date.parse(`${point.date}T00:00:00Z`)
  })).filter((point) => Number.isFinite(point.chartValue) && Number.isFinite(point.timestamp));
  if (!points.length) {
    renderEmptyIncomeChart("No realized entries", "Sales, CSV dividends, and manual income will build this line.");
    return;
  }
  const scales = incomeChartScales(points, ["chartValue"], { includeZero: true });
  const chartEvents = [...points];
  const eventShapes = (payload?.realizedGrowth?.events || [])
    .filter((event) => event.date >= payload.startDate && event.date <= points.at(-1).date)
    .map((event) => {
      const anchor = closestChartPoint(points, event.date);
      if (!anchor) return "";
      const eventWithKind = {
        ...event,
        chartKind: "realized_growth_event",
        cumulativeRealizedBase: anchor.cumulativeRealizedBase,
        chartValue: anchor.chartValue
      };
      const index = chartEvents.push(eventWithKind) - 1;
      return realizedChartShape(eventWithKind, scales.xFor(Date.parse(`${event.date}T00:00:00Z`)), scales.yFor(anchor.chartValue), index);
    }).join("");
  state.realizedIncomeChartEvents = chartEvents;
  const first = points[0];
  const last = points.at(-1);
  const pointPath = linePath(points, "chartValue", scales);
  const fillPath = areaPath(points, "chartValue", scales);
  const hoverPoints = points.map((point, index) => {
    const x = scales.xFor(point.timestamp);
    const y = scales.yFor(point.chartValue);
    return `
      <g class="wealth-point-group">
        <line x1="${x}" x2="${x}" y1="${scales.pad.top}" y2="${scales.height - scales.pad.bottom}" class="wealth-crosshair"></line>
        <circle class="wealth-hit" data-income-point="${index}" cx="${x}" cy="${y}" r="10" aria-label="${escapeHtml(point.date)} ${money(point.chartValue, baseCurrency)}"></circle>
      </g>
    `;
  }).join("");
  svg.innerHTML = `
    <rect width="${scales.width}" height="${scales.height}" rx="18" class="chart-empty-bg"></rect>
    <line x1="${scales.pad.left}" x2="${scales.width - scales.pad.right}" y1="${scales.yFor(0)}" y2="${scales.yFor(0)}" class="zero-line"></line>
    ${chartAxes(scales, points, baseCurrency)}
    <path d="${fillPath}" class="wealth-area realized-growth-area"></path>
    <path d="${pointPath}" class="wealth-line"></path>
    <circle cx="${scales.xFor(first.timestamp)}" cy="${scales.yFor(first.chartValue)}" r="4.5" class="wealth-anchor"></circle>
    <circle cx="${scales.xFor(last.timestamp)}" cy="${scales.yFor(last.chartValue)}" r="5.5" class="wealth-anchor current"></circle>
    <text x="${scales.xFor(first.timestamp) + 8}" y="${Math.max(16, scales.yFor(first.chartValue) - 10)}" class="wealth-label">${money(first.chartValue, baseCurrency)}</text>
    <text x="${Math.min(scales.width - 170, scales.xFor(last.timestamp) - 154)}" y="${Math.max(16, scales.yFor(last.chartValue) - 12)}" class="wealth-label current">${money(last.chartValue, baseCurrency)}</text>
    ${eventShapes}
    ${hoverPoints}
  `;
}

function renderBookValueChart() {
  const svg = $("#realizedIncomeChart");
  const payload = state.portfolioWealth;
  if (!svg) return;
  const baseCurrency = payload?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  const points = (payload?.bookValue?.points || []).map((point) => ({
    ...point,
    chartKind: "book_value_point",
    bookValueBase: Number(point.bookValueBase),
    netCapitalContributedBase: Number(point.netCapitalContributedBase || 0),
    timestamp: Date.parse(`${point.date}T00:00:00Z`)
  })).filter((point) => Number.isFinite(point.bookValueBase) && Number.isFinite(point.timestamp));
  if (!points.length) {
    renderEmptyIncomeChart("No book-value history", "Import transactions or set an opening balance to build cost-basis history.");
    return;
  }
  const scales = incomeChartScales(points, ["bookValueBase", "netCapitalContributedBase"], { includeZero: true });
  const chartEvents = [...points];
  const eventShapes = (payload?.bookValue?.events || [])
    .filter((event) => event.date >= payload.startDate && event.date <= points.at(-1).date)
    .map((event) => {
      const anchor = closestChartPoint(points, event.date);
      if (!anchor) return "";
      const eventWithKind = {
        ...event,
        chartKind: "book_value_event",
        bookValueBase: anchor.bookValueBase,
        cashValueBase: anchor.cashValueBase,
        remainingCostBasisBase: anchor.remainingCostBasisBase,
        netCapitalContributedBase: anchor.netCapitalContributedBase
      };
      const index = chartEvents.push(eventWithKind) - 1;
      return wealthEventShape(eventWithKind, scales.xFor(Date.parse(`${event.date}T00:00:00Z`)), scales.yFor(anchor.bookValueBase), index);
    }).join("");
  state.realizedIncomeChartEvents = chartEvents;
  const bookPath = linePath(points, "bookValueBase", scales);
  const contributionPath = linePath(points, "netCapitalContributedBase", scales);
  const fillPath = areaPath(points, "bookValueBase", scales);
  const hoverPoints = points.map((point, index) => {
    const x = scales.xFor(point.timestamp);
    const y = scales.yFor(point.bookValueBase);
    return `
      <g class="wealth-point-group">
        <line x1="${x}" x2="${x}" y1="${scales.pad.top}" y2="${scales.height - scales.pad.bottom}" class="wealth-crosshair"></line>
        <circle class="wealth-hit" data-income-point="${index}" cx="${x}" cy="${y}" r="10" aria-label="${escapeHtml(point.date)} ${money(point.bookValueBase, baseCurrency)}"></circle>
      </g>
    `;
  }).join("");
  svg.innerHTML = `
    <rect width="${scales.width}" height="${scales.height}" rx="18" class="chart-empty-bg"></rect>
    <line x1="${scales.pad.left}" x2="${scales.width - scales.pad.right}" y1="${scales.yFor(0)}" y2="${scales.yFor(0)}" class="zero-line"></line>
    ${chartAxes(scales, points, baseCurrency)}
    <path d="${fillPath}" class="wealth-area book-value-area"></path>
    <path d="${bookPath}" class="wealth-line"></path>
    <path d="${contributionPath}" class="wealth-line secondary"></path>
    ${eventShapes}
    ${hoverPoints}
  `;
}

function renderSnapshotChart() {
  const svg = $("#realizedIncomeChart");
  const payload = state.portfolioWealth;
  if (!svg) return;
  const baseCurrency = payload?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  const points = (payload?.actualPortfolioValue?.points || []).map((point) => ({
    ...point,
    chartKind: "snapshot_point",
    chartValue: Number(point.totalValueBase),
    timestamp: Date.parse(`${point.date}T00:00:00Z`)
  })).filter((point) => Number.isFinite(point.chartValue) && Number.isFinite(point.timestamp));
  if (!points.length) {
    renderEmptyIncomeChart("No market-value snapshots yet", "Refresh prices to save a daily snapshot, or add a broker statement snapshot below.");
    return;
  }
  const scales = incomeChartScales(points, ["chartValue"]);
  state.realizedIncomeChartEvents = [...points];
  const lineSegments = segmentedLinePaths(points, "chartValue", scales).map((path) => `<path d="${path}" class="wealth-line"></path>`).join("");
  const markers = points.map((point, index) => {
    const x = scales.xFor(point.timestamp);
    const y = scales.yFor(point.chartValue);
    const cls = point.manual ? "snapshot-marker manual" : "snapshot-marker auto";
    return point.manual
      ? `<rect class="${cls}" data-income-point="${index}" x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})"></rect>`
      : `<circle class="${cls}" data-income-point="${index}" cx="${x}" cy="${y}" r="5.5"></circle>`;
  }).join("");
  const hoverPoints = points.map((point, index) => {
    const x = scales.xFor(point.timestamp);
    const y = scales.yFor(point.chartValue);
    return `
      <g class="wealth-point-group">
        <line x1="${x}" x2="${x}" y1="${scales.pad.top}" y2="${scales.height - scales.pad.bottom}" class="wealth-crosshair"></line>
        <circle class="wealth-hit" data-income-point="${index}" cx="${x}" cy="${y}" r="11" aria-label="${escapeHtml(point.date)} ${money(point.chartValue, baseCurrency)}"></circle>
      </g>
    `;
  }).join("");
  const first = points[0];
  const last = points.at(-1);
  svg.innerHTML = `
    <rect width="${scales.width}" height="${scales.height}" rx="18" class="chart-empty-bg"></rect>
    ${chartAxes(scales, points, baseCurrency)}
    ${lineSegments}
    ${markers}
    <text x="${scales.xFor(first.timestamp) + 8}" y="${Math.max(16, scales.yFor(first.chartValue) - 10)}" class="wealth-label">${money(first.chartValue, baseCurrency)}</text>
    <text x="${Math.min(scales.width - 170, scales.xFor(last.timestamp) - 154)}" y="${Math.max(16, scales.yFor(last.chartValue) - 12)}" class="wealth-label current">${money(last.chartValue, baseCurrency)}</text>
    ${hoverPoints}
  `;
}

function renderRealizedIncomeChart() {
  if (state.realizedIncomeMode === "book_value") {
    renderBookValueChart();
  } else if (state.realizedIncomeMode === "portfolio_value") {
    renderSnapshotChart();
  } else {
    renderRealizedGrowthChart();
  }
}

function renderOpeningBalanceForm() {
  const form = $("#openingBalanceForm");
  if (!form) return;
  const opening = state.portfolioWealth?.openingBalance || {};
  const active = document.activeElement;
  const userCurrency = state.dashboard?.user?.baseCurrency || "AUD";
  if (!form.contains(active)) {
    form.elements.date.value = opening.date || state.portfolioWealth?.firstInvestmentDate || "";
    form.elements.amount.value = opening.configured ? Number(opening.amount || 0).toFixed(2) : "";
    form.elements.currency.value = opening.currency || userCurrency;
    form.elements.notes.value = opening.notes || "";
  }
  const status = $("#openingBalanceStatus");
  if (status) {
    status.textContent = opening.configured
      ? `Saved: ${money(opening.amountBase || 0, state.portfolioWealth?.baseCurrency || userCurrency)} base`
      : "Not set";
  }
}

function renderRealizedIncomeNotice() {
  const node = $("#realizedIncomeNotice");
  if (!node) return;
  const wealth = state.portfolioWealth || {};
  const warnings = wealth.dataQuality?.warnings || [];
  const notices = [];
  if (state.realizedIncomeMode === "realized_growth" && !(wealth.actualPortfolioValue?.points || []).length) {
    notices.push("Historical market prices are incomplete. Showing transaction-based results.");
  }
  if (state.realizedIncomeMode === "book_value") {
    notices.push(wealth.bookValue?.label || "Book value - does not include historical unrealized market gains.");
  }
  if (state.realizedIncomeMode === "portfolio_value") {
    notices.push("Actual Portfolio Value uses saved snapshots only. Dates without snapshots are not connected or estimated.");
  }
  for (const warning of warnings) {
    if (!notices.includes(warning)) notices.push(warning);
  }
  node.textContent = notices.slice(0, 2).join(" ");
  node.hidden = !node.textContent;
}

function resetManualSnapshotForm() {
  const form = $("#manualSnapshotForm");
  if (!form) return;
  form.reset();
  form.dataset.snapshotId = "";
  if (form.elements.currency) form.elements.currency.value = state.dashboard?.user?.baseCurrency || "AUD";
  const submit = $("#manualSnapshotSubmit");
  if (submit) submit.textContent = "Save Snapshot";
  const cancel = $("#manualSnapshotCancel");
  if (cancel) cancel.hidden = true;
}

function renderManualSnapshotForm() {
  const form = $("#manualSnapshotForm");
  if (!form) return;
  const active = document.activeElement;
  if (!form.contains(active) && !form.dataset.snapshotId && form.elements.currency) {
    form.elements.currency.value = state.dashboard?.user?.baseCurrency || "AUD";
  }
}

function renderPortfolioSnapshotsTable() {
  const node = $("#portfolioSnapshotsTable");
  if (!node) return;
  const snapshots = state.portfolioWealth?.snapshots || [];
  const baseCurrency = state.portfolioWealth?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  if (!snapshots.length) {
    node.innerHTML = `
      <div class="empty-state compact">
        <strong>No saved market-value snapshots yet</strong>
        <span>Refresh prices to save today's automatic snapshot, or enter an old broker statement above.</span>
      </div>
    `;
    return;
  }
  node.innerHTML = snapshots.map((snapshot) => {
    const sourceLabel = snapshot.manual ? "Manual broker snapshot" : "Automatic app snapshot";
    const actions = snapshot.manual
      ? `
        <div class="button-row">
          <button class="button secondary" data-edit-portfolio-snapshot="${escapeHtml(snapshot.id)}" type="button">Edit</button>
          <button class="button danger" data-delete-portfolio-snapshot="${escapeHtml(snapshot.id)}" type="button">Delete</button>
        </div>
      `
      : `<span class="muted">Auto</span>`;
    return `
      <div class="compact-row snapshot-row">
        <div>
          <strong>${escapeHtml(snapshot.date)}</strong>
          <br><span class="muted">${escapeHtml(sourceLabel)} | ${escapeHtml(snapshot.source || snapshot.provider || "-")}</span>
        </div>
        <div>Holdings<br><strong>${money(snapshot.holdingsValueBase, baseCurrency)}</strong></div>
        <div>Cash<br><strong>${money(snapshot.cashValueBase, baseCurrency)}</strong></div>
        <div>Total<br><strong>${money(snapshot.totalValueBase, baseCurrency)}</strong></div>
        <div class="muted">${snapshot.dataCoveragePercent == null ? "n/a" : `${number(snapshot.dataCoveragePercent, 2)}% coverage`}</div>
        ${actions}
      </div>
    `;
  }).join("");
}

function editPortfolioSnapshot(snapshotId) {
  const snapshot = (state.portfolioWealth?.snapshots || []).find((item) => String(item.id) === String(snapshotId));
  if (!snapshot || !snapshot.manual) {
    toast("Manual snapshot not found");
    return;
  }
  const form = $("#manualSnapshotForm");
  if (!form) return;
  form.dataset.snapshotId = snapshot.id;
  form.elements.date.value = snapshot.date || "";
  form.elements.holdingsValue.value = snapshot.holdingsValueBase ?? "";
  form.elements.cashValue.value = snapshot.cashValueBase ?? "";
  form.elements.currency.value = state.portfolioWealth?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  form.elements.source.value = snapshot.source || "";
  form.elements.notes.value = snapshot.notes || "";
  const submit = $("#manualSnapshotSubmit");
  if (submit) submit.textContent = "Save Changes";
  const cancel = $("#manualSnapshotCancel");
  if (cancel) cancel.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderRealizedIncome() {
  if (!state.dashboard) return;
  renderSegmentButtons($("#realizedIncomeRanges"), REALIZED_RANGES, state.realizedIncomeRange, "realized-range");
  renderSegmentButtons($("#realizedIncomeFilters"), REALIZED_FILTERS, state.realizedIncomeFilter, "realized-filter");
  renderSegmentButtons($("#realizedIncomeModes"), REALIZED_MODES, state.realizedIncomeMode, "realized-mode");
  renderSegmentButtons($("#realizedIncomeViews"), REALIZED_VIEWS, state.realizedIncomeView, "realized-view");
  document.querySelectorAll("[data-income-view-panel]").forEach((node) => {
    node.hidden = node.dataset.incomeViewPanel !== state.realizedIncomeView;
  });
  const payload = state.realizedIncome;
  const events = payload?.events || [];
  renderRealizedIncomeSummary();
  renderRealizedIncomeNotice();
  renderOpeningBalanceForm();
  renderManualSnapshotForm();
  renderPortfolioSnapshotsTable();
  renderRealizedIncomeChart();
  const legend = $("#realizedIncomeLegend");
  if (legend) {
    const entries = state.realizedIncomeMode === "book_value"
      ? [
        ["line", "Book value"],
        ["neutral", "Net contributed capital"],
        ["sale", "Sale"],
        ["dividend", "Dividend"],
        ["external", "Cash income/expense"]
      ]
      : state.realizedIncomeMode === "portfolio_value"
        ? [
          ["line", "Daily snapshot line"],
          ["snapshot", "Automatic snapshot"],
          ["manual", "Manual broker snapshot"]
        ]
        : [
          ["line", "Cumulative realized result"],
        ["sale", "Share sale"],
        ["dividend", "Dividend"],
        ["external", "External income"],
        ["expense", "External expense"]
      ];
    legend.innerHTML = entries.map(([className, label]) => `<span><span class="income-dot ${className}"></span>${escapeHtml(label)}</span>`).join("");
  }
  const transactions = $("#realizedIncomeTransactionsTable");
  if (transactions) transactions.innerHTML = realizedRows(events);
  const dividends = $("#realizedIncomeDividendsTable");
  if (dividends) dividends.innerHTML = realizedRows(events, { only: "dividends" });
  const external = $("#externalIncomeTable");
  if (external) external.innerHTML = realizedRows(events, { only: "external", externalActions: true });
}

function resetExternalIncomeForm() {
  const form = $("#externalIncomeForm");
  if (!form) return;
  form.reset();
  form.dataset.eventId = "";
  const date = form.elements.date;
  if (date) date.value = new Date().toISOString().slice(0, 10);
  const currency = form.elements.currency;
  if (currency) currency.value = state.dashboard?.user?.baseCurrency || "AUD";
  const submit = $("#externalIncomeSubmit");
  if (submit) submit.textContent = "Save Entry";
  const cancel = $("#externalIncomeCancel");
  if (cancel) cancel.hidden = true;
}

function editExternalIncome(eventId) {
  const entry = (state.realizedIncome?.events || []).find((item) => String(item.id) === String(eventId));
  if (!entry) {
    toast("External income entry not found");
    return;
  }
  const form = $("#externalIncomeForm");
  if (!form) return;
  const details = entry.details || {};
  form.dataset.eventId = entry.id;
  form.elements.type.value = entry.transactionType === "external_expense" ? "EXPENSE" : "INCOME";
  form.elements.date.value = entry.date || "";
  form.elements.category.value = details.category || (entry.transactionType === "external_expense" ? "External Expense" : "Other Income");
  form.elements.description.value = details.description || entry.source || "";
  form.elements.amount.value = Math.abs(Number(details.grossAmount ?? entry.amountOriginal) || 0);
  form.elements.currency.value = entry.currency || state.dashboard?.user?.baseCurrency || "AUD";
  form.elements.feesTax.value = details.feesTax || "";
  form.elements.netAmount.value = details.netAmount || "";
  form.elements.propertyAccount.value = details.propertyAccount || "";
  form.elements.notes.value = details.notes || "";
  form.elements.recurring.checked = Boolean(details.recurring);
  form.elements.addToCash.checked = Boolean(details.addToCash);
  const submit = $("#externalIncomeSubmit");
  if (submit) submit.textContent = "Save Changes";
  const cancel = $("#externalIncomeCancel");
  if (cancel) cancel.hidden = false;
  state.realizedIncomeView = "external";
  localStorage.setItem("realizedIncomeView", state.realizedIncomeView);
  renderRealizedIncome();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  form.elements.description.focus();
}

function realizedTooltipHtml(event) {
  const details = event.details || {};
  const baseCurrency = state.portfolioWealth?.baseCurrency || state.realizedIncome?.baseCurrency || state.dashboard?.user?.baseCurrency || "AUD";
  if (event.chartKind === "realized_growth_point") {
    const rows = [
      ["Date", event.date],
      ["Cumulative realized result", signedMoney(event.cumulativeRealizedBase || 0, baseCurrency)],
      ["Event amount", signedMoney(event.eventAmountBase || 0, baseCurrency)]
    ];
    const eventText = (event.events || []).map((item) => `${realizedEventLabel(item)} ${signedMoney(item.amountBase || 0, baseCurrency)} ${item.ticker || item.source || ""}`).join(" | ");
    if (eventText) rows.push(["Events", eventText]);
    return `
      <strong>Realized Growth</strong>
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
    `;
  }
  if (event.chartKind === "book_value_point") {
    const rows = [
      ["Date", event.date],
      ["Remaining investment cost basis", money(event.remainingCostBasisBase, baseCurrency)],
      ["Portfolio cash", money(event.cashValueBase, baseCurrency)],
      ["Total book value", money(event.bookValueBase, baseCurrency)],
      ["Net contributed capital", signedMoney(event.netCapitalContributedBase || 0, baseCurrency)]
    ];
    if (event.estimated) rows.push(["Quality", "Includes cash reconciliation"]);
    return `
      <strong>Book Value</strong>
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
    `;
  }
  if (event.chartKind === "snapshot_point") {
    const rows = [
      ["Date", event.date],
      ["Holdings market value", money(event.holdingsValueBase, baseCurrency)],
      ["Cash", money(event.cashValueBase, baseCurrency)],
      ["Total portfolio value", money(event.totalValueBase, baseCurrency)],
      ["Snapshot source", event.manual ? "Manual broker snapshot" : "Automatic app snapshot"],
      ["Data coverage", event.dataCoveragePercent == null ? "n/a" : `${number(event.dataCoveragePercent, 2)}%`],
      ["Provider", event.provider || "-"]
    ];
    if (event.source) rows.push(["Source", event.source]);
    if (event.notes) rows.push(["Notes", event.notes]);
    return `
      <strong>Actual Portfolio Value</strong>
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
    `;
  }
  if (event.chartKind === "book_value_event") {
    const rows = [
      ["Date", event.date],
      ["Type", wealthEventLabel(event)],
      ["Ticker / source", event.ticker || event.source || "-"],
      ["Cash impact", signedMoney(event.amountBase || 0, baseCurrency)],
      ["Book value", money(event.bookValueBase, baseCurrency)],
      ["Cost basis / cash", `${money(event.remainingCostBasisBase, baseCurrency)} / ${money(event.cashValueBase, baseCurrency)}`]
    ];
    if (event.type === "share_sale") {
      rows.push(
        ["Quantity", number(details.quantity, 4)],
        ["Sale price", money(details.salePrice, details.saleCurrency)],
        ["Proceeds", money(details.proceedsBase, baseCurrency)],
        ["Cost basis", money(details.costBasisBase, baseCurrency)],
        ["Realized gain/loss", signedMoney(details.gainLossBase, baseCurrency)],
        ["Lot", details.lotId || "FIFO / external"]
      );
    }
    if (event.type === "dividend") {
      rows.push(
        ["Quantity", number(details.eligibleQuantity, 4)],
        ["Per share", money(details.amountPerShare, event.currency)],
        ["Ex / pay date", `${details.exDate || "-"} / ${details.payDate || "-"}`]
      );
    }
    if (event.type === "buy") {
      rows.push(
        ["Quantity", number(details.quantity, 4)],
        ["Buy price", money(details.price, details.currency)]
      );
    }
    if (event.type === "external_income" || event.type === "external_expense") {
      rows.push(
        ["Category", details.category || "-"],
        ["Gross", money(details.grossAmount, event.currency)],
        ["Fees / tax", money(details.feesTax || 0, event.currency)],
        ["Net", money(details.netAmount, event.currency)],
        ["Cash applied", "Yes"]
      );
    }
    if (details.notes || details.note || details.description) rows.push(["Notes", details.notes || details.note || details.description]);
    return `
      <strong>${escapeHtml(wealthEventLabel(event))}</strong>
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
      `;
  }
  if (event.chartKind === "realized_growth_event") {
    const rows = [
      ["Date", event.date],
      ["Event type", realizedEventLabel(event)],
      ["Ticker / source", realizedEventSource(event)],
      ["Event amount", signedMoney(event.amountBase || 0, baseCurrency)],
      ["Cumulative realized result", signedMoney(event.cumulativeRealizedBase || 0, baseCurrency)]
    ];
    if ((event.transactionType || event.type) === "dividend") rows.push(["Dividend amount", signedMoney(event.amountBase || 0, baseCurrency)]);
    if ((event.transactionType || event.type) === "share_sale") {
      rows.push(
        ["Quantity", number(details.quantity, 4)],
        ["Sale price", money(details.salePrice, details.saleCurrency)],
        ["Cost basis", money(details.costBasisBase, baseCurrency)],
        ["Proceeds", money(details.proceedsBase, baseCurrency)],
        ["Gain / loss", signedMoney(details.gainLossBase, baseCurrency)]
      );
    }
    if (details.notes || details.description) rows.push(["Notes", details.notes || details.description]);
    return `
      <strong>${escapeHtml(realizedEventLabel(event))}</strong>
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
    `;
  }
  const rows = [
    ["Date", event.date],
    ["Type", realizedEventLabel(event)],
    ["Ticker / source", realizedEventSource(event)],
    ["Original", money(event.amountOriginal, event.currency)],
    ["Converted", event.conversionUnavailable ? "FX unavailable" : signedMoney(event.amountBase, baseCurrency)]
  ];
  const kind = event.transactionType || event.type;
  if (kind === "share_sale") {
    rows.push(
      ["Quantity", number(details.quantity, 4)],
      ["Sale price", money(details.salePrice, details.saleCurrency)],
      ["Cost basis", money(details.costBasisBase, baseCurrency)],
      ["Proceeds", money(details.proceedsBase, baseCurrency)],
      ["Gain / loss", signedMoney(details.gainLossBase, baseCurrency)],
      ["Lot", details.lotId || "FIFO / external"],
      ["Fees / tax", `${money(details.fees || 0, baseCurrency)} / ${money(details.taxes || 0, baseCurrency)}`]
    );
  }
  if (kind === "dividend") {
    rows.push(
      ["Quantity", number(details.eligibleQuantity, 4)],
      ["Per share", money(details.amountPerShare, event.currency)],
      ["Ex / pay date", `${details.exDate || "-"} / ${details.payDate || "-"}`]
    );
  }
  if (kind === "external_income" || kind === "external_expense") {
    rows.push(
      ["Category", details.category || "-"],
      ["Gross", money(details.grossAmount, event.currency)],
      ["Fees / tax", money(details.feesTax || 0, event.currency)],
      ["Net", money(details.netAmount, event.currency)],
      ["Property / account", details.propertyAccount || "-"],
      ["Cash applied", details.addToCash ? "Yes, once" : "No"]
    );
  }
  if (details.notes || details.description) rows.push(["Notes", details.notes || details.description]);
  return `
    <strong>${escapeHtml(realizedEventLabel(event))}</strong>
    ${rows.map(([label, value]) => `
      <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
    `).join("")}
  `;
}

function showRealizedIncomeTooltip(index, x, y) {
  const tooltip = $("#realizedIncomeTooltip");
  const event = state.realizedIncomeChartEvents[Number(index)];
  if (!tooltip || !event) return;
  tooltip.innerHTML = realizedTooltipHtml(event);
  tooltip.hidden = false;
  const shell = tooltip.closest(".realized-income-chart-shell")?.getBoundingClientRect();
  const left = shell ? x - shell.left : x;
  const top = shell ? y - shell.top : y;
  tooltip.style.left = `${Math.min(Math.max(12, left + 16), Math.max(12, (shell?.width || 360) - 290))}px`;
  tooltip.style.top = `${Math.max(12, top - 34)}px`;
}

function renderNotifications() {
  const { notifications, user } = state.dashboard;
  const emailForm = $("#emailSettingsForm");
  if (emailForm && !emailForm.elements.recipientEmail.value) {
    emailForm.elements.recipientEmail.value = user.email || "";
  }
  $("#notificationsTable").innerHTML = notifications.length ? notifications.map((item) => {
    const status = notificationStatusView(item.status);
    return `
      <div class="compact-row wide">
        <div><strong>${item.kind}</strong><br><span class="muted">${item.ticker ? tickerButton(item.ticker) : ""}</span></div>
        <div>${item.subject}<br><span class="muted">${item.recipient}</span></div>
        <div><span class="status-pill ${status.className}">${status.label}</span></div>
        <div class="muted">${item.sentAt || item.createdAt}</div>
      </div>
    `;
  }).join("") : `<p class="muted">No notifications</p>`;
}

function renderWarnings() {
  const warnings = state.dashboard.warnings || [];
  $("#warningsBand").hidden = warnings.length === 0;
  $("#warningsList").innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
}

function render() {
  renderSummary();
  renderProviderStatus().catch(() => undefined);
  renderImports();
  renderIntelligence();
  renderDashboardIntelligence();
  renderValuationMonitor();
  renderNewsIntelligence();
  renderPortfolioCharts();
  renderMarketPulse();
  renderPortfolioPerformance();
  renderAllocation();
  renderCash();
  renderHoldings();
  renderGroupSettings();
  renderMarketPulseSuggestions();
  renderMarketPulseSettings();
  renderResearchMetrics();
  renderWatchlist();
  renderAlerts();
  renderDividends();
  renderExternalTransactions();
  renderRealizedIncome();
  renderRulesV2();
  renderEvents();
  renderNotifications();
  renderWarnings();
  setView(state.currentView, { scroll: false, routeTab: state.routeTab, alertTab: state.alertTab });
}

function lotsForTicker(ticker) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  const position = state.dashboard.positions.find((item) => item.ticker === normalizedTicker);
  return position?.lots || [];
}

function positionForTicker(ticker) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  return state.dashboard.positions.find((item) => item.ticker === normalizedTicker);
}

function quoteCurrencyForTicker(ticker) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  const position = positionForTicker(normalizedTicker);
  const watchlistItem = state.dashboard.watchlist.find((item) => item.ticker === normalizedTicker);
  return position?.price?.currency
    || watchlistItem?.price?.currency
    || position?.lots?.[0]?.purchaseCurrency
    || state.dashboard.user.baseCurrency;
}

function saleLotOptions(ticker, selectedLotId = "") {
  const position = positionForTicker(ticker);
  const lots = lotsForTicker(ticker).filter((lot) => (lot.quantity || 0) > 0);
  const openQuantity = position?.quantity || lots.reduce((total, lot) => total + (lot.quantity || 0), 0);
  const fifoSelected = selectedLotId ? "" : "selected";
  const lotRows = lots.map((lot) => `
    <option value="${escapeHtml(lot.id)}" ${lot.id === selectedLotId ? "selected" : ""}>
      ${escapeHtml(lot.purchaseDate)} | ${number(lot.quantity, 4)} shares @ ${money(lot.purchasePrice, lot.purchaseCurrency)}
    </option>
  `).join("");
  return `
    <option value="" ${fifoSelected}>Automatic FIFO | ${number(openQuantity, 4)} open shares</option>
    ${lotRows}
  `;
}

function updateSaleLotHint() {
  const form = $("#saleForm");
  if (!form) return;
  const ticker = String(form.elements.ticker.value || "").trim().toUpperCase();
  const lotId = form.elements.lotId.value;
  const lots = lotsForTicker(ticker).filter((lot) => (lot.quantity || 0) > 0);
  const selectedLot = lots.find((lot) => lot.id === lotId);
  const openQuantity = selectedLot?.quantity || positionForTicker(ticker)?.quantity || lots.reduce((total, lot) => total + (lot.quantity || 0), 0);
  form.elements.quantity.max = openQuantity || "";
  const hint = $("#saleLotHint");
  if (!hint) return;
  if (!ticker) {
    hint.textContent = "Enter a ticker first, then choose automatic FIFO or one exact lot.";
  } else if (selectedLot) {
    hint.textContent = `Selected ${selectedLot.purchaseDate} lot. You can sell up to ${number(selectedLot.quantity, 4)} shares from this lot.`;
  } else {
    hint.textContent = `Automatic FIFO will sell earliest lots first. Open quantity: ${number(openQuantity, 4)} shares.`;
  }
}

function watchlistIdForTicker(ticker) {
  const selectedId = state.watchlistFilter === "all" ? "" : state.watchlistFilter;
  const matching = state.dashboard.watchlist.find((item) => (
    item.ticker === ticker && (!selectedId || item.watchlistId === selectedId)
  ));
  return matching?.id || state.dashboard.watchlist.find((item) => item.ticker === ticker)?.id || "";
}

function openLotDialog({ ticker = "", categoryId = "", quantity = "", purchasePrice = "" } = {}) {
  const dialog = $("#lotDialog");
  const form = $("#lotForm");
  form.elements.ticker.value = ticker;
  form.elements.categoryId.innerHTML = categoryOptions(categoryId);
  form.elements.quantity.value = quantity;
  form.elements.purchasePrice.value = purchasePrice;
  form.elements.purchaseCurrency.innerHTML = marketCurrencyOptions(quoteCurrencyForTicker(ticker));
  form.elements.purchaseDate.value = new Date().toISOString().slice(0, 10);
  form.elements.notes.value = "";
  dialog.showModal();
}

function openSaleDialog({ ticker = "", quantity = "", salePrice = "", saleCurrency = "", lotId = "" } = {}) {
  const dialog = $("#saleDialog");
  const form = $("#saleForm");
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  const selectedLot = lotsForTicker(normalizedTicker).find((lot) => lot.id === lotId);
  form.elements.ticker.value = normalizedTicker;
  form.elements.lotId.innerHTML = saleLotOptions(normalizedTicker, lotId);
  form.elements.quantity.value = quantity || selectedLot?.quantity || "";
  form.elements.salePrice.value = salePrice;
  form.elements.saleCurrency.innerHTML = marketCurrencyOptions(saleCurrency || quoteCurrencyForTicker(normalizedTicker));
  form.elements.soldAt.value = new Date().toISOString().slice(0, 10);
  updateSaleLotHint();
  dialog.showModal();
}

function openAlertDialog({ ticker = "", scope = "EQUITY", lotId = "", watchlistItemId = "", alert = null } = {}) {
  const dialog = $("#alertDialog");
  const form = $("#alertForm");
  const editTicker = alert ? (alert.ticker || ticker) : ticker;
  const editScope = alert ? (alert.scope || scope) : scope;
  const normalizedTicker = String(editTicker || "").trim().toUpperCase();
  form.elements.ticker.value = normalizedTicker;
  form.elements.scope.value = editScope;
  const editCurrency = alert ? (alert.currency || quoteCurrencyForTicker(normalizedTicker)) : quoteCurrencyForTicker(normalizedTicker);
  form.elements.currency.innerHTML = marketCurrencyOptions(editCurrency);
  form.elements.thresholdPrice.value = alert ? (alert.threshold_price ?? alert.thresholdPrice ?? alert.targetPrice ?? "") : "";
  form.elements.label.value = alert ? (alert.label || "") : "";
  form.elements.note.value = alert ? (alert.note || "") : "";
  form.elements.alertType.value = alert ? (alert.alert_type || alert.alertType || "PRICE_ALERT") : "PRICE_ALERT";
  form.elements.priority.value = alert ? (alert.priority || "medium") : "medium";
  if (form.elements.direction && alert?.direction) form.elements.direction.value = String(alert.direction).toUpperCase();
  form.dataset.alertId = alert ? String(alert.id) : "";
  form.dataset.watchlistItemId = (alert ? (alert.watchlist_item_id || alert.watchlistItemId) : watchlistItemId) || watchlistIdForTicker(normalizedTicker);
  const lots = lotsForTicker(normalizedTicker);
  const selectedLot = alert ? (alert.lot_id || alert.lotId || lotId) : lotId;
  form.elements.lotId.innerHTML = lots.map((lot) => `
    <option value="${lot.id}" ${lot.id === selectedLot ? "selected" : ""}>${lot.purchaseDate} - ${number(lot.quantity, 4)} shares</option>
  `).join("");
  const titleNode = dialog.querySelector("h2, .dialog-header h2");
  if (titleNode) titleNode.textContent = alert ? "Edit Alert" : "New Alert";
  const deleteBtn = dialog.querySelector("#alertDeleteBtn");
  if (deleteBtn) deleteBtn.style.display = alert?.id ? "" : "none";
  dialog.showModal();
}

function setFormValue(form, name, value) {
  if (!form.elements[name]) return;
  form.elements[name].value = value == null ? "" : value;
}

function openZoneDialog(itemId) {
  const item = watchlistItemById(itemId);
  if (!item) {
    toast("Watchlist item not found");
    return;
  }
  const dialog = $("#zoneDialog");
  const form = $("#zoneForm");
  form.dataset.itemId = item.id;
  form.dataset.currentPrice = item.price?.price ?? "";
  setFormValue(form, "ticker", item.ticker);
  setFormValue(form, "currency", item.currency || state.dashboard.user.baseCurrency);
  setFormValue(form, "targetPrice", item.targetPrice);
  setFormValue(form, "fairValue", item.fairValue);
  setFormValue(form, "buyZoneLow", item.buyZoneLow);
  setFormValue(form, "buyZoneHigh", item.buyZoneHigh);
  setFormValue(form, "addZoneLow", item.addZoneLow);
  setFormValue(form, "addZoneHigh", item.addZoneHigh);
  setFormValue(form, "trimPrice", item.trimPrice);
  setFormValue(form, "note", item.note);
  dialog.showModal();
}

function suggestZones() {
  const form = $("#zoneForm");
  const anchor = Number(form.elements.fairValue.value)
    || Number(form.elements.targetPrice.value)
    || Number(form.dataset.currentPrice);
  if (!Number.isFinite(anchor) || anchor <= 0) {
    toast("Add a target, fair value, or live price first");
    return;
  }
  form.elements.buyZoneLow.value = roundInput(anchor * 0.82);
  form.elements.buyZoneHigh.value = roundInput(anchor * 0.9);
  form.elements.addZoneLow.value = roundInput(anchor * 0.9);
  form.elements.addZoneHigh.value = roundInput(anchor * 0.98);
  form.elements.fairValue.value = roundInput(anchor);
  form.elements.trimPrice.value = roundInput(anchor * 1.25);
}

function roundInput(value) {
  return Number(value).toFixed(2);
}

async function submitJson(path, body, options = {}) {
  await api(path, {
    method: options.method || "POST",
    body: JSON.stringify(body)
  });
  await loadDashboard();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "alertCommandForm") {
      parseAlertCommandFromForm();
      return;
    }
    if (form.id === "authForm") {
      const body = Object.fromEntries(new FormData(form));
      const endpoint = state.authMode === "setup"
        ? "/api/auth/setup"
        : state.authMode === "register"
          ? "/api/auth/register"
          : "/api/auth/login";
      await api(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        skipAuthRedirect: true
      });
      await loadSession();
      await loadDashboard(true);
      configureAutoPrices();
      toast(state.authMode === "setup"
        ? "Owner login created"
        : state.authMode === "register"
          ? "Account created"
          : "Signed in");
      return;
    }
    if (form.id === "addUserForm") {
      const body = Object.fromEntries(new FormData(form));
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify(body)
      });
      form.reset();
      await loadUsers();
      toast("User added");
      return;
    }
    if (form.id === "uploadForm") {
      const data = new FormData(form);
      const kind = form.elements.kind.value;
      const replace = form.elements.replace.checked;
      if (replace && kind !== "watchlist") {
        const confirmed = window.confirm(
          kind === "netwealth_transactions"
            ? "Replace the whole portfolio from this Netwealth file? This clears current lots, sales, dividends, and cash. Watchlists stay separate."
            : "Replace the whole portfolio from this file? This clears current lots, sales, and dividends. Watchlists stay separate."
        );
        if (!confirmed) return;
      }
      data.set("replace", replace ? "true" : "false");
      const result = await api("/api/imports", { method: "POST", body: data });
      if (result.kind === "netwealth_transactions") {
        const details = result.details || {};
        const matched = (details.purchasesMatched || 0) + (details.salesMatched || 0) + (details.dividendsUpdated || 0);
        toast(`${details.purchasesCreated || 0} buys, ${details.salesCreated || 0} sales, ${details.dividendsCreated || 0} CSV dividends added${matched ? `, ${matched} already there` : ""}`);
      } else {
        toast(`${result.createdCount} added, ${result.errorCount} errors`);
      }
      form.reset();
      updateImportControls();
      await loadDashboard(true);
    }
    if (form.id === "cashForm") {
      const submitButton = form.querySelector('button[type="submit"]');
      try {
        if (submitButton) submitButton.disabled = true;
        await submitJson("/api/cash", Object.fromEntries(new FormData(form)));
        toast("Cash balance saved");
        form.reset();
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    }
    if (form.id === "externalTransactionForm") {
      await submitJson("/api/transactions/external", Object.fromEntries(new FormData(form)));
      toast("Closed trade saved");
      form.reset();
    }
    if (form.id === "openingBalanceForm") {
      const body = Object.fromEntries(new FormData(form));
      await api("/api/portfolio-wealth/opening-balance", {
        method: "POST",
        body: JSON.stringify(body)
      });
      toast("Opening balance saved");
      await loadDashboard();
      await loadRealizedIncome();
    }
    if (form.id === "manualSnapshotForm") {
      const body = Object.fromEntries(new FormData(form));
      const snapshotId = form.dataset.snapshotId;
      await api(snapshotId ? `/api/portfolio-wealth/snapshots/${encodeURIComponent(snapshotId)}` : "/api/portfolio-wealth/snapshots", {
        method: snapshotId ? "PATCH" : "POST",
        body: JSON.stringify(body)
      });
      toast(snapshotId ? "Snapshot updated" : "Snapshot saved");
      resetManualSnapshotForm();
      await loadDashboard();
      await loadRealizedIncome();
    }
    if (form.id === "externalIncomeForm") {
      const body = Object.fromEntries(new FormData(form));
      const eventId = form.dataset.eventId;
      const endpoint = eventId ? `/api/external-income/${encodeURIComponent(eventId)}` : "/api/external-income";
      const method = eventId ? "PATCH" : "POST";
      await submitJson(endpoint, body, { method });
      toast(eventId ? "External income entry updated" : "External income entry saved");
      resetExternalIncomeForm();
      await loadDashboard();
      await loadRealizedIncome();
    }
    if (form.id === "watchlistForm") {
      await submitJson("/api/watchlist", Object.fromEntries(new FormData(form)));
      toast("Watchlist updated");
      form.reset();
      hideWatchlistSymbolResults();
      await loadDashboard().catch(() => undefined);
    }
    if (form.id === "groupCreateForm") {
      const body = Object.fromEntries(new FormData(form));
      const payload = {
        name: body.name,
        targetPercent: body.targetPercent || 0,
        color: body.color || "#C9A86A"
      };
      await submitJson("/api/categories", payload);
      toast("Group added");
      form.reset();
      form.elements.color.value = "#C9A86A";
    }
    if (form.id === "marketPulseForm") {
      syncMarketPulseFormFromSuggestion(form, { rewriteSymbol: true });
      const body = resolveMarketPulseBody(Object.fromEntries(new FormData(form)));
      try {
        await submitJson("/api/market-pulse", body);
        toast("Market Pulse item added");
      } catch (error) {
        if (!shouldUsePulseLocalFallback(error)) throw error;
        upsertLocalMarketPulse(body);
        toast("Market Pulse item saved locally");
      }
      form.reset();
    }
    if (form.id === "renameWatchlistForm") {
      if (state.watchlistFilter === "all") throw new Error("Choose one watchlist to rename");
      await submitJson(`/api/watchlists/${encodeURIComponent(state.watchlistFilter)}`, Object.fromEntries(new FormData(form)), { method: "PATCH" });
      toast("Watchlist renamed");
    }
    if (form.id === "providerKeyForm") {
      await submitJson("/api/settings/finnhub-key", Object.fromEntries(new FormData(form)));
      toast("Live price key saved");
      form.reset();
    }
    if (form.id === "emailSettingsForm") {
      await submitJson("/api/settings/email", Object.fromEntries(new FormData(form)));
      toast("Email settings saved");
      form.reset();
    }
    if (form.id === "aiSettingsForm") {
      await api("/api/settings/ai", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      toast("AI settings saved");
      if (form.elements.apiKey) form.elements.apiKey.value = "";
      await loadDashboard();
    }
    if (form.id === "memoForm") {
      const body = Object.fromEntries(new FormData(form));
      $("#memoOutput").textContent = "Generating memo...";
      const result = await api("/api/intelligence/memo", {
        method: "POST",
        body: JSON.stringify(body)
      });
      $("#memoOutput").textContent = result.memo || "No memo returned";
      const label = result.provider === "gemini" ? "Gemini" : result.provider === "openai" ? "OpenAI" : "Rules";
      toast(`${label} memo generated`);
    }
    if (form.id === "zoneForm" && event.submitter?.value !== "cancel") {
      const itemId = form.dataset.itemId;
      if (!itemId) throw new Error("Choose a watchlist ticker first");
      await submitJson(`/api/watchlist/${encodeURIComponent(itemId)}`, Object.fromEntries(new FormData(form)), { method: "PATCH" });
      $("#zoneDialog").close();
      toast("Price zones saved");
    }
    if (form.id === "zoneForm" && event.submitter?.value === "cancel") {
      $("#zoneDialog").close();
    }
    if (form.id === "lotForm" && event.submitter?.value !== "cancel") {
      await submitJson("/api/lots", Object.fromEntries(new FormData(form)));
      $("#lotDialog").close();
      toast("Lot added");
      form.reset();
    }
    if (form.id === "lotForm" && event.submitter?.value === "cancel") {
      $("#lotDialog").close();
    }
    if (form.id === "saleForm" && event.submitter?.value !== "cancel") {
      await submitJson("/api/transactions/sell", Object.fromEntries(new FormData(form)));
      $("#saleDialog").close();
      toast("Sale recorded");
      form.reset();
    }
    if (form.id === "saleForm" && event.submitter?.value === "cancel") {
      $("#saleDialog").close();
    }
    if (form.id === "alertForm" && event.submitter?.value !== "cancel") {
      const body = Object.fromEntries(new FormData(form));
      if (body.scope === "WATCHLIST") body.watchlistItemId = form.dataset.watchlistItemId;
      if (body.scope !== "LOT") delete body.lotId;
      const editId = form.dataset.alertId;
      if (editId) {
        await submitJson(`/api/alerts/${editId}`, body, { method: "PATCH" });
        form.dataset.alertId = "";
        $("#alertDialog").close();
        toast("Alert updated");
      } else {
        await submitJson("/api/alerts", body);
        $("#alertDialog").close();
        toast("Alert saved");
      }
    }
    if (form.id === "alertForm" && event.submitter?.value === "cancel") {
      form.dataset.alertId = "";
      $("#alertDialog").close();
    }
  } catch (error) {
    toastError(error);
  }
});

let watchlistSearchTimer = null;
let watchlistSearchSeq = 0;

async function renderWatchlistSymbolResults(query) {
  const box = $("#watchlistSymbolResults");
  if (!box) return;
  const q = String(query || "").trim();
  if (q.length < 1) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const seq = ++watchlistSearchSeq;
  try {
    const data = await api(`/api/symbols/search?q=${encodeURIComponent(q)}`);
    if (seq !== watchlistSearchSeq) return;
    const results = data.results || [];
    if (!results.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.innerHTML = results.map((r) => `
      <button type="button" class="symbol-option" data-symbol-pick="${escapeHtml(r.symbol)}" data-symbol-currency="${escapeHtml(r.currency)}">
        <span class="symbol-option-code">${escapeHtml(r.symbol)}</span>
        <span class="symbol-option-name">${escapeHtml(r.name)}</span>
        <span class="symbol-option-exch">${escapeHtml(r.exchange)}${r.currency ? ` &middot; ${escapeHtml(r.currency)}` : ""}</span>
      </button>
    `).join("");
    box.hidden = false;
  } catch {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function scheduleWatchlistSymbolSearch(query) {
  clearTimeout(watchlistSearchTimer);
  watchlistSearchTimer = setTimeout(() => renderWatchlistSymbolResults(query), 220);
}

function hideWatchlistSymbolResults() {
  const box = $("#watchlistSymbolResults");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.alertCommandField) {
    updateAlertCommandDraft(target.dataset.alertCommandId, target.dataset.alertCommandField, target.value, { render: false });
    return;
  }
  if (target.dataset.groupDraftField) {
    const value = target.type === "checkbox" ? target.checked : target.value;
    updateGroupDraft(target.dataset.groupDraftId, target.dataset.groupDraftField, value);
    updateGroupManagerSummary();
    return;
  }
  if (target.id === "watchlistTickerInput") {
    scheduleWatchlistSymbolSearch(target.value);
    return;
  }
  if (target.name === "symbol" && target.closest("#marketPulseForm")) {
    state.marketPulseAutocompleteIndex = 0;
    syncMarketPulseFormFromSuggestion(target.form, { rewriteSymbol: false });
    renderMarketPulseAutocomplete(target);
  }
});

document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (target.name === "symbol" && target.closest("#marketPulseForm")) {
    renderMarketPulseAutocomplete(target);
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  try {
    if (target.dataset.alertCommandField) {
      updateAlertCommandDraft(target.dataset.alertCommandId, target.dataset.alertCommandField, target.value);
      return;
    }
    if (target.dataset.groupDraftField) {
      const field = target.dataset.groupDraftField;
      const value = target.type === "checkbox" ? target.checked : target.value;
      updateGroupDraft(target.dataset.groupDraftId, field, value);
      if (field === "sortOrder") sortedDraftsByOrder();
      if (["sortOrder", "active"].includes(field)) renderGroupManager();
      else updateGroupManagerSummary();
      return;
    }
    if (target.id === "importKind") {
      updateImportControls();
    }
    if (target.id === "baseCurrency") {
      await submitJson("/api/settings/base-currency", { currency: target.value });
      state.portfolioPerformance = null;
      renderPortfolioPerformance();
      await loadPortfolioPerformance(state.portfolioPerformanceRange, { force: true });
      toast(`Currency updated to ${target.value}`);
    }
    if (target.dataset.categoryTarget) {
      await submitJson(`/api/categories/${target.dataset.categoryTarget}`, { targetPercent: target.value }, { method: "PATCH" });
      toast("Target updated");
    }
    if (target.dataset.equityCategory) {
      await submitJson(`/api/equities/${encodeURIComponent(target.dataset.equityCategory)}/category`, { categoryId: target.value }, { method: "PATCH" });
      toast("Group updated");
    }
    if (target.id === "holdingsSort") {
      state.holdingsSort = target.value;
      saveHoldingsView();
      renderHoldings();
    }
    if (target.id === "holdingsGroup") {
      state.holdingsGroup = target.value;
      saveHoldingsView();
      renderHoldings();
    }
    if (target.id === "holdingsViewMode") {
      state.holdingsViewMode = target.value;
      saveHoldingsView();
      renderHoldings();
    }
    if (target.id === "watchlistFilter") {
      state.watchlistFilter = target.value;
      localStorage.setItem("watchlistFilter", state.watchlistFilter);
      renderWatchlist();
    }
    if (target.id === "aiProvider") {
      const modelInput = $("#aiModel");
      if (modelInput && (!modelInput.value || modelInput.value === "gpt-5-mini" || modelInput.value === "gemini-2.5-flash")) {
        modelInput.value = target.value === "gemini" ? "gemini-2.5-flash" : "gpt-5-mini";
      }
    }
    if (target.name === "symbol" && target.closest("#marketPulseForm")) {
      syncMarketPulseFormFromSuggestion(target.form, { rewriteSymbol: true });
      hideMarketPulseAutocomplete();
    }
    if (target.name === "ticker" && target.closest("#alertForm")) {
      const form = $("#alertForm");
      const ticker = target.value.toUpperCase();
      const lots = lotsForTicker(ticker);
      form.elements.currency.innerHTML = marketCurrencyOptions(quoteCurrencyForTicker(ticker));
      form.elements.lotId.innerHTML = lots.map((lot) => `<option value="${lot.id}">${lot.purchaseDate} - ${number(lot.quantity, 4)} shares</option>`).join("");
      form.dataset.watchlistItemId = watchlistIdForTicker(ticker);
    }
    if (target.name === "ticker" && target.closest("#saleForm")) {
      const form = $("#saleForm");
      const ticker = target.value.toUpperCase();
      form.elements.lotId.innerHTML = saleLotOptions(ticker);
      form.elements.saleCurrency.innerHTML = marketCurrencyOptions(quoteCurrencyForTicker(ticker));
      updateSaleLotHint();
    }
    if (target.name === "lotId" && target.closest("#saleForm")) {
      updateSaleLotHint();
    }
  } catch (error) {
    toastError(error);
  }
});

document.addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-group-draft-row]");
  if (!row || !state.groupEditor) return;
  state.groupEditor.draggedId = row.dataset.groupDraftRow;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.groupEditor.draggedId);
});

document.addEventListener("dragover", (event) => {
  const row = event.target.closest("[data-group-draft-row]");
  if (!row || !state.groupEditor?.draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});

document.addEventListener("drop", (event) => {
  const row = event.target.closest("[data-group-draft-row]");
  if (!row || !state.groupEditor?.draggedId) return;
  event.preventDefault();
  moveGroupDraftBefore(state.groupEditor.draggedId, row.dataset.groupDraftRow);
  state.groupEditor.draggedId = "";
});

document.addEventListener("dragend", (event) => {
  event.target.closest("[data-group-draft-row]")?.classList.remove("dragging");
  if (state.groupEditor) state.groupEditor.draggedId = "";
});

document.addEventListener("keydown", (event) => {
  const pulseInput = event.target.closest?.("#marketPulseForm input[name='symbol']");
  if (pulseInput && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
    const panel = $("#marketPulseAutocomplete");
    const matches = marketPulseAutocompleteMatches(pulseInput.value);
    if (event.key === "Escape") {
      hideMarketPulseAutocomplete();
      return;
    }
    if (!matches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.marketPulseAutocompleteIndex = Math.min(matches.length - 1, state.marketPulseAutocompleteIndex + 1);
      renderMarketPulseAutocomplete(pulseInput);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.marketPulseAutocompleteIndex = Math.max(0, state.marketPulseAutocompleteIndex - 1);
      renderMarketPulseAutocomplete(pulseInput);
      return;
    }
    if (event.key === "Enter" && panel && !panel.hidden) {
      event.preventDefault();
      selectMarketPulseSuggestion(currentMarketPulseAutocompleteMatch(pulseInput));
      return;
    }
  }
  const target = event.target.closest('[role="button"][data-action]');
  if (!target || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  target.click();
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest?.("#marketPulseForm")) hideMarketPulseAutocomplete();
  if (!event.target.closest?.(".symbol-field")) hideWatchlistSymbolResults();
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, [role='button'][data-action]");
  if (!target) return;
  const action = target.dataset.action || target.id;
  try {
    if (target.id === "authModeSwitch") {
      showAuthGate(state.authMode === "register" ? "login" : "register");
      return;
    }
    if (action === "logout") {
      await api("/api/auth/logout", { method: "POST", skipAuthRedirect: true });
      state.session = null;
      showAuthGate("login", "Signed out. Sign in again to continue.");
      toast("Signed out");
      return;
    }
    if (target.dataset.symbolPick) {
      const input = $("#watchlistTickerInput");
      if (input) input.value = target.dataset.symbolPick;
      const currency = target.dataset.symbolCurrency;
      const currencySelect = $("#watchlistCurrency");
      if (currency && currencySelect && [...currencySelect.options].some((o) => o.value === currency)) {
        currencySelect.value = currency;
      }
      hideWatchlistSymbolResults();
      return;
    }
    if (target.dataset.pulseAutocompleteIndex) {
      const input = pulseFormField($("#marketPulseForm"), "symbol");
      const matches = marketPulseAutocompleteMatches(input?.value || "");
      selectMarketPulseSuggestion(matches[Number(target.dataset.pulseAutocompleteIndex)]);
      return;
    }
    if (target.dataset.viewTab) {
      setView(target.dataset.viewTab);
      return;
    }
    if (target.dataset.viewJump) {
      setView(target.dataset.viewJump);
      if (target.dataset.scrollTarget) {
        requestAnimationFrame(() => {
          const node = document.getElementById(target.dataset.scrollTarget);
          if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
      return;
    }
    if (action === "refreshRulesV2") {
      await loadRulesV2({ refresh: true });
      toast("Rules V2 comparison refreshed");
      return;
    }
    if (target.dataset.alertTab) {
      state.alertTab = target.dataset.alertTab;
      syncBrowserRoute("alerts", { alertTab: state.alertTab });
      renderAlerts();
      return;
    }
    if (target.dataset.realizedRange) {
      state.realizedIncomeRange = target.dataset.realizedRange;
      localStorage.setItem("realizedIncomeRange", state.realizedIncomeRange);
      await loadRealizedIncome();
      return;
    }
    if (target.dataset.realizedFilter) {
      state.realizedIncomeFilter = target.dataset.realizedFilter;
      localStorage.setItem("realizedIncomeFilter", state.realizedIncomeFilter);
      await loadRealizedIncome();
      return;
    }
    if (target.dataset.realizedMode) {
      state.realizedIncomeMode = target.dataset.realizedMode;
      localStorage.setItem("realizedIncomeMode", state.realizedIncomeMode);
      renderRealizedIncome();
      return;
    }
    if (target.dataset.realizedView) {
      state.realizedIncomeView = target.dataset.realizedView;
      localStorage.setItem("realizedIncomeView", state.realizedIncomeView);
      renderRealizedIncome();
      return;
    }
    if (action === "repairLnwSales") {
      const confirmed = window.confirm("Fix LNW.AX June Netwealth sales to newest/cheapest lots? A database backup will be created first.");
      if (!confirmed) return;
      target.disabled = true;
      const resultNode = $("#lnwRepairResult");
      if (resultNode) resultNode.textContent = "Repairing...";
      try {
        const result = await api("/api/admin/repair-lnw-sales", { method: "POST" });
        if (resultNode) {
          resultNode.textContent = `Done. Realized P&L changed by ${signedMoney(result.realizedGainLossChange || 0, state.dashboard?.user?.baseCurrency || "AUD")}.`;
        }
        await loadDashboard(true);
        await loadRealizedIncome();
        toast("Light & Wonder lots repaired");
      } finally {
        target.disabled = false;
      }
      return;
    }
    if (action === "focusExternalIncomeForm") {
      state.realizedIncomeView = "external";
      localStorage.setItem("realizedIncomeView", state.realizedIncomeView);
      renderRealizedIncome();
      resetExternalIncomeForm();
      $("#externalIncomeForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
      $("#externalIncomeForm")?.elements?.description?.focus();
      return;
    }
    if (action === "cancelExternalIncomeEdit") {
      resetExternalIncomeForm();
      return;
    }
    if (action === "cancelSnapshotEdit") {
      resetManualSnapshotForm();
      return;
    }
    if (target.dataset.editPortfolioSnapshot) {
      editPortfolioSnapshot(target.dataset.editPortfolioSnapshot);
      return;
    }
    if (target.dataset.deletePortfolioSnapshot) {
      const confirmed = window.confirm("Delete this manual broker snapshot? Automatic snapshots and transactions stay untouched.");
      if (!confirmed) return;
      await api(`/api/portfolio-wealth/snapshots/${encodeURIComponent(target.dataset.deletePortfolioSnapshot)}`, { method: "DELETE" });
      resetManualSnapshotForm();
      await loadRealizedIncome();
      toast("Snapshot deleted");
      return;
    }
    if (target.dataset.editExternalIncome) {
      editExternalIncome(target.dataset.editExternalIncome);
      return;
    }
    if (target.dataset.deleteExternalIncome) {
      const confirmed = window.confirm("Delete this manual income or expense entry? Any one-time cash adjustment from it will be reversed.");
      if (!confirmed) return;
      await api(`/api/external-income/${encodeURIComponent(target.dataset.deleteExternalIncome)}`, { method: "DELETE" });
      await loadDashboard();
      await loadRealizedIncome();
      toast("External income entry deleted");
      return;
    }
    if (target.dataset.alertCommandHistory) {
      const input = $("#alertCommandInput");
      if (input) {
        input.value = target.dataset.alertCommandHistory;
        input.focus();
      }
      return;
    }
    if (action === "clearAlertCommand") {
      const input = $("#alertCommandInput");
      if (input) input.value = "";
      state.alertCommandDrafts = [];
      state.lastAlertCommandText = "";
      renderAlertCommandPreview();
      return;
    }
    if (action === "cancelAlertCommand") {
      state.alertCommandDrafts = [];
      state.lastAlertCommandText = "";
      renderAlertCommandPreview();
      return;
    }
    if (action === "removeAlertCommandDraft") {
      state.alertCommandDrafts = state.alertCommandDrafts.filter((draft) => draft.id !== target.dataset.alertCommandId);
      renderAlertCommandPreview();
      return;
    }
    if (action === "focusAlertCommandDraft") {
      const card = document.querySelector(`[data-alert-command-card="${CSS.escape(target.dataset.alertCommandId)}"]`);
      const field = card?.querySelector("input, select, textarea");
      field?.focus();
      return;
    }
    if (action === "saveAlertCommandDrafts") {
      target.disabled = true;
      try {
        await saveAlertCommandDrafts();
      } finally {
        target.disabled = false;
      }
      return;
    }
    if (action === "openAlerts") {
      openAlertCenter({ tab: target.dataset.alertRouteTab || "all" });
      return;
    }
    if (action === "openHoldings") {
      setView("portfolio", { routeTab: "holdings" });
      return;
    }
    if (action === "openWatchlists") {
      setView("research", { routeTab: "watchlists" });
      return;
    }
    if (action === "openRulesEditor") {
      await openRulesEditor();
      return;
    }
    if (action === "rulesSaveButton") {
      await saveRulesFromEditor();
      return;
    }
    if (action === "rulesResetButton") {
      await resetRulesInEditor();
      return;
    }
    if (target.dataset.openStock) {
      await openStockPage(target.dataset.openStock);
      return;
    }
    if (target.dataset.performanceRange) {
      const range = target.dataset.performanceRange;
      if (target.dataset.performanceScope === "stock") {
        state.stockPerformanceRange = range;
        localStorage.setItem("stockPerformanceRange", range);
        await loadStockPerformance(range);
      } else {
        state.portfolioPerformanceRange = range;
        localStorage.setItem("portfolioPerformanceRange", range);
        await loadPortfolioPerformance(range, { force: true });
      }
      return;
    }
    if (action === "backToPreviousView") {
      setView(state.stockPreviousView || "dashboard");
      return;
    }
    if (action === "stockRefreshButton") {
      if (state.currentStockTicker) await openStockPage(state.currentStockTicker, { refresh: true });
      return;
    }
    if (action === "stockAlertButton") {
      if (state.currentStockTicker) openAlertDialog({ ticker: state.currentStockTicker, scope: "EQUITY" });
      return;
    }
    if (target.dataset.watchlistSelect) {
      state.watchlistFilter = target.dataset.watchlistSelect;
      localStorage.setItem("watchlistFilter", state.watchlistFilter);
      renderWatchlist();
      return;
    }
    if (target.dataset.closeDialog) {
      document.getElementById(target.dataset.closeDialog)?.close();
      return;
    }
    if (action === "refreshPrices") {
      target.disabled = true;
      toast("Refreshing prices...");
      let refreshError = null;
      try {
        await api("/api/prices/refresh", { method: "POST" });
      } catch (error) {
        refreshError = error;
      }
      await loadDashboard().catch((error) => {
        refreshError ||= error;
      });
      await loadMarketPulseQuotes({ force: true });
      if (refreshError) throw refreshError;
      toast("Prices refreshed");
    }
    if (action === "refreshIntl") {
      target.disabled = true;
      toast("Refreshing ASX / LSE / Copenhagen...");
      let intlError = null;
      try {
        await api("/api/prices/refresh?scope=intl", { method: "POST" });
      } catch (error) {
        intlError = error;
      }
      await loadDashboard().catch((error) => {
        intlError ||= error;
      });
      target.disabled = false;
      if (intlError) throw intlError;
      toast("International prices refreshed");
    }
    if (action === "refreshFundamentals") {
      target.disabled = true;
      toast("Refreshing fundamentals. This can take a little while.");
      await api("/api/fundamentals/refresh", { method: "POST" });
      await loadDashboard();
      toast("Fundamentals refreshed");
    }
    if (action === "autoPricesToggle") {
      state.autoPrices = !state.autoPrices;
      localStorage.setItem("autoPrices", String(state.autoPrices));
      configureAutoPrices();
      toast(state.autoPrices ? "Auto prices on" : "Auto prices off");
    }
    if (action === "schedulerToggle") {
      const result = await api("/api/settings/scheduler", {
        method: "POST",
        body: JSON.stringify({ enabled: !state.schedulerEnabled })
      });
      state.schedulerEnabled = Boolean(result.schedulerEnabled);
      renderSchedulerControl();
      await renderProviderStatus().catch(() => undefined);
      toast(state.schedulerEnabled ? "Scheduler on" : "Scheduler off");
    }
    if (action === "toggleImportHistory") {
      state.importHistoryOpen = !state.importHistoryOpen;
      localStorage.setItem("importHistoryOpen", String(state.importHistoryOpen));
      renderImports();
    }
    if (action === "refreshEvents") {
      target.disabled = true;
      await api("/api/events/refresh", { method: "POST" });
      await loadDashboard(true);
      toast("Events refreshed");
    }
    if (action === "syncDividends") {
      target.disabled = true;
      const fromDate = $("#dividendFromDate").value;
      const result = await api("/api/dividends/sync", {
        method: "POST",
        body: JSON.stringify({ fromDate })
      });
      await loadDashboard();
      if (result.csvOnly) {
        toast(`${result.csvDividendCount || 0} CSV dividends tracked${result.removedExternalCount ? `, ${result.removedExternalCount} old API rows removed` : ""}`);
        return;
      }
      const errors = result.errorCount || result.errors?.length || 0;
      toast(`${result.createdCount} dividends added, ${result.updatedCount} updated${errors ? `, ${errors} errors` : ""}`);
    }
    if (action === "evaluateAlerts") {
      await api("/api/alerts/evaluate", { method: "POST" });
      await loadDashboard();
      toast("Alerts evaluated");
    }
    if (action === "togglePortfolioChart") {
      const card = target.closest("[data-performance-card]");
      if (card?.dataset.performanceCard === "dashboard") {
        state.dashboardChartCollapsed = !state.dashboardChartCollapsed;
        localStorage.setItem("dashboardChartCollapsed", String(state.dashboardChartCollapsed));
      } else {
        state.portfolioChartCollapsed = !state.portfolioChartCollapsed;
        localStorage.setItem("portfolioChartCollapsed", String(state.portfolioChartCollapsed));
      }
      renderPortfolioPerformance();
    }
    if (action === "togglePerformanceMode") {
      state.portfolioPerformanceMode = state.portfolioPerformanceMode === "withCash" ? "withoutCash" : "withCash";
      localStorage.setItem("portfolioPerformanceMode", state.portfolioPerformanceMode);
      renderPortfolioPerformance();
    }
    if (action === "toggleAllocation") {
      state.allocationCollapsed = !state.allocationCollapsed;
      localStorage.setItem("allocationCollapsed", String(state.allocationCollapsed));
      renderPortfolioCharts();
      renderAllocation();
    }
    if (action === "toggleCash") {
      state.cashCollapsed = !state.cashCollapsed;
      localStorage.setItem("cashCollapsed", String(state.cashCollapsed));
      renderCash();
    }
    if (action === "clearTriggeredAlerts") {
      const alerts = triggeredAlerts();
      if (!alerts.length) {
        toast("No triggered alerts to clear");
        return;
      }
      const confirmed = window.confirm(`Clear ${alerts.length} triggered alert${alerts.length === 1 ? "" : "s"}? The alert rules stay active.`);
      if (!confirmed) return;
      for (const alert of alerts) {
        await api(`/api/alerts/${alert.id}/review`, { method: "POST" });
      }
      await loadDashboard();
      toast("Triggered alerts cleared");
    }
    if (action === "seedStrategyAlerts") {
      const result = await api("/api/alerts/seed-strategy", { method: "POST" });
      await loadDashboard();
      toast(`${result.created} strategy alerts added, ${result.updated} updated`);
    }
    if (action === "enableDesktopAlerts") {
      if (!("Notification" in window)) {
        toast("Desktop notifications are not supported in this browser");
      } else {
        const permission = await Notification.requestPermission();
        toast(permission === "granted" ? "Desktop alerts enabled" : "Desktop alerts not enabled");
      }
    }
    if (action === "retryNotifications") {
      const result = await api("/api/notifications/retry", { method: "POST" });
      await loadDashboard();
      const results = flattenNotificationResults(result);
      const sent = results.filter((item) => item.status === "SENT").length;
      const waiting = results.filter((item) => item.status !== "SENT").length;
      toast(`${sent} emails sent${waiting ? `, ${waiting} still waiting` : ""}`);
    }
    if (action === "newAlert") {
      openAlertDialog();
    }
    if (action === "suggestZones") {
      suggestZones();
    }
    if (action === "addLotButton") {
      openLotDialog();
    }
    if (action === "recordSaleButton") {
      openSaleDialog();
    }
    if (action === "openGroupManager") {
      await openGroupManager();
      return;
    }
    if (action === "addGroupDraft") {
      addGroupDraft();
      return;
    }
    if (action === "moveGroupDraft") {
      moveGroupDraft(target.dataset.groupDraftId, Number(target.dataset.moveDirection) || 0);
      return;
    }
    if (target.dataset.groupColorChoice) {
      updateGroupDraft(target.dataset.groupColorChoice, "color", target.dataset.groupColor);
      renderGroupManager();
      return;
    }
    if (action === "deleteGroupDraft") {
      removeGroupDraft(target.dataset.groupDraftId);
      return;
    }
    if (action === "undoGroupDelete") {
      undoGroupDelete(target.dataset.groupDraftId);
      return;
    }
    if (action === "cancelGroupChanges") {
      state.groupEditor = null;
      $("#groupManagerDialog")?.close();
      return;
    }
    if (action === "saveGroupChanges") {
      await saveGroupChanges();
      return;
    }
    if (action === "resetDefaultGroups") {
      const confirmed = window.confirm("Reset portfolio groups to the default 6 groups and remap known holdings? Lots, cost basis, cash, and P/L stay unchanged.");
      if (!confirmed) return;
      await api("/api/categories/reset-defaults", { method: "POST" });
      await loadDashboard();
      toast("Default 6 groups applied");
      return;
    }
    if (target.dataset.savePulse) {
      const id = target.dataset.savePulse;
      const body = {
        symbol: document.querySelector(`[data-pulse-symbol="${id}"]`)?.value,
        displayName: document.querySelector(`[data-pulse-name="${id}"]`)?.value,
        category: document.querySelector(`[data-pulse-category="${id}"]`)?.value,
        sortOrder: document.querySelector(`[data-pulse-order="${id}"]`)?.value
      };
      let savedToServer = false;
      if (String(id).startsWith("local_")) {
        try {
          await submitJson("/api/market-pulse", body);
          deleteLocalMarketPulse(id);
          savedToServer = true;
          toast("Market Pulse item saved");
        } catch (error) {
          if (!shouldUsePulseLocalFallback(error)) throw error;
          upsertLocalMarketPulse(body, id);
          toast("Market Pulse item saved locally");
        }
      } else {
        try {
          await submitJson(`/api/market-pulse/${encodeURIComponent(id)}`, body, { method: "PATCH" });
          savedToServer = true;
          toast("Market Pulse item saved");
        } catch (error) {
          if (!shouldUsePulseLocalFallback(error)) throw error;
          upsertLocalMarketPulse(body);
          toast("Market Pulse item saved locally");
        }
      }
      // Reload so the saved sort order comes back from the server, then re-render.
      if (savedToServer) await loadDashboard().catch(() => undefined);
      renderMarketPulse();
      renderMarketPulseSettings();
      return;
    }
    if (target.dataset.deletePulse) {
      const id = target.dataset.deletePulse;
      if (!window.confirm("Remove this Market Pulse item?")) return;
      if (String(id).startsWith("local_")) {
        deleteLocalMarketPulse(id);
        toast("Market Pulse item deleted");
        return;
      }
      try {
        await api(`/api/market-pulse/${encodeURIComponent(id)}`, { method: "DELETE" });
        await loadDashboard();
        toast("Market Pulse item deleted");
      } catch (error) {
        if (!shouldUsePulseLocalFallback(error)) throw error;
        toast("This item is from the running server. Restart the app, then delete it again.");
      }
    }
    if (target.dataset.toggleLots) {
      const ticker = target.dataset.toggleLots;
      if (state.expandedLots.has(ticker)) state.expandedLots.delete(ticker);
      else state.expandedLots.add(ticker);
      renderHoldings();
    }
    if (target.dataset.editAlert) {
      const editing = (state.dashboard.alerts || []).find((a) => String(a.id) === String(target.dataset.editAlert));
      if (editing) openAlertDialog({ alert: editing });
      else toast("Alert not found");
      return;
    }
    if (target.dataset.openAlert) {
      openAlertDialog({
        ticker: target.dataset.openAlert,
        scope: target.dataset.scope || "EQUITY",
        lotId: target.dataset.lotId || "",
        watchlistItemId: target.dataset.watchlistItemId || ""
      });
    }
    if (target.dataset.openZone) {
      openZoneDialog(target.dataset.openZone);
    }
    if (target.dataset.openSale) {
      openSaleDialog({
        ticker: target.dataset.openSale,
        quantity: target.dataset.quantity,
        salePrice: target.dataset.price,
        saleCurrency: target.dataset.currency,
        lotId: target.dataset.lotId || ""
      });
    }
    if (target.dataset.deleteWatch) {
      await api(`/api/watchlist/${target.dataset.deleteWatch}`, { method: "DELETE" });
      await loadDashboard();
      toast("Watchlist item deleted");
    }
    if (target.dataset.saveCash) {
      const currency = target.dataset.saveCash;
      const input = document.querySelector(`[data-cash-amount="${currency}"]`);
      const amount = Number(input?.value);
      if (!Number.isFinite(amount)) throw new Error("Cash amount must be a valid number");
      target.disabled = true;
      await api("/api/cash", {
        method: "POST",
        body: JSON.stringify({ currency, amount })
      });
      await loadDashboard(true);
      toast(`${currency} cash saved`);
    }
    if (target.dataset.deleteCash) {
      const currency = target.dataset.deleteCash;
      const confirmed = window.confirm(`Delete ${currency} cash balance?`);
      if (!confirmed) return;
      target.disabled = true;
      await api(`/api/cash/${encodeURIComponent(currency)}`, { method: "DELETE" });
      await loadDashboard(true);
      toast(`${currency} cash deleted`);
    }
    if (target.dataset.toggleAlert) {
      await api(`/api/alerts/${target.dataset.toggleAlert}`, {
        method: "PATCH",
        body: JSON.stringify({ active: target.dataset.active === "1", triggered: false })
      });
      await loadDashboard();
      toast("Alert updated");
    }
    if (target.dataset.reviewAlert) {
      await api(`/api/alerts/${target.dataset.reviewAlert}/review`, { method: "POST" });
      await loadDashboard();
      toast("Triggered alert cleared");
    }
    if (target.dataset.snoozeAlert) {
      await api(`/api/alerts/${target.dataset.snoozeAlert}/snooze`, {
        method: "POST",
        body: JSON.stringify({ hours: 24 })
      });
      await loadDashboard();
      toast("Alert snoozed for 24 hours");
    }
    if (target.dataset.archiveAlert) {
      await api(`/api/alerts/${target.dataset.archiveAlert}/archive`, { method: "POST" });
      await loadDashboard();
      toast("Alert archived");
    }
    if (target.dataset.reactivateAlert) {
      await api(`/api/alerts/${target.dataset.reactivateAlert}/reactivate`, { method: "POST" });
      await loadDashboard();
      toast("Alert reactivated");
    }
    if (target.dataset.orderDraftAlert) {
      toast("Order drafts are not enabled yet. Alerts are review signals only.");
    }
    if (target.dataset.deleteAlert) {
      if (window.confirm("Delete this alert permanently?")) {
        await api(`/api/alerts/${target.dataset.deleteAlert}`, { method: "DELETE" });
        await loadDashboard();
        toast("Alert deleted");
      }
    }
    if (target.dataset.deleteCurrentAlert !== undefined) {
      const form = $("#alertForm");
      const alertId = form?.dataset.alertId;
      if (alertId) {
        await api(`/api/alerts/${alertId}`, { method: "DELETE" });
        $("#alertDialog")?.close();
        await loadDashboard();
        toast("Alert deleted");
      }
    }
    if (target.dataset.deleteExternalTransaction) {
      await api(`/api/transactions/external/${encodeURIComponent(target.dataset.deleteExternalTransaction)}`, { method: "DELETE" });
      await loadDashboard();
      toast("Closed trade deleted");
    }
  } catch (error) {
    toastError(error);
  } finally {
    if (
      action === "refreshPrices"
      || action === "refreshFundamentals"
      || action === "refreshEvents"
      || action === "syncDividends"
      || target.dataset.saveCash
      || target.dataset.deleteCash
    ) target.disabled = false;
  }
});

document.addEventListener("pointerover", (event) => {
  const point = event.target.closest?.("[data-income-point]");
  if (!point) return;
  showRealizedIncomeTooltip(point.dataset.incomePoint, event.clientX, event.clientY);
});

document.addEventListener("pointermove", (event) => {
  const point = event.target.closest?.("[data-income-point]");
  if (!point) return;
  showRealizedIncomeTooltip(point.dataset.incomePoint, event.clientX, event.clientY);
});

document.addEventListener("pointerout", (event) => {
  if (!event.target.closest?.("[data-income-point]")) return;
  const tooltip = $("#realizedIncomeTooltip");
  if (tooltip) tooltip.hidden = true;
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.autoPrices) {
    loadDashboard().catch(() => undefined);
    refreshQuotesSafely();
  }
});

window.addEventListener("popstate", () => {
  const route = routeStateFromLocation();
  state.alertTab = route.alertTab;
  setView(route.view, { scroll: false, updateRoute: false, alertTab: route.alertTab, routeTab: route.routeTab });
  if (route.view === "alerts") renderAlerts();
});

async function boot() {
  const authenticated = await loadSession();
  if (!authenticated) return;
  if (state.dashboard) {
    render();
    renderAccountState();
    updateImportControls();
  }
  await loadDashboard();
  updateImportControls();
  setView(state.currentView, { scroll: false, updateRoute: false, alertTab: state.alertTab, routeTab: state.routeTab });
  configureAutoPrices();
}

boot().catch((error) => {
  if (error.status === 401) return;
  toastError(error);
});
