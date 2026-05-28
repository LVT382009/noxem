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
import { URL } from 'url';

const BRAIN2_PROVIDER = (process.env.BRAIN2_PROVIDER || 'qwenproxy').toLowerCase();
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || process.env.LLM_URL || process.env.GEMMA_URL || '';
const ADAPTER_PORT = parseInt(process.env.LLM_PORT || process.env.GEMMA4_PORT || '8000');
const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// H-1/H-2: Validate QWENPROXY_URL at startup — reject non-local targets.
// QwenProxy mode proxies user messages externally; the upstream must be localhost.
const QWENPROXY_URL_RAW = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';
let QWENPROXY_URL = QWENPROXY_URL_RAW;
if (BRAIN2_PROVIDER === 'qwenproxy') {
  try {
    const parsed = new URL(QWENPROXY_URL_RAW);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1' && parsed.hostname !== '::') {
      throw new Error(`QWENPROXY_URL must resolve to localhost, got "${parsed.hostname}". Set QWENPROXY_URL=http://127.0.0.1:3000`);
    }
    QWENPROXY_URL = parsed.origin; // normalise to origin only
  } catch (err) {
    console.error(`[llm-adapter] FATAL: Invalid QWENPROXY_URL: ${err.message}`);
    process.exit(1);
  }
}

// H-1: Per-request content-size limit to prevent proxying arbitrarily large payloads
const MAX_REQUEST_CONTENT_SIZE = parseInt(process.env.MAX_REQUEST_CONTENT_SIZE || '32768'); // 32 KB

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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if ((res.status === 429 || res.status === 502) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      console.error(`[Adapter] ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    throw new Error(`QwenProxy returned ${res.status}: ${text.substring(0, 500)}`);
  }

  let content = '';
  let reasoning = '';
  let model = DEFAULT_MODEL;
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const text = await res.text();
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
  } // end retry loop
}

// Parse SSE from an already-fetched Response object (avoids double-POST).
async function collectSSEResponse(res) {
  let content = '';
  let reasoning = '';
  let model = DEFAULT_MODEL;
  let finishReason = 'stop';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const text = await res.text();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') continue;
    if (!trimmed.startsWith('data: ')) continue;

    try {
      const chunk = JSON.parse(trimmed.slice(6));
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) content += delta.content;
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
}

// ── SSE streaming passthrough ─────────────────────────────────

async function streamSSE(upstreamUrl, bodyObj, clientRes, headers, timeoutMs = 120000) {
  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });

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
      clientRes.write(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    LOG_DEBUG && console.error(`[llm-adapter] Stream error: ${err.message}`);
  } finally {
    clientRes.end();
  }
}

// ── Read request body ────────────────────────────────────────
// H-1: Hard size cap independent of Content-Length header.
// Prevents a misbehaving client from declaring a small header but sending unbounded data.
const MAX_READ_SIZE = 10_485_760; // 10 MiB hard cap on body accumulation

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejecting = false;
    req.on('data', chunk => {
      body += chunk;
      size += chunk.length;
      if (size > MAX_READ_SIZE && !rejecting) {
        rejecting = true;
        req.destroy();
        reject(new Error(`Request body exceeds hard cap of ${MAX_READ_SIZE} bytes`));
      }
      // Also hard-cap individual chunk to prevent a single giant chunk inflating memory
      if (chunk.length > MAX_READ_SIZE) {
        if (!rejecting) { rejecting = true; req.destroy(); reject(new Error('Chunk oversized')); }
      }
    });
    req.on('end', () => { if (!rejecting) resolve(body); });
    req.on('error', reject);
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
    const rawBody = await readBody(req);

    // H-1: Reject oversized payloads before parsing
    if (rawBody.length > MAX_REQUEST_CONTENT_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: { message: `Request body too large (${rawBody.length} bytes, max ${MAX_REQUEST_CONTENT_SIZE})`, type: 'max_tokens_exceeded' }
      }));
    }

    let reqObj;
    try { reqObj = JSON.parse(rawBody); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
    }

    // H-1: Validate message structure — extract text from multipart content, reject non-text modalities.
    if (reqObj.messages) {
      for (const msg of reqObj.messages) {
        if (msg.content != null && typeof msg.content !== 'string') {
          // Array content (multi-modal) — extract text parts, ignore images/audio/etc.
          if (Array.isArray(msg.content)) {
            msg.content = msg.content
              .map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') return part.text;
                return null;
              })
              .filter(part => part !== null)
              .join('\n');
          }
          if (typeof msg.content !== 'string') {
            msg.content = String(msg.content);
          }
        }
      }
    }

    // H-1: Cap max_tokens to a safe bound
    if (reqObj.max_tokens == null || reqObj.max_tokens > 8192) {
      reqObj.max_tokens = 8192;
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
          // H-2: Reject non-SSE responses by checking Content-Type before collecting
          const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
          });
          if (!upstreamRes.ok) {
            const errText = await upstreamRes.text().catch(() => '');
            throw new Error(`QwenProxy returned ${upstreamRes.status} ${upstreamRes.statusText}: ${errText.substring(0, 500)}`);
          }
          const ct = upstreamRes.headers.get('content-type') || '';
          if (!ct.includes('text/event-stream') && !ct.includes('stream')) {
            const text = await upstreamRes.text().catch(() => '');
            throw new Error(`QwenProxy returned non-SSE response (${ct}): ${text.substring(0, 300)}`);
          }
          // Parse the already-fetched response instead of issuing a second POST
          const result = await collectSSEResponse(upstreamRes);
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
