/**
 * Shared LLM fetch helper — adds Authorization header when LLM_API_KEY is set.
 * All code that calls an LLM endpoint should use this instead of raw fetch().
 */

function _getApiKey() { return process.env.LLM_API_KEY || ''; }

export function llmHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (_getApiKey()) h['Authorization'] = `Bearer ${_getApiKey()}`;
  return h;
}

export function llmFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: llmHeaders(opts.headers || {}) });
}
