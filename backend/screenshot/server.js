const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Device presets for realistic screenshots
const DEVICES = {
  desktop: {
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  mobile: {
    viewport: { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  }
};

let browser = null;
let pagePool = [];
const POOL_SIZE = 3;

// Initialize browser and page pool
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update'
      ]
    });

    // Pre-warm page pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const page = await browser.newPage();
      await page.setViewport({ width: 800, height: 600 });
      pagePool.push({ page, busy: false });
    }

    console.log(`Browser initialized with ${POOL_SIZE} pages`);
  }
  return browser;
}

// Get available page from pool
async function getPage() {
  await initBrowser();

  // Find free page
  const slot = pagePool.find(s => !s.busy);
  if (slot) {
    slot.busy = true;
    return slot;
  }

  // All busy - create temporary page
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  return { page, busy: true, temp: true };
}

// Release page back to pool
async function releasePage(slot) {
  if (slot.temp) {
    await slot.page.close().catch(() => {});
  } else {
    slot.busy = false;
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await initBrowser();
    res.json({ status: 'ok', poolSize: pagePool.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Screenshot endpoint
app.post('/screenshot', async (req, res) => {
  const { url, html, device = 'desktop' } = req.body;

  if (!url && !html) {
    return res.status(400).json({ error: 'URL or HTML is required' });
  }

  const deviceConfig = DEVICES[device] || DEVICES.desktop;
  let slot = null;

  try {
    slot = await getPage();
    const page = slot.page;

    // Apply device settings
    await page.setViewport(deviceConfig.viewport);
    await page.setUserAgent(deviceConfig.userAgent);

    if (html) {
      // Direct HTML content - faster
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 5000 });
    } else if (url.startsWith('data:')) {
      // Data URL - extract and set content directly
      const base64Match = url.match(/^data:text\/html;base64,(.+)$/);
      if (base64Match) {
        const htmlContent = Buffer.from(base64Match[1], 'base64').toString('utf-8');
        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 5000 });
      } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      }
    } else {
      // Regular URL
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    }

    // Take screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true
    });

    await releasePage(slot);

    res.json({
      screenshot: screenshot.toString('base64')
    });

  } catch (error) {
    console.error('Screenshot error:', error.message);
    if (slot) await releasePage(slot);
    res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

// Init on startup
initBrowser().catch(console.error);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Screenshot service running on port ${PORT}`);
});
