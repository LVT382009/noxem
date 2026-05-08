import * as https from 'node:https';
import * as http from 'node:http';
import { parse as parseUrl } from 'node:url';
import { search as ddgScrapeSearch, SafeSearchType } from 'duck-duck-scrape';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      // Reject non-200 responses (e.g., 202 bot challenge, 429 rate limit)
      if (res.statusCode !== 200) {
        res.resume(); // drain the response
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
    console.error('[DDG] duck-duck-scrape failed, trying HTML fallback:', err.message);
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
          title: linkMatch[2].replace(/<[^>]+>/g, '').trim(),
          snippet: '',
        };
        continue;
      }

      // Match <td class='result-snippet'>snippet text</td>
      // The snippet content may span the next line, so capture generously
      const snippetMatch = line.match(
        /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i
      );
      if (snippetMatch && current) {
        const text = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text) current.snippet = text;
      }

      // Also try capturing snippet text on the next line after opening tag
      // e.g. <td class='result-snippet'>\n  actual text\n</td>
      if (current && !current.snippet) {
        const snippetOpen = line.match(/<td[^>]*class=['"]result-snippet['"][^>]*>/i);
        if (snippetOpen) {
          const afterTag = line.slice(snippetOpen.index + snippetOpen[0].length);
          const closingIdx = afterTag.indexOf('</td>');
          if (closingIdx > -1) {
            const text = afterTag.slice(0, closingIdx).replace(/<[^>]+>/g, '').trim();
            if (text) current.snippet = text;
          }
          // Otherwise the text is on the next line; will be caught on next iteration
          // by a line that has text content but no tags of interest, so we do a
          // catch-all below.
        }
      }

      // Catch-all: if we have a current result with no snippet yet, and this line
      // is plain text (no anchor or td tag), it might be the snippet text
      if (current && !current.snippet) {
        const stripped = line.replace(/<[^>]+>/g, '').trim();
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
    console.error('[DDG] HTML fallback search error:', err.message);
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
  const [instant, lite] = await Promise.all([
    searchDuckDuckGoInstant(query),
    searchDuckDuckGo(query, maxResults),
  ]);

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

  return results.slice(0, maxResults + 2);
}

// Format search results for LLM consumption
export function formatSearchResults(results) {
  if (!results || results.length === 0) return 'No search results found.';
  return results.map((r, i) => {
    if (r.type === 'abstract') return `[Abstract from ${r.title}]: ${r.snippet}`;
    if (r.type === 'answer') return `[Answer]: ${r.snippet}`;
    return `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`;
  }).join('\n\n');
}
