import { Router } from 'express';
import { google } from 'googleapis';
import { syncClients, syncPayPals } from '../services/supabase.js';
import { syncClientsLocal, syncPayPalsLocal } from '../services/localdb.js';
import { getTelegramUsername } from '../services/telegram.js';

const router = Router();

/**
 * Create Google Sheets client
 */
function getSheetsClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN_1
  });
  
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

/**
 * POST /webhook/UpdateClients
 * Syncs Clients sheet to Supabase
 */
router.post('/UpdateClients', async (req, res) => {
  res.json({ success: true, message: 'Sync started' });
  
  try {
    const sheets = getSheetsClient();
    
    // Get data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Clients!A:C' // Columns: Client, Emails, Tg_ID
    });
    
    const rows = response.data.values || [];
    
    if (rows.length <= 1) {
      console.log('No client data to sync');
      return;
    }
    
    // Skip header row, map to objects
    const headers = rows[0];
    const clientsData = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    }).filter(c => c.Tg_ID); // Only rows with Tg_ID

    // Enrich each client with real Telegram username
    for (const c of clientsData) {
      const username = await getTelegramUsername(c.Tg_ID);
      c.Client = username || `@${c.Client}`;
    }

    // Sync to Supabase
    const result = await syncClients(clientsData);

    // Sync to local SQLite
    syncClientsLocal(clientsData);

    console.log('Clients synced:', result.synced, '(Supabase + SQLite)');

  } catch (error) {
    console.error('Clients sync error:', error);
  }
});

/**
 * POST /webhook/paypals-to-db
 * Syncs PayPals sheet to Supabase
 */
router.post('/paypals-to-db', async (req, res) => {
  res.json({ success: true, message: 'Sync started' });

  try {
    const sheets = getSheetsClient();

    // Get data from Google Sheets (A=Email, C=Name)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'PayPals!A:C'
    });

    const rows = response.data.values || [];
    console.log('PayPals raw rows from Sheets:', rows.length);

    if (rows.length <= 1) {
      console.log('No PayPal data to sync (only header or empty)');
      return;
    }

    // Skip header, map columns A (index 0) and C (index 2)
    const paypalsData = rows.slice(1).map(row => ({
      Email: row[0] || '',
      Name: row[2] || ''
    })).filter(p => p.Email); // Only rows with Email

    console.log('PayPals after filter:', paypalsData.length);

    console.log('PayPals after filter:', paypalsData.length);

    // Sync to Supabase
    const result = await syncPayPals(paypalsData);

    // Sync to local SQLite
    syncPayPalsLocal(paypalsData);

    console.log('PayPals synced:', result.synced, '(Supabase + SQLite)');

  } catch (error) {
    console.error('PayPals sync error:', error);
  }
});

export default router;
