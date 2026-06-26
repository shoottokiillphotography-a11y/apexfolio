import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb, getPrimaryUser, resetDefaultPortfolioGroups } from "./db.js";
import { InputError, normalizeTicker } from "./utils.js";
import {
  addManualLot,
  addMarketPulseItem,
  addOrUpdateWatchlistItem,
  calculatePortfolio,
  createCategory,
  deleteCategory,
  deleteCashBalance,
  deleteMarketPulseItem,
  deleteExternalClosedTransaction,
  listCategories,
  recordExternalClosedTransaction,
  recordSale,
  removeWatchlistItem,
  saveCategoryChanges,
  updateWatchlistItem,
  updateBaseCurrency,
  updateCategory,
  updateCategoryTarget,
  updateEquityCategory,
  updateMarketPulseItem,
  upsertCashBalance
} from "./services/calculations.js";
import { importFile, previewImport } from "./services/importer.js";
import {
  archiveAlert,
  createAlert,
  deleteAlert,
  evaluateAlerts,
  markAlertReviewed,
  reactivateAlert,
  snoozeAlert,
  updateAlert
} from "./services/alerts.js";
import { getQuote, refreshTrackedQuotes, marketProviderStatus, diagnoseQuote, diagnoseBatch, searchSymbols, resolveTickerInput } from "./services/market-data.js";
import { dashboardNews, notifyNewCorporateEvents, refreshCorporateEvents } from "./services/events.js";
import { sendPendingNotifications } from "./services/notifications.js";
import { startScheduler } from "./services/scheduler.js";
import { syncDividends } from "./services/dividends.js";
import { createWatchlist, renameWatchlist } from "./services/watchlists.js";
import { aiSettingsForUser, generateResearchMemo, saveAiSettings } from "./services/intelligence.js";
import { getRules, saveRules, resetRules, DEFAULT_RULES } from "./services/rules.js";
import { buildRulesEngineComparison } from "./services/rules-engine-v2.js";
import { refreshTrackedFundamentals } from "./services/fundamentals.js";
import { portfolioPerformance, stockDetail, tickerPerformance } from "./services/performance.js";
import { seedStrategyAlerts } from "./services/strategy-alerts.js";
import {
  exportCurrentPortfolioCsv,
  exportFullHistoryCsv,
  exportInvestmentHistoryCsv,
  exportPortfolioSnapshotCsv,
  exportTriggeredAlertsCsv
} from "./services/export-data.js";
import {
  createExternalIncomeEvent,
  deleteExternalIncomeEvent,
  realizedIncomeTimeline,
  updateExternalIncomeEvent
} from "./services/realized-income.js";
import {
  createManualPortfolioSnapshot,
  deletePortfolioSnapshot,
  portfolioWealthTimeline,
  saveAutomaticPortfolioSnapshot,
  updateManualPortfolioSnapshot,
  saveOpeningPortfolioBalance
} from "./services/portfolio-wealth.js";
import { reallocateLightWonderSales } from "./services/sale-lot-repair.js";
import {
  authenticatedUser,
  authNeedsSetup,
  clearSessionCookie,
  createUserAccount,
  currentSession,
  listUsers,
  loginUser,
  registerUser,
  requireOwner,
  setupOwner
} from "./services/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, "public");
// Bump this on each backend release so /api/health and the startup log show which
// code is actually running - the fastest way to confirm a server restart took.
const APP_BUILD = "2026-06-26-rules-center";
let stopScheduler = null;

async function setSchedulerEnabled(enabled) {
  const next = Boolean(enabled);
  await setEnvValue("RUN_SCHEDULER", next ? "true" : "false");
  config.runScheduler = next;
  if (next && !stopScheduler) stopScheduler = startScheduler();
  if (!next && stopScheduler) {
    stopScheduler();
    stopScheduler = null;
  }
  return { schedulerEnabled: Boolean(stopScheduler) };
}

function emailConfigured() {
  if (config.emailProvider === "brevo") return Boolean(config.brevoApiKey && config.brevoFromEmail);
  return Boolean(config.sendgridApiKey && config.sendgridFromEmail);
}

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

async function readBody(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new InputError("Request body is too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new InputError("Invalid JSON body");
  }
}

async function readJsonOrForm(req) {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {};
  const contentTypeHeader = req.headers["content-type"] || "";
  if (contentTypeHeader.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body.toString("utf8")));
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new InputError("Invalid settings body");
  }
}

async function setEnvValue(name, value) {
  const envPath = path.join(config.projectRoot, ".env");
  let text;
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch {
    text = await fs.readFile(path.join(config.projectRoot, ".env.example"), "utf8");
  }

  const escaped = String(value || "").trim();
  if (!escaped) throw new InputError(`${name} cannot be empty`);

  const line = `${name}=${escaped}`;
  if (new RegExp(`^${name}=.*$`, "m").test(text)) {
    text = text.replace(new RegExp(`^${name}=.*$`, "m"), line);
  } else {
    text += `\n${line}\n`;
  }
  await fs.writeFile(envPath, text);
}

function parseMultipart(buffer, contentTypeHeader) {
  const boundary = /boundary=([^;]+)/.exec(contentTypeHeader || "")?.[1]?.replace(/^"|"$/g, "");
  if (!boundary) throw new InputError("Multipart upload boundary is missing");

  const parts = buffer.toString("latin1").split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = [];

  for (const raw of parts) {
    const cleaned = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const separator = cleaned.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headers = cleaned.slice(0, separator);
    const body = cleaned.slice(separator + 4);
    const disposition = /Content-Disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1] || "";
    const name = /name="([^"]+)"/.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    if (!name) continue;
    if (filename) {
      files.push({ field: name, filename: path.basename(filename), buffer: Buffer.from(body, "latin1") });
    } else {
      fields[name] = body;
    }
  }

  return { fields, files };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendDownload(res, statusCode, download) {
  const body = Buffer.isBuffer(download.body) ? download.body : Buffer.from(String(download.body || ""), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": download.contentType || "application/octet-stream",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${String(download.filename || "apexfolio-export.csv").replace(/"/g, "")}"`,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function sendStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicRoot, requested));
  if (!filePath.startsWith(publicRoot)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    const hasExtension = Boolean(path.extname(requested));
    if (!hasExtension) {
      const body = await fs.readFile(path.join(publicRoot, "index.html"));
      res.writeHead(200, {
        "Content-Type": contentType("index.html"),
        "Content-Length": body.length,
        "Cache-Control": "no-store"
      });
      res.end(body);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  }
}

function route(method, pathname, pattern) {
  if (method !== pattern.method) return null;
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.path.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function handleApi(req, res, url) {
  const database = getDb();
  const publicRoutes = [
    {
      method: "GET",
      path: "/api/health",
      handler: async () => {
        const user = authenticatedUser(req, database) || getPrimaryUser();
        const aiSettings = user ? aiSettingsForUser(database, user.id) : null;
        return {
          ok: true,
          build: APP_BUILD,
          providerStatus: marketProviderStatus(),
          emailProvider: config.emailProvider,
          emailConfigured: emailConfigured(),
          aiConfigured: Boolean(aiSettings?.apiKey),
          aiProvider: aiSettings?.provider || "rules",
          aiModel: aiSettings?.model || null,
          schedulerEnabled: Boolean(stopScheduler),
          baseCurrency: user?.base_currency || config.baseCurrency
        };
      }
    },
    {
      method: "GET",
      path: "/api/session",
      handler: async () => currentSession(req, database)
    },
    {
      method: "POST",
      path: "/api/auth/setup",
      handler: async () => {
        const result = setupOwner(await readJson(req), req, database);
        return { __cookie: result.cookie, payload: { ok: true, user: result.user } };
      }
    },
    {
      method: "POST",
      path: "/api/auth/login",
      handler: async () => {
        const result = loginUser(await readJson(req), req, database);
        return { __cookie: result.cookie, payload: { ok: true, user: result.user } };
      }
    },
    {
      method: "POST",
      path: "/api/auth/register",
      handler: async () => {
        const result = registerUser(await readJson(req), req, database);
        return { __cookie: result.cookie, payload: { ok: true, user: result.user } };
      }
    },
    {
      method: "POST",
      path: "/api/auth/logout",
      handler: async () => ({ __cookie: clearSessionCookie(req, database), payload: { ok: true } })
    }
  ];

  for (const pattern of publicRoutes) {
    const params = route(req.method, url.pathname, pattern);
    if (params) {
      const result = await pattern.handler(params);
      if (result?.__download) {
        sendDownload(res, 200, result);
        return;
      }
      if (result?.__cookie) {
        sendJson(res, 200, result.payload, { "Set-Cookie": result.__cookie });
      } else {
        sendJson(res, 200, result);
      }
      return;
    }
  }

  const user = authenticatedUser(req, database);
  if (!user) {
    sendJson(res, 401, {
      error: authNeedsSetup(database) ? "Owner login setup is required" : "Login required",
      authRequired: true,
      needsSetup: authNeedsSetup(database)
    });
    return;
  }

  const routes = [
    {
      method: "GET",
      path: "/api/dashboard",
      handler: async () => {
        const dashboard = await calculatePortfolio(user.id, { refreshPrices: url.searchParams.get("refresh") === "true" });
        saveAutomaticPortfolioSnapshot(user.id, dashboard);
        return dashboard;
      }
    },
    {
      method: "GET",
      path: "/api/exports/full-history",
      handler: async () => exportFullHistoryCsv(user.id)
    },
    {
      method: "GET",
      path: "/api/exports/current-portfolio",
      handler: async () => exportCurrentPortfolioCsv(user.id)
    },
    {
      method: "GET",
      path: "/api/exports/portfolio",
      handler: async () => exportPortfolioSnapshotCsv(user.id)
    },
    {
      method: "GET",
      path: "/api/exports/history",
      handler: async () => exportInvestmentHistoryCsv(user.id)
    },
    {
      method: "GET",
      path: "/api/exports/triggered-alerts",
      handler: async () => exportTriggeredAlertsCsv(user.id, {
        includeReviewed: url.searchParams.get("include") === "reviewed"
      })
    },
    {
      method: "GET",
      path: "/api/realized-income",
      handler: async () => realizedIncomeTimeline(user.id, {
        range: url.searchParams.get("range") || "all",
        filter: url.searchParams.get("filter") || "all"
      })
    },
    {
      method: "GET",
      path: "/api/portfolio-wealth",
      handler: async () => portfolioWealthTimeline(user.id, {
        range: url.searchParams.get("range") || "all"
      })
    },
    {
      method: "POST",
      path: "/api/portfolio-wealth/opening-balance",
      handler: async () => saveOpeningPortfolioBalance(user.id, await readJson(req))
    },
    {
      method: "POST",
      path: "/api/portfolio-wealth/snapshots",
      handler: async () => createManualPortfolioSnapshot(user.id, await readJson(req))
    },
    {
      method: "PATCH",
      path: "/api/portfolio-wealth/snapshots/:snapshotId",
      handler: async ({ snapshotId }) => updateManualPortfolioSnapshot(user.id, snapshotId, await readJson(req))
    },
    {
      method: "DELETE",
      path: "/api/portfolio-wealth/snapshots/:snapshotId",
      handler: async ({ snapshotId }) => deletePortfolioSnapshot(user.id, snapshotId)
    },
    {
      method: "POST",
      path: "/api/external-income",
      handler: async () => createExternalIncomeEvent(user.id, await readJson(req))
    },
    {
      method: "PATCH",
      path: "/api/external-income/:eventId",
      handler: async ({ eventId }) => updateExternalIncomeEvent(user.id, eventId, await readJson(req))
    },
    {
      method: "DELETE",
      path: "/api/external-income/:eventId",
      handler: async ({ eventId }) => deleteExternalIncomeEvent(user.id, eventId)
    },
    {
      method: "GET",
      path: "/api/performance/portfolio",
      handler: async () => portfolioPerformance(user.id, url.searchParams.get("range") || "1y")
    },
    {
      method: "GET",
      path: "/api/performance/ticker/:ticker",
      handler: async ({ ticker }) => tickerPerformance(ticker, url.searchParams.get("range") || "1y")
    },
    {
      method: "GET",
      path: "/api/stocks/:ticker",
      handler: async ({ ticker }) => stockDetail(user.id, ticker, {
        refresh: url.searchParams.get("refresh") === "true"
      })
    },
    {
      method: "GET",
      path: "/api/quotes/:ticker",
      handler: async ({ ticker }) => ({
        quote: await getQuote(ticker, { force: url.searchParams.get("refresh") === "true" })
      })
    },
    {
      method: "GET",
      path: "/api/quote/:ticker",
      handler: async ({ ticker }) => ({
        quote: await getQuote(ticker, { force: url.searchParams.get("refresh") === "true" })
      })
    },
    {
      method: "GET",
      path: "/api/diag/quote/:ticker",
      handler: async ({ ticker }) => diagnoseQuote(ticker, {
        reset: url.searchParams.get("reset") === "1",
        limited: url.searchParams.get("limited") === "1"
      })
    },
    {
      method: "GET",
      path: "/api/diag/batch",
      handler: async () => diagnoseBatch(url.searchParams.get("scope") || "all")
    },
    {
      method: "GET",
      path: "/api/symbols/search",
      handler: async () => ({ results: await searchSymbols(url.searchParams.get("q") || "") })
    },
    {
      method: "GET",
      path: "/api/categories",
      handler: async () => ({ categories: listCategories() })
    },
    {
      method: "GET",
      path: "/api/news",
      handler: async () => dashboardNews(user.id, { refresh: url.searchParams.get("refresh") === "true" })
    },
    {
      method: "GET",
      path: "/api/rules",
      handler: async () => ({ rules: getRules(user.id), defaults: DEFAULT_RULES })
    },
    {
      method: "GET",
      path: "/api/rules/v2/compare",
      handler: async () => {
        const dashboard = await calculatePortfolio(user.id, { refreshPrices: url.searchParams.get("refresh") === "true" });
        return dashboard.rulesV2Comparison || buildRulesEngineComparison(dashboard);
      }
    },
    {
      method: "PUT",
      path: "/api/rules",
      handler: async () => {
        const body = await readJson(req);
        return { rules: saveRules(user.id, body?.rules ?? body), defaults: DEFAULT_RULES };
      }
    },
    {
      method: "POST",
      path: "/api/rules/reset",
      handler: async () => ({ rules: resetRules(user.id), defaults: DEFAULT_RULES })
    },
    {
      method: "GET",
      path: "/api/users",
      handler: async () => {
        requireOwner(user);
        return { users: listUsers(database) };
      }
    },
    {
      method: "POST",
      path: "/api/users",
      handler: async () => {
        requireOwner(user);
        return { user: createUserAccount(await readJson(req), database) };
      }
    },
    {
      method: "POST",
      path: "/api/admin/repair-lnw-sales",
      handler: async () => {
        requireOwner(user);
        return reallocateLightWonderSales(user.id, { apply: true });
      }
    },
    {
      method: "POST",
      path: "/api/settings/base-currency",
      handler: async () => ({ baseCurrency: updateBaseCurrency(user.id, (await readJson(req)).currency) })
    },
    {
      method: "POST",
      path: "/api/settings/finnhub-key",
      handler: async () => {
        requireOwner(user);
        const body = await readJson(req);
        const key = String(body.key || "").trim();
        if (key.length < 8) throw new InputError("Finnhub key looks too short");
        await setEnvValue("FINNHUB_API_KEY", key);
        config.finnhubApiKey = key;
        return { ok: true, finnhubConfigured: true };
      }
    },
    {
      method: "POST",
      path: "/api/settings/email",
      handler: async () => {
        requireOwner(user);
        const body = await readJsonOrForm(req);
        const provider = String(body.provider || body.emailProvider || config.emailProvider || "brevo").trim().toLowerCase();
        if (!["brevo", "sendgrid"].includes(provider)) throw new InputError("Email provider must be Brevo or SendGrid");
        const key = String(body.apiKey || body.brevoApiKey || body.sendgridApiKey || body.key || "").trim();
        const existingKey = provider === "brevo" ? config.brevoApiKey : config.sendgridApiKey;
        const existingFromEmail = provider === "brevo" ? config.brevoFromEmail : config.sendgridFromEmail;
        const fromEmail = String(body.fromEmail || existingFromEmail || "").trim();
        const recipientEmail = String(body.recipientEmail || "").trim();
        const fromName = String(body.fromName || config.brevoFromName || config.sendgridFromName || "Portfolio Tracker").trim();
        if (!key && !existingKey) throw new InputError("Email API key is required");
        if (key && key.length < 8) throw new InputError("Email API key looks too short");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new InputError("Sender email is required");
        if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
          throw new InputError("Recipient email is not valid");
        }
        await setEnvValue("EMAIL_PROVIDER", provider);
        config.emailProvider = provider;
        if (provider === "brevo") {
          if (key) await setEnvValue("BREVO_API_KEY", key);
          await setEnvValue("BREVO_FROM_EMAIL", fromEmail);
          await setEnvValue("BREVO_FROM_NAME", fromName);
          if (key) config.brevoApiKey = key;
          config.brevoFromEmail = fromEmail;
          config.brevoFromName = fromName;
        } else {
          if (key) await setEnvValue("SENDGRID_API_KEY", key);
          await setEnvValue("SENDGRID_FROM_EMAIL", fromEmail);
          await setEnvValue("SENDGRID_FROM_NAME", fromName);
          if (key) config.sendgridApiKey = key;
          config.sendgridFromEmail = fromEmail;
          config.sendgridFromName = fromName;
        }
        if (recipientEmail) {
          await setEnvValue("DEFAULT_USER_EMAIL", recipientEmail);
          getDb().prepare("UPDATE users SET email = ? WHERE id = ?").run(recipientEmail, user.id);
          user.email = recipientEmail;
        }
        return { ok: true, emailProvider: provider, emailConfigured: true };
      }
    },
    {
      method: "POST",
      path: "/api/settings/openai-key",
      handler: async () => {
        requireOwner(user);
        const settings = saveAiSettings(user.id, { ...(await readJson(req)), provider: "openai" });
        return { ok: true, aiConfigured: true, aiProvider: settings.provider, aiModel: settings.model };
      }
    },
    {
      method: "POST",
      path: "/api/settings/ai",
      handler: async () => {
        requireOwner(user);
        const settings = saveAiSettings(user.id, await readJson(req));
        return { ok: true, aiConfigured: true, aiProvider: settings.provider, aiModel: settings.model };
      }
    },
    {
      method: "POST",
      path: "/api/settings/scheduler",
      handler: async () => {
        requireOwner(user);
        return setSchedulerEnabled((await readJson(req)).enabled);
      }
    },
    {
      method: "POST",
      path: "/api/intelligence/memo",
      handler: async () => {
        const body = await readJson(req);
        const dashboard = await calculatePortfolio(user.id);
        return generateResearchMemo({ intelligence: dashboard.intelligence, ticker: body.ticker, userId: user.id });
      }
    },
    {
      method: "POST",
      path: "/api/categories",
      handler: async () => {
        requireOwner(user);
        return createCategory(await readJson(req));
      }
    },
    {
      method: "PUT",
      path: "/api/categories",
      handler: async () => {
        requireOwner(user);
        return saveCategoryChanges(await readJson(req));
      }
    },
    {
      method: "POST",
      path: "/api/categories/reset-defaults",
      handler: async () => {
        requireOwner(user);
        return resetDefaultPortfolioGroups(getDb());
      }
    },
    {
      method: "PATCH",
      path: "/api/categories/:categoryId",
      handler: async ({ categoryId }) => {
        requireOwner(user);
        const body = await readJson(req);
        if (Object.keys(body).length === 1 && Object.hasOwn(body, "targetPercent")) {
          updateCategoryTarget(categoryId, body.targetPercent);
          return { ok: true };
        }
        return updateCategory(categoryId, body);
      }
    },
    {
      method: "DELETE",
      path: "/api/categories/:categoryId",
      handler: async ({ categoryId }) => {
        requireOwner(user);
        return deleteCategory(categoryId, await readJson(req));
      }
    },
    {
      method: "PATCH",
      path: "/api/equities/:ticker/category",
      handler: async ({ ticker }) => {
        requireOwner(user);
        const body = await readJson(req);
        updateEquityCategory(ticker, body.categoryId);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/cash",
      handler: async () => {
        const body = await readJson(req);
        upsertCashBalance(user.id, body.currency, body.amount);
        return { ok: true };
      }
    },
    {
      method: "DELETE",
      path: "/api/cash/:currency",
      handler: async ({ currency }) => deleteCashBalance(user.id, currency)
    },
    {
      method: "POST",
      path: "/api/market-pulse",
      handler: async () => addMarketPulseItem(user.id, await readJson(req))
    },
    {
      method: "PATCH",
      path: "/api/market-pulse/:itemId",
      handler: async ({ itemId }) => updateMarketPulseItem(user.id, itemId, await readJson(req))
    },
    {
      method: "DELETE",
      path: "/api/market-pulse/:itemId",
      handler: async ({ itemId }) => deleteMarketPulseItem(user.id, itemId)
    },
    {
      method: "POST",
      path: "/api/lots",
      handler: async () => ({ id: addManualLot(user.id, await readJson(req)) })
    },
    {
      method: "POST",
      path: "/api/imports",
      handler: async () => {
        const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
        const file = multipart.files[0];
        if (!file) throw new InputError("Upload file is required");
        return importFile({
          userId: user.id,
          filename: file.filename,
          buffer: file.buffer,
          kind: multipart.fields.kind || "auto",
          replace: multipart.fields.replace === "true",
          watchlistName: multipart.fields.watchlistName || "Default"
        });
      }
    },
    {
      method: "POST",
      path: "/api/imports/preview",
      handler: async () => {
        const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
        const file = multipart.files[0];
        if (!file) throw new InputError("Upload file is required");
        return previewImport(file.filename, file.buffer);
      }
    },
    {
      method: "POST",
      path: "/api/watchlist",
      handler: async () => {
        const body = await readJson(req);
        if (body && body.ticker) body.ticker = await resolveTickerInput(body.ticker);
        addOrUpdateWatchlistItem(user.id, body);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/watchlists",
      handler: async () => createWatchlist(user.id, await readJson(req))
    },
    {
      method: "PATCH",
      path: "/api/watchlists/:watchlistId",
      handler: async ({ watchlistId }) => renameWatchlist(user.id, watchlistId, await readJson(req))
    },
    {
      method: "PATCH",
      path: "/api/watchlist/:itemId",
      handler: async ({ itemId }) => updateWatchlistItem(user.id, itemId, await readJson(req))
    },
    {
      method: "DELETE",
      path: "/api/watchlist/:itemId",
      handler: async ({ itemId }) => {
        removeWatchlistItem(user.id, itemId);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/alerts",
      handler: async () => ({ id: createAlert(user.id, await readJson(req)) })
    },
    {
      method: "POST",
      path: "/api/alerts/seed-strategy",
      handler: async () => seedStrategyAlerts(user.id)
    },
    {
      method: "POST",
      path: "/api/alerts/:alertId/review",
      handler: async ({ alertId }) => {
        markAlertReviewed(user.id, alertId);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/alerts/:alertId/snooze",
      handler: async ({ alertId }) => {
        const body = await readJson(req);
        snoozeAlert(user.id, alertId, body.hours || 24);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/alerts/:alertId/archive",
      handler: async ({ alertId }) => {
        archiveAlert(user.id, alertId);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/alerts/:alertId/reactivate",
      handler: async ({ alertId }) => {
        reactivateAlert(user.id, alertId);
        return { ok: true };
      }
    },
    {
      method: "PATCH",
      path: "/api/alerts/:alertId",
      handler: async ({ alertId }) => {
        updateAlert(user.id, alertId, await readJson(req));
        return { ok: true };
      }
    },
    {
      method: "DELETE",
      path: "/api/alerts/:alertId",
      handler: async ({ alertId }) => {
        deleteAlert(user.id, alertId);
        return { ok: true };
      }
    },
    {
      method: "POST",
      path: "/api/alerts/evaluate",
      handler: async () => evaluateAlerts(user.id, { forceQuotes: true })
    },
    {
      method: "POST",
      path: "/api/prices/refresh",
      handler: async () => {
        const body = await readJson(req);
        const force = url.searchParams.get("force") === "false" || body.force === false ? false : true;
        const scopeRaw = url.searchParams.get("scope") || body.scope || "all";
        const scope = ["fast", "alerts", "watchlist", "intl", "all"].includes(scopeRaw) ? scopeRaw : "all";
        // Scope "intl" is the explicit Refresh International action. It is the only
        // path allowed to spend the limited international quote provider.
        return refreshTrackedQuotes({ force, scope, resetBreaker: scope === "all" || scope === "intl" });
      }
    },
    {
      method: "POST",
      path: "/api/fundamentals/refresh",
      handler: async () => refreshTrackedFundamentals({ force: true })
    },
    {
      method: "POST",
      path: "/api/events/refresh",
      handler: async () => {
        const created = await refreshCorporateEvents(user.id);
        const notified = await notifyNewCorporateEvents(user.id);
        const dividends = await syncDividends(user.id);
        return { created, notified, dividends };
      }
    },
    {
      method: "POST",
      path: "/api/dividends/sync",
      handler: async () => syncDividends(user.id, await readJson(req))
    },
    {
      method: "POST",
      path: "/api/transactions/sell",
      handler: async () => recordSale(user.id, await readJson(req))
    },
    {
      method: "POST",
      path: "/api/transactions/external",
      handler: async () => recordExternalClosedTransaction(user.id, await readJson(req))
    },
    {
      method: "DELETE",
      path: "/api/transactions/external/:transactionId",
      handler: async ({ transactionId }) => deleteExternalClosedTransaction(user.id, transactionId)
    },
    {
      method: "POST",
      path: "/api/notifications/retry",
      handler: async () => {
        const events = await notifyNewCorporateEvents(user.id);
        const notifications = await sendPendingNotifications(50);
        return { events, notifications };
      }
    }
  ];

  for (const pattern of routes) {
    const params = route(req.method, url.pathname, pattern);
    if (params) {
      const result = await pattern.handler(params);
      if (result?.__download) {
        sendDownload(res, 200, result);
        return;
      }
      sendJson(res, 200, result);
      return;
    }
  }
  sendJson(res, 404, { error: "API route not found" });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await sendStatic(req, res, url.pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: error.message,
      details: error.details || null
    });
    if (statusCode >= 500) console.error(error);
  }
}

getDb();
if (config.runScheduler) stopScheduler = startScheduler();

const server = http.createServer(handleRequest);
server.listen(config.port, config.host, () => {
  console.log(`Investment portfolio tracker running at http://${config.host}:${config.port}`);
  console.log(`ApexFolio build: ${APP_BUILD}`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
