import { google } from 'googleapis';

/**
 * Create OAuth2 client for Gmail API
 */
function createOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN_1
  });

  return oauth2Client;
}

/**
 * Search for email by transaction ID
 */
export async function searchEmailByTransactionId(txnId) {
  if (!process.env.GMAIL_REFRESH_TOKEN_1) return null;
  
  try {
    const auth = createOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });
    
    // Search for transaction ID in emails
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: txnId,
      maxResults: 1
    });
    
    if (!response.data.messages || response.data.messages.length === 0) {
      return null;
    }
    
    // Get full message
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: response.data.messages[0].id,
      format: 'full'
    });
    
    return parseEmailData(message.data);
  } catch (error) {
    console.error('Gmail search error:', error.message);
    return null;
  }
}

/**
 * Parse email data from Gmail API response
 */
function parseEmailData(message) {
  const headers = message.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

  let html = '';
  let text = '';

  // Extract body
  function extractParts(parts) {
    if (!parts) return;

    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType === 'text/plain' && part.body?.data) {
        text = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.parts) {
        extractParts(part.parts);
      }
    }
  }

  // Try payload body first
  if (message.payload?.body?.data) {
    const content = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    if (message.payload.mimeType === 'text/html') {
      html = content;
    } else {
      text = content;
    }
  }

  // Then try parts
  extractParts(message.payload?.parts);

  // Fallback to snippet
  if (!html && !text) {
    html = `<div style="padding:20px;font-family:Arial,sans-serif;">${message.snippet || ''}</div>`;
  }

  return {
    id: message.id,
    threadId: message.threadId,
    subject: getHeader('Subject'),
    from: getHeader('From'),
    to: getHeader('To'),
    date: getHeader('Date'),
    html: html || `<pre>${text}</pre>`,
    text,
    snippet: message.snippet
  };
}
