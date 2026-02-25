import { Router } from 'express';
import { verifyCaptcha } from '../services/hcaptcha.js';
import { sendNewOrderNotification } from '../services/telegram.js';

const router = Router();

// Wallet validation patterns
const walletPatterns = {
  'USDT TRC20': /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  'USDT ERC20': /^0x[a-fA-F0-9]{40}$/,
  'USDT BEP20': /^0x[a-fA-F0-9]{40}$/,
  'Binance Pay': /^[a-zA-Z0-9@._-]{3,100}$/
};

/**
 * POST /webhook/pp-exchange
 * Handles new exchange application from website form
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body;
    
    // 1. Honeypot check
    if (body.website) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bot detected' 
      });
    }
    
    // 2. Verify hCaptcha
    const captchaResult = await verifyCaptcha(body['h-captcha-response']);
    if (!captchaResult.success) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid captcha' 
      });
    }
    
    // 3. Validate wallet address
    const { wallet, crypto } = body;
    const pattern = walletPatterns[crypto];
    
    if (!pattern) {
      return res.status(400).json({
        success: false,
        error: 'Invalid crypto type'
      });
    }
    
    if (!pattern.test(wallet)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address'
      });
    }
    
    // Additional hex validation for ERC20/BEP20
    if ((crypto.includes('ERC20') || crypto.includes('BEP20'))) {
      const address = wallet.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid hex address'
        });
      }
    }
    
    // 4. Send to Telegram
    await sendNewOrderNotification({
      telegram: body.telegram,
      amount: body.amount,
      crypto: body.crypto,
      wallet: body.wallet,
      personalPaypal: body.personalPaypal,
      comment: body.comment
    });
    
    // 5. Success response
    res.json({ 
      success: true, 
      message: 'Application sent successfully' 
    });
    
  } catch (error) {
    console.error('PP Exchange error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error' 
    });
  }
});

export default router;
