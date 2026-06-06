#!/usr/bin/env node
/**
 * LLM Adapter — universal OpenAI-compatible API proxy.
 *
 * Supports two Brain 2 provider modes:
 * 1. **qwenproxy** — Proxies through QwenProxy (chat.qwen.ai scraper).
 *    QwenProxy only supports SSE streaming, so the adapter collects SSE
 *    for non-streaming requests and normalizes model names.
 *    When conversation payload exceeds FILE_ATTACH_THRESHOLD, it auto-uploads
 *    the conversation as a .txt file attachment to bypass prompt size limits.
 * 2. **local** — Passes through directly to any OpenAI-compatible endpoint
 *    (Ollama, LM Studio, llama.cpp, etc.). No SSE buffering needed —
 *    local endpoints natively support both streaming and non-streaming.
 *
 * OpenAI-compatible base URL: http://127.0.0.1:{ADAPTER_PORT}/v1
 */

import { createServer } from 'http';
import { LLM_API_KEY as _CONFIG_API_KEY, LLM_MODEL as _CONFIG_MODEL } from './llm-config.mjs';

const BRAIN2_PROVIDER = (process.env.BRAIN2_PROVIDER || 'qwenproxy').toLowerCase();
const QWENPROXY_URL = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || process.env.LLM_URL || process.env.GEMMA_URL || '';
const ADAPTER_PORT = parseInt(process.env.LLM_PORT || process.env.GEMMA4_PORT || '8000');
const DEFAULT_MODEL = _CONFIG_MODEL;
const LLM_API_KEY = _CONFIG_API_KEY;
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Model normalization (QwenProxy only) ──────────────────
function normalizeModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  const m = requestedModel.toLowerCase();
  if (m.includes('thinking') && !m.includes('no-thinking')) return 'qwen3.6-plus';
  return 'qwen3.6-plus-no-thinking';
}

// ── Build upstream headers ────────────────────────────────
function sanitizeErrorText(text) {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function upstreamHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (LLM_API_KEY) h['Authorization'] = `Bearer ${LLM_API_KEY}`;
  return h;
}

// ── SSE collection (for QwenProxy non-streaming mode) ─────

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

async function collectSSE(url, bodyObj, timeoutMs = 60000) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(),
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
      throw new Error(`QwenProxy returned ${res.status}: ${sanitizeErrorText(text.substring(0, 500))}`);
    }

    let content = '';
    let reasoning = '';
    let model = DEFAULT_MODEL;
    let finishReason = 'stop';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        let value = trimmed.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        const chunk = JSON.parse(value);
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

    if (!content && reasoning) { content = reasoning; reasoning = ''; }

    return { content, reasoning, model, finishReason, usage };
  }
}

// ── SSE streaming passthrough ──────────────────────────────

async function streamSSE(upstreamUrl, bodyObj, clientRes, headers, timeoutMs = 120000) {
  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!upstream.ok) {
    let errText = '';
    try {
      const reader = upstream.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        errText = new TextDecoder().decode(value || new Uint8Array()).substring(0, 300);
        reader.cancel();
      }
    } catch { errText = upstream.statusText || ''; }
    clientRes.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ error: { message: `Upstream error: ${sanitizeErrorText(errText)}`, type: 'upstream_error' } }));
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

// ── File upload for large conversations ──────────────────

const MAX_REQUEST_BODY_SIZE = 1_048_576; // 1 MiB
const FILE_ATTACH_THRESHOLD = 100_000; // Upload as file when messages > 100KB

async function uploadConversationAsFile(messagesText) {
  const filename = `conversation-${Date.now()}.txt`;
  const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
  const CRLF = '\r\n';
  const header = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: text/plain${CRLF}${CRLF}`;
  const footer = `${CRLF}--${boundary}--${CRLF}`;
  const payload = Buffer.concat([
    Buffer.from(header, 'utf8'),
    Buffer.from(messagesText, 'utf8'),
    Buffer.from(footer, 'utf8'),
  ]);
  const uploadUrl = `${QWENPROXY_URL}/v1/files/upload`;
  const hdrs = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (LLM_API_KEY) hdrs['Authorization'] = `Bearer ${LLM_API_KEY}`;
  try {
    const res = await fetch(uploadUrl, { method: 'POST', headers: hdrs, body: payload, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const json = await res.json();
    LOG_DEBUG && console.error(`[llm-adapter] File uploaded: id=${json.id} name=${json.name} size=${json.size}`);
    return json;
  } catch (err) {
    LOG_DEBUG && console.error(`[llm-adapter] File upload failed: ${err.message}`);
    return null;
  }
}

// ── Read request body ──────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── Determine upstream URL based on provider mode ──────────

function getUpstreamUrl(path) {
  if (BRAIN2_PROVIDER === 'local' && LOCAL_LLM_URL) {
    const base = LOCAL_LLM_URL.replace(/\/v1\/?$|\/v1\/chat\/completions\/?$/i, '');
    return `${base}${path}`;
  }
  return `${QWENPROXY_URL}${path}`;
}

// ── HTTP server ────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigins = ['http://127.0.0.1', 'http://localhost', 'http://127.0.0.1:' + ADAPTER_PORT, 'http://localhost:' + ADAPTER_PORT];
  if (origin && allowedOrigins.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
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
    const body = await readBody(req);

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
        // ── Local mode: pass through directly ──────────
        const upstreamUrl = LOCAL_LLM_URL.includes('/v1/chat/completions')
          ? LOCAL_LLM_URL
          : `${LOCAL_LLM_URL.replace(/\/+$/, '')}/v1/chat/completions`;

        if (wantStream) {
          return await streamSSE(upstreamUrl, reqObj, res, upstreamHeaders(), timeoutMs);
        } else {
          const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify({ ...reqObj, stream: false }),
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!upstreamRes.ok) {
            const text = await upstreamRes.text().catch(() => '');
            throw new Error(`Local LLM returned ${upstreamRes.status}: ${sanitizeErrorText(text.substring(0, 500))}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(await upstreamRes.json()));
        }
      } else {
        // ── QwenProxy mode: SSE bridge ─────────────────
        const model = normalizeModel(reqObj.model);

        // Auto-attach large conversations as files to bypass prompt size limits
        const bodySize = Buffer.byteLength(JSON.stringify(reqObj.messages || []), 'utf8');
        let proxyBody;
        if (bodySize > FILE_ATTACH_THRESHOLD && reqObj.messages?.length > 2) {
          const systemMsgs = reqObj.messages.filter(m => m.role === 'system');
          const convoMsgs = reqObj.messages.filter(m => m.role !== 'system');
          const convoText = convoMsgs.map(m => m.role.toUpperCase() + ': ' + (m.content || '')).join('\n\n');
          const uploadResult = await uploadConversationAsFile(convoText);
          if (uploadResult?.id) {
            const refMsg = { role: 'user', content: 'I have attached a file containing the full conversation. Please read it and refer to it for context.' };
            proxyBody = { ...reqObj, model, stream: true, messages: [...systemMsgs, refMsg], file_ids: [uploadResult.id] };
            LOG_DEBUG && console.error(`[llm-adapter] Conversation attached as file (id=${uploadResult.id}, ${Math.round(convoText.length / 1024)}KB)`);
          } else {
            proxyBody = { ...reqObj, model, stream: true };
          }
        } else {
          proxyBody = { ...reqObj, model, stream: true };
        }
        const upstreamUrl = `${QWENPROXY_URL}/v1/chat/completions`;

        if (wantStream) {
          return await streamSSE(upstreamUrl, proxyBody, res, upstreamHeaders(), timeoutMs);
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
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `LLM unavailable: ${err.message}`, type: 'upstream_error' } }));
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

// BUG-23: Protect against slowloris attacks with request/header timeouts
server.requestTimeout = 30000;
server.headersTimeout = 31000;

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
