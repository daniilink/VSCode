import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.LOCAL_DB_PATH || '/app/data/pp-exchange.db';

let db = null;

/**
 * Initialize SQLite database
 */
export function initDatabase() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT UNIQUE NOT NULL,
      client TEXT,
      emails TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paypals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      sender TEXT,
      amount TEXT,
      currency TEXT,
      original_amount TEXT,
      original_currency TEXT,
      exchange_rate TEXT,
      date TEXT,
      client TEXT,
      telegram_id TEXT,
      time_to_proceed TEXT,
      payer_email TEXT,
      payer_status TEXT,
      residence_country TEXT,
      protection_eligibility TEXT,
      source TEXT DEFAULT 'ipn',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clients_tg_id ON clients(tg_id);
    CREATE INDEX IF NOT EXISTS idx_clients_emails ON clients(emails);
    CREATE INDEX IF NOT EXISTS idx_paypals_email ON paypals(email);
    CREATE INDEX IF NOT EXISTS idx_transactions_id ON transactions(transaction_id);

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      method TEXT,
      status_code INTEGER,
      duration_ms REAL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_endpoint ON metrics(endpoint);
    CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
  `);

  // Migrate: add new columns if missing
  const cols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
  const newCols = [
    ['currency', 'TEXT'],
    ['original_amount', 'TEXT'],
    ['original_currency', 'TEXT'],
    ['exchange_rate', 'TEXT'],
    ['payer_email', 'TEXT'],
    ['payer_status', 'TEXT'],
    ['residence_country', 'TEXT'],
    ['protection_eligibility', 'TEXT'],
    ['source', 'TEXT DEFAULT "ipn"'],
    ['processing_time_ms', 'INTEGER'],
    ['memo', 'TEXT']
  ];
  for (const [col, type] of newCols) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE transactions ADD COLUMN ${col} ${type}`);
    }
  }

  console.log('📦 Local SQLite database initialized');
  return db;
}

/**
 * Get database instance
 */
export function getDb() {
  if (!db) initDatabase();
  return db;
}

// ═══════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════

export function getClientsLocal() {
  const stmt = getDb().prepare('SELECT * FROM clients');
  return stmt.all();
}

export function findClientByTgIdLocal(tgId) {
  const clients = getClientsLocal();
  return clients.find(c => String(c.tg_id) === String(tgId)) || null;
}

export function findClientByEmailLocal(email) {
  const clients = getClientsLocal();
  return clients.find(c =>
    c.emails && c.emails.toLowerCase().includes(email.toLowerCase())
  );
}

export function syncClientsLocal(clientsData) {
  const db = getDb();

  const deleteStmt = db.prepare('DELETE FROM clients');
  const insertStmt = db.prepare(`
    INSERT INTO clients (tg_id, client, emails)
    VALUES (@tg_id, @client, @emails)
  `);

  const syncMany = db.transaction((clients) => {
    deleteStmt.run();
    for (const c of clients) {
      insertStmt.run({
        tg_id: String(c.Tg_ID || c.tg_id),
        client: c.Client || c.client || '',
        emails: c.Emails || c.emails || ''
      });
    }
  });

  syncMany(clientsData);
  return { synced: clientsData.length };
}

// ═══════════════════════════════════════════════════════════════
// PAYPALS
// ═══════════════════════════════════════════════════════════════

export function getPayPalsLocal() {
  const stmt = getDb().prepare('SELECT * FROM paypals');
  return stmt.all();
}

export function getPayPalByEmailLocal(email) {
  const stmt = getDb().prepare('SELECT * FROM paypals WHERE LOWER(email) = LOWER(?)');
  return stmt.get(email);
}

export function syncPayPalsLocal(paypalsData) {
  const db = getDb();

  const deleteStmt = db.prepare('DELETE FROM paypals');
  const insertStmt = db.prepare(`
    INSERT INTO paypals (email, name)
    VALUES (@email, @name)
  `);

  const syncMany = db.transaction((paypals) => {
    deleteStmt.run();
    for (const p of paypals) {
      insertStmt.run({
        email: p.Email || p.email,
        name: p.Name || p.name || ''
      });
    }
  });

  syncMany(paypalsData);
  return { synced: paypalsData.length };
}

// ═══════════════════════════════════════════════════════════════
// TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

export function transactionExistsLocal(txnId) {
  const stmt = getDb().prepare('SELECT id FROM transactions WHERE transaction_id = ?');
  return !!stmt.get(txnId);
}

export function logTransactionLocal(txData) {
  const stmt = getDb().prepare(`
    INSERT INTO transactions (
      transaction_id, email, name, sender, amount, currency,
      original_amount, original_currency, exchange_rate,
      date, client, telegram_id, time_to_proceed,
      payer_email, payer_status, residence_country, protection_eligibility, source, processing_time_ms, memo
    ) VALUES (
      @transaction_id, @email, @name, @sender, @amount, @currency,
      @original_amount, @original_currency, @exchange_rate,
      @date, @client, @telegram_id, @time_to_proceed,
      @payer_email, @payer_status, @residence_country, @protection_eligibility, @source, @processing_time_ms, @memo
    )
  `);

  stmt.run({
    transaction_id: txData.transactionId,
    email: txData.email || '',
    name: txData.name || '',
    sender: txData.sender || '',
    amount: txData.amount || '',
    currency: txData.currency || 'USD',
    original_amount: txData.originalAmount || '',
    original_currency: txData.originalCurrency || '',
    exchange_rate: txData.exchangeRate || '',
    date: txData.date || '',
    client: txData.client || '',
    telegram_id: txData.telegramId ? String(txData.telegramId) : '',
    time_to_proceed: txData.timeToProceed || '',
    payer_email: txData.payerEmail || '',
    payer_status: txData.payerStatus || '',
    residence_country: txData.residenceCountry || '',
    protection_eligibility: txData.protectionEligibility || '',
    source: txData.source || 'ipn',
    processing_time_ms: txData.processingTimeMs || null,
    memo: txData.memo || ''
  });

  return true;
}

// ═══════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════

export function getStats() {
  const db = getDb();
  return {
    clients: db.prepare('SELECT COUNT(*) as count FROM clients').get().count,
    paypals: db.prepare('SELECT COUNT(*) as count FROM paypals').get().count,
    transactions: db.prepare('SELECT COUNT(*) as count FROM transactions').get().count
  };
}

// ═══════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════

export function logMetric(endpoint, method, statusCode, durationMs) {
  try {
    const stmt = getDb().prepare(`
      INSERT INTO metrics (endpoint, method, status_code, duration_ms)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(endpoint, method, statusCode, durationMs);
  } catch (e) {
    // Ignore metric errors
  }
}

export function getMetricsStats() {
  const db = getDb();

  // Average response times by endpoint (last 24h)
  const avgTimes = db.prepare(`
    SELECT
      endpoint,
      COUNT(*) as requests,
      ROUND(AVG(duration_ms), 2) as avg_ms,
      ROUND(MIN(duration_ms), 2) as min_ms,
      ROUND(MAX(duration_ms), 2) as max_ms
    FROM metrics
    WHERE timestamp > datetime('now', '-24 hours')
    GROUP BY endpoint
    ORDER BY requests DESC
  `).all();

  // Recent requests
  const recent = db.prepare(`
    SELECT endpoint, method, status_code, duration_ms, timestamp
    FROM metrics
    ORDER BY id DESC
    LIMIT 20
  `).all();

  // Total stats
  const total = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      ROUND(AVG(duration_ms), 2) as avg_ms
    FROM metrics
    WHERE timestamp > datetime('now', '-24 hours')
  `).get();

  return { avgTimes, recent, total };
}

// Cleanup old metrics (keep last 7 days)
export function cleanupMetrics() {
  try {
    getDb().prepare(`
      DELETE FROM metrics WHERE timestamp < datetime('now', '-7 days')
    `).run();
  } catch (e) {
    // Ignore
  }
}

// ═══════════════════════════════════════════════════════════════
// SYNC FROM SUPABASE
// ═══════════════════════════════════════════════════════════════

/**
 * Sync transactions from Supabase to local SQLite
 * Only imports missing transactions (by transaction_id)
 */
export function syncTransactionsFromSupabase(supabaseTransactions) {
  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (
      transaction_id, email, name, sender, amount,
      date, client, telegram_id, time_to_proceed,
      payer_email, payer_status, residence_country,
      protection_eligibility, source, memo
    ) VALUES (
      @transaction_id, @email, @name, @sender, @amount,
      @date, @client, @telegram_id, @time_to_proceed,
      @payer_email, @payer_status, @residence_country,
      @protection_eligibility, @source, @memo
    )
  `);

  let imported = 0;
  const syncMany = db.transaction((txns) => {
    for (const tx of txns) {
      const result = insertStmt.run({
        transaction_id: tx.transaction_id || '',
        email: tx.email || '',
        name: tx.name || '',
        sender: tx.sender || '',
        amount: tx.amount || '',
        date: tx.date || '',
        client: tx.client || '',
        telegram_id: tx.telegram_id ? String(tx.telegram_id) : '',
        time_to_proceed: tx.time_to_proceed || '',
        payer_email: tx.payer_email || '',
        payer_status: tx.payer_status || '',
        residence_country: tx.residence_country || '',
        protection_eligibility: tx.protection_eligibility || '',
        source: tx.source || 'supabase-sync',
        memo: tx.memo || ''
      });
      if (result.changes > 0) imported++;
    }
  });

  syncMany(supabaseTransactions);
  return { imported, total: supabaseTransactions.length };
}
