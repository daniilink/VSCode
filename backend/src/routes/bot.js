import { Router } from 'express';
import { findClientByTgIdLocal, getPayPalsLocal } from '../services/localdb.js';
import { sendMessage, editMessageText, answerCallbackQuery } from '../services/telegram.js';
import { checkGmailStatus } from '../services/gmail.js';

const router = Router();

// Active check sessions: tgId → { ppEmail, ppName, createdAt }
const pendingSessions = new Map();

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_DELAY_MS = 30 * 1000;      // 30 seconds

// ─────────────────────────────────────────────────────────────
// Webhook entry point
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // Always reply 200 immediately

  const { message, callback_query } = req.body;

  try {
    if (message)        await handleMessage(message);
    if (callback_query) await handleCallback(callback_query);
  } catch (err) {
    console.error('[Bot] Error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// /send command
// ─────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const tgId = String(msg.from.id);
  const text  = (msg.text || '').trim();

  if (text !== '/send') return;

  // Only known clients
  const client = findClientByTgIdLocal(tgId);
  if (!client) return;

  // Clear any old session
  pendingSessions.delete(tgId);

  const paypals = getPayPalsLocal();
  if (!paypals.length) {
    await sendMessage(tgId, '⚠️ No PayPal accounts available right now. Try later.');
    return;
  }

  // Build inline keyboard — 1 button per row (email is unique key)
  const keyboard = paypals.map(pp => ([{
    text: `${pp.name}  ·  ${pp.email}`,
    callback_data: `pp:${pp.email}`
  }]));

  await sendMessage(tgId,
    `👋 ${client.client}, select the PayPal you want to send to:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// ─────────────────────────────────────────────────────────────
// Button callbacks
// ─────────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const tgId     = String(cb.from.id);
  const data     = cb.data || '';
  const chatId   = cb.message.chat.id;
  const msgId    = cb.message.message_id;

  await answerCallbackQuery(cb.id);

  // ── PayPal selected ──────────────────────────────────────
  if (data.startsWith('pp:')) {
    const ppEmail = data.slice(3);
    const paypals = getPayPalsLocal();
    const pp = paypals.find(p => p.email === ppEmail);
    if (!pp) return;

    pendingSessions.set(tgId, {
      ppEmail: pp.email,
      ppName:  pp.name,
      createdAt: Date.now()
    });

    await editMessageText(chatId, msgId,
      `✅ <b>${pp.name}</b>\n<code>${pp.email}</code>\n\n` +
      `Open PayPal and start the send.\n` +
      `When you <b>see the fees</b> on the confirmation screen — press the button below.`,
      {
        reply_markup: {
          inline_keyboard: [[{
            text: '✅ Check (I see fees on PayPal)',
            callback_data: 'check'
          }]]
        }
      }
    );
    return;
  }

  // ── Check pressed ────────────────────────────────────────
  if (data === 'check') {
    const session = pendingSessions.get(tgId);

    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(tgId);
      await editMessageText(chatId, msgId,
        '❌ Session expired. Start again with /send',
        { reply_markup: { inline_keyboard: [] } }
      );
      return;
    }

    // Hide button, show countdown message
    await editMessageText(chatId, msgId,
      `⏳ Checking PayPal status for <b>${session.ppName}</b>...\n` +
      `Will reply in 30 seconds. Don't close the app.`,
      { reply_markup: { inline_keyboard: [] } }
    );

    // Wait 30s, then check Gmail labels
    setTimeout(async () => {
      try {
        const status = await checkGmailStatus();
        pendingSessions.delete(tgId);

        if (status.ban) {
          await sendMessage(chatId,
            `🚫 <b>Don't send!</b>\n\n` +
            `PayPal account has been restricted (banpp/deactivated).\n` +
            `I'll notify you when it's restored.`
          );
        } else if (status.action) {
          await sendMessage(chatId,
            `⚠️ <b>Hold on, don't send!</b>\n\n` +
            `PayPal requires action on the account.\n` +
            `Wait until the issue is resolved.`
          );
        } else if (status.delay) {
          await sendMessage(chatId,
            `⏳ <b>Possible delay!</b>\n\n` +
            `Payment may be held for up to 24h after sending.\n` +
            `You can send, but warn your recipient about the delay.`
          );
        } else {
          await sendMessage(chatId,
            `✅ <b>All clear! You can send.</b>\n\n` +
            `No issues detected on PayPal.\n` +
            `<b>${session.ppName}</b> · <code>${session.ppEmail}</code>`
          );
        }
      } catch (err) {
        console.error('[Bot] Gmail check error:', err.message);
        pendingSessions.delete(tgId);
        await sendMessage(chatId,
          `⚠️ Could not check status. Proceed with caution.`
        );
      }
    }, CHECK_DELAY_MS);
  }
}

export default router;
