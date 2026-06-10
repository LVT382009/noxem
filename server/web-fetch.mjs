/**
 * Web Fetch Module — fetch URLs and extract readable text content.
 * Zero external dependencies: uses Node.js built-in fetch (Node 18+).
 * Used by research-engine.mjs to read pages found by DDG search.
 */

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE = 1_048_576; // 1 MiB — abort if response exceeds this
const MAX_TEXT_LENGTH = 2000; // Truncate extracted text to this many chars

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
/**
 * S-NEW-6: SSRF defense — reject URLs that resolve to private/loopback IPs.
 * The Node `fetch` follows redirects silently, so we must resolve the host
 * ourselves and check the IP *before* the request is made. We use DNS lookup
 * via the URL object's hostname; actual DNS resolution is performed by fetch.
 * A redirect to a private IP (e.g., 127.0.0.1, 169.254.169.254) is blocked
 * by setting `redirect: 'manual'` and re-validating on every redirect.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,
  // S-NEW-12: IPv6 loopback + private ranges. Node's URL parser returns IPv6
  // hostnames WITH brackets (e.g. `[::1]`, `[fc00::1]`), so patterns must
  // accept the bracket form. We also match bare `::1` and bare `fc00:...`
  // for callers that strip brackets themselves.
  /^\[?::1\]?$/i,
  /^\[?fc[0-9a-f]{2}:[0-9a-f:]+\]?$/i,  // RFC4193 unique-local (fc00::/7)
  /^\[?fd[0-9a-f]{2}:[0-9a-f:]+\]?$/i,  // RFC4193 unique-local (fd00::/8) — both halves of /7
  /^\[?fe80:[0-9a-f:]+\]?$/i,            // link-local
  /^0\.0\.0\.0$/,                         // all-interfaces
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,  // CGNAT 100.64.0.0/10
];

function isPrivateHost(hostname) {
  if (!hostname) return true;
  // S-NEW-12: strip surrounding brackets that Node adds for IPv6 literals
  const h = hostname.replace(/^\[|\]$/g, '');
  return PRIVATE_HOST_PATTERNS.some(p => p.test(h) || p.test(hostname));
}

// cycle-4: defense against DNS rebinding. The string-based isPrivateHost
// only checks the literal hostname. An attacker could register
// `evil.example.com` that resolves to 127.0.0.1 — string check passes,
// connection happens, SSRF succeeds. We resolve once and check the actual
// returned IPs. Cached briefly (60s) to amortize the lookup cost across
// redirects.
const _dnsCache = new Map(); // hostname -> { ok: boolean, expires: number }
const DNS_CACHE_TTL_MS = 60_000;
async function resolvesToPrivate(hostname) {
  if (!hostname) return true;
  const h = hostname.replace(/^\[|\]$/g, '');
  // If it's a literal IP, no resolution needed — just check the string.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) {
    return isPrivateHost(h);
  }
  const cached = _dnsCache.get(h);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.ok;
  let addresses = [];
  try {
    const recs = await dns.lookup(h, { all: true });
    addresses = recs.map(r => r.address);
  } catch {
    // Lookup failed — fall back to string check (most attackers can't
    // make their own domain unresolvable in our DNS, so the string
    // check is the better defense for typos and the like).
    return isPrivateHost(h);
  }
  const ok = addresses.length > 0 && addresses.every(isPrivateHost);
  _dnsCache.set(h, { ok, expires: now + DNS_CACHE_TTL_MS });
  return ok;
}

export function isFetchableUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    // S-NEW-6: explicit private-host rejection. The url-extension check
    // alone is not enough — a 302 to http://169.254.169.254/ bypasses it.
    if (isPrivateHost(parsed.hostname)) return false;
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
export async function fetchPage(url, { timeout = FETCH_TIMEOUT_MS, maxText = MAX_TEXT_LENGTH, depth = 0 } = {}) {
  // cycle-4: DNS rebinding defense — after the cheap string check passes,
  // resolve the hostname and confirm no returned IP is private. Catches
  // `evil.example.com -> 127.0.0.1` that string-only isFetchableUrl misses.
  // We re-check on every redirect hop (depth 0 entry + each recurse).
  if (await resolvesToPrivate(new URL(url).hostname)) {
    return { url, title: '', text: '', error: 'private-host-on-resolve' };
  }
  if (!isFetchableUrl(url)) {
    return { url, title: '', text: '', error: 'non-html-url' };
  }

  if (!canFetch()) {
    return { url, title: '', text: '', error: 'rate-limited' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // S-NEW-6: use 'manual' redirect mode so we can re-validate every hop.
    // With 'follow' (the previous setting), a 302 to 127.0.0.1 would silently
    // succeed. With 'manual', we get the 3xx response back and decide ourselves.
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NoxemResearch/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    clearTimeout(timeoutId);

    // Handle redirects manually — validate each Location header.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { url, title: '', text: '', error: 'redirect-missing-location' };
      }
      // cycle-4: resolve relative redirects against the current URL before
      // validating. Many 301/302 responses use a relative Location like
      // `/article` or `../login`, which `new URL(location)` would reject as
      // invalid (the previous isFetchableUrl check returned false), causing
      // valid same-origin redirects to be blocked.
      let nextUrl;
      try { nextUrl = new URL(location, url).toString(); }
      catch { return { url, title: '', text: '', error: 'redirect-bad-location' }; }
      if (!isFetchableUrl(nextUrl)) {
        return { url, title: '', text: '', error: 'redirect-blocked' };
      }
      // Recurse with the validated redirect target (depth-bounded to 3 to avoid loops)
      if (depth >= 3) {
        return { url, title: '', text: '', error: 'redirect-depth-exceeded' };
      }
      return fetchPage(nextUrl, { timeout, maxText, depth: depth + 1 });
    }

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
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x?([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
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
