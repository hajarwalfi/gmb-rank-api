import axios from 'axios';

/**
 * Best-effort sitekey from a Playwright page (reCAPTCHA v2 / “I’m not a robot”).
 */
export async function extractRecaptchaSiteKey(page) {
  if (!page) return null;
  return page
    .evaluate(() => {
      const vis = document.querySelector('[data-sitekey]');
      if (vis) return vis.getAttribute('data-sitekey');
      for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
        const src = iframe.getAttribute('src') || '';
        const m = src.match(/[?&]k=([^&]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    })
    .catch(() => null);
}

/**
 * Solve reCAPTCHA v2 via 2Captcha-compatible API (CAPTCHA_2_API_KEY / TWOCAPTCHA_API_KEY).
 */
export async function solveRecaptchaV2({ apiKey, pageUrl, siteKey }) {
  const key = String(apiKey || '').trim();
  const url = String(pageUrl || '').trim();
  const sk = String(siteKey || '').trim();
  if (!key || !url || !sk) return null;

  const inUrl = 'https://2captcha.com/in.php';
  const resUrl = 'https://2captcha.com/res.php';
  const body = new URLSearchParams({
    key,
    method: 'userrecaptcha',
    googlekey: sk,
    pageurl: url,
    json: '1',
  });

  const { data: created } = await axios.post(inUrl, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 120000,
  });
  if (created.status !== 1) {
    console.warn('[2captcha] in.php:', created.request || created);
    return null;
  }
  const id = created.request;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const { data: out } = await axios.get(resUrl, {
      params: { key, action: 'get', id, json: 1 },
      timeout: 120000,
    });
    if (out.status === 1 && out.request) return String(out.request);
    if (String(out.request || '') === 'CAPCHA_NOT_READY') continue;
    console.warn('[2captcha] res.php:', out.request || out);
    return null;
  }
  return null;
}

/**
 * Inject token into the page — textarea + optional grecaptcha client callback.
 */
export async function injectRecaptchaV2Token(page, token) {
  if (!page || !token) return;
  const t = String(token);
  await page.evaluate((tok) => {
    for (const sel of ['textarea[name="g-recaptcha-response"]', '#g-recaptcha-response']) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = tok;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    try {
      const cfg = window.___grecaptcha_cfg;
      const clients = cfg && cfg.clients;
      if (!clients || typeof clients !== 'object') return;
      for (const cid of Object.keys(clients)) {
        const c = clients[cid];
        const stack = [c];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          if (typeof cur.callback === 'function') {
            cur.callback(tok);
            return;
          }
          for (const v of Object.values(cur)) {
            if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch (_) {
      /* ignore */
    }
  }, t);
}
