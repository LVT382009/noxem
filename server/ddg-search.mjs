import * as https from 'node:https';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
import * as http from 'node:http';
import * as dns from 'node:dns/promises';
import { parse as parseUrl } from 'node:url';
import { search as ddgScrapeSearch, SafeSearchType } from 'duck-duck-scrape';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// S-#49: Private IP ranges for SSRF protection
const PRIVATE_IP_RANGES = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./, /^\[?::1\]?/, /^\[?fe80:/i, /^\[?fc00:/i];

function isPrivateIp(ip) {
  return PRIVATE_IP_RANGES.some(r => r.test(ip));
}

function isPrivateUrl(urlStr) {
  try {
    const parsed = parseUrl(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  const hostname = parsed.hostname || '';
  // Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x) and strip brackets
  const ipv4mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const checkHost = ipv4mapped ? ipv4mapped[1] : hostname.replace(/[\[\]]/g, '');
  return isPrivateIp(checkHost);
  } catch { return true; }
}

async function isPrivateUrlAfterDns(urlStr) {
  if (isPrivateUrl(urlStr)) return true;
  try {
    const parsed = parseUrl(urlStr);
    const hostname = parsed.hostname || '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return isPrivateIp(hostname);
    const addresses = await dns.resolve4(hostname);
    return addresses.some(ip => isPrivateIp(ip));
  } catch { return true; }
}

async function fetchUrl(url, timeout = 10000, maxRedirects = 5, originalUrl = null) {
  if (maxRedirects <= 0) throw new Error('Too many redirects');
  // S-#32: Resolve relative redirect URLs against original
  if (originalUrl && !url.startsWith('http')) {
    const base = parseUrl(originalUrl);
    url = `${base.protocol}//${base.host}${url.startsWith('/') ? url : '/' + url}`;
  }
  // S-#49: SSRF protection with DNS rebinding check
  if (await isPrivateUrlAfterDns(url)) throw new Error('Blocked: private/internal URL');

  return new Promise((resolve, reject) => {
    let settled = false;
    const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };
    const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
    const parsed = parseUrl(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout,
    }, (res) => {
      // Follow redirects (with depth limit) — S-#32: pass original URL for relative resolution
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const location = res.headers.location;
        res.resume();
        return fetchUrl(location, timeout, maxRedirects - 1, url).then(safeResolve).catch(safeReject);
      }
      // Reject non-200 responses (e.g., 202 bot challenge, 429 rate limit)
      if (res.statusCode !== 200) {
        res.resume(); // drain the response
        return safeReject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => safeResolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', safeReject);
    req.on('timeout', () => { req.destroy(); safeReject(new Error('timeout')); });
  });
}

/** Decode a DDG redirect URL like //duckduckgo.com/l/?uddg=<encoded>&rut=... */
function decodeDdgRedirect(url) {
  if (url.includes('uddg=')) {
    try {
      const decoded = decodeURIComponent(url.split('uddg=')[1]?.split('&')[0] || url);
      if (decoded.startsWith('http')) return decoded;
    } catch { /* keep original */ }
  }
  // Prepend https: if protocol-relative
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

// S-#41: Basic HTML entity decoder
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// Search DDG using duck-duck-scrape npm package, fall back to HTML scraping
export async function searchDuckDuckGo(query, maxResults = 5) {
  // Primary: duck-duck-scrape npm package
  try {
    const results = await ddgScrapeSearch(query, {
      safeSearch: SafeSearchType.MODERATE,
      region: 'wt-wt',
    });
    if (results?.results?.length) {
      // Filter out DDG ad URLs before slicing
      const filtered = results.results.filter(r => !r.url?.includes('duckduckgo.com/y.js'));
      return filtered.slice(0, maxResults).map(r => ({
        title: r.title || '',
        url: r.url || '',
        snippet: (r.description || r.rawDescription || '')
          .replace(/<\/?b>/g, '')
          .substring(0, 300),
      }));
    }
  } catch (err) {
    LOG_DEBUG && console.error('[DDG] duck-duck-scrape failed, trying HTML fallback:', err.message);
  }

  // Fallback: HTML scraping of lite.duckduckgo.com
  try {
    const html = await fetchUrl(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
    );
    const results = [];
    const lines = html.split('\n');
    let current = null;

    for (const line of lines) {
      // S-#33: Early break when we have enough results
      if (results.length >= maxResults && !current) break;

      // Match <a ... class='result-link' ...>Title</a> (DDG lite uses single quotes)
      const linkMatch = line.match(
        /<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i
      ) || line.match(
        /<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/i
      );

      if (linkMatch) {
        if (current) results.push(current);
        current = {
          url: decodeDdgRedirect(linkMatch[1]),
          title: decodeHtmlEntities(linkMatch[2].replace(/<[^>]+>/g, '').trim()), // S-#41
          snippet: '',
        };
        continue;
      }

      // Match <td class='result-snippet'>snippet text</td>
      const snippetMatch = line.match(
        /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i
      );
      if (snippetMatch && current) {
        const text = decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '').trim()); // S-#41
        if (text) current.snippet = text;
      }

      // Also try capturing snippet text on the next line after opening tag
      if (current && !current.snippet) {
        const snippetOpen = line.match(/<td[^>]*class=['"]result-snippet['"][^>]*>/i);
        if (snippetOpen) {
          const afterTag = line.slice(snippetOpen.index + snippetOpen[0].length);
          const closingIdx = afterTag.indexOf('</td>');
          if (closingIdx > -1) {
            const text = decodeHtmlEntities(afterTag.slice(0, closingIdx).replace(/<[^>]+>/g, '').trim());
            if (text) current.snippet = text;
          }
        }
      }

      // Catch-all: if we have a current result with no snippet yet, and this line
      // is plain text (no anchor or td tag), it might be the snippet text
      if (current && !current.snippet) {
        const stripped = decodeHtmlEntities(line.replace(/<[^>]+>/g, '').trim());
        if (stripped.length > 20 && stripped.length < 500 && !stripped.includes('result-link')) {
          current.snippet = stripped;
        }
      }
    }
    if (current) results.push(current);

    // Filter out DDG ad URLs (duckduckgo.com/y.js ad redirects)
    const filtered = results.filter(r => !r.url.includes('duckduckgo.com/y.js'));

    return filtered.slice(0, maxResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet?.substring(0, 300) || '',
    }));
  } catch (err) {
    LOG_DEBUG && console.error('[DDG] HTML fallback search error:', err.message);
    return [];
  }
}

// Instant Answer API (for definitions, facts, etc)
export async function searchDuckDuckGoInstant(query) {
  try {
    const json = await fetchUrl(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
    );
    const data = JSON.parse(json);
    return {
      abstract: data.AbstractText || '',
      source: data.AbstractSource || '',
      infobox: data.Infobox || null,
      answer: data.Answer || '',
      results: (data.Results || []).map(r => ({
        title: r.Text || '',
        url: r.FirstURL || '',
      })),
    };
  } catch {
    return { abstract: '', source: '', infobox: null, answer: '', results: [] };
  }
}

// Combined search: try instant answer first, fall back to lite
export async function searchWeb(query, maxResults = 5) {
  // S-#50: Use Promise.allSettled to preserve partial results
  const [instantResult, liteResult] = await Promise.allSettled([
    searchDuckDuckGoInstant(query),
    searchDuckDuckGo(query, maxResults),
  ]);

  const instant = instantResult.status === 'fulfilled' ? instantResult.value : { abstract: '', source: '', infobox: null, answer: '', results: [] };
  const lite = liteResult.status === 'fulfilled' ? liteResult.value : [];

  const results = [];
  if (instant.abstract) {
    results.push({
      type: 'abstract',
      title: instant.source,
      snippet: instant.abstract,
      url: '',
    });
  }
  if (instant.answer) {
    results.push({
      type: 'answer',
      title: 'Direct Answer',
      snippet: instant.answer,
      url: '',
    });
  }
  for (const r of lite) {
    results.push({ type: 'link', ...r });
  }

  return results.slice(0, maxResults); // S-#34: respect maxResults, not +2
}

// Format search results for LLM consumption
export function formatSearchResults(results) {
  if (!results || results.length === 0) return 'No search results found.';
  return results.map((r, i) => {
    if (r.type === 'abstract') return `[Abstract from ${r.title}]: ${r.snippet}`;
    if (r.type === 'answer') return `[Answer]: ${r.snippet}`;
    return `[${i + 1}] ${r.title}\n URL: ${r.url}\n ${r.snippet}`;
  }).join('\n\n');
}
