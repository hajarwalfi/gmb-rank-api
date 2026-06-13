
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import {
  launchPersistentChromium,
  ensureVirtualDisplay,
  detectHeadlessMode,
  SNIPER_CONTEXT,
  isCaptchaPage,
  STEALTH_SCRIPT,
  getSelectorsForUrl,
  selectorCsv,
  WIT_AI_TOKEN,
} from './ranking.service.js';
import { replaceNearMeWithServiceArea } from './nearMeQuery.service.js';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.join(__dirname, '../../outputs');
const SCREENSHOTS_DIR = path.join(OUTPUTS_DIR, 'screenshots');

/** Legal / suffix tokens */
const BUSINESS_NAME_NOISE = new Set([
  'tree', 'service', 'services', 'inc', 'llc', 'company', 'corp', 'solutions', 'contractor', 'the', 'and', 'of',
  'co', 'ltd', 'llp', 'lp', 'plc', 'dba', 'group', 'holdings', 'associates', 'pc', 'pa',
]);

function titleContainsWord(word, rWords) {
  if (rWords.includes(word)) return true;
  if (word.length <= 2) return false;
  if (word.endsWith('ies') && word.length > 3) {
    const y = `${word.slice(0, -3)}y`;
    if (rWords.includes(y)) return true;
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    const singular = word.slice(0, -1);
    if (rWords.includes(singular)) return true;
  }
  if (!word.endsWith('s')) {
    if (rWords.includes(`${word}s`)) return true;
  }
  return false;
}

function isStrictMatch(searchName, resultTitle) {
  if (!searchName || !resultTitle) return false;
  const s = searchName.toLowerCase().trim();
  const r = resultTitle.toLowerCase().trim();
  if (s === r) return true;

  const clean = (str) => str.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(w => w.length > 1);
  const sWords = clean(s);
  const rWords = clean(r);
  const sEssential = sWords.filter((w) => !BUSINESS_NAME_NOISE.has(w));
  if (sEssential.length === 0) return r.includes(s);

  let matched = sEssential.every((word) => titleContainsWord(word, rWords));
  if (!matched && sEssential.length >= 2) {
    const phrase = sEssential.join(' ');
    if (phrase.length >= 6 && r.replace(/\s+/g, ' ').includes(phrase)) {
      matched = true;
    }
  }
  return matched;
}

async function isMoreBusinessResultsPage(page) {
  const url = page.url();
  return /tbm=lcl|maps\.google|\/maps\/search/i.test(url) || /[?&]start=\d+/i.test(url);
}

/** 
 * Navigates to a URL but catches the "Interrupted" error 
 * if Google redirects to the CAPTCHA /sorry/ page.
 */
async function safeGoto(page, url, reason = '') {
  try {
    console.log(`[Automation] Navigating to: ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // If we landed on a CAPTCHA page, resolve it immediately
    if (page.url().includes('/sorry/') || await isCaptchaPage(page)) {
      if (!await resolveCaptchaIfPresent(page, false, reason)) {
        throw new Error('Google showing CAPTCHA (SafeGoto).');
      }
    }
    return resp;
  } catch (err) {
    // If ANY error occurs (Aborted, Timed out, etc.), check if it's a CAPTCHA
    console.warn(`[Automation] Navigation warning: ${err.message}. Checking for CAPTCHA...`);
    await page.waitForTimeout(2000); // Give potential redirect time to finish
    if (page.url().includes('/sorry/') || await isCaptchaPage(page)) {
      console.log('[Automation] CAPTCHA detected after navigation error. Attempting solve...');
      if (await resolveCaptchaIfPresent(page, false, reason)) {
        return; // Success after solve
      }
    }
    throw err;
  }
}

async function solveAudioCaptcha(page, recaptchaFrame) {
  try {
    if (!WIT_AI_TOKEN) {
      console.warn('[Automation] WIT_AI_TOKEN not found in .env. Skipping FREE AI solve.');
      return false;
    }

    console.log('[Automation] Attempting FREE AI Audio Solve (Wit.ai)...');
    
    // Switch to audio mode (try multiple selectors)
    const audioBtn = recaptchaFrame.locator('#recaptcha-audio-button, .rc-button-audio, button[title*="audio"]');
    if (!await audioBtn.isVisible({ timeout: 5000 })) {
      console.warn('[Automation] Headphones icon not visible in challenge frame.');
      return false;
    }
    await audioBtn.click({ force: true });
    await page.waitForTimeout(3000);

    // Get the audio download link (arrow icon in your screenshot)
    const downloadLink = await recaptchaFrame.locator('.rc-audiochallenge-downloader-link, a[href*="payload"], .rc-button-download').first().getAttribute('href');
    if (!downloadLink) {
      console.warn('[Automation] Download link (arrow) not found.');
      return false;
    }

    console.log('[Automation] Audio challenge found. Transcribing via Wit.ai (Free)...');
    const audioResp = await axios.get(downloadLink, { responseType: 'arraybuffer' });
    
    const transcriptionResponse = await axios({
      method: 'POST',
      url: 'https://api.wit.ai/speech',
      params: { v: '20230215' },
      headers: {
        Authorization: `Bearer ${WIT_AI_TOKEN}`,
        'Content-Type': 'audio/mpeg3',
      },
      data: response.data,
    });

    // Wit.ai returns a stream of JSON chunks; the last one contains the final text result
    const transcription = transcriptionResponse.data;
    const code = (typeof transcription === 'string') 
      ? transcription.split('\r\n').map(l => JSON.parse(l)).reverse().find(o => o.text)?.text
      : transcription.text;

    if (!code) throw new Error('Wit.ai failed to return transcription text.');

    console.log(`[Automation] FREE AI Transcription success: "${code}"`);

    // Type the code
    const input = recaptchaFrame.locator('#audio-response, input[id*="response"]');
    await input.fill(code);
    
    // Explicitly CLICK THE BLUE "VERIFY" BUTTON from your screenshot
    const verifyBtn = recaptchaFrame.locator('#recaptcha-verify-button, .rc-button-default, button:has-text("VERIFY")');
    if (await verifyBtn.isVisible({ timeout: 5000 })) {
      await verifyBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    await page.waitForTimeout(10000); // 10s wait for Google to reload search results
    return true;
  } catch (e) {
    console.log('[Automation] FREE AI Audio solve failed:', e.message);
    return false;
  }
}

async function resolveCaptchaIfPresent(page, headless, reason = '') {
  let isBlocked = await isCaptchaPage(page);
  if (!isBlocked && !page.url().includes('/sorry/')) return true;

  console.warn(`[Automation] CAPTCHA detected during ${reason}.`);
  
  // 1. Try to AUTO-CLICK the "I'm not a robot" checkbox
  let recaptchaFrame;
  try {
    const frames = page.frames();
    recaptchaFrame = frames.find(f => f.url().includes('api2/anchor') || f.name().includes('a-'));
    if (recaptchaFrame) {
      console.log('[Automation] Found reCAPTCHA checkbox. Attempting auto-click...');
      const checkboxSelectors = ['#recaptcha-anchor', '.recaptcha-checkbox-border', '.recaptcha-checkbox'];
      let clicked = false;
      for (const sel of checkboxSelectors) {
        const checkbox = recaptchaFrame.locator(sel);
        if (await checkbox.isVisible({ timeout: 2000 })) {
          await checkbox.click({ force: true });
          clicked = true;
          break;
        }
      }
      if (clicked) await page.waitForTimeout(4000); 
    }
  } catch (e) { }

  // 2. Wait up to 10s for the challenge frame (bframe) to appear
  console.log('[Automation] Searching for voice/image challenge frame...');
  let bframe = null;
  for (let i = 0; i < 10; i++) {
    const frames = page.frames();
    bframe = frames.find(f => f.url().includes('api2/bframe') || f.name().startsWith('c-'));
    if (bframe && await bframe.locator('#recaptcha-audio-button').isVisible({ timeout: 1000 }).catch(() => false)) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  // 3. If found, try AI AUDIO SOLVE
  if (bframe) {
    const solved = await solveAudioCaptcha(page, bframe);
    if (solved) {
      console.log('[Automation] AI Audio Solve completed successfully.');
      await page.waitForTimeout(3000);
    }
  }

  // 4. Final check. If still blocked and not headless, wait for user.
  isBlocked = await isCaptchaPage(page) || page.url().includes('/sorry/');
  if (!isBlocked) return true;
  if (headless) return false;

  console.warn('[Automation] AI solve failed or blocked by Google. Please solve the CAPTCHA MANUALLY (up to 8 min)...');
  await page.waitForFunction(() => {
    const blocked = window.location.href.includes('/sorry/') || !!document.querySelector('form[action*="sorry"]');
    return !blocked;
  }, { timeout: 480000, polling: 1000 }).catch(() => { });

  return !(await isCaptchaPage(page));
}

/** 
 * MAIN RANK SEARCH (CHUNKED)
 */
export async function automatedRankSearch(keyword, businessName, location = '', proxy = null, startPage = 1, maxPagesPerChunk = 3, targetRankInfo = null) {
  let context = null;
  const screenshotName = `rank_${Date.now()}.png`;
  const searchQuery = replaceNearMeWithServiceArea(keyword, location);
  const startOffset = (startPage - 1) * 20;

  try {
    await ensureVirtualDisplay();
    const headless = detectHeadlessMode();
    context = await launchPersistentChromium(null, headless, 'en-US');
    const page = await context.newPage();
    await page.addInitScript({ content: STEALTH_SCRIPT });

    if (targetRankInfo?.directUrl) {
      console.log(`[Automation] Targeted Jump: ${targetRankInfo.directUrl}`);
      await safeGoto(page, targetRankInfo.directUrl, 'Targeted Map Page');
      await page.waitForTimeout(5000); 
      
      const activeSelectors = getSelectorsForUrl(page.url());
      const foundMatch = {
        found: true,
        rank: targetRankInfo.rank,
        absoluteRank: targetRankInfo.rank,
        relativePos: targetRankInfo.relativePos,
        page: targetRankInfo.page,
        title: targetRankInfo.title || businessName,
      };

      const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
      
      await page.evaluate(({ match, cardsSel }) => {
        const items = document.querySelectorAll(cardsSel);
        const target = items[match.relativePos - 1];
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.border = '8px solid #e74c3c';
          target.style.borderRadius = '16px';
          target.style.boxShadow = '0 0 30px rgba(231, 76, 60, 0.6)';
        }
      }, { match: foundMatch, cardsSel: selectorCsv(activeSelectors.cards) });

      await page.waitForTimeout(1000);

      const rawPath = path.join(SCREENSHOTS_DIR, `raw_${screenshotName}`);
      await page.screenshot({ path: rawPath, fullPage: false });
      await fs.rename(rawPath, screenshotPath);

      return {
        success: true,
        found: true,
        rank: foundMatch.absoluteRank,
        screenshotPath: `screenshots/${screenshotName}`,
        title: foundMatch.title,
        page: foundMatch.page
      };
    }

    // --- FULL SEARCH FLOW (IF NO TARGET INFO) ---
    console.log(`[Automation] Search: "${businessName}" | Keyword: "${keyword}" | Pages: ${startPage}-${startPage + maxPagesPerChunk - 1}`);
    
    if (startPage === 1) {
      await safeGoto(page, 'https://www.google.com', 'Google Home');
      const searchBox = page.locator('[name="q"]');
      await searchBox.fill(searchQuery);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);

      const selectors = [
        '.iY7pq', '[data-async-trigger="more_places"]',
        'a:has-text("More businesses")', 'a:has-text("More places")',
        '.hGSR8', '#lu_map',
      ];

      let foundTransition = false;
      for (const sel of selectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await page.waitForTimeout(3000);
          foundTransition = true;
          break;
        }
      }

      if (!foundTransition) {
        const directLocalUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&tbm=lcl&pws=0&start=0&gl=us&hl=en`;
        await safeGoto(page, directLocalUrl, 'Direct Map View');
      }
    } else {
      const chunkUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&tbm=lcl&pws=0&start=${startOffset}&gl=us&hl=en`;
      await safeGoto(page, chunkUrl, `Page ${startPage}`);
    }

    await page.waitForTimeout(5000); 
    if (!await resolveCaptchaIfPresent(page, false, 'Map Results')) {
      throw new Error('Google showing CAPTCHA.');
    }

    let pageNum = startPage;
    let totalRank = startOffset;
    let foundMatch = null;
    const MAX_PAGES = 30;
    const endChunkPage = Math.min(startPage + maxPagesPerChunk - 1, MAX_PAGES);

    while (pageNum <= endChunkPage) {
      console.log(`[Automation] Page ${pageNum}`);
      const activeSelectors = getSelectorsForUrl(page.url());
      const cardsSelector = selectorCsv(activeSelectors.cards);

      const listings = await page.evaluate(({ cardsSel, titleSels, descSels }) => {
        return Array.from(document.querySelectorAll(cardsSel)).map((el, i) => {
          let titleEl = null;
          for (const s of titleSels || []) {
            titleEl = el.querySelector(s);
            if (titleEl && titleEl.innerText) break;
          }
          if (!titleEl) return null;
          const descEl = el.querySelector(descSels?.[0] || '');
          return { index: i, title: titleEl.innerText.trim(), description: descEl ? descEl.innerText.trim() : '' };
        }).filter(Boolean);
      }, { cardsSel: cardsSelector, titleSels: activeSelectors.title || [], descSels: activeSelectors.desc || [] }).catch(() => []);

      for (let i = 0; i < listings.length; i++) {
        if (isStrictMatch(businessName, listings[i].title)) {
          foundMatch = { page: pageNum, relativePos: i + 1, absoluteRank: totalRank + i + 1, title: listings[i].title };
          break;
        }
      }

      if (foundMatch) break;
      totalRank += listings.length;

      if (pageNum < endChunkPage) {
        console.log('[Automation] Navigating to next result page...');
        const nextSelectors = [selectorCsv(activeSelectors.nextPage), 'button[aria-label*="Next"]', 'a[id="pnnext"]', 'button:has-text("Next")'];
        let moved = false;
        for (const sel of nextSelectors) {
          const nextBtn = page.locator(sel).first();
          if (await nextBtn.isVisible({ timeout: 4000 })) {
            await nextBtn.click({ force: true });
            await page.waitForTimeout(4000);
            pageNum++;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      } else {
        break;
      }
    }

    if (foundMatch) {
      const activeSelectors = getSelectorsForUrl(page.url());
      const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);

      await page.evaluate(({ match, cardsSel }) => {
        const items = document.querySelectorAll(cardsSel);
        const target = items[match.relativePos - 1];
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.border = '8px solid #e74c3c';
          target.style.borderRadius = '16px';
          target.style.boxShadow = '0 0 30px rgba(231, 76, 60, 0.6)';
        }
      }, { match: foundMatch, cardsSel: selectorCsv(activeSelectors.cards) });

      await page.waitForTimeout(1000);
      const rawPath = path.join(SCREENSHOTS_DIR, `raw_${screenshotName}`);
      await page.screenshot({ path: rawPath, fullPage: false });
      await fs.rename(rawPath, screenshotPath);

      return { success: true, found: true, rank: foundMatch.absoluteRank, page: foundMatch.page, screenshotPath: `screenshots/${screenshotName}`, title: foundMatch.title };
    } else {
      return { success: true, found: false, nextStartPage: pageNum < MAX_PAGES ? pageNum + 1 : null, hasMore: pageNum < MAX_PAGES };
    }
  } catch (err) {
    console.error('[Automation ERROR]', err);
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
