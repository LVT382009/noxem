/**
 * Web Fetch Module — fetch URLs and extract readable text content.
 * Zero external dependencies: uses Node.js built-in fetch (Node 18+).
 * Used by research-engine.mjs to read pages found by DDG search.
 *
 * v2: servo-fetch adapter — tries servo-fetch sidecar first, falls back to regex.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE = 1_048_576; // 1 MiB — abort if response exceeds this
const MAX_TEXT_LENGTH = 2000; // Truncate extracted text to this many chars
const SERVO_FETCH_URL = process.env.SERVO_FETCH_URL || 'http://127.0.0.1:3002';
const SERVO_FETCH_TIMEOUT_MS = 8_000;
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// v2: SSRF protection — private IP ranges
const PRIVATE_IP_RANGES = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./, /^\[?::1\]?/, /^\[?fe80:/i, /^\[?fc00:/i];

export function isPrivateUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const hostname = parsed.hostname || '';
    const ipv4mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    const checkHost = ipv4mapped ? ipv4mapped[1] : hostname.replace(/[\[\]]/g, '');
    return PRIVATE_IP_RANGES.some(r => r.test(checkHost));
  } catch { return true; }
}

// v2: servo-fetch liveness check
let servoFetchAlive = false;
let servoFetchCheckedAt = 0;
const SERVO_FETCH_CHECK_INTERVAL_MS = 30_000;

export async function checkServoFetchLiveness() {
  const now = Date.now();
  if (now - servoFetchCheckedAt < SERVO_FETCH_CHECK_INTERVAL_MS) return servoFetchAlive;
  servoFetchCheckedAt = now;
  try {
    const res = await fetch(`${SERVO_FETCH_URL}/health`, { signal: AbortSignal.timeout(2000) });
    servoFetchAlive = res.ok;
  } catch {
    servoFetchAlive = false;
  }
  return servoFetchAlive;
}

// Skip these URL extensions (non-HTML content)
const SKIP_EXTENSIONS = /\.(pdf|png|jpg|jpeg|gif|svg|webp|ico|zip|tar|gz|bz2|7z|exe|dmg|mp3|mp4|avi|mov|wav|ogg|flac|doc|docx|xls|xlsx|ppt|pptx|apk|iso|bin|dat)$/i;

// Rate limiter: max N fetches per minute
const fetchTimestamps = [];
const FETCH_RATE_LIMIT = 10; // max 10 page fetches per minute

function canFetch() {
  const now = Date.now();
  while (fetchTimestamps.length && now - fetchTimestamps[0] > 60_000) {
    fetchTimestamps.shift();
  }
  if (fetchTimestamps.length >= FETCH_RATE_LIMIT) return false;
  fetchTimestamps.push(now);
  return true;
}

/**
 * Check if a URL looks fetchable (HTML page, not a binary file).
 */
export function isFetchableUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const pathname = parsed.pathname.toLowerCase();
    if (SKIP_EXTENSIONS.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Try servo-fetch sidecar first, fall back to regex extraction.
 * servo-fetch returns { markdown, title, byline, lang }.
 * We map: markdown → text, title → title.
 */
async function fetchViaServoFetch(url, { timeout = SERVO_FETCH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`${SERVO_FETCH_URL}/v1/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.markdown) return null;
    return {
      url,
      title: data.title || '',
      text: data.markdown.replace(/\s+/g, ' ').trim().substring(0, MAX_TEXT_LENGTH),
      error: null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and extract readable text content.
 * Returns { url, title, text, error } — never throws.
 */
export async function fetchPage(url, { timeout = FETCH_TIMEOUT_MS, maxText = MAX_TEXT_LENGTH } = {}) {
  if (!isFetchableUrl(url)) {
    return { url, title: '', text: '', error: 'non-html-url' };
  }

  // v2: SSRF protection
  if (isPrivateUrl(url)) {
    return { url, title: '', text: '', error: 'blocked-private-url' };
  }

  if (!canFetch()) {
    return { url, title: '', text: '', error: 'rate-limited' };
  }

  // v2: Try servo-fetch sidecar first
  if (await checkServoFetchLiveness()) {
    const servoResult = await fetchViaServoFetch(url);
    if (servoResult) return servoResult;
  }

  // Fallback: regex-based extraction
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NoxemResearch/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { url, title: '', text: '', error: `http-${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return { url, title: '', text: '', error: `wrong-content-type:${contentType.split(';')[0]}` };
    }

    // Read body with size limit
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (totalBytes < MAX_BODY_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    reader.cancel?.();

    const html = new TextDecoder('utf-8', { fatal: false }).decode(
      Buffer.concat(chunks)
    );

    const title = extractTitle(html);
    const text = extractText(html, maxText);

    return { url, title, text, error: null };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { url, title: '', text: '', error: 'timeout' };
    }
    return { url, title: '', text: '', error: err.message?.substring(0, 100) || 'unknown' };
  }
}

/**
 * Extract <title> from HTML.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '').trim()).substring(0, 200);
}

/**
 * Extract readable text from HTML — zero-dependency approach.
 */
function extractText(html, maxLength = MAX_TEXT_LENGTH) {
  let text = html;

  // Remove non-content blocks (multiline)
  text = text.replace(/<script[\s>][\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s>][\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s>][\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s>][\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s>][\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s>][\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<form[\s>][\s\S]*?<\/form>/gi, '');
  text = text.replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, '');

  // Try to extract <main>, <article>, or <div role="main"> content preferentially
  const mainMatch = text.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i)
    || text.match(/<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i);
  if (mainMatch) text = mainMatch[1];

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text.substring(0, maxLength);
}

/**
 * Decode common HTML entities without external deps.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x?([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}


/**
 * Crawl a domain: fetch seed URL, extract links, follow them up to maxDepth.
 * Uses servo-fetch POST /v1/crawl when available, else BFS with fetchPage().
 * Per-domain rate limiting (500ms). URL dedup via Set.
 */
export async function crawlDomain(seedUrl, { maxDepth = 2, maxPages = 5, sameDomainOnly = true } = {}) {
  if (isPrivateUrl(seedUrl)) return [];
  if (!isFetchableUrl(seedUrl)) return [];

  // v2: Try servo-fetch crawl endpoint first
  if (await checkServoFetchLiveness()) {
    try {
      const res = await fetch(`${SERVO_FETCH_URL}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: seedUrl, max_depth: maxDepth, max_pages: maxPages, same_domain_only: sameDomainOnly }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.pages?.length) {
          return data.pages.map(p => ({
            url: p.url,
            title: p.title || '',
            text: (p.markdown || p.text || '').replace(/\s+/g, ' ').trim().substring(0, MAX_TEXT_LENGTH),
          })).filter(p => p.text.length > 50);
        }
      }
    } catch (err) {
      LOG_DEBUG && console.error('[WebFetch] servo-fetch crawl failed:', err.message);
    }
  }

  // Fallback: BFS crawl using fetchPage
  const visited = new Set();
  const results = [];
  const queue = [{ url: seedUrl, depth: 0 }];
  const seedOrigin = new URL(seedUrl).origin;
  const domainLastFetch = new Map();

  while (queue.length > 0 && results.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    if (depth > maxDepth) continue;
    visited.add(url);

    // Per-domain rate limit: 500ms
    const domain = new URL(url).hostname;
    const lastFetch = domainLastFetch.get(domain) || 0;
    if (Date.now() - lastFetch < 500) {
      await new Promise(r => setTimeout(r, 500 - (Date.now() - lastFetch)));
    }

    const page = await fetchPage(url);
    domainLastFetch.set(domain, Date.now());

    if (page.error || !page.text) continue;
    results.push({ url: page.url, title: page.title, text: page.text });

    // Extract links from the page (simple regex, not full HTML parsing)
    if (depth < maxDepth && results.length < maxPages) {
      const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
      let match;
      while ((match = linkRegex.exec(page.text)) !== null) {
        try {
          const linkUrl = match[1];
          if (sameDomainOnly && new URL(linkUrl).origin !== seedOrigin) continue;
          if (!visited.has(linkUrl) && isFetchableUrl(linkUrl) && !isPrivateUrl(linkUrl)) {
            queue.push({ url: linkUrl, depth: depth + 1 });
          }
        } catch {}
      }
    }
  }

  return results.filter(r => r.text.length > 50);
}

/**
 * Fetch multiple URLs concurrently with a concurrency limit.
 * Returns array of results, filtering out errors.
 */
export async function fetchPages(urls, { maxConcurrency = 2, maxText = MAX_TEXT_LENGTH } = {}) {
  const results = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) break;
      const result = await fetchPage(url, { maxText });
      if (!result.error) results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
