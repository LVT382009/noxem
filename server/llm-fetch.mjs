/**
 * Shared LLM fetch helper — Authorization header, retry on 429/502, timeout, and prompt size guard.
 *
 * All code that calls an LLM endpoint should use this instead of raw fetch().
 */

import { LLM_API_KEY, MAX_PROMPT_BYTES } from './llm-config.mjs';

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

function _getApiKey() { return LLM_API_KEY; }

export function llmHeaders(extra = {}) {
  const extraObj = extra instanceof Headers ? Object.fromEntries(extra.entries()) : extra;
  const h = { 'Content-Type': 'application/json', ...extraObj };
  if (_getApiKey() && !h['Authorization']) h['Authorization'] = `Bearer ${_getApiKey()}`;
  return h;
}

/**
 * Truncate messages to fit within MAX_PROMPT_BYTES.
 * Removes oldest user/assistant messages first, keeps system messages.
 */
function _enforceSizeLimit(bodyStr) {
  if (Buffer.byteLength(bodyStr, 'utf8') <= MAX_PROMPT_BYTES) return bodyStr;

  let obj;
  try { obj = JSON.parse(bodyStr); } catch { return bodyStr; }

  const messages = obj.messages;
  if (!Array.isArray(messages)) return bodyStr;

  // Keep truncating oldest non-system messages until under limit
  while (Buffer.byteLength(JSON.stringify(obj), 'utf8') > MAX_PROMPT_BYTES) {
    const idx = messages.findIndex(m => m.role !== 'system');
    if (idx === -1) break;
    const removed = messages.splice(idx, 1)[0];
    LOG_DEBUG && console.warn(`[llm-fetch] Prompt size >${MAX_PROMPT_BYTES}B — dropped ${removed.role} message (${(removed.content || '').length} chars)`);
  }

  // If still over, truncate each remaining message content
  for (const m of messages) {
    if (typeof m.content === 'string' && m.content.length > 2000) {
      m.content = m.content.substring(0, 2000) + '\n[truncated]';
    }
  }

  const result = JSON.stringify(obj);
  if (Buffer.byteLength(result, 'utf8') > MAX_PROMPT_BYTES) {
    LOG_DEBUG && console.error(`[llm-fetch] Prompt still exceeds ${MAX_PROMPT_BYTES}B after truncation`);
  }
  return result;
}

/**
 * LLM fetch with retry (429/502), timeout, and prompt size guard.
 *
 * @param {string} url
 * @param {RequestInit & { signal?: AbortSignal }} opts
 * @param {{ timeoutMs?: number, maxRetries?: number, enforceSizeLimit?: boolean }} [rpcOpts]
 */
export function llmFetch(url, opts = {}, rpcOpts = {}) {
  const timeoutMs = rpcOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = rpcOpts.maxRetries ?? MAX_RETRIES;
  const enforceSizeLimit = rpcOpts.enforceSizeLimit !== false; // default true

  const headers = llmHeaders(opts.headers || {});
  let body = opts.body;
  if (typeof body === 'string' && enforceSizeLimit) {
    body = _enforceSizeLimit(body);
  }

  const signal = opts.signal;

  return _fetchWithRetry(url, {
    ...opts,
    headers,
    body,
    signal: _mergedSignal(signal, timeoutMs),
  }, maxRetries, timeoutMs, signal);
}

// Merge the caller's AbortSignal with a fresh per-call timeout. AbortSignal is single-use, so a
// fresh timeout is created on EVERY call (and every retry); AbortSignal.any (Node 20.3+, stable
// on Node 22) propagates the caller's external abort onto the merged signal. FIX: retries
// previously rebuilt a bare `AbortSignal.timeout(timeoutMs)`, dropping any caller-supplied
// signal — a caller that aborted would NOT abort retries. With no caller signal the merge
// collapses to the bare timeout (same as prior behavior).
function _mergedSignal(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

async function _fetchWithRetry(url, opts, retriesLeft, timeoutMs, callerSignal) {
  try {
    const res = await fetch(url, opts);

    if ((res.status === 429 || res.status === 502) && retriesLeft > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, MAX_RETRIES - retriesLeft);
      LOG_DEBUG && console.warn(`[llm-fetch] ${res.status} — retry (${retriesLeft} left) in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));

      // Re-create the merged signal for the retry (per-call timeout is single-use); the caller's
      // signal threads through `callerSignal` so an external abort still propagates.
      const retryOpts = { ...opts, signal: _mergedSignal(callerSignal, timeoutMs) };
      return _fetchWithRetry(url, retryOpts, retriesLeft - 1, timeoutMs, callerSignal);
    }

    return res;
  } catch (err) {
    if (retriesLeft > 0 && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      LOG_DEBUG && console.warn(`[llm-fetch] ${err.name} — retry (${retriesLeft} left)`);
      const retryOpts = { ...opts, signal: _mergedSignal(callerSignal, timeoutMs) };
      return _fetchWithRetry(url, retryOpts, retriesLeft - 1, timeoutMs, callerSignal);
    }
    throw err;
  }
}
