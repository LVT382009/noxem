#!/usr/bin/env node
/**
 * LLM Adapter — universal OpenAI-compatible API proxy.
 *
 * Supports two Brain 2 provider modes:
 * 1. **qwenproxy** — Proxies through QwenProxy (chat.qwen.ai scraper).
 *    QwenProxy only supports SSE streaming, so the adapter collects SSE
 *    for non-streaming requests and normalizes model names.
 * 2. **local** — Passes through directly to any OpenAI-compatible endpoint
 *    (Ollama, LM Studio, llama.cpp, etc.). No SSE buffering needed —
 *    local endpoints natively support both streaming and non-streaming.
 *
 * OpenAI-compatible base URL: http://127.0.0.1:{ADAPTER_PORT}/v1
 */

import { createServer } from 'http';

const BRAIN2_PROVIDER = (process.env.BRAIN2_PROVIDER || 'qwenproxy').toLowerCase();
const QWENPROXY_URL = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || process.env.LLM_URL || process.env.GEMMA_URL || '';
const ADAPTER_PORT = parseInt(process.env.LLM_PORT || process.env.GEMMA4_PORT || '8000');
const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Model normalization (QwenProxy only) ─────────────────────
// QwenProxy only accepts "qwen3.6-plus" or "qwen3.6-plus-no-thinking"
function normalizeModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  const m = requestedModel.toLowerCase();
  if (m.includes('thinking') && !m.includes('no-thinking')) return 'qwen3.6-plus';
  return 'qwen3.6-plus-no-thinking';
}

// ── Build upstream headers ────────────────────────────────────
function upstreamHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (LLM_API_KEY) h['Authorization'] = `Bearer ${LLM_API_KEY}`;
  return h;
}

// ── SSE collection (for QwenProxy non-streaming mode) ────────

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

async function collectSSE(url, bodyObj, timeoutMs = 60000) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  // M-NEW-6: Single AbortController per attempt that we abort on retry.
  // Previously each iteration created a fresh AbortSignal.timeout but the
  // previous request's response body was never consumed on the 429/502 retry
  // path — leaked TCP connections in the agent pool under sustained errors.
  //
  // cycle-6: keep the timeout active until the body is fully consumed.
  // The previous code cleared the timeout immediately after `await fetch(...)`
  // resolved, leaving `res.text()` (and the 429/502 retry drain) unprotected.
  // If the upstream sent headers and then stalled the body, `res.text()` would
  // hang with no abort path. Restructured so clearTimeout runs only AFTER
  // the body is consumed (or before a retry, after the drain).
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(new Error('upstream-timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: ac.signal,
    });

    if (!res.ok) {
      // M-NEW-6: drain the body before retrying so the underlying socket is
      // freed. The abort signal is still active here, so a stalled drain
      // throws AbortError which is caught by the outer catch and re-thrown.
      try { await res.text(); } catch (err) {
        if (err.name === 'AbortError') throw err;
        // Non-abort errors on drain are non-fatal; continue to the retry
        // decision below.
      }
      if ((res.status === 429 || res.status === 502) && attempt < MAX_RETRIES) {
        clearTimeout(timeoutId);
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.error(`[Adapter] ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`QwenProxy returned ${res.status}: ${res.statusText || 'unknown'}`);
    }

    let content = '';
    let reasoning = '';
    let model = DEFAULT_MODEL;
    let finishReason = 'stop';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Body read is protected by the same AbortController — a stalled body
    // (upstream sent headers but no data) will be aborted at timeoutMs.
    const text = await res.text();
    // Body fully consumed — safe to clear the timeout now.
    clearTimeout(timeoutId);

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const chunk = JSON.parse(trimmed.slice(6));
        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (delta.content) content += delta.content;
          // Handle both QwenProxy (reasoning_content) and Ollama (thinking) fields
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.thinking) reasoning += delta.thinking;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      } catch { /* skip malformed lines */ }
    }

    if (!content && reasoning) content = reasoning;

    return { content, reasoning, model, finishReason, usage };
  } catch (err) {
    // cycle-6: clear the timeout on any exit path (success, abort, or
    // error) to prevent a late-fire from corrupting a future request.
    clearTimeout(timeoutId);
    throw err;
  }
  } // end retry loop
}

// ── SSE streaming passthrough ─────────────────────────────────

async function streamSSE(upstreamUrl, bodyObj, clientRes, headers, timeoutMs = 120000) {
  // M-NEW-5: Wire an AbortController to the client response so we cancel the
  // upstream fetch as soon as the client disconnects. Previously the upstream
  // fetch kept running until the LLM finished, wasting compute and bandwidth.
  const abortController = new AbortController();
  // cycle-5: apply timeoutMs to the upstream lifecycle. Previously the
  // parameter was accepted but never used — a stalled upstream that kept
  // the client socket open would hang this request forever. The same
  // AbortController is shared so client-close AND timeout both abort.
  const timeoutId = setTimeout(() => abortController.abort(new Error('stream-timeout')), timeoutMs);
  let clientClosed = false;
  const onClientClose = () => {
    clientClosed = true;
    abortController.abort();
  };
  // 'close' fires for both abrupt disconnect and normal end-of-stream
  clientRes.once('close', onClientClose);

  // cycle-4: wrap the initial fetch in try/catch so an AbortError raised
  // while the upstream is still resolving doesn't escape and get re-thrown
  // to a caller whose socket has already closed. Previously the abort-aware
  // catch only wrapped reader.read(), so a client disconnect during the
  // initial fetch() left the request hanging.
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: abortController.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError' && clientClosed) {
      return; // expected — client disconnected
    }
    throw err;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    clientRes.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${text.substring(0, 300)}`, type: 'upstream_error' } }));
  }

  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Guard against writing after the client disconnected
      if (clientClosed) {
        try { await reader.cancel(); } catch {}
        break;
      }
      clientRes.write(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (err.name === 'AbortError' && clientClosed) {
      // Expected — client disconnected, we aborted. Don't log as an error.
    } else {
      LOG_DEBUG && console.error(`[llm-adapter] Stream error: ${err.message}`);
    }
  } finally {
    // Detach the close listener to avoid leaks
    clientRes.off('close', onClientClose);
    // cycle-5: clear the timeout to prevent a late-fire from aborting a
    // request that already completed cleanly.
    clearTimeout(timeoutId);
    if (!clientRes.writableEnded) {
      try { clientRes.end(); } catch {}
    }
  }
}

// ── Read request body ────────────────────────────────────────

// S-NEW-5: readBody must enforce a size limit to prevent OOM/DoS. Previously
// this concatenated chunks with no cap — an attacker could stream gigabytes.
// Default cap is 2 MB, matching the express.json limit on gemma4-server.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        // cycle-6: do NOT call req.destroy() here. Previously the destroy
        // tore down the socket before the caller could send an HTTP 413
        // response — the client just saw ECONNRESET. Instead, mark aborted
        // and reject; the caller's catch block (in /v1/chat/completions)
        // will write a proper 413 response, which causes Node's HTTP
        // server to close the connection cleanly. Memory safety is still
        // preserved: the 'data' handler returns early for subsequent
        // chunks, so the body string stops growing.
        reject(Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`), { statusCode: 413, code: 'BODY_TOO_LARGE' }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => { if (!aborted) resolve(body); });
    req.on('error', err => { if (!aborted) reject(err); });
  });
}

// ── Determine upstream URL based on provider mode ─────────────

function getUpstreamUrl(path) {
  if (BRAIN2_PROVIDER === 'local' && LOCAL_LLM_URL) {
    // For local mode, strip /v1 prefix from LOCAL_LLM_URL if present, since path already includes it
    const base = LOCAL_LLM_URL.replace(/\/v1\/?$|\/v1\/chat\/completions\/?$/i, '');
    return `${base}${path}`;
  }
  return `${QWENPROXY_URL}${path}`;
}

// ── HTTP server ──────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://127.0.0.1:${ADAPTER_PORT}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    const upstreamBase = BRAIN2_PROVIDER === 'local' && LOCAL_LLM_URL
      ? LOCAL_LLM_URL.replace(/\/v1\/?$|\/v1\/chat\/completions\/?$/i, '')
      : QWENPROXY_URL;
    const healthPath = BRAIN2_PROVIDER === 'local' ? '/v1/models' : '/health';
    try {
      const qp = await fetch(`${upstreamBase}${healthPath}`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      const qpData = await qp.json().catch(() => ({}));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ready: true, provider: BRAIN2_PROVIDER, upstreamHealth: qpData }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ready: false, provider: BRAIN2_PROVIDER, upstreamHealth: 'unreachable' }));
    }
  }

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const upstreamBase = BRAIN2_PROVIDER === 'local' && LOCAL_LLM_URL
      ? LOCAL_LLM_URL.replace(/\/v1\/?$|\/v1\/chat\/completions\/?$/i, '')
      : QWENPROXY_URL;
    try {
      const qp = await fetch(`${upstreamBase}/v1/models`, {
        headers: upstreamHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      const data = await qp.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch {
      // Fallback model list
      const models = BRAIN2_PROVIDER === 'qwenproxy'
        ? [
            { id: 'qwen3.6-plus', object: 'model', created: Date.now(), owned_by: 'qwen' },
            { id: 'qwen3.6-plus-no-thinking', object: 'model', created: Date.now(), owned_by: 'qwen' },
          ]
        : [
            { id: DEFAULT_MODEL, object: 'model', created: Date.now(), owned_by: 'local' },
          ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models }));
    }
  }

  // POST /v1/chat/completions
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    // cycle-6: catch BODY_TOO_LARGE rejections from readBody() and return
    // an HTTP 413 JSON response. Previously the rejection propagated out to
    // the generic outer catch which only logged a debug message and
    // returned a 200 [LLM unavailable] fallback — clients never saw the
    // proper status code.
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err?.code === 'BODY_TOO_LARGE' || err?.statusCode === 413) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'body_too_large' } }));
        }
        // Destroy the request stream so a malicious client can't keep
        // streaming the rest of the oversized body. readBody() rejected
        // without calling req.destroy() so the response above could be
        // sent cleanly first.
        if (!req.destroyed) req.destroy();
        return;
      }
      throw err;
    }

    let reqObj;
    try { reqObj = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
    }

    const wantStream = reqObj.stream === true;
    const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '120000');

    LOG_DEBUG && console.error(`[llm-adapter] POST /v1/chat/completions provider=${BRAIN2_PROVIDER} model=${reqObj.model} stream=${wantStream}`);

    try {
      if (BRAIN2_PROVIDER === 'local' && LOCAL_LLM_URL) {
        // ── Local mode: pass through directly ──────────────────
        // Local endpoints (Ollama, LM Studio, llama.cpp) natively
        // support both streaming and non-streaming. No SSE buffering needed.
        const upstreamUrl = LOCAL_LLM_URL.includes('/v1/chat/completions')
          ? LOCAL_LLM_URL
          : `${LOCAL_LLM_URL.replace(/\/+$/, '')}/v1/chat/completions`;

        if (wantStream) {
          return await streamSSE(upstreamUrl, reqObj, res, upstreamHeaders(), timeoutMs);
        } else {
          // Non-streaming: forward directly, get JSON back
          const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify({ ...reqObj, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!upstreamRes.ok) {
            const text = await upstreamRes.text().catch(() => '');
            throw new Error(`Local LLM returned ${upstreamRes.status}: ${text.substring(0, 500)}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(await upstreamRes.json()));
        }
      } else {
        // ── QwenProxy mode: SSE bridge ─────────────────────────
        // QwenProxy only supports streaming. For non-streaming requests,
        // we buffer SSE and return a single JSON response.
        const model = normalizeModel(reqObj.model);
        const proxyBody = { ...reqObj, model, stream: true };
        const upstreamUrl = `${QWENPROXY_URL}/v1/chat/completions`;

        if (wantStream) {
          return await streamSSE(upstreamUrl, proxyBody, res, { 'Content-Type': 'application/json' }, timeoutMs);
        } else {
          const result = await collectSSE(upstreamUrl, proxyBody, timeoutMs);
          const response = {
            id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: result.model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: result.content,
                ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
              },
              finish_reason: result.finishReason,
            }],
            usage: result.usage,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(response));
        }
      }
    } catch (err) {
      LOG_DEBUG && console.error(`[llm-adapter] Error: ${err.message}`);
      const fallback = {
        id: `chatcmpl-fallback-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: reqObj.model || DEFAULT_MODEL,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '[LLM unavailable]' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(fallback));
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

server.listen(ADAPTER_PORT, '127.0.0.1', () => {
  const mode = BRAIN2_PROVIDER === 'local' ? `local (${LOCAL_LLM_URL})` : `qwenproxy (${QWENPROXY_URL})`;
  console.log(`[llm-adapter] Listening on http://127.0.0.1:${ADAPTER_PORT}`);
  console.log(`[llm-adapter] Provider: ${mode}`);
  console.log(`[llm-adapter] Default model: ${DEFAULT_MODEL}`);
  console.log(`[llm-adapter] OpenAI base URL: http://127.0.0.1:${ADAPTER_PORT}/v1`);
});

// Graceful shutdown
function shutdown() {
  LOG_DEBUG && console.error('[llm-adapter] Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
