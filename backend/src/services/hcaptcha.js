const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;
const VERIFY_URL = 'https://hcaptcha.com/siteverify';

/**
 * Verify hCaptcha response
 */
export async function verifyCaptcha(token) {
  if (!token) {
    return { success: false, error: 'No captcha token provided' };
  }
  
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        secret: HCAPTCHA_SECRET,
        response: token
      })
    });
    
    const result = await response.json();
    
    return {
      success: result.success === true,
      error: result['error-codes']?.join(', ') || null
    };
  } catch (error) {
    console.error('hCaptcha verification error:', error);
    return { success: false, error: error.message };
  }
}
