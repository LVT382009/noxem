import * as https from 'node:https';
import * as http from 'node:http';
import { parse as parseUrl } from 'node:url';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Search DDG Lite (HTML-based, no API key needed)
export async function searchDuckDuckGo(query, maxResults = 5) {
  try {
    const html = await fetchUrl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
    const results = [];
    // Parse HTML table rows
    const rowRegex = /<tr[^>]*>[\s\S]*?<td[^>]*class=["']result-snippet["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class=["']snippet["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    // Simpler: parse by splitting on result rows
    const lines = html.split('\n');
    let current = null;

    for (const line of lines) {
      const linkMatch = line.match(/<a[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) {
        if (current) results.push(current);
        current = {
          url: linkMatch[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, ''), // clean redirect URLs
          title: linkMatch[2].replace(/<[^>]+>/g, '').trim(),
          snippet: '',
        };
        // Decode URL if it's a redirect
        if (current.url.includes('uddg=')) {
          try {
            current.url = decodeURIComponent(current.url.split('uddg=')[1]?.split('&')[0] || current.url);
          } catch { /* keep original */ }
        }
      }
      const snippetMatch = line.match(/<td[^>]*class="snippet"[^>]*>([\s\S]*?)<\/td>/i);
      if (snippetMatch && current) {
        current.snippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
      }
    }
    if (current) results.push(current);

    return results.slice(0, maxResults).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet?.substring(0, 300) || '',
    }));
  } catch (err) {
    console.error('DDG search error:', err.message);
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
    return `[${i + 1}] ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`;
  }).join('\n\n');
}