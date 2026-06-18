import { getDb } from "../db.js";
import { config } from "../config.js";
import { fetchJson, InputError, nowIso, SUPPORTED_FX_CURRENCIES } from "../utils.js";

function pair(fromCurrency, toCurrency) {
  return `${fromCurrency}_${toCurrency}`;
}

function isFresh(asOf, hours) {
  return asOf && Date.now() - new Date(asOf).getTime() < hours * 60 * 60 * 1000;
}

async function fetchRate(fromCurrency, toCurrency) {
  const url = new URL(config.fxApiUrl);
  url.searchParams.set("from", fromCurrency);
  url.searchParams.set("to", toCurrency);
  const payload = await fetchJson(url, { timeoutMs: 12000 });
  const rate = payload?.rates?.[toCurrency];
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX provider did not return ${fromCurrency}/${toCurrency}`);
  }
  return rate;
}

export async function getExchangeRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();
  if (!SUPPORTED_FX_CURRENCIES.includes(from) || !SUPPORTED_FX_CURRENCIES.includes(to)) {
    throw new InputError(`FX conversion is not supported for ${from}/${to}`);
  }
  if (from === to) return { rate: 1, stale: false, provider: "identity" };

  const database = getDb();
  const existing = database.prepare("SELECT * FROM exchange_rates WHERE pair = ?").get(pair(from, to));
  if (existing && isFresh(existing.as_of, config.fxCacheHours)) {
    return { rate: existing.rate, stale: false, provider: existing.provider };
  }

  try {
    const rate = await fetchRate(from, to);
    database.prepare(`
      INSERT INTO exchange_rates (pair, from_currency, to_currency, rate, provider, as_of)
      VALUES (?, ?, ?, ?, 'frankfurter', ?)
      ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, provider = excluded.provider, as_of = excluded.as_of
    `).run(pair(from, to), from, to, rate, nowIso());
    return { rate, stale: false, provider: "frankfurter" };
  } catch (error) {
    if (existing) {
      return { rate: existing.rate, stale: true, provider: existing.provider, error: error.message };
    }
    throw new Error(`FX rate unavailable for ${from}/${to}: ${error.message}`);
  }
}

export async function convertAmount(amount, fromCurrency, toCurrency) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  const { rate, stale, error } = await getExchangeRate(fromCurrency, toCurrency);
  return { amount: numeric * rate, rate, stale, error };
}
