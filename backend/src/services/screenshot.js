const SCREENSHOT_SERVICE_URL = process.env.SCREENSHOT_SERVICE_URL || 'http://screenshot-service:3000/screenshot';

/**
 * Take screenshot of HTML content
 * @param {string} htmlContent - HTML to screenshot
 * @param {string} device - 'desktop' or 'mobile' (default: 'desktop')
 */
export async function takeScreenshot(htmlContent, device = 'desktop') {
  try {
    const response = await fetch(SCREENSHOT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: htmlContent, device }),
    });

    if (!response.ok) {
      throw new Error(`Screenshot service error: ${response.status}`);
    }

    const result = await response.json();

    if (!result.screenshot) {
      throw new Error('No screenshot in response');
    }

    // Return as Buffer
    return Buffer.from(result.screenshot, 'base64');
  } catch (error) {
    console.error('Screenshot error:', error);
    throw error;
  }
}

/**
 * Generate loading HTML page
 */
export function generateLoadingPage(screenshotUrl, title = 'Loading Screenshot...') {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
    <style>
        body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
        .card{background:#fff;padding:2rem;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:500px;width:90%}
        .loader{border:4px solid #f3f3f3;border-top:4px solid #667eea;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:20px auto}
        @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        #screenshotImage{width:100%;border-radius:8px;display:none}
    </style>
</head>
<body>
    <div class="card">
        <div id="loading"><h3>${title}</h3><div class="loader"></div></div>
        <img id="screenshotImage" alt="Screenshot">
        <p id="error" style="display:none;color:red">Loading error</p>
    </div>
    <script>
        async function load(){
            try{
                const res=await fetch('${screenshotUrl}');
                if(!res.ok)throw new Error();
                const blob=await res.blob();
                document.getElementById('loading').style.display='none';
                const img=document.getElementById('screenshotImage');
                img.src=URL.createObjectURL(blob);
                img.style.display='block';
            }catch(e){
                document.getElementById('loading').style.display='none';
                document.getElementById('error').style.display='block';
            }
        }
        load();
    </script>
</body>
</html>`;
}
