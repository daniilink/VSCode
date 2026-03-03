import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default supabase;

// ═══════════════════════════════════════════════════════════════
// CLIENTS TABLE
// ═══════════════════════════════════════════════════════════════

export async function getClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*');
  
  if (error) throw error;
  return data || [];
}

export async function findClientByEmail(email) {
  const clients = await getClients();
  return clients.find(c => 
    c.emails && c.emails.toLowerCase().includes(email.toLowerCase())
  );
}

export async function syncClients(clientsData) {
  // Delete all existing
  await supabase.from('clients').delete().neq('id', 0);
  
  // Insert new
  if (clientsData.length > 0) {
    const { error } = await supabase.from('clients').insert(
      clientsData.map(c => ({
        tg_id: c.Tg_ID || c.tg_id,
        client: c.Client || c.client,
        emails: c.Emails || c.emails
      }))
    );
    if (error) throw error;
  }
  
  return { synced: clientsData.length };
}

// ═══════════════════════════════════════════════════════════════
// PAYPALS TABLE
// ═══════════════════════════════════════════════════════════════

export async function getPayPals() {
  const { data, error } = await supabase
    .from('paypals')
    .select('*');
  
  if (error) throw error;
  return data || [];
}

export async function getPayPalByEmail(email) {
  const { data, error } = await supabase
    .from('paypals')
    .select('*')
    .ilike('email', email)
    .single();
  
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function syncPayPals(paypalsData) {
  // Delete all existing
  await supabase.from('paypals').delete().neq('id', 0);

  // Insert new
  if (paypalsData.length > 0) {
    const { error } = await supabase.from('paypals').insert(
      paypalsData.map(p => ({
        email: p.Email || p.email,
        name: p.Name || p.name || ''
      }))
    );
    if (error) throw error;
  }

  return { synced: paypalsData.length };
}

// ═══════════════════════════════════════════════════════════════
// TRANSACTIONS TABLE (for logging & duplicate check)
// ═══════════════════════════════════════════════════════════════

export async function transactionExists(txnId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('transaction_id', txnId)
    .single();
  
  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

export async function logTransaction(txData) {
  const { error } = await supabase.from('transactions').insert({
    transaction_id: txData.transactionId,
    email: txData.email,
    name: txData.name,
    sender: txData.sender,
    amount: txData.amount,
    currency: txData.currency || null,
    original_amount: txData.originalAmount || null,
    original_currency: txData.originalCurrency || null,
    date: txData.date,
    client: txData.client,
    telegram_id: txData.telegramId,
    time_to_proceed: txData.timeToProceed,
    payer_email: txData.payerEmail,
    payer_status: txData.payerStatus,
    residence_country: txData.residenceCountry,
    protection_eligibility: txData.protectionEligibility,
    memo: txData.memo
  });

  if (error) throw error;
  return true;
}

export async function getAllTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .order('id', { ascending: false });

  if (error) throw error;
  return data || [];
}
