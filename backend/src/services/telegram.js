const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to Telegram
 */
export async function sendMessage(chatId, text, options = {}) {
  const response = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'HTML',
      disable_web_page_preview: options.disablePreview ?? true,
      ...options
    })
  });
  
  const result = await response.json();
  
  if (!result.ok) {
    console.error('Telegram error:', result);
    throw new Error(result.description || 'Telegram API error');
  }
  
  return result;
}

/**
 * Send new exchange application notification
 */
export async function sendNewOrderNotification(orderData) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  const text = `🔔 <b>NEW EXCHANGE APPLICATION</b>

👤 Telegram: ${orderData.telegram}
💰 Amount: $${orderData.amount} USD
📤 Payout: ${orderData.crypto}
🏦 Wallet/ID: <code>${orderData.wallet}</code>
📱 Personal PP: ${orderData.personalPaypal === 'true' ? 'YES' : 'NO'}
${orderData.comment ? `💬 Comment: ${orderData.comment}` : ''}

⏰ ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/Kyiv' })}`;

  return sendMessage(chatId, text);
}

/**
 * Send PayPal income notification to client
 */
export async function sendIncomeNotification(clientTgId, data) {
  const screenshotUrl = data.gmailId 
    ? `https://api.daniilink.com/webhook/email-screenshot?messageId=${data.gmailId}`
    : `https://api.daniilink.com/webhook/txnscreen?transactionId=${data.transactionId}`;

  const text = `📧 New Email to <code>${data.email}</code>
Hello, <code>${data.name}</code>
Accept your <code>${data.amount}</code> from <code>${data.sender}</code>
Transaction ID: <code>${data.transactionId}</code>
Transaction date: <code>${data.date}</code>
<a href="${screenshotUrl}">Screenshot PNG🧾</a>`;

  return sendMessage(clientTgId, text);
}

/**
 * Send IPN notification (from PayPal direct)
 */
export async function sendIPNNotification(clientTgId, data) {
  const screenshotUrl = `https://api.daniilink.com/webhook/txnscreen?transactionId=${data.txnId}`;
  
  const text = `📧 New Email to <code>${data.receiverEmail}</code>
Hello, <code>${data.paypalName}</code>
Accept your <code>${data.formattedAmount}</code> from <code>${data.senderName}</code>
Transaction ID: <code>${data.txnId}</code>
Transaction date: <code>${data.date}</code>${data.memo ? `\n📝 Note: ${data.memo}` : ''}
<a href="${screenshotUrl}">Screenshot PNG🧾</a>`;

  return sendMessage(clientTgId, text);
}

/**
 * Send error notification to admin
 */
export async function sendErrorNotification(message) {
  const chatId = process.env.TELEGRAM_ERROR_CHAT_ID;
  return sendMessage(chatId, `⚠️ Error: ${message}`);
}
