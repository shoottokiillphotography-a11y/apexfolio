import { getDb } from "../db.js";
import { nowIso } from "../utils.js";

const RULES_KEY = "dashboard_rules";

// Defaults mirror the original hard-coded thresholds in dashboard-intelligence.js,
// so behaviour is identical until the user edits the rules.
export const DEFAULT_RULES = {
  concentration: {
    warnAtPercent: 15,
    highAtPercent: 20
  },
  allocation: {
    warnAtVariancePP: 5,
    highAtVariancePP: 15,
    onTargetBandPP: 2
  },
  cash: {
    elevatedAtPercent: 12,
    highAtPercent: 20
  },
  playbook: "Deploy cash only into valid buy/add zones. Review triggered alerts before any new buys. Do not add to a position above its concentration limit unless the sizing is intentional."
};

function clampNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// Merge a user-supplied object onto the defaults, keeping only known fields and
// coercing numbers. Anything missing or invalid falls back to the default.
export function normalizeRules(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const concentration = source.concentration || {};
  const allocation = source.allocation || {};
  const cash = source.cash || {};
  return {
    concentration: {
      warnAtPercent: clampNumber(concentration.warnAtPercent, DEFAULT_RULES.concentration.warnAtPercent),
      highAtPercent: clampNumber(concentration.highAtPercent, DEFAULT_RULES.concentration.highAtPercent)
    },
    allocation: {
      warnAtVariancePP: clampNumber(allocation.warnAtVariancePP, DEFAULT_RULES.allocation.warnAtVariancePP),
      highAtVariancePP: clampNumber(allocation.highAtVariancePP, DEFAULT_RULES.allocation.highAtVariancePP),
      onTargetBandPP: clampNumber(allocation.onTargetBandPP, DEFAULT_RULES.allocation.onTargetBandPP)
    },
    cash: {
      elevatedAtPercent: clampNumber(cash.elevatedAtPercent, DEFAULT_RULES.cash.elevatedAtPercent),
      highAtPercent: clampNumber(cash.highAtPercent, DEFAULT_RULES.cash.highAtPercent)
    },
    playbook: typeof source.playbook === "string" ? source.playbook.slice(0, 4000) : DEFAULT_RULES.playbook
  };
}

export function getRules(userId, database = getDb()) {
  try {
    const row = database
      .prepare("SELECT value_json FROM app_settings WHERE user_id = ? AND key = ?")
      .get(userId, RULES_KEY);
    if (!row?.value_json) return normalizeRules(DEFAULT_RULES);
    return normalizeRules(JSON.parse(row.value_json));
  } catch (error) {
    return normalizeRules(DEFAULT_RULES);
  }
}

export function saveRules(userId, input, database = getDb()) {
  const rules = normalizeRules(input);
  database
    .prepare(`
      INSERT INTO app_settings (user_id, key, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `)
    .run(userId, RULES_KEY, JSON.stringify(rules), nowIso());
  return rules;
}

export function resetRules(userId, database = getDb()) {
  database.prepare("DELETE FROM app_settings WHERE user_id = ? AND key = ?").run(userId, RULES_KEY);
  return normalizeRules(DEFAULT_RULES);
}
