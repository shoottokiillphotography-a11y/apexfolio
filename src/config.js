import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function readLocalEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

readLocalEnv();

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(name, fallback) {
  const raw = process.env[name];
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function currency(name, fallback) {
  const value = (process.env[name] || fallback).toUpperCase();
  if (!["USD", "AUD", "GBP"].includes(value)) {
    throw new Error(`${name} must be one of USD, AUD, or GBP`);
  }
  return value;
}

function emailProvider() {
  const configured = String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  const inferred = process.env.BREVO_API_KEY ? "brevo" : process.env.SENDGRID_API_KEY ? "sendgrid" : "brevo";
  const provider = configured || inferred;
  if (!["brevo", "sendgrid"].includes(provider)) {
    throw new Error("EMAIL_PROVIDER must be brevo or sendgrid");
  }
  return provider;
}

export const config = {
  projectRoot,
  port: int("PORT", 8080),
  host: process.env.HOST || "127.0.0.1",
  databasePath: path.resolve(projectRoot, process.env.DATABASE_PATH || "./data/portfolio.sqlite"),
  baseCurrency: currency("BASE_CURRENCY", "USD"),
  defaultUserEmail: process.env.DEFAULT_USER_EMAIL || "investor@example.com",
  finnhubApiKey: process.env.FINNHUB_API_KEY || "",
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || "",
  eodhdApiKey: process.env.EODHD_API_KEY || process.env.EODHD_API_TOKEN || "",
  finnhubMinIntervalMs: int("FINNHUB_MIN_INTERVAL_MS", 1100),
  alphaVantageMinIntervalMs: int("ALPHA_VANTAGE_MIN_INTERVAL_MS", 13000),
  eodhdMinIntervalMs: int("EODHD_MIN_INTERVAL_MS", 1100),
  eodhdDailyCallLimit: int("EODHD_DAILY_CALL_LIMIT", 20),
  quoteCacheSeconds: int("QUOTE_CACHE_SECONDS", 60),
  fundamentalCacheSeconds: int("FUNDAMENTAL_CACHE_SECONDS", 86400),
  fxApiUrl: process.env.FX_API_URL || "https://api.frankfurter.app/latest",
  fxCacheHours: int("FX_CACHE_HOURS", 12),
  sendgridApiKey: process.env.SENDGRID_API_KEY || "",
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL || "",
  sendgridFromName: process.env.SENDGRID_FROM_NAME || "Portfolio Tracker",
  emailProvider: emailProvider(),
  brevoApiKey: process.env.BREVO_API_KEY || "",
  brevoFromEmail: process.env.BREVO_FROM_EMAIL || process.env.SENDGRID_FROM_EMAIL || "",
  brevoFromName: process.env.BREVO_FROM_NAME || process.env.SENDGRID_FROM_NAME || "Portfolio Tracker",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5-mini",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  runScheduler: bool("RUN_SCHEDULER", true),
  pricePollIntervalSeconds: int("PRICE_POLL_INTERVAL_SECONDS", 300),
  holdingsPollIntervalSeconds: int("HOLDINGS_POLL_INTERVAL_SECONDS", 120),
  alertsPollIntervalSeconds: int("ALERTS_POLL_INTERVAL_SECONDS", 600),
  watchlistPollIntervalSeconds: int("WATCHLIST_POLL_INTERVAL_SECONDS", 3600),
  fundamentalPollIntervalSeconds: int("FUNDAMENTAL_POLL_INTERVAL_SECONDS", 43200),
  corporateEventPollIntervalSeconds: int("CORPORATE_EVENT_POLL_INTERVAL_SECONDS", 21600),
  notificationRetryIntervalSeconds: int("NOTIFICATION_RETRY_INTERVAL_SECONDS", 120),
  corporateEventLookaheadDays: int("CORPORATE_EVENT_LOOKAHEAD_DAYS", 45)
};
