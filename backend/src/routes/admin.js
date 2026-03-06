import { Router } from 'express';
import {
  getDb, getStats,
  getPasskeyCredentials, savePasskeyCredential, updatePasskeyCounter, deletePasskeyCredential,
} from '../services/localdb.js';
import { authMiddleware, handleLogin, handleLogout, generateToken } from '../middleware/auth.js';
import { sendBackupToTelegram } from '../services/backup.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const router = Router();

// ─────────────────────────────────────────────────────────────
// WebAuthn config
// ─────────────────────────────────────────────────────────────
const BASE_URL  = process.env.BASE_URL || 'https://api.daniilink.com';
const RP_ID     = new URL(BASE_URL).hostname;
const RP_ORIGIN = BASE_URL;
const RP_NAME   = 'PP Exchange Admin';

// In-memory challenge store (one admin — one challenge at a time)
let pendingRegChallenge  = null; // { challenge, expiry }
let pendingAuthChallenge = null; // { challenge, expiry }
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 min

// Root redirect to login/dashboard
router.get('/', (req, res) => {
  res.redirect('/admin/login');
});

// Login page
router.get('/login', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Admin Login</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔐</text></svg>">
  <style>
    :root{--bg:#0f0f1a;--card:#1a1a2e;--accent:#667eea;--text:#e2e8f0;--muted:#64748b;--border:#2a2a4a;--red:#f87171}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:var(--card);padding:40px;border-radius:16px;border:1px solid var(--border);width:100%;max-width:360px}
    h1{color:var(--accent);margin-bottom:30px;text-align:center;font-size:1.5em}
    input{width:100%;padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:1em;margin-bottom:15px}
    input:focus{outline:none;border-color:var(--accent)}
    button{width:100%;padding:14px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:1em;cursor:pointer;font-weight:500}
    button:hover{opacity:0.9}
    .error{color:var(--red);text-align:center;margin-bottom:15px;display:none}
    .divider{display:flex;align-items:center;gap:10px;margin:15px 0;color:var(--muted);font-size:0.85em}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}
    .passkey-btn{width:100%;padding:14px;background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:1em;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:border-color .2s}
    .passkey-btn:hover{border-color:var(--accent)}
    .passkey-btn:disabled{opacity:0.5;cursor:not-allowed}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Admin Login</h1>
    <div class="error" id="error"></div>
    <form id="form">
      <input type="password" name="password" placeholder="Password" required autofocus>
      <button type="submit">Login</button>
    </form>
    <div class="divider">or</div>
    <button class="passkey-btn" id="passkey-btn">🔑 Use Passkey (Face ID)</button>
  </div>
  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>
  <script>
    const errEl = document.getElementById('error');
    function showError(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      const password = e.target.password.value;
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({password})
      });
      if (res.ok) {
        window.location.href = '/admin/dashboard';
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Invalid password');
      }
    };

    document.getElementById('passkey-btn').onclick = async () => {
      const btn = document.getElementById('passkey-btn');
      errEl.style.display = 'none';
      try {
        btn.disabled = true;
        btn.textContent = '⏳ Waiting for Face ID...';

        const optRes = await fetch('/admin/passkey/auth-options', { method: 'POST' });
        if (!optRes.ok) { throw new Error('No passkeys registered yet. Log in with password first.'); }
        const options = await optRes.json();

        const assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });

        const verRes = await fetch('/admin/passkey/auth-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(assertion)
        });
        if (verRes.ok) {
          window.location.href = '/admin/dashboard';
        } else {
          const data = await verRes.json().catch(() => ({}));
          throw new Error(data.error || 'Passkey verification failed');
        }
      } catch (err) {
        if (err.name !== 'NotAllowedError') showError(err.message);
        btn.disabled = false;
        btn.innerHTML = '🔑 Use Passkey (Face ID)';
      }
    };
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Login/Logout handlers
router.post('/login', handleLogin);
router.get('/logout', handleLogout);

// Use JWT auth for all routes below
const auth = authMiddleware;

// GET /admin/backup - Manual backup trigger
router.get('/backup', auth, async (req, res) => {
  try {
    const result = await sendBackupToTelegram();
    res.send(`
      <html><head><meta charset="UTF-8"><style>body{font-family:system-ui;background:#0f0f1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style></head>
      <body><div style="text-align:center"><h1>✅ Backup sent!</h1><p>Size: ${(result.size/1024).toFixed(1)}KB encrypted</p><a href="/admin/dashboard" style="color:#667eea">← Back</a></div></body></html>
    `);
  } catch (err) {
    res.status(500).send(`
      <html><head><meta charset="UTF-8"><style>body{font-family:system-ui;background:#0f0f1a;color:#f87171;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style></head>
      <body><div style="text-align:center"><h1>❌ Backup failed</h1><p>${err.message}</p><a href="/admin/dashboard" style="color:#667eea">← Back</a></div></body></html>
    `);
  }
});

// GET /admin/stats
router.get('/stats', auth, (req, res) => {
  res.json(getStats());
});

// GET /admin/clients
router.get('/clients', auth, (req, res) => {
  const db = getDb();
  const clients = db.prepare('SELECT * FROM clients ORDER BY id DESC').all();
  res.json(clients);
});

// GET /admin/paypals
router.get('/paypals', auth, (req, res) => {
  const db = getDb();
  const paypals = db.prepare('SELECT * FROM paypals ORDER BY id DESC').all();
  res.json(paypals);
});

// GET /admin/transactions
router.get('/transactions', auth, (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT ?').all(limit);
  res.json(transactions);
});

// GET /admin/search?email=xxx
router.get('/search', auth, (req, res) => {
  const { email, txn } = req.query;
  const db = getDb();

  if (txn) {
    const tx = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(txn);
    return res.json({ transaction: tx || null });
  }

  if (email) {
    const clients = db.prepare('SELECT * FROM clients WHERE emails LIKE ?').all(`%${email}%`);
    const paypals = db.prepare('SELECT * FROM paypals WHERE email LIKE ?').all(`%${email}%`);
    const transactions = db.prepare('SELECT * FROM transactions WHERE email LIKE ? OR sender LIKE ?').all(`%${email}%`, `%${email}%`);
    return res.json({ clients, paypals, transactions });
  }

  res.json({ error: 'Provide email or txn parameter' });
});

// Format processing time
function formatTime(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Convert any date to Kyiv timezone (DD.MM.YYYY, HH:mm)
function toKyivTime(dateStr) {
  if (!dateStr) return '-';
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
                   January:0, February:1, March:2, April:3, June:5, July:6, August:7, September:8, October:9, November:10, December:11 };
  const fmt = (d) => d.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', ' at').replace('\u202f', ' ');

  try {
    // Format 1: "11:33:21 Feb 21, 2026 PST" (PayPal IPN)
    let m = dateStr.match(/(\d{1,2}:\d{2}:\d{2})\s+(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(PST|PDT)/);
    if (m) {
      const [h, min, s] = m[1].split(':').map(Number);
      const offset = m[5] === 'PST' ? 8 : 7;
      const d = new Date(Date.UTC(+m[4], months[m[2]], +m[3], h + offset, min, s));
      return fmt(d);
    }

    // Format 2: "20 February 2026 at 19:48:18" (n8n/Supabase)
    m = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(+m[3], months[m[2]], +m[1], +m[4], +m[5], +m[6]);
      return fmt(d);
    }

    // Format 3: "23.02.2026 at 00:34:54" (mixed)
    m = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
      return fmt(d);
    }

    // Format 4: "23.02.2026, 00:34" (already good, just normalize)
    m = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
      return fmt(d);
    }

    // Fallback: try native parsing
    const date = new Date(dateStr);
    if (!isNaN(date)) return fmt(date);

    return dateStr;
  } catch {
    return dateStr;
  }
}

// Format amount for dashboard
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$' };
function formatAmount(amount, currency) {
  if (!amount || amount === '0') return '-';
  const str = String(amount).trim();
  // Detect currency from string if not passed
  const codeMatch = str.match(/\b(USD|EUR|GBP|RUB|UAH|PLN|CZK|CAD|AUD|CHF|JPY|NOK|SEK|DKK|HUF|ILS|TRY|CNY)\b/i);
  const code = (currency || (codeMatch ? codeMatch[1].toUpperCase() : null));
  // Strip any currency codes and symbols from amount string
  const clean = str
    .replace(/\s*(USD|EUR|GBP|RUB|UAH|PLN|CZK|CAD|AUD|CHF|JPY|NOK|SEK|DKK|HUF|ILS|TRY|CNY)\b/gi, '')
    .replace(/^[$€£₽₴]/, '')
    .trim();
  const sym = CURRENCY_SYMBOLS[code] || '';
  return `${sym}${clean}${sym ? '' : (code ? ' ' + code : '')}`;
}

// GET /admin/dashboard - Beautiful HTML dashboard
router.get('/dashboard', auth, (req, res) => {
  const stats = getStats();
  const db = getDb();
  // Sort by transaction date (newest first), parse all date formats
  const recentTx = db.prepare('SELECT * FROM transactions ORDER BY id DESC').all()
    .sort((a, b) => {
      const parseDate = (d) => {
        if (!d) return 0;
        const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
                         January:0, February:1, March:2, April:3, June:5, July:6, August:7, September:8, October:9, November:10, December:11 };

        // Format 1: "11:33:21 Feb 21, 2026 PST" (PayPal IPN)
        let m = d.match(/(\d{1,2}):(\d{2}):(\d{2})\s+(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(PST|PDT)/);
        if (m) {
          const [h, min, s] = m[1].split(':').map(Number);
          const offset = m[7] === 'PST' ? 8 : 7;
          return new Date(Date.UTC(+m[6], months[m[4]], +m[5], h + offset, min, s)).getTime();
        }

        // Format 2: "20 February 2026 at 19:48:18" (n8n/Supabase)
        m = d.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})/);
        if (m) {
          return new Date(+m[3], months[m[2]], +m[1], +m[4], +m[5], +m[6]).getTime();
        }

        // Format 3: "23.02.2026 at 00:34:54" (mixed, 4-digit year)
        m = d.match(/(\d{2})\.(\d{2})\.(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})/);
        if (m) {
          return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
        }

        // Format 5: "23.02.2026, 00:34"
        m = d.match(/(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})/);
        if (m) {
          return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]).getTime();
        }

        return new Date(d).getTime() || 0;
      };
      return parseDate(b.date) - parseDate(a.date);
    });

  // Avg processing time
  const avgProcessing = db.prepare(`
    SELECT ROUND(AVG(processing_time_ms)) as avg_ms
    FROM transactions
    WHERE processing_time_ms IS NOT NULL
  `).get();

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>PP Exchange Dashboard</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚙️</text></svg>">
  <style>
    :root{--bg:#0f0f1a;--card:#1a1a2e;--accent:#667eea;--green:#4ade80;--yellow:#fbbf24;--red:#f87171;--blue:#60a5fa;--text:#e2e8f0;--muted:#64748b}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);padding:20px;line-height:1.5}
    .container{max-width:1400px;margin:0 auto}
    h1{color:var(--accent);margin-bottom:20px;font-size:1.8em}
    h2{color:var(--accent);margin:20px 0 10px;font-size:1.2em}
    .grid{display:grid;gap:15px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
    .card{background:var(--card);padding:20px;border-radius:12px;border:1px solid #2a2a4a}
    .stat{text-align:center}
    .stat h3{font-size:2em;color:var(--accent);margin-bottom:5px}
    .stat p{color:var(--muted);font-size:0.9em}
    table{width:100%;border-collapse:collapse;font-size:0.85em}
    th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #2a2a4a}
    th{color:var(--accent);font-weight:600;background:rgba(102,126,234,0.1)}
    tr:hover{background:rgba(102,126,234,0.05)}
    .amount{color:var(--green);font-weight:600;font-size:1.1em}
    .converted{color:var(--yellow);font-size:0.8em;margin-top:2px}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75em;font-weight:500;margin:1px}
    .badge-green{background:rgba(74,222,128,0.2);color:var(--green)}
    .badge-yellow{background:rgba(251,191,36,0.2);color:var(--yellow)}
    .badge-red{background:rgba(248,113,113,0.2);color:var(--red)}
    .badge-blue{background:rgba(96,165,250,0.2);color:var(--blue)}
    .badge-purple{background:rgba(167,139,250,0.2);color:#a78bfa}
    .mono{font-family:ui-monospace,monospace;font-size:0.85em}
    .muted{color:var(--muted)}
    .flag{font-size:1.1em;margin-right:4px}
    .time{font-weight:600}
    .time.fast{color:var(--green)}
    .time.medium{color:var(--yellow)}
    .time.slow{color:var(--red)}
    .scroll{overflow-x:auto}
    .cell-badges{display:flex;flex-wrap:wrap;gap:3px}
    .copyable{cursor:pointer;transition:color .2s}
    .copyable:hover{color:var(--accent)}
    .note{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8em;color:var(--yellow)}
    .toast{position:fixed;bottom:20px;right:20px;background:var(--green);color:#000;padding:10px 20px;border-radius:8px;opacity:0;transition:opacity .3s}
    .toast.show{opacity:1}
    @media(max-width:900px){.hide-mobile{display:none}}
  </style>
</head>
<body>
  <div class="container">
    <h1>PP Exchange Dashboard</h1>
    <div style="margin-bottom:15px;display:flex;gap:20px;flex-wrap:wrap">
      <a href="/admin/db" style="color:var(--accent);text-decoration:none;font-size:0.9em">📦 Database Browser</a>
      <a href="/admin/backup" style="color:var(--accent);text-decoration:none;font-size:0.9em">💾 Create Backup</a>
      <a href="/admin/settings" style="color:var(--accent);text-decoration:none;font-size:0.9em">⚙️ Settings</a>
      <a href="/admin/logout" style="color:var(--muted);text-decoration:none;font-size:0.9em">🚪 Logout</a>
    </div>

    <div class="grid">
      <div class="card stat">
        <h3>${stats.clients}</h3>
        <p>Clients</p>
      </div>
      <div class="card stat">
        <h3>${stats.paypals}</h3>
        <p>PayPals</p>
      </div>
      <div class="card stat">
        <h3>${stats.transactions}</h3>
        <p>Transactions</p>
      </div>
      <div class="card stat">
        <h3>${formatTime(avgProcessing?.avg_ms)}</h3>
        <p>Avg Processing</p>
      </div>
    </div>

    <div class="card" style="margin-top:20px">
      <h2>All Transactions (${recentTx.length})</h2>
      <div class="scroll">
        <table>
          <tr>
            <th>TXN ID</th>
            <th>Time</th>
            <th>Date (Kyiv)</th>
            <th>Sender</th>
            <th>Amount</th>
            <th>Country</th>
            <th class="hide-mobile">Payer</th>
            <th>Status</th>
            <th>Note</th>
            <th>Client</th>
          </tr>
          ${recentTx.map(tx => {
            const hasConversion = tx.original_amount && tx.original_currency;
            const timeClass = !tx.processing_time_ms ? '' : tx.processing_time_ms < 2000 ? 'fast' : tx.processing_time_ms < 5000 ? 'medium' : 'slow';
            return `
            <tr>
              <td class="mono muted copyable" style="font-size:0.75em" onclick="copyTxn('${tx.transaction_id || ''}')" title="Click to copy">${tx.transaction_id || '-'}</td>
              <td><span class="time ${timeClass}">${formatTime(tx.processing_time_ms)}</span></td>
              <td class="muted">${toKyivTime(tx.date)}</td>
              <td>${tx.sender || '-'}</td>
              <td>
                <div class="amount">${formatAmount(tx.amount, tx.currency)}${hasConversion ? ` <span style="color:var(--muted);font-size:0.85em">(${formatAmount(tx.original_amount, tx.original_currency)})</span>` : ''}</div>
              </td>
              <td>${tx.residence_country ? `<img src="https://flagcdn.com/16x12/${tx.residence_country.toLowerCase()}.png" width="16" height="12" alt="${tx.residence_country}" title="${tx.residence_country}" style="margin-right:4px;vertical-align:middle">` : ''}${tx.residence_country || '-'}</td>
              <td class="mono muted hide-mobile">${tx.payer_email || '-'}</td>
              <td>
                <div class="cell-badges">
                  <span class="badge ${tx.payer_status === 'verified' ? 'badge-green' : 'badge-yellow'}">${tx.payer_status || '?'}</span>
                  ${tx.protection_eligibility === 'Eligible' ? '<span class="badge badge-blue">Protected</span>' : tx.protection_eligibility === 'Ineligible' ? '<span class="badge badge-red">Unprotected</span>' : ''}
                  <span class="badge badge-purple">${tx.source || 'ipn'}</span>
                </div>
              </td>
              <td class="note" title="${tx.memo || ''}">${tx.memo || ''}</td>
              <td>${tx.client || '-'}</td>
            </tr>
          `}).join('')}
        </table>
      </div>
    </div>

    <p class="muted" style="margin-top:20px;text-align:center;font-size:0.8em">
      Auto-refresh 30s
    </p>
  </div>
  <div class="toast" id="toast">Copied!</div>
  <script>
    function copyTxn(txn) {
      if (!txn || txn === '-') return;
      navigator.clipboard.writeText(txn).then(() => {
        const toast = document.getElementById('toast');
        toast.textContent = 'Copied: ' + txn;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
      });
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// GET /admin/db - Database browser
router.get('/db', auth, (req, res) => {
  const db = getDb();
  const table = req.query.table || 'transactions';
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search || '';

  // Get all tables (hide internal/unused ones)
  const HIDDEN_TABLES = new Set(['metrics', 'user_prefs']);
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(t => t.name).filter(t => !HIDDEN_TABLES.has(t));

  // Validate table name
  if (!tables.includes(table)) {
    return res.status(400).send('Invalid table');
  }

  // Get table info
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const totalCount = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;

  // Build query with optional search
  let whereClause = '';
  let params = [];
  if (search) {
    const searchCols = columns.filter(c =>
      ['TEXT', 'VARCHAR', 'CHAR'].some(t => (c.type || '').toUpperCase().includes(t))
    );
    if (searchCols.length > 0) {
      whereClause = 'WHERE ' + searchCols.map(c => `${c.name} LIKE ?`).join(' OR ');
      params = searchCols.map(() => `%${search}%`);
    }
  }

  const rows = db.prepare(`
    SELECT * FROM ${table} ${whereClause}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>DB Browser - ${table}</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{--bg:#0f0f1a;--card:#1a1a2e;--accent:#667eea;--green:#4ade80;--text:#e2e8f0;--muted:#64748b;--border:#2a2a4a}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:ui-monospace,monospace;background:var(--bg);color:var(--text);padding:20px;font-size:13px}
    .container{max-width:1600px;margin:0 auto}
    h1{color:var(--accent);margin-bottom:15px;font-size:1.4em;font-weight:500}
    .nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:15px}
    .nav a{padding:6px 12px;background:var(--card);color:var(--text);text-decoration:none;border-radius:6px;border:1px solid var(--border);transition:all .2s}
    .nav a:hover{border-color:var(--accent)}
    .nav a.active{background:var(--accent);color:white;border-color:var(--accent)}
    .toolbar{display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap;align-items:center}
    .toolbar input{padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit}
    .toolbar input:focus{outline:none;border-color:var(--accent)}
    .toolbar button{padding:8px 16px;background:var(--accent);border:none;border-radius:6px;color:white;cursor:pointer}
    .toolbar button:hover{opacity:0.9}
    .info{color:var(--muted);font-size:0.9em}
    .card{background:var(--card);border-radius:10px;border:1px solid var(--border);overflow:hidden}
    .scroll{overflow-x:auto}
    table{width:100%;border-collapse:collapse;white-space:nowrap}
    th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
    th{background:rgba(102,126,234,0.15);color:var(--accent);position:sticky;top:0;font-weight:500}
    tr:hover{background:rgba(102,126,234,0.05)}
    td{max-width:300px;overflow:hidden;text-overflow:ellipsis}
    td.id{color:var(--muted);font-size:0.9em}
    td.null{color:var(--muted);font-style:italic}
    .pagination{display:flex;gap:10px;margin-top:15px;justify-content:center}
    .pagination a{padding:6px 14px;background:var(--card);color:var(--text);text-decoration:none;border-radius:6px;border:1px solid var(--border)}
    .pagination a:hover{border-color:var(--accent)}
    .pagination a.disabled{opacity:0.4;pointer-events:none}
    .back{color:var(--muted);text-decoration:none;font-size:0.9em;margin-bottom:15px;display:inline-block}
    .back:hover{color:var(--accent)}
  </style>
</head>
<body>
  <div class="container">
    <a class="back" href="/admin/dashboard">&larr; Back to Dashboard</a>
    <h1>📦 Database Browser</h1>

    <div class="nav">
      ${tables.map(t => `
        <a href="/admin/db?table=${t}" class="${t === table ? 'active' : ''}">${t}</a>
      `).join('')}
    </div>

    <form class="toolbar" method="GET">
            <input type="hidden" name="table" value="${table}">
      <input type="text" name="search" placeholder="Search..." value="${search}">
      <button type="submit">Search</button>
      <span class="info">${totalCount} total rows | Showing ${offset + 1}-${Math.min(offset + limit, totalCount)}</span>
    </form>

    <div class="card">
      <div class="scroll">
        <table>
          <tr>
            ${columns.map(c => `<th>${c.name}</th>`).join('')}
          </tr>
          ${rows.map(row => `
            <tr>
              ${columns.map(c => {
                const val = row[c.name];
                if (val === null || val === undefined) return `<td class="null">NULL</td>`;
                if (c.name === 'id') return `<td class="id">${val}</td>`;
                return `<td title="${String(val).replace(/"/g, '&quot;')}">${val}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </table>
      </div>
    </div>

    <div class="pagination">
      <a href="/admin/db?table=${table}&offset=${Math.max(0, offset - limit)}&limit=${limit}&search=${search}"
         class="${offset === 0 ? 'disabled' : ''}">&larr; Prev</a>
      <a href="/admin/db?table=${table}&offset=${offset + limit}&limit=${limit}&search=${search}"
         class="${offset + limit >= totalCount ? 'disabled' : ''}">Next &rarr;</a>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ─────────────────────────────────────────────────────────────
// Passkey: Registration (requires auth — first login with password)
// ─────────────────────────────────────────────────────────────
router.get('/passkey/register-options', auth, async (req, res) => {
  try {
    const existing = getPasskeyCredentials();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: 'admin',
      userID: new Uint8Array(Buffer.from('pp-admin')),
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({
        id: c.credential_id,
        type: 'public-key',
        transports: JSON.parse(c.transports || '[]'),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    pendingRegChallenge = { challenge: options.challenge, expiry: Date.now() + CHALLENGE_TTL };
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/passkey/register-verify', auth, async (req, res) => {
  if (!pendingRegChallenge || Date.now() > pendingRegChallenge.expiry) {
    return res.status(400).json({ error: 'Challenge expired. Try again.' });
  }
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pendingRegChallenge.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Verification failed' });
    }

    const { credential } = verification.registrationInfo;
    savePasskeyCredential({
      credentialId: credential.id,
      publicKey:    Buffer.from(credential.publicKey).toString('base64url'),
      counter:      credential.counter,
      transports:   req.body.response?.transports || [],
      label:        `Passkey ${new Date().toLocaleDateString('uk-UA')}`,
    });

    pendingRegChallenge = null;
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Passkey: Authentication (public — no auth required)
// ─────────────────────────────────────────────────────────────
router.post('/passkey/auth-options', async (req, res) => {
  const credentials = getPasskeyCredentials();
  if (!credentials.length) {
    return res.status(404).json({ error: 'No passkeys registered' });
  }
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: credentials.map(c => ({
        id: c.credential_id,
        type: 'public-key',
        transports: JSON.parse(c.transports || '[]'),
      })),
      userVerification: 'preferred',
    });

    pendingAuthChallenge = { challenge: options.challenge, expiry: Date.now() + CHALLENGE_TTL };
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/passkey/auth-verify', async (req, res) => {
  if (!pendingAuthChallenge || Date.now() > pendingAuthChallenge.expiry) {
    return res.status(400).json({ error: 'Challenge expired. Try again.' });
  }
  const credentials = getPasskeyCredentials();
  const stored = credentials.find(c => c.credential_id === req.body.id);
  if (!stored) {
    return res.status(400).json({ error: 'Unknown passkey' });
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: pendingAuthChallenge.challenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id:         stored.credential_id,
        publicKey:  Buffer.from(stored.public_key, 'base64url'),
        counter:    stored.counter,
        transports: JSON.parse(stored.transports || '[]'),
      },
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Verification failed' });
    }

    pendingAuthChallenge = null;
    updatePasskeyCounter(stored.credential_id, verification.authenticationInfo.newCounter);

    const token = generateToken();
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/passkey/:id', auth, (req, res) => {
  deletePasskeyCredential(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// Settings page — manage passkeys
// ─────────────────────────────────────────────────────────────
router.get('/settings', auth, (req, res) => {
  const credentials = getPasskeyCredentials();
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Admin Settings</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{--bg:#0f0f1a;--card:#1a1a2e;--accent:#667eea;--green:#4ade80;--red:#f87171;--text:#e2e8f0;--muted:#64748b;--border:#2a2a4a}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px}
    .container{max-width:600px;margin:0 auto}
    h1{color:var(--accent);margin-bottom:20px}
    h2{color:var(--accent);margin:20px 0 10px;font-size:1.1em}
    .card{background:var(--card);padding:20px;border-radius:12px;border:1px solid var(--border);margin-bottom:16px}
    .back{color:var(--muted);text-decoration:none;font-size:0.9em;display:inline-block;margin-bottom:20px}
    .back:hover{color:var(--accent)}
    .btn{padding:12px 20px;border:none;border-radius:8px;cursor:pointer;font-size:0.95em;font-weight:500}
    .btn-primary{background:var(--accent);color:white}
    .btn-primary:hover{opacity:0.9}
    .btn-primary:disabled{opacity:0.5;cursor:not-allowed}
    .btn-danger{background:rgba(248,113,113,0.2);color:var(--red);border:1px solid rgba(248,113,113,0.3)}
    .btn-danger:hover{background:rgba(248,113,113,0.35)}
    .passkey-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
    .passkey-row:last-child{border-bottom:none}
    .passkey-info{display:flex;flex-direction:column;gap:3px}
    .passkey-label{font-weight:500}
    .passkey-date{font-size:0.8em;color:var(--muted)}
    .msg{margin-top:12px;padding:10px;border-radius:6px;font-size:0.9em;display:none}
    .msg.ok{background:rgba(74,222,128,0.15);color:var(--green)}
    .msg.err{background:rgba(248,113,113,0.15);color:var(--red)}
    .empty{color:var(--muted);font-size:0.9em;padding:12px 0}
  </style>
</head>
<body>
  <div class="container">
    <a class="back" href="/admin/dashboard">← Back to Dashboard</a>
    <h1>⚙️ Settings</h1>

    <div class="card">
      <h2>🔑 Passkeys</h2>
      <div id="list">
        ${credentials.length === 0
          ? '<div class="empty">No passkeys registered yet.</div>'
          : credentials.map(c => `
            <div class="passkey-row" id="pk-${c.id}">
              <div class="passkey-info">
                <span class="passkey-label">🔑 ${c.label}</span>
                <span class="passkey-date">Registered: ${c.created_at.slice(0, 16).replace('T', ' ')}</span>
              </div>
              <button class="btn btn-danger" onclick="deletePasskey('${c.credential_id}', ${c.id})">Delete</button>
            </div>`).join('')
        }
      </div>
      <button class="btn btn-primary" id="reg-btn" style="margin-top:16px">+ Register New Passkey</button>
      <div class="msg" id="msg"></div>
    </div>
  </div>

  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>
  <script>
    const msgEl = document.getElementById('msg');
    function showMsg(text, type) {
      msgEl.textContent = text;
      msgEl.className = 'msg ' + type;
      msgEl.style.display = 'block';
      setTimeout(() => msgEl.style.display = 'none', 4000);
    }

    document.getElementById('reg-btn').onclick = async () => {
      const btn = document.getElementById('reg-btn');
      try {
        btn.disabled = true;
        btn.textContent = '⏳ Waiting for Face ID...';

        const optRes = await fetch('/admin/passkey/register-options');
        const options = await optRes.json();

        const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

        const verRes = await fetch('/admin/passkey/register-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credential)
        });
        if (verRes.ok) {
          showMsg('✅ Passkey registered! Reload to see it.', 'ok');
          setTimeout(() => location.reload(), 1500);
        } else {
          const d = await verRes.json();
          throw new Error(d.error || 'Failed');
        }
      } catch (err) {
        if (err.name !== 'NotAllowedError') showMsg('❌ ' + err.message, 'err');
        btn.disabled = false;
        btn.textContent = '+ Register New Passkey';
      }
    };

    async function deletePasskey(credentialId, rowId) {
      if (!confirm('Delete this passkey?')) return;
      const res = await fetch('/admin/passkey/' + encodeURIComponent(credentialId), { method: 'DELETE' });
      if (res.ok) {
        document.getElementById('pk-' + rowId)?.remove();
        showMsg('Passkey deleted.', 'ok');
      }
    }
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

export default router;
