import { getDb } from "../db.js";
import { config } from "../config.js";
import {
  daysFromNow,
  fetchJson,
  id,
  nowIso,
  RateLimiter,
  safeJsonParse,
  todayIsoDate
} from "../utils.js";
import { trackedTickers } from "./market-data.js";
import {
  createAndSendNotification,
  renderCorporateEventEmail,
  sendNotification
} from "./notifications.js";

const limiter = new RateLimiter(config.finnhubMinIntervalMs);
const rssLimiter = new RateLimiter(350);

async function finnhub(pathname, params) {
  if (!config.finnhubApiKey) throw new Error("FINNHUB_API_KEY is not configured");
  const url = new URL(`https://finnhub.io/api/v1/${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("token", config.finnhubApiKey);
  return limiter.enqueue(() => fetchJson(url));
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "ApexFolio portfolio news monitor",
        "Accept": "application/rss+xml, application/xml, text/xml, text/plain;q=0.9, */*;q=0.8",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function eventSourceId(type, ticker, eventDate, payload) {
  return [
    type,
    ticker,
    eventDate,
    payload.id || payload.accessNumber || payload.report?.accessNumber || payload.url || payload.title || JSON.stringify(payload).slice(0, 80)
  ].join(":");
}

function classifyThesisNews(headline = "", summary = "") {
  const text = `${headline} ${summary}`.toLowerCase();
  const patterns = [
    ["GUIDANCE_CHANGE", /\b(guidance|outlook|forecast|raises forecast|cuts forecast|lowers forecast|warns|warning)\b/],
    ["REGULATORY_RISK", /\b(regulator|regulation|regulatory|doj|ftc|sec|antitrust|lawsuit|probe|investigation|ban|export control)\b/],
    ["ACQUISITION", /\b(acquire|acquires|acquisition|merger|merge|takeover|buyout)\b/],
    ["PRODUCT_LAUNCH", /\b(launch|launches|unveils|announces new|new chip|new platform|new model|data center)\b/],
    ["COMPETITIVE_THREAT", /\b(competition|competitor|rival|loses share|market share|pricing pressure|margin pressure)\b/]
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function normalizeEvents(ticker, earnings, earningsResults, dividends, splits, filings, news) {
  const events = [];
  for (const item of earnings?.earningsCalendar || []) {
    events.push({
      ticker,
      eventType: "EARNINGS",
      eventDate: item.date,
      title: `${ticker} earnings announcement`,
      details: [item.epsEstimate ? `EPS estimate ${item.epsEstimate}` : null, item.revenueEstimate ? `Revenue estimate ${item.revenueEstimate}` : null]
        .filter(Boolean).join("; "),
      source: "finnhub",
      sourceEventId: eventSourceId("EARNINGS", ticker, item.date, item),
      payload: item
    });
  }
  for (const item of earningsResults || []) {
    const eventDate = item.period || item.date || item.fiscalDateEnding;
    if (!eventDate) continue;
    const surprise = item.surprisePercent ?? item.surprise;
    events.push({
      ticker,
      eventType: "EARNINGS_RESULT",
      eventDate,
      title: `${ticker} earnings result`,
      details: [
        item.actual != null ? `EPS actual ${item.actual}` : null,
        item.estimate != null ? `estimate ${item.estimate}` : null,
        surprise != null ? `surprise ${surprise}%` : null
      ].filter(Boolean).join("; "),
      source: "finnhub",
      sourceEventId: eventSourceId("EARNINGS_RESULT", ticker, eventDate, item),
      payload: item
    });
  }
  for (const item of dividends || []) {
    events.push({
      ticker,
      eventType: "DIVIDEND",
      eventDate: item.date || item.exDate || item.recordDate,
      title: `${ticker} dividend declaration`,
      details: `Amount ${item.amount ?? item.dividend ?? "n/a"} ${item.currency || ""}`.trim(),
      source: "finnhub",
      sourceEventId: eventSourceId("DIVIDEND", ticker, item.date || item.exDate, item),
      payload: item
    });
  }
  for (const item of splits || []) {
    events.push({
      ticker,
      eventType: "STOCK_SPLIT",
      eventDate: item.exDate || item.date,
      title: `${ticker} stock split`,
      details: item.ratio ? `Split ratio ${item.ratio}` : null,
      source: "finnhub",
      sourceEventId: eventSourceId("STOCK_SPLIT", ticker, item.exDate || item.date, item),
      payload: item
    });
  }
  for (const item of filings || []) {
    events.push({
      ticker,
      eventType: "REGULATORY_FILING",
      eventDate: item.filedDate || item.acceptedDate,
      title: `${ticker} ${item.form || "regulatory"} filing`,
      details: item.description || item.form || null,
      source: "finnhub",
      sourceEventId: eventSourceId("REGULATORY_FILING", ticker, item.filedDate || item.acceptedDate, item),
      payload: item
    });
  }
  for (const item of news || []) {
    const headline = item.headline || item.title || "";
    const eventType = classifyThesisNews(headline, item.summary || "");
    if (!eventType) continue;
    events.push({
      ticker,
      eventType,
      eventDate: item.datetime ? new Date(item.datetime * 1000).toISOString().slice(0, 10) : todayIsoDate(),
      title: headline,
      details: item.summary || item.source || null,
      source: "finnhub_news",
      sourceEventId: eventSourceId(eventType, ticker, item.datetime || todayIsoDate(), item),
      payload: item
    });
  }
  return events.filter((event) => event.eventDate);
}

async function fetchTickerEvents(ticker) {
  const from = todayIsoDate();
  const to = daysFromNow(config.corporateEventLookaheadDays);
  const recentFrom = daysFromNow(-10);
  const [earnings, earningsResults, dividends, splits, filings, news] = await Promise.all([
    finnhub("calendar/earnings", { symbol: ticker, from, to }).catch(() => ({ earningsCalendar: [] })),
    finnhub("stock/earnings", { symbol: ticker, limit: "4" }).catch(() => []),
    finnhub("stock/dividend", { symbol: ticker, from, to }).catch(() => []),
    finnhub("stock/split", { symbol: ticker, from, to }).catch(() => []),
    finnhub("stock/filings", { symbol: ticker, from: recentFrom, to }).catch(() => []),
    finnhub("company-news", { symbol: ticker, from: recentFrom, to }).catch(() => [])
  ]);
  return normalizeEvents(ticker, earnings, earningsResults, dividends, splits, filings, news);
}

function ownedPortfolioTickers(database, userId) {
  return database.prepare(`
    SELECT DISTINCT ticker
    FROM holding_lots
    WHERE user_id = ? AND quantity > 0
    ORDER BY ticker
  `).all(userId).map((row) => row.ticker);
}

function safeNewsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function decodeXmlText(value = "") {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function rssTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXmlText(match[1]) : "";
}

function rssSource(item) {
  return rssTag(item, "source") || "Yahoo Finance";
}

function newsItemFromYahooRss(ticker, item = "") {
  const sourceUrl = safeNewsUrl(rssTag(item, "link") || rssTag(item, "guid"));
  if (!sourceUrl) return null;
  const title = rssTag(item, "title") || `${ticker} news`;
  const details = rssTag(item, "description") || null;
  const dateValue = rssTag(item, "pubDate") || rssTag(item, "dc:date");
  const published = dateValue ? new Date(dateValue) : new Date();
  const publishedAt = Number.isFinite(published.getTime()) ? published.toISOString() : nowIso();
  return {
    id: `yahoo:${ticker}:${publishedAt}:${sourceUrl}`,
    ticker,
    eventType: classifyThesisNews(title, details || "") || "NEWS",
    eventDate: publishedAt.slice(0, 10),
    title,
    details,
    source: "yahoo_finance_rss",
    sourceUrl,
    newsSource: rssSource(item),
    publishedAt
  };
}

async function yahooFinanceRssNews(ticker) {
  const url = new URL("https://feeds.finance.yahoo.com/rss/2.0/headline");
  url.searchParams.set("s", ticker);
  url.searchParams.set("region", "US");
  url.searchParams.set("lang", "en-US");
  const xml = await rssLimiter.enqueue(() => fetchText(url, { timeoutMs: 10000 }));
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map((item) => newsItemFromYahooRss(ticker, item)).filter(Boolean);
}

function newsItemFromFinnhub(ticker, item = {}) {
  const sourceUrl = safeNewsUrl(item.url);
  if (!sourceUrl) return null;
  const publishedAt = item.datetime ? new Date(Number(item.datetime) * 1000).toISOString() : nowIso();
  return {
    id: `news:${ticker}:${item.datetime || item.id || sourceUrl}`,
    ticker,
    eventType: classifyThesisNews(item.headline || item.title || "", item.summary || "") || "NEWS",
    eventDate: publishedAt.slice(0, 10),
    title: item.headline || item.title || `${ticker} news`,
    details: item.summary || item.source || null,
    source: "finnhub_news",
    sourceUrl,
    newsSource: item.source || "Finnhub company news",
    publishedAt
  };
}

function sourceLinkedStoredNews(database, userId, ownedTickers) {
  const owned = new Set(ownedTickers);
  return database.prepare(`
    SELECT ticker, event_type AS eventType, event_date AS eventDate, title, details,
      source, payload_json AS payloadJson, created_at AS createdAt
    FROM corporate_events
    WHERE user_id = ?
    ORDER BY event_date DESC, created_at DESC
    LIMIT 80
  `).all(userId).map((event) => {
    if (!owned.has(event.ticker)) return null;
    const payload = safeJsonParse(event.payloadJson, {}) || {};
    const sourceUrl = safeNewsUrl(payload.url || payload.articleUrl || payload.link);
    if (!sourceUrl) return null;
    return {
      id: `stored:${event.ticker}:${event.eventDate}:${sourceUrl}`,
      ticker: event.ticker,
      eventType: event.eventType,
      eventDate: event.eventDate,
      title: event.title,
      details: event.details,
      source: event.source,
      sourceUrl,
      newsSource: payload.source || event.source,
      publishedAt: payload.datetime ? new Date(Number(payload.datetime) * 1000).toISOString() : event.createdAt
    };
  }).filter(Boolean);
}

export async function dashboardNews(userId, { refresh = false } = {}) {
  const database = getDb();
  const ownedTickers = ownedPortfolioTickers(database, userId);
  const items = sourceLinkedStoredNews(database, userId, ownedTickers);
  const errors = [];
  const providers = [];
  if (items.length) providers.push("Stored corporate events");

  if (ownedTickers.length && (refresh || items.length < 6)) {
    const from = daysFromNow(-7);
    const to = todayIsoDate();
    for (const ticker of ownedTickers.slice(0, 10)) {
      if (config.finnhubApiKey) {
        try {
          const news = await finnhub("company-news", { symbol: ticker, from, to });
          providers.push("Finnhub company news");
          for (const item of news || []) {
            const normalized = newsItemFromFinnhub(ticker, item);
            if (normalized) items.push(normalized);
          }
        } catch (error) {
          errors.push({ ticker, provider: "finnhub", message: error.message });
        }
      }
      try {
        const news = await yahooFinanceRssNews(ticker);
        if (news.length) providers.push("Yahoo Finance RSS");
        items.push(...news);
      } catch (error) {
        errors.push({ ticker, provider: "yahoo_rss", message: error.message });
      }
    }
  }

  const seen = new Set();
  const uniqueItems = items
    .filter((item) => {
      const key = item.sourceUrl || `${item.ticker}:${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.publishedAt || b.eventDate).localeCompare(String(a.publishedAt || a.eventDate)))
    .slice(0, 30);

  const message = !ownedTickers.length
    ? "No open portfolio positions were found for the news feed."
    : errors.length
      ? `${errors.length} provider checks failed. Stored and successful news items are shown.`
      : uniqueItems.length
        ? "Portfolio news loaded."
        : "No recent source-linked articles were returned for owned positions.";

  return {
    items: uniqueItems,
    diagnostics: {
      status: errors.length ? "PARTIAL" : providers.some((provider) => provider !== "Stored corporate events") ? "LIVE" : "STORED_ONLY",
      message,
      providers: [...new Set(providers)],
      ownedTickers: ownedTickers.length,
      errors
    }
  };
}

export async function refreshCorporateEvents(userId) {
  const database = getDb();
  const tickers = trackedTickers(database);
  const created = [];
  const errors = [];

  for (const ticker of tickers) {
    try {
      const events = await fetchTickerEvents(ticker);
      for (const event of events) {
        const eventId = id("event");
        const result = database.prepare(`
          INSERT OR IGNORE INTO corporate_events (
            id, user_id, ticker, event_type, event_date, title, details,
            source, source_event_id, payload_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventId,
          userId,
          ticker,
          event.eventType,
          event.eventDate,
          event.title,
          event.details || null,
          event.source,
          event.sourceEventId,
          JSON.stringify(event.payload || {}),
          nowIso()
        );
        if (result.changes) created.push({ ...event, id: eventId });
      }
    } catch (error) {
      errors.push({ ticker, message: error.message });
    }
  }

  return { created, errors };
}

export async function notifyNewCorporateEvents(userId) {
  const database = getDb();
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const events = database.prepare(`
    SELECT *
    FROM corporate_events
    WHERE user_id = ? AND notified_at IS NULL
    ORDER BY event_date
    LIMIT 25
  `).all(userId);

  const results = [];
  for (const event of events) {
    const existing = database.prepare(`
      SELECT id, status
      FROM notification_history
      WHERE user_id = ? AND event_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId, event.id);
    let sendResult;
    if (existing?.status === "SENT") {
      sendResult = { id: existing.id, status: "SENT" };
    } else if (existing?.id) {
      sendResult = await sendNotification(existing.id);
    } else {
      const email = renderCorporateEventEmail({ event });
      sendResult = await createAndSendNotification({
        userId,
        kind: "CORPORATE_EVENT",
        ticker: event.ticker,
        eventId: event.id,
        recipient: user.email,
        subject: email.subject,
        body: email.body
      });
    }
    if (sendResult?.status === "SENT") {
      database.prepare("UPDATE corporate_events SET notified_at = ? WHERE id = ?").run(nowIso(), event.id);
    }
    results.push({ eventId: event.id, ticker: event.ticker, notification: sendResult });
  }
  return results;
}
