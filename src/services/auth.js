import crypto from "node:crypto";
import { getDb } from "../db.js";
import { InputError, nowIso, normalizeCurrency } from "../utils.js";
import { config } from "../config.js";

const SESSION_COOKIE = "apexfolio_session";
const SESSION_DAYS = 30;

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new InputError("Enter a valid email address");
  return value;
}

function assertPassword(password) {
  const value = String(password || "");
  if (value.length < 8) throw new InputError("Password must be at least 8 characters");
  return value;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt:")) return false;
  const [, salt, savedHash] = stored.split(":");
  if (!salt || !savedHash) return false;
  const hash = crypto.scryptSync(String(password || ""), salt, 64);
  const saved = Buffer.from(savedHash, "base64url");
  return saved.length === hash.length && crypto.timingSafeEqual(saved, hash);
}

function cookieToken(req) {
  const cookie = req.headers.cookie || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1) || "";
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.display_name || "",
    role: row.role || "member",
    baseCurrency: row.base_currency
  };
}

export function authNeedsSetup(database = getDb()) {
  const row = database.prepare("SELECT COUNT(*) AS count FROM users WHERE password_hash IS NOT NULL AND password_hash <> ''").get();
  return Number(row?.count || 0) === 0;
}

export function authenticatedUser(req, database = getDb()) {
  const token = cookieToken(req);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = database.prepare(`
    SELECT sessions.*, users.*
    FROM user_sessions sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
  `).get(tokenHash, nowIso());
  if (!session) return null;
  database.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), session.id);
  return session;
}

export function currentSession(req, database = getDb()) {
  const user = authenticatedUser(req, database);
  return {
    authenticated: Boolean(user),
    needsSetup: authNeedsSetup(database),
    user: publicUser(user)
  };
}

export function createSessionCookie(userId, req, database = getDb()) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, hashToken(token), createdAt, createdAt, expiresAt);

  const host = String(req.headers.host || "");
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") || host.includes("railway.app");
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(req, database = getDb()) {
  const token = cookieToken(req);
  if (token) database.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hashToken(token));
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function setupOwner(body, req, database = getDb()) {
  if (!authNeedsSetup(database)) throw new InputError("Login is already set up", 409);
  const email = normalizeEmail(body.email || config.defaultUserEmail);
  const password = assertPassword(body.password);
  const name = String(body.name || "Owner").trim() || "Owner";
  const primary = database.prepare("SELECT * FROM users ORDER BY created_at LIMIT 1").get();
  if (!primary) throw new InputError("Primary user is missing", 500);
  database.prepare(`
    UPDATE users
    SET email = ?, display_name = ?, password_hash = ?, role = 'owner', updated_at = ?
    WHERE id = ?
  `).run(email, name, hashPassword(password), nowIso(), primary.id);
  const user = database.prepare("SELECT * FROM users WHERE id = ?").get(primary.id);
  return { user: publicUser(user), cookie: createSessionCookie(user.id, req, database) };
}

export function loginUser(body, req, database = getDb()) {
  const email = normalizeEmail(body.email);
  const password = assertPassword(body.password);
  const user = database.prepare("SELECT * FROM users WHERE lower(email) = ?").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new InputError("Email or password is incorrect", 401);
  }
  database.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), user.id);
  return { user: publicUser(user), cookie: createSessionCookie(user.id, req, database) };
}

export function requireOwner(user) {
  if ((user?.role || "member") !== "owner") throw new InputError("Owner access required", 403);
}

export function listUsers(database = getDb()) {
  return database.prepare(`
    SELECT id, email, display_name, role, base_currency, created_at, last_login_at
    FROM users
    ORDER BY role = 'owner' DESC, created_at ASC
  `).all().map(publicUser);
}

export function createUserAccount(body, database = getDb()) {
  const email = normalizeEmail(body.email);
  const password = assertPassword(body.password);
  const name = String(body.name || "").trim();
  const baseCurrency = normalizeCurrency(body.baseCurrency || body.base_currency || config.baseCurrency, config.baseCurrency);
  const existing = database.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email);
  if (existing) throw new InputError("A user with this email already exists", 409);
  const createdAt = nowIso();
  const userId = crypto.randomUUID();
  database.prepare(`
    INSERT INTO users (id, email, display_name, password_hash, role, base_currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'member', ?, ?, ?)
  `).run(userId, email, name, hashPassword(password), baseCurrency, createdAt, createdAt);
  database.prepare(`
    INSERT OR IGNORE INTO cash_balances (id, user_id, currency, amount, updated_at)
    VALUES (?, ?, ?, 0, ?)
  `).run(`cash_${userId}_${baseCurrency}`, userId, baseCurrency, createdAt);
  database.prepare(`
    INSERT OR IGNORE INTO watchlists (id, user_id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, 'Default', 0, ?, ?)
  `).run(`watchlist_${userId}_default`, userId, createdAt, createdAt);
  return publicUser(database.prepare("SELECT * FROM users WHERE id = ?").get(userId));
}
