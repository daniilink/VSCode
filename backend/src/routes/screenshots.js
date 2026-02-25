import { Router } from 'express';
import { searchEmailByTransactionId } from '../services/gmail.js';
import { takeScreenshot } from '../services/screenshot.js';
import { sendErrorNotification } from '../services/telegram.js';

const router = Router();
const BASE_URL = process.env.BASE_URL || 'https://api.daniilink.com';

// ═══════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize HTML - fix encoding issues from PayPal emails
 */
function sanitizeHtml(html) {
  if (!html) return html;
  return html
    // Replace non-breaking space (causes "Â" display issue)
    .replace(/\u00A0/g, ' ')
    .replace(/&nbsp;/g, ' ')
    // Replace other problematic characters
    .replace(/\u200B/g, '') // zero-width space
    .replace(/\u200C/g, '') // zero-width non-joiner
    .replace(/\u200D/g, '') // zero-width joiner
    .replace(/\uFEFF/g, '') // BOM
    // Remove Quoted-Printable encoded emoji (=F0=9F=XX=XX patterns)
    .replace(/=F0=9F=[0-9A-F]{2}=[0-9A-F]{2}/gi, '')
    // Remove broken UTF-8 emoji display (ð followed by garbage)
    .replace(/ð[\x80-\xFF]{1,3}/g, '');
}

/**
 * Detect if request is from mobile device
 */
function isMobile(userAgent) {
  return /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent || '');
}

/**
 * Generate viewer HTML page with Copy/Download buttons
 */
function generateViewerHtml(emailHtml, id, idParam, device) {
  const htmlBase64 = Buffer.from(emailHtml, 'utf-8').toString('base64');
  const screenshotUrlBase = `${BASE_URL}/webhook/get-viewer-screenshot?${idParam}=${id}&device=`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" type="image/png" href="https://www.paypalobjects.com/webstatic/icon/pp258.png">
  <title>Email Viewer</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;min-height:100vh}
    .toolbar{position:fixed;top:0;left:0;right:0;background:#fff;padding:12px 20px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.1);z-index:100}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all .15s;text-decoration:none}
    .btn-primary{background:#4285f4;color:#fff}
    .btn-primary:hover{background:#3367d6}
    .btn-secondary{background:#f1f3f4;color:#5f6368}
    .btn-secondary:hover{background:#e8eaed}
    .btn:disabled{opacity:.6;cursor:not-allowed}
    .btn svg{width:18px;height:18px}
    .spacer{flex:1}
    .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .3s;z-index:200;pointer-events:none}
    .toast.show{opacity:1}
    .frame-wrap{padding-top:70px;display:flex;justify-content:center;padding-bottom:20px}
    iframe{border:none;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.15);border-radius:8px;max-width:100%}
    .spinner{width:18px;height:18px;border:2px solid #e8eaed;border-top-color:#4285f4;border-radius:50%;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn btn-primary" id="copyBtn" onclick="handleAction()" style="display:none">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      <span id="copyBtnText">Copy Image</span>
    </button>
    <button class="btn" id="downloadBtn" onclick="downloadImage()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
      Download
    </button>
    <div class="spacer"></div>
    <span style="color:#5f6368;font-size:13px">${device === 'mobile' ? 'Mobile' : 'Desktop'} view</span>
  </div>

  <div class="frame-wrap">
    <iframe id="emailFrame" srcdoc="" width="${device === 'mobile' ? 430 : 800}" height="600"></iframe>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const device = '${device}';
    const screenshotUrl = '${screenshotUrlBase}' + device;
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    (function(){
      const copyBtn = document.getElementById('copyBtn');
      const downloadBtn = document.getElementById('downloadBtn');
      const copyBtnText = document.getElementById('copyBtnText');

      if (isSafari) {
        copyBtn.style.display = 'inline-flex';
        copyBtnText.textContent = 'View Image';
        copyBtn.querySelector('svg').innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
        downloadBtn.className = 'btn btn-secondary';
      } else if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        copyBtn.style.display = 'inline-flex';
        downloadBtn.className = 'btn btn-secondary';
      } else {
        downloadBtn.className = 'btn btn-primary';
      }

      const htmlContent = atob('${htmlBase64}');
      const frame = document.getElementById('emailFrame');
      frame.srcdoc = htmlContent;
      frame.onload = function() {
        try {
          const doc = frame.contentDocument || frame.contentWindow.document;
          const height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
          frame.height = Math.min(height + 40, 2000);
        } catch(e) {}
      };
    })();

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    async function getScreenshot() {
      const res = await fetch(screenshotUrl);
      if (!res.ok) throw new Error('Screenshot failed');
      return await res.blob();
    }

    function handleAction() {
      if (isSafari) {
        window.location.href = screenshotUrl;
      } else {
        copyImage();
      }
    }

    async function copyImage() {
      const btn = document.getElementById('copyBtn');
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<div class="spinner"></div> <span>Copying...</span>';

      try {
        const blob = await getScreenshot();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Image copied!');
      } catch(e) {
        showToast('Error: Copy failed');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }

    async function downloadImage() {
      const btn = document.getElementById('downloadBtn');
      btn.disabled = true;
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<div class="spinner"></div> <span>Downloading...</span>';

      try {
        const blob = await getScreenshot();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'email-${id}.png';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Downloaded!');
      } catch(e) {
        showToast('Download failed');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

/**
 * GET /webhook/txnscreen
 * Main production endpoint - viewer with Copy/Download buttons
 */
router.get('/txnscreen', async (req, res) => {
  try {
    const { transactionId } = req.query;

    if (!transactionId) {
      return res.status(400).send('transactionId not provided');
    }

    const email = await searchEmailByTransactionId(transactionId);

    if (!email || !email.html) {
      return res.status(404).send('Email not found');
    }

    const device = isMobile(req.headers['user-agent']) ? 'mobile' : 'desktop';
    const viewerHtml = generateViewerHtml(sanitizeHtml(email.html), transactionId, 'transactionId', device);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtml);

  } catch (error) {
    console.error('Txnscreen error:', error);
    res.status(500).send('Error loading screenshot');
  }
});

/**
 * GET /webhook/email-screenshot and /webhook/email-viewer
 * DEPRECATED - redirects to txnscreen with input form
 */
router.get(['/email-screenshot', '/email-viewer'], (req, res) => {
  const { transactionId } = req.query;

  // If transactionId provided, redirect to txnscreen
  if (transactionId) {
    return res.redirect(`/webhook/txnscreen?transactionId=${encodeURIComponent(transactionId)}`);
  }

  // Show form to enter transaction ID
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Email Screenshot - Redirect</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);max-width:400px;width:90%;text-align:center}
    h1{color:#333;margin-bottom:10px;font-size:1.5em}
    p{color:#666;margin-bottom:25px;font-size:0.95em}
    input{width:100%;padding:14px;border:2px solid #e0e0e0;border-radius:8px;font-size:1em;margin-bottom:15px;text-align:center}
    input:focus{outline:none;border-color:#4285f4}
    button{width:100%;padding:14px;background:#4285f4;color:#fff;border:none;border-radius:8px;font-size:1em;cursor:pointer;font-weight:500}
    button:hover{background:#3367d6}
    .note{color:#999;font-size:0.8em;margin-top:20px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Screenshot Service</h1>
    <p>This link format is deprecated.<br>Enter Transaction ID to view screenshot:</p>
    <form action="/webhook/txnscreen" method="GET">
      <input type="text" name="transactionId" placeholder="Transaction ID (e.g. 5SV28207A90645610)" required>
      <button type="submit">View Screenshot</button>
    </form>
    <p class="note">Transaction ID can be found in your PayPal notification</p>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * GET /webhook/get-viewer-screenshot
 * Returns PNG for viewer's Copy/Download buttons
 */
router.get('/get-viewer-screenshot', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { transactionId, device = 'desktop' } = req.query;

    if (!transactionId) {
      return res.status(400).send('transactionId required');
    }

    const email = await searchEmailByTransactionId(transactionId);

    if (!email || !email.html) {
      return res.status(404).send('Email not found');
    }

    // Take screenshot with device preset
    const screenshot = await takeScreenshot(sanitizeHtml(email.html), device);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="email-screenshot.png"');
    res.send(screenshot);

  } catch (error) {
    console.error('Viewer screenshot error:', error);
    res.status(500).send('Screenshot generation failed');
  }
});

export default router;
