import { Router } from 'express';
import { DateTime } from 'luxon';
import {
  transactionExists,
  logTransaction
} from '../services/supabase.js';
import { sendMessage } from '../services/telegram.js';
import {
  logTransactionLocal,
  getPayPalByEmailLocal,
  findClientByEmailLocal,
  transactionExistsLocal
} from '../services/localdb.js';

const router = Router();

// Admin Telegram ID - always receives notifications
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;

// Currency symbols mapping
const currencySymbols = {
  'USD': '$', 'EUR': '€', 'GBP': '£', 'RUB': '₽', 'UAH': '₴', 'PLN': 'zl',
  'CZK': 'Kc', 'CAD': 'C$', 'AUD': 'A$', 'CHF': 'Fr', 'JPY': 'Y',
  'NOK': 'kr', 'SEK': 'kr', 'DKK': 'kr', 'HUF': 'Ft', 'ILS': 'Sh',
  'HKD': 'HK$', 'SGD': 'S$', 'TRY': 'TL', 'CNY': 'Y'
};

/**
 * POST /webhook/ipn-paypal
 * Handles PayPal Instant Payment Notifications
 */
router.post('/', async (req, res) => {
  const startTime = Date.now();

  // Respond immediately to PayPal
  res.status(200).send('OK');

  try {
    const body = req.body;
    const txnId = body.txn_id || 'unknown';
    const paymentStatus = body.payment_status;

    // 1. Build IPN verification string
    let ipnString = 'cmd=_notify-validate';
    for (const key in body) {
      if (key !== 'cmd' && key !== 'headers' && typeof body[key] !== 'object') {
        ipnString += `&${encodeURIComponent(key)}=${encodeURIComponent(body[key])}`;
      }
    }

    // 2. Verify with PayPal
    const verifyResponse = await fetch(process.env.PAYPAL_IPN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'node-ipn-verifier'
      },
      body: ipnString
    });

    const verifyResult = await verifyResponse.text();

    if (verifyResult !== 'VERIFIED') {
      console.log('IPN verification failed:', {
        txn_id: txnId,
        payer_email: body.payer_email,
        result: verifyResult
      });
      return;
    }

    // 3. Handle non-Completed statuses (refunds, disputes, etc.)
    if (paymentStatus !== 'Completed') {
      await handleSpecialStatus(body, txnId, paymentStatus, startTime);
      return;
    }

    // 4. Check for duplicate (local first, then Supabase as fallback)
    if (transactionExistsLocal(txnId) || await transactionExists(txnId)) {
      console.log('Duplicate transaction:', txnId);
      return;
    }

    // 5. Format amount
    const formattedAmount = formatAmount(body);

    // 6. Find client by receiver email (local DB - fast)
    const client = findClientByEmailLocal(body.receiver_email);

    // 7. Get PayPal account name (local DB)
    const paypal = getPayPalByEmailLocal(body.receiver_email);
    const paypalName = paypal?.name || 'Unknown';

    // 8. Format date (supports both PST and PDT)
    const formattedDate = formatPayPalDate(body.payment_date);

    // 9. Build notification message
    const notificationData = {
      receiverEmail: body.receiver_email,
      paypalName: paypalName,
      formattedAmount: formattedAmount,
      senderName: `${body.first_name || ''} ${body.last_name || ''}`.trim() || 'Unknown',
      txnId: txnId,
      date: formattedDate,
      memo: body.memo,
      payerEmail: body.payer_email,
      payerStatus: body.payer_status,
      residenceCountry: body.residence_country
    };

    const messageText = buildIncomeMessage(notificationData);

    // 10. Always send to ADMIN
    let tgResult = null;
    if (ADMIN_TG_ID) {
      tgResult = await sendMessage(ADMIN_TG_ID, messageText);
    }

    // 11. Also send to client if exists (and different from admin)
    if (client && client.tg_id && String(client.tg_id) !== String(ADMIN_TG_ID)) {
      await sendMessage(client.tg_id, messageText);
    }

    // 12. Calculate processing time
    const processingTimeMs = Date.now() - startTime;

    // 13. Log transaction to Supabase
    await logTransaction({
      transactionId: txnId,
      email: body.receiver_email,
      name: paypalName,
      sender: notificationData.senderName,
      amount: formattedAmount,
      date: formattedDate,
      client: client ? `@${tgResult?.result?.chat?.username || client.client || 'unknown'}` : 'no-client',
      telegramId: client?.tg_id || ADMIN_TG_ID,
      payerEmail: body.payer_email,
      payerStatus: body.payer_status,
      residenceCountry: body.residence_country,
      protectionEligibility: body.protection_eligibility,
      memo: body.memo
    });

    // 14. Log transaction to local SQLite DB
    try {
      logTransactionLocal({
        transactionId: txnId,
        email: body.receiver_email,
        name: paypalName,
        sender: notificationData.senderName,
        amount: formattedAmount,
        date: formattedDate,
        client: client ? `@${tgResult?.result?.chat?.username || client.client || 'unknown'}` : 'no-client',
        telegramId: client?.tg_id || ADMIN_TG_ID,
        payerEmail: body.payer_email,
        payerStatus: body.payer_status,
        residenceCountry: body.residence_country,
        protectionEligibility: body.protection_eligibility,
        source: 'ipn',
        memo: body.memo,
        processingTimeMs: processingTimeMs
      });
    } catch (localDbErr) {
      console.error('Failed to log to local DB:', localDbErr.message);
    }

    console.log(`IPN processed: ${txnId} in ${processingTimeMs}ms`);

  } catch (error) {
    console.error('IPN processing error:', error);
  }
});

/**
 * Handle special payment statuses (Refunded, Reversed, Pending, etc.)
 */
async function handleSpecialStatus(body, txnId, status, startTime) {
  const formattedAmount = formatAmount(body);

  // For refunds: payer = who receives refund, receiver = PayPal account sending refund
  const payerName = `${body.first_name || ''} ${body.last_name || ''}`.trim() || 'Unknown';
  const payerEmail = body.payer_email || 'Unknown';

  // Find client for this PayPal email (the merchant account)
  const client = findClientByEmailLocal(body.receiver_email);
  const paypal = getPayPalByEmailLocal(body.receiver_email);
  const paypalName = paypal?.name || body.receiver_email;

  let emoji, title, extraInfo = '';

  switch (status) {
    case 'Refunded':
      emoji = '🔄';
      title = 'REFUND SENT';
      extraInfo = `\nTo: <code>${payerName}</code> (${payerEmail})`;
      if (body.parent_txn_id) {
        extraInfo += `\nOriginal TXN: <code>${body.parent_txn_id}</code>`;
      }
      break;
    case 'Reversed':
      emoji = '⚠️';
      title = 'REVERSAL';
      extraInfo = `\nTo: <code>${payerName}</code> (${payerEmail})`;
      if (body.reason_code) {
        extraInfo += `\nReason: ${body.reason_code}`;
      }
      break;
    case 'Canceled_Reversal':
      emoji = '✅';
      title = 'REVERSAL CANCELED';
      extraInfo = `\nPayer: <code>${payerName}</code>`;
      break;
    case 'Pending':
      emoji = '⏳';
      title = 'PENDING PAYMENT';
      extraInfo = `\nFrom: <code>${payerName}</code> (${payerEmail})`;
      if (body.pending_reason) {
        extraInfo += `\nReason: ${body.pending_reason}`;
      }
      break;
    case 'Failed':
      emoji = '❌';
      title = 'PAYMENT FAILED';
      extraInfo = `\nFrom: <code>${payerName}</code> (${payerEmail})`;
      break;
    case 'Denied':
      emoji = '🚫';
      title = 'PAYMENT DENIED';
      extraInfo = `\nFrom: <code>${payerName}</code> (${payerEmail})`;
      break;
    case 'Expired':
      emoji = '⏰';
      title = 'PAYMENT EXPIRED';
      extraInfo = `\nFrom: <code>${payerName}</code> (${payerEmail})`;
      break;
    default:
      emoji = '📋';
      title = status.toUpperCase();
      extraInfo = `\nPayer: <code>${payerName}</code> (${payerEmail})`;
  }

  const message = `${emoji} <b>${title}</b>

PayPal: <code>${body.receiver_email}</code>
Account: <code>${paypalName}</code>
Amount: <code>${formattedAmount}</code>
TXN ID: <code>${txnId}</code>${extraInfo}${body.memo ? `\n📝 Note: ${body.memo}` : ''}`;

  // Always send to admin
  if (ADMIN_TG_ID) {
    await sendMessage(ADMIN_TG_ID, message);
  }

  // Also send to client if exists
  if (client && client.tg_id && String(client.tg_id) !== String(ADMIN_TG_ID)) {
    await sendMessage(client.tg_id, message);
  }

  console.log(`IPN special status: ${txnId} - ${status} (${Date.now() - startTime}ms)`);
}

/**
 * Build income notification message
 */
function buildIncomeMessage(data) {
  const screenshotUrl = `https://api.daniilink.com/webhook/txnscreen?transactionId=${data.txnId}`;

  // Country flag
  const flag = data.residenceCountry ? countryFlag(data.residenceCountry) : '';

  return `📧 New Email to <code>${data.receiverEmail}</code>
Hello, <code>${data.paypalName}</code>
Accept your <code>${data.formattedAmount}</code> from <code>${data.senderName}</code>${flag ? ` ${flag}` : ''}
Transaction ID: <code>${data.txnId}</code>
Transaction date: <code>${data.date}</code>${data.memo ? `\n📝 Note: ${data.memo}` : ''}
<a href="${screenshotUrl}">Screenshot PNG</a>`;
}

/**
 * Get country flag emoji
 */
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  const offset = 127397;
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => c.charCodeAt(0) + offset));
}

/**
 * Format PayPal amount with currency symbol
 */
function formatAmount(body) {
  const getSym = (code) => currencySymbols[code] || '';
  const gross = body.mc_gross || '0';
  const currency = body.mc_currency || 'USD';
  const isConversion = !!body.settle_amount && currency !== body.settle_currency;

  if (isConversion) {
    const original = `${getSym(currency)}${gross} ${currency}`;
    const settled = `${getSym(body.settle_currency)}${body.settle_amount} ${body.settle_currency}`;
    return `${original} (${settled})`;
  } else {
    return `${getSym(currency)}${gross} ${currency}`;
  }
}

/**
 * Format PayPal date to readable format (supports PST and PDT)
 */
function formatPayPalDate(dateStr) {
  if (!dateStr) return 'Unknown date';

  try {
    // PayPal formats: "HH:mm:ss MMM dd, yyyy PDT" or "HH:mm:ss MMM dd, yyyy PST"
    // Also handles single-digit days

    // Remove timezone suffix and parse
    let cleanDate = dateStr;
    let tz = 'America/Los_Angeles'; // Both PST and PDT are in this zone

    // Try parsing with various formats
    const formats = [
      "HH:mm:ss MMM dd, yyyy 'PDT'",
      "HH:mm:ss MMM dd, yyyy 'PST'",
      "HH:mm:ss MMM d, yyyy 'PDT'",
      "HH:mm:ss MMM d, yyyy 'PST'",
      "HH:mm:ss LLL dd, yyyy 'PDT'",
      "HH:mm:ss LLL dd, yyyy 'PST'"
    ];

    for (const format of formats) {
      const dt = DateTime.fromFormat(dateStr, format, { zone: tz });
      if (dt.isValid) {
        return dt.setZone('Europe/Kyiv').toFormat("d MMMM yyyy 'at' HH:mm:ss");
      }
    }

    // Try ISO format
    const dt2 = DateTime.fromISO(dateStr);
    if (dt2.isValid) {
      return dt2.setZone('Europe/Kyiv').toFormat("d MMMM yyyy 'at' HH:mm:ss");
    }

    return dateStr;
  } catch {
    return dateStr;
  }
}

export default router;
