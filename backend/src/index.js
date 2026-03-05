import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { scheduleBackup } from './services/backup.js';
import { sendErrorNotification } from './services/telegram.js';

// Routes
import ppExchangeRouter from './routes/pp-exchange.js';
import ipnPaypalRouter from './routes/ipn-paypal.js';
import screenshotsRouter from './routes/screenshots.js';
import syncRouter from './routes/sync.js';
import adminRouter from './routes/admin.js';
import botRouter from './routes/bot.js';
import {
  getStats,
  initDatabase,
  getDb,
  syncTransactionsFromSupabase,
  syncClientsLocal,
  syncPayPalsLocal
} from './services/localdb.js';
import { getAllTransactions, getClients, getPayPals } from './services/supabase.js';

const app = express();
const PORT = process.env.PORT || 3000;
let server;

// Middleware
app.use(cors({
  origin: [
    'https://pp.daniilink.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

// Parse JSON, URL-encoded bodies, and cookies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check with stats
app.get('/health', (req, res) => {
  try {
    const stats = getStats();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: 'sqlite',
      stats
    });
  } catch (e) {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  }
});

// Routes - matching n8n webhook paths
app.use('/webhook/pp-exchange', ppExchangeRouter);      // Form submission
app.use('/webhook/ipn-paypal', ipnPaypalRouter);        // PayPal IPN
app.use('/webhook', screenshotsRouter);                 // Screenshot endpoints
app.use('/webhook', syncRouter);                        // Sheets to DB sync
app.use('/admin', adminRouter);                         // Admin dashboard
app.use('/webhook/bot', botRouter);                     // Telegram bot

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler with Telegram alerts
app.use(async (err, req, res, next) => {
  console.error('Error:', err);

  // Send to Telegram (don't await, fire and forget)
  sendErrorNotification(
    `<b>Server Error</b>\n\n` +
    `<b>Path:</b> ${req.method} ${req.path}\n` +
    `<b>Error:</b> ${err.message}\n` +
    `<b>Stack:</b> <code>${(err.stack || '').slice(0, 500)}</code>`
  ).catch(() => {}); // ignore telegram errors

  res.status(500).json({ error: 'Internal server error' });
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  sendErrorNotification(`<b>Uncaught Exception</b>\n\n${err.message}\n<code>${(err.stack || '').slice(0, 500)}</code>`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  sendErrorNotification(`<b>Unhandled Rejection</b>\n\n${reason}`).catch(() => {});
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  server.close(() => {
    console.log('HTTP server closed');

    // Close SQLite connection
    try {
      const db = getDb();
      db.close();
      console.log('SQLite connection closed');
    } catch (e) {
      // ignore
    }

    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize database
initDatabase();

// Sync from Supabase on startup (handles n8n fallback scenario)
(async () => {
  try {
    console.log('Syncing from Supabase...');

    // 1. Sync Clients
    const clients = await getClients();
    if (clients.length > 0) {
      syncClientsLocal(clients.map(c => ({
        Tg_ID: c.tg_id,
        Client: c.client,
        Emails: c.emails
      })));
      console.log(`  Clients: ${clients.length}`);
    }

    // 2. Sync PayPals
    const paypals = await getPayPals();
    if (paypals.length > 0) {
      syncPayPalsLocal(paypals.map(p => ({
        Email: p.email,
        Name: p.name
      })));
      console.log(`  PayPals: ${paypals.length}`);
    }

    // 3. Sync Transactions
    const transactions = await getAllTransactions();
    const result = syncTransactionsFromSupabase(transactions);
    console.log(`  Transactions: ${result.imported} new of ${result.total} total`);

    console.log('Sync complete');
  } catch (err) {
    console.error('Supabase sync failed:', err.message);
  }
})();

server = app.listen(PORT, () => {
  console.log(`PP Exchange Backend running on port ${PORT}`);
  scheduleBackup();

  // Register Telegram bot webhook
  const botWebhookUrl = `${process.env.BASE_URL}/webhook/bot`;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${botWebhookUrl}`)
    .then(r => r.json())
    .then(r => console.log(`Bot webhook: ${r.ok ? '✅' : '❌'} ${botWebhookUrl}`))
    .catch(e => console.error('Bot webhook error:', e.message));
  // Clear global commands (visible only per-client, set during UpdateClients sync)
  fetch(`https://api.telegram.org/bot${botToken}/deleteMyCommands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  }).catch(() => {});
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/pp-exchange     - Form submission`);
  console.log(`  POST /webhook/ipn-paypal      - PayPal IPN`);
  console.log(`  GET  /webhook/txnscreen       - Screenshot by TxID`);
  console.log(`  GET  /webhook/email-screenshot - Screenshot by MessageID`);
  console.log(`  POST /webhook/UpdateClients   - Sync clients`);
  console.log(`  POST /webhook/paypals-to-db   - Sync PayPals`);
  console.log(`  GET  /admin                   - Admin dashboard`);
});
