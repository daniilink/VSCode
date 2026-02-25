import jwt from 'jsonwebtoken';

const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_KEY;
const JWT_EXPIRES = '7d';

/**
 * Generate JWT token
 */
export function generateToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Auth middleware - supports both JWT cookie and legacy key param
 */
export function authMiddleware(req, res, next) {
  // 1. Check JWT in cookie
  const token = req.cookies?.admin_token;
  if (token && verifyToken(token)) {
    req.isAuthenticated = true;
    return next();
  }

  // 2. Legacy: check key in query (for backwards compatibility)
  if (req.query.key === ADMIN_KEY) {
    req.isAuthenticated = true;
    return next();
  }

  // 3. Not authenticated - redirect to login or return 401
  if (req.headers.accept?.includes('text/html')) {
    return res.redirect('/admin/login');
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Login handler
 */
export function handleLogin(req, res) {
  const { password } = req.body;

  if (password !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = generateToken();

  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  res.json({ success: true });
}

/**
 * Logout handler
 */
export function handleLogout(req, res) {
  res.clearCookie('admin_token');
  res.redirect('/admin/login');
}
