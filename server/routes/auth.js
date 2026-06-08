/**
 * Auth Router — /api/auth
 *
 * POST /register       — create account (name, email, password)
 * POST /login          — email + password → JWT token
 * POST /logout         — client discards token (stateless)
 * GET  /me             — get current user profile
 * PUT  /me             — update name, currency preference
 * POST /verify/:token  — verify email address
 * POST /forgot         — request password reset email
 * POST /reset/:token   — set new password
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../models/database');
const { signToken, requireAuth } = require('../middleware/auth');
const EmailService = require('../services/emailService');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const SALT_ROUNDS = 12;

// ─── REGISTER ─────────────────────────────────────────────────────────────────
router.post('/register', [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
], validate, async (req, res, next) => {
  try {
    const db = getDb();
    const { name, email, password } = req.body;

    // Check duplicate
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const verifyToken = crypto.randomBytes(32).toString('hex');

    // Create user + default portfolio in one transaction
    const txn = db.transaction(() => {
      const { lastInsertRowid: userId } = db.prepare(`
        INSERT INTO users (email, name, password_hash, verify_token)
        VALUES (?, ?, ?, ?)
      `).run(email, name, passwordHash, verifyToken);

      const { lastInsertRowid: portfolioId } = db.prepare(`
        INSERT INTO portfolios (user_id, name, base_currency) VALUES (?, ?, ?)
      `).run(userId, 'My Portfolio', 'AUD');

      // Default groups are seeded lazily on first /api/groups call.
      return { userId, portfolioId };
    });

    const { userId } = txn();

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      await EmailService.sendVerificationEmail({ to: email, name, token: verifyToken });
    } catch (emailErr) {
      console.warn('[Auth] Verification email failed:', emailErr.message);
    }

    // Return token immediately so user can start using app
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
    const token = signToken(user);

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, isVerified: false },
      message: 'Account created. Check your email to verify.',
    });
  } catch (err) {
    next(err);
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], validate, async (req, res, next) => {
  try {
    const db = getDb();
    const { email, password } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    // Use constant-time comparison even if user not found (prevents timing attacks)
    const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attacks.padding';
    const hash = user?.password_hash || dummyHash;
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);

    const token = signToken(user);

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, isVerified: !!user.is_verified },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET CURRENT USER ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, email, name, is_verified, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const portfolio = db.prepare('SELECT id, name, base_currency as currency FROM portfolios WHERE user_id = ? LIMIT 1').get(user.id);

    res.json({ user, portfolio });
  } catch (err) {
    next(err);
  }
});

// ─── UPDATE PROFILE ───────────────────────────────────────────────────────────
router.put('/me', requireAuth, [
  body('name').optional().trim().isLength({ min: 2, max: 80 }),
  body('currency').optional().isString(),
], validate, (req, res, next) => {
  try {
    const db = getDb();
    const { name, currency } = req.body;

    if (name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    }
    if (currency) {
      db.prepare('UPDATE portfolios SET base_currency = ? WHERE user_id = ?').run(currency, req.user.id);
    }

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

// ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────
router.post('/verify/:token', (req, res, next) => {
  try {
    const db = getDb();
    const { token } = req.params;
    const user = db.prepare('SELECT id FROM users WHERE verify_token = ?').get(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification link' });

    db.prepare(`UPDATE users SET is_verified = 1, verify_token = NULL WHERE id = ?`).run(user.id);
    res.json({ verified: true, message: 'Email verified successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
router.post('/forgot', [
  body('email').isEmail().normalizeEmail(),
], validate, async (req, res, next) => {
  try {
    const db = getDb();
    const { email } = req.body;
    const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);

    // Always respond the same way to prevent email enumeration
    const safeResponse = { message: 'If that email exists, a reset link has been sent' };

    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour

      db.prepare(`UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?`)
        .run(resetToken, expires, user.id);

      try {
        await EmailService.sendPasswordResetEmail({ to: email, name: user.name, token: resetToken });
      } catch (emailErr) {
        console.warn('[Auth] Reset email failed:', emailErr.message);
      }
    }

    res.json(safeResponse);
  } catch (err) {
    next(err);
  }
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
router.post('/reset/:token', [
  body('password').isLength({ min: 8 }).matches(/[A-Z]/).matches(/[0-9]/),
], validate, async (req, res, next) => {
  try {
    const db = getDb();
    const { token } = req.params;
    const { password } = req.body;

    const user = db.prepare(`
      SELECT id FROM users
      WHERE reset_token = ? AND reset_expires > datetime('now')
    `).get(token);

    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    db.prepare(`
      UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?
    `).run(passwordHash, user.id);

    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
