-- ═══════════════════════════════════════════════════════════════
-- PP Exchange Database Schema
-- Migration: 001_initial_schema
-- ═══════════════════════════════════════════════════════════════

-- Clients table (maps emails to Telegram IDs)
CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  tg_id BIGINT NOT NULL,
  client TEXT,
  emails TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for email search
CREATE INDEX IF NOT EXISTS idx_clients_emails ON clients USING gin(to_tsvector('simple', emails));
CREATE INDEX IF NOT EXISTS idx_clients_tg_id ON clients(tg_id);

-- PayPals table (PayPal accounts info)
CREATE TABLE IF NOT EXISTS paypals (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for email lookup
CREATE INDEX IF NOT EXISTS idx_paypals_email ON paypals(email);

-- Transactions table (log of all processed transactions)
CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  sender TEXT,
  amount TEXT,
  date TEXT,
  client TEXT,
  telegram_id BIGINT,
  time_to_proceed TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for duplicate check
CREATE INDEX IF NOT EXISTS idx_transactions_txn_id ON transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- Row Level Security (RLS)
-- ═══════════════════════════════════════════════════════════════

-- Enable RLS on all tables
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE paypals ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for backend)
CREATE POLICY "Service role full access on clients" ON clients
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on paypals" ON paypals
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on transactions" ON transactions
  FOR ALL USING (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════
-- Updated_at trigger function
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables with updated_at
CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_paypals_updated_at
  BEFORE UPDATE ON paypals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
