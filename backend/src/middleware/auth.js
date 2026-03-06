import jwt from 'jsonwebtoken';
import { sendMessage } from '../services/telegram.js';

const ADMIN_KEY    = process.env.ADMIN_KEY || 'changeme';
const JWT_SECRET   = process.env.JWT_SECRET || process.env.ADMIN_KEY;
const JWT_EXPIRES  = '7d';
const ADMIN_TG_ID  = '472124645';

// ─────────────────────────────────────────────────────────────
// Brute-force tracking: ip → { count, firstAttempt, alertSent }
// ─────────────────────────────────────────────────────────────
const loginAttempts = new Map();
const MAX_ATTEMPTS      = 10;
const LOCKOUT_MS        = 15 * 60 * 1000; // 15 min
const ALERT_THRESHOLD   = 3;              // alert after 3 bad tries

// Auto-cleanup old entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttempt > LOCKOUT_MS) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

function getClientIP(req) {
  return (
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isLockedOut(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOCKOUT_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

// ─────────────────────────────────────────────────────────────
// JWT helpers
// ─────────────────────────────────────────────────────────────
export function generateToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────
export function authMiddleware(req, res, next) {
  const token = req.cookies?.admin_token;
  if (token && verifyToken(token)) {
    req.isAuthenticated = true;
    return next();
  }

  // Legacy key param (backwards compat)
  if (req.query.key === ADMIN_KEY) {
    req.isAuthenticated = true;
    return next();
  }

  if (req.headers.accept?.includes('text/html')) {
    return res.redirect('/admin/login');
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ─────────────────────────────────────────────────────────────
// Login handler
// ─────────────────────────────────────────────────────────────
export async function handleLogin(req, res) {
  const { password } = req.body;
  const ip = getClientIP(req);

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  if (password !== ADMIN_KEY) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, firstAttempt: now, alertSent: false };
    entry.count++;
    if (entry.firstAttempt === now) entry.firstAttempt = now; // preserve original
    loginAttempts.set(ip, entry);

    // Alert admin on threshold (once per lockout window)
    if (entry.count >= ALERT_THRESHOLD && !entry.alertSent) {
      entry.alertSent = true;
      sendMessage(ADMIN_TG_ID,
        `🚨 <b>Admin panel: failed login attempts!</b>\n\n` +
        `IP: <code>${ip}</code>\n` +
        `Attempts: <b>${entry.count}</b>\n\n` +
        `Auto-block activates at ${MAX_ATTEMPTS} attempts.`,
        {}
      ).catch(() => {});
    }

    return res.status(401).json({ error: 'Invalid password' });
  }

  // Success — clear attempt counter
  loginAttempts.delete(ip);

  const token = generateToken();
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.json({ success: true });
}

// ─────────────────────────────────────────────────────────────
// Logout handler
// ─────────────────────────────────────────────────────────────
export function handleLogout(req, res) {
  res.clearCookie('admin_token');
  res.redirect('/admin/login');
}
