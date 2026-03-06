import { Router } from 'express';
import {
  findClientByTgIdLocal,
  getClientPayPalsSorted,
  logPayPalSelected,
  getLang,
  setLang,
} from '../services/localdb.js';
import { sendMessage, editMessageText, answerCallbackQuery } from '../services/telegram.js';
import { checkGmailStatus } from '../services/gmail.js';

const router = Router();

const ADMIN_TG_ID = '472124645';

// tgId → { ppEmail, ppName, lang, createdAt, checking, chatId, msgId }
const pendingSessions = new Map();

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 min
const CHECK_DELAY_MS = 30 * 1000;      // 30 sec

// Cleanup expired sessions every minute (prevent memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [tgId, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(tgId);
    }
  }
}, 60_000);

// ─────────────────────────────────────────────────────────────
// i18n
// ─────────────────────────────────────────────────────────────
const T = {
  en: {
    welcome:       '👋 Welcome! Use /send to check PayPal status before sending.',
    cmdDesc:       'Check PayPal status before sending',
    chooseLang:    '🌐 Choose language / Выберите язык:',
    choosePaypal:  (name) => `👋 ${name}, select the PayPal to send to:`,
    noPaypals:     '⚠️ No PayPal accounts available right now. Try later.',
    sessionExpired:'❌ Session expired. Start over: /send',
    ppDetail:      (pp) =>
      `✅ <b>${pp.name || pp.email}</b>\n<code>${pp.email}</code>\n\n` +
      `Open PayPal and start the send.\n` +
      `When you <b>see the fees</b> on the confirmation screen — tap below.`,
    checkBtn:      '✅ Check (I see fees on PayPal)',
    backBtn:       '← Back',
    checking:      (ppName, secs) =>
      `⏳ Checking status for <b>${ppName}</b>...\n${secs} seconds remaining.`,
    ok:            (ppName, ppEmail) =>
      `👌 <b>All clear! You can send.</b>\n\nNo issues detected.\n<b>${ppName}</b> · <code>${ppEmail}</code>`,
    ban:
      `🚫 <b>Don't send!</b>\n\nPayPal is restricted (banpp).\nWill notify you when restored.`,
    action:
      `⚠️ <b>Hold on!</b>\n\nPayPal requires action on the account.\nWait for the issue to be resolved.`,
    error:
      `⚠️ Could not check status. Proceed with caution.`,
  },
  ru: {
    welcome:       '👋 Добро пожаловать! Используйте /send для проверки PayPal перед отправкой.',
    cmdDesc:       'Проверить PayPal перед отправкой',
    chooseLang:    '🌐 Choose language / Выберите язык:',
    choosePaypal:  (name) => `👋 ${name}, выберите PayPal для отправки:`,
    noPaypals:     '⚠️ Нет доступных PayPal аккаунтов. Попробуйте позже.',
    sessionExpired:'❌ Сессия истекла. Начните заново: /send',
    ppDetail:      (pp) =>
      `✅ <b>${pp.name || pp.email}</b>\n<code>${pp.email}</code>\n\n` +
      `Откройте PayPal и начните отправку.\n` +
      `Когда <b>увидите комиссию</b> на экране подтверждения — нажмите ниже.`,
    checkBtn:      '✅ Проверить (вижу комиссию в PayPal)',
    backBtn:       '← Назад',
    checking:      (ppName, secs) =>
      `⏳ Проверяю статус <b>${ppName}</b>...\nОсталось ${secs} сек.`,
    ok:            (ppName, ppEmail) =>
      `👌 <b>Всё чисто! Можно отправлять.</b>\n\nПроблем не обнаружено.\n<b>${ppName}</b> · <code>${ppEmail}</code>`,
    ban:
      `🚫 <b>Не отправляй!</b>\n\nPayPal заблокирован (banpp).\nСообщу когда восстановят.`,
    action:
      `⚠️ <b>Стоп, не отправляй!</b>\n\nPayPal требует действий с аккаунтом.\nПодожди пока проблема не решится.`,
    error:
      `⚠️ Не удалось проверить статус. Действуйте с осторожностью.`,
  },
};

const t = (lang) => T[lang] || T.en;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function buildPpKeyboard(paypals) {
  return paypals.map(pp => ([{
    text: pp.name ? `${pp.name}  ·  ${pp.email}` : pp.email,
    callback_data: `pp:${pp.email}`,
  }]));
}

async function showPayPalList(chatId, msgId, tgId, isAdmin, lang) {
  const client = findClientByTgIdLocal(tgId);
  const paypals = getClientPayPalsSorted(tgId, isAdmin);

  if (!paypals.length) {
    await editMessageText(chatId, msgId, t(lang).noPaypals, { reply_markup: { inline_keyboard: [] } });
    return;
  }

  const displayName = client?.client || (isAdmin ? '@daniilink' : 'there');
  await editMessageText(chatId, msgId, t(lang).choosePaypal(displayName), {
    reply_markup: { inline_keyboard: buildPpKeyboard(paypals) },
  });
}

// ─────────────────────────────────────────────────────────────
// Webhook entry point
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200);

  const { message, callback_query } = req.body;
  try {
    if (message)        await handleMessage(message);
    if (callback_query) await handleCallback(callback_query);
  } catch (err) {
    console.error('[Bot] Error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const tgId    = String(msg.from.id);
  const text    = (msg.text || '').trim();
  const isAdmin = tgId === ADMIN_TG_ID;
  const client  = findClientByTgIdLocal(tgId);

  if (text === '/start') {
    if (client || isAdmin) {
      const lang = getLang(tgId);
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [{ command: 'send', description: t(lang).cmdDesc }],
          scope: { type: 'chat', chat_id: Number(tgId) },
        }),
      }).catch(() => {});
      await sendMessage(tgId, t(lang).welcome);
    }
    return;
  }

  if (text !== '/send') return;
  if (!client && !isAdmin) return;

  // Kill any old pending session
  pendingSessions.delete(tgId);

  // Show language chooser (preference shown pre-selected via button order)
  const currentLang = getLang(tgId);
  const langButtons = currentLang === 'ru'
    ? [{ text: '🇷🇺 Русский ✓', callback_data: 'lang:ru' }, { text: '🇬🇧 English', callback_data: 'lang:en' }]
    : [{ text: '🇷🇺 Русский',   callback_data: 'lang:ru' }, { text: '🇬🇧 English ✓', callback_data: 'lang:en' }];

  await sendMessage(tgId, T.en.chooseLang, {
    reply_markup: { inline_keyboard: [langButtons] },
  });
}

// ─────────────────────────────────────────────────────────────
// Callback handler
// ─────────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const tgId    = String(cb.from.id);
  const data    = cb.data || '';
  const chatId  = cb.message.chat.id;
  const msgId   = cb.message.message_id;
  const isAdmin = tgId === ADMIN_TG_ID;

  await answerCallbackQuery(cb.id);

  // ── Language selected ──────────────────────────────────────
  if (data.startsWith('lang:')) {
    const lang = data === 'lang:ru' ? 'ru' : 'en';
    setLang(tgId, lang);
    await showPayPalList(chatId, msgId, tgId, isAdmin, lang);
    return;
  }

  // ── Back to PayPal list ────────────────────────────────────
  if (data === 'back') {
    const lang = getLang(tgId);
    await showPayPalList(chatId, msgId, tgId, isAdmin, lang);
    return;
  }

  // ── PayPal selected ────────────────────────────────────────
  if (data.startsWith('pp:')) {
    const ppEmail = data.slice(3);
    const lang    = getLang(tgId);
    const paypals = getClientPayPalsSorted(tgId, isAdmin);
    const pp      = paypals.find(p => p.email === ppEmail);
    if (!pp) return; // tampered data or stale session

    // Log the selection
    logPayPalSelected(tgId, cb.from.username || '', pp.email);

    pendingSessions.set(tgId, {
      ppEmail:   pp.email,
      ppName:    pp.name || pp.email,
      lang,
      createdAt: Date.now(),
      checking:  false,
      chatId,
      msgId,
    });

    await editMessageText(chatId, msgId, t(lang).ppDetail(pp), {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang).checkBtn, callback_data: 'check' }],
          [{ text: t(lang).backBtn,  callback_data: 'back'  }],
        ],
      },
    });
    return;
  }

  // ── Check pressed ──────────────────────────────────────────
  if (data === 'check') {
    const session = pendingSessions.get(tgId);

    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(tgId);
      const lang = getLang(tgId);
      await editMessageText(chatId, msgId, t(lang).sessionExpired, { reply_markup: { inline_keyboard: [] } });
      return;
    }

    // Guard: ignore duplicate tap while already checking
    if (session.checking) return;

    session.checking = true;
    const lang = session.lang;

    // Notify admin silently (skip if admin is the one checking)
    if (tgId !== ADMIN_TG_ID) {
      const who = cb.from.username ? `@${cb.from.username}` : `#${tgId}`;
      sendMessage(ADMIN_TG_ID,
        `🔔 ${who} → <b>${session.ppName}</b>`,
        { disable_notification: true }
      ).catch(() => {});
    }

    // Show initial countdown
    let remaining = CHECK_DELAY_MS / 1000;
    await editMessageText(chatId, msgId, t(lang).checking(session.ppName, remaining), {
      reply_markup: { inline_keyboard: [] },
    });

    // Update countdown every 5 seconds
    const countdownInterval = setInterval(async () => {
      remaining -= 5;
      if (remaining > 0) {
        editMessageText(chatId, msgId, t(lang).checking(session.ppName, remaining), {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
    }, 5000);

    setTimeout(async () => {
      clearInterval(countdownInterval);
      try {
        const status = await checkGmailStatus();
        pendingSessions.delete(tgId);

        let resultMsg;
        if (status.ban) {
          resultMsg = t(lang).ban;
        } else if (status.action) {
          resultMsg = t(lang).action;
        } else {
          resultMsg = t(lang).ok(session.ppName, session.ppEmail);
        }

        await sendMessage(chatId, resultMsg);
      } catch (err) {
        console.error('[Bot] Gmail check error:', err.message);
        pendingSessions.delete(tgId);
        await sendMessage(chatId, t(lang).error);
      }
    }, CHECK_DELAY_MS);
  }
}

export default router;
