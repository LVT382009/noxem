/**
 * Web Fetch Module — fetch URLs and extract readable text content.
 * Zero external dependencies: uses Node.js built-in fetch (Node 18+).
 * Used by research-engine.mjs to read pages found by DDG search.
 */

import { isPrivateUrl } from './ddg-search.mjs';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE = 1_048_576; // 1 MiB — abort if response exceeds this
const MAX_TEXT_LENGTH = 2000; // Truncate extracted text to this many chars
const MAX_REDIRECTS = 5;

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
 * Fetch a URL and extract readable text content.
 * Returns { url, title, text, error } — never throws.
 */
export async function fetchPage(url, { timeout = FETCH_TIMEOUT_MS, maxText = MAX_TEXT_LENGTH } = {}) {
  if (!isFetchableUrl(url)) {
    return { url, title: '', text: '', error: 'non-html-url' };
  }

  if (isPrivateUrl(url)) {
    return { url, title: '', text: '', error: 'blocked-private-url' };
  }

  if (!canFetch()) {
    return { url, title: '', text: '', error: 'rate-limited' };
  }

try {
  let currentUrl = url;
  let hops = 0;
  let response;
  // Single timeout signal covers entire redirect chain
  const signal = AbortSignal.timeout(timeout);

  // Manual redirect loop - validate each hop against SSRF
  while (hops <= MAX_REDIRECTS) {
    response = await fetch(currentUrl, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NoxemResearch/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) { await response.body.cancel(); return { url, title: "", text: "", error: "redirect-no-location" }; }
      const nextUrl = new URL(location, currentUrl).href;
      if (!isFetchableUrl(nextUrl)) { await response.body.cancel(); return { url, title: "", text: "", error: "redirect-not-fetchable" }; }
        if (isPrivateUrl(nextUrl)) { await response.body.cancel(); return { url, title: "", text: "", error: "blocked-private-url" }; }

      currentUrl = nextUrl;
      hops++;
      continue;
    }
    break;
  }

  if (hops > MAX_REDIRECTS) {
    await response.body.cancel(); return { url, title: "", text: "", error: "too-many-redirects" };
  }

    if (!response.ok) {
      await response.body.cancel(); return { url, title: '', text: '', error: `http-${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      await response.body.cancel(); return { url, title: '', text: '', error: `wrong-content-type:${contentType.split(';')[0]}` };
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
 * 1. Remove script, style, nav, header, footer, aside blocks
 * 2. Decode HTML entities
 * 3. Strip remaining tags
 * 4. Collapse whitespace
 * 5. Truncate
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
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return '�'; } })
    .replace(/&#(\d+);/g, (_, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return '�'; } });
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
