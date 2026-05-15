#!/usr/bin/env node
/**
 * QwenProxy Adapter — bridges QwenProxy SSE-only API to non-streaming OpenAI format.
 *
 * QwenProxy (port 3000) only returns SSE streaming responses, but Noxem's
 * advisor-engine, research-engine, and memory-extract all expect non-streaming
 * JSON responses (stream: false). This adapter sits on port 8000 and:
 *
 * 1. Accepts standard OpenAI POST /v1/chat/completions with stream: false
 * 2. Forwards to QwenProxy with stream: true
 * 3. Collects SSE chunks, strips reasoning_content, assembles non-streaming JSON
 * 4. Returns a single response object
 *
 * This means ZERO changes needed in advisor-engine.mjs, research-engine.mjs,
 * memory-extract.mjs, or memory-server.mjs — they all think they're talking
 * to the old gemma4-server on port 8000.
 */

import { createServer } from 'http';

const QWENPROXY_URL = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';
const ADAPTER_PORT = parseInt(process.env.LLM_PORT || process.env.GEMMA4_PORT || '8000');
const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── SSE parsing ──────────────────────────────────────────────

async function collectSSE(url, bodyObj, timeoutMs = 60000) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bodyObj),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
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
				if (delta.reasoning_content) reasoning += delta.reasoning_content;
			}
			if (chunk.model) model = chunk.model;
			if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
			if (chunk.usage) usage = chunk.usage;
		} catch { /* skip malformed lines */ }
	}

	// If no content but has reasoning, use reasoning as content (shouldn't happen with no-thinking model)
	if (!content && reasoning) content = reasoning;

	return { content, model, finishReason, usage };
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
		try {
			const qp = await fetch(`${QWENPROXY_URL}/health`, { signal: AbortSignal.timeout(3000) });
			const qpData = await qp.json().catch(() => ({}));
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ ok: true, ready: true, upstream: 'qwenproxy', upstreamHealth: qpData }));
		} catch {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ ok: true, ready: false, upstream: 'qwenproxy', upstreamHealth: 'unreachable' }));
		}
	}

	// GET /v1/models
	if (req.method === 'GET' && url.pathname === '/v1/models') {
		try {
			const qp = await fetch(`${QWENPROXY_URL}/v1/models`, { signal: AbortSignal.timeout(5000) });
			const data = await qp.json();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify(data));
		} catch (err) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ object: 'list', data: [
				{ id: DEFAULT_MODEL, object: 'model', created: Date.now(), owned_by: 'qwen' }
			]}));
		}
	}

	// POST /v1/chat/completions
	if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
		let body = '';
		for await (const chunk of req) body += chunk;

		let reqObj;
		try { reqObj = JSON.parse(body); } catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: 'Invalid JSON' }));
		}

		// CRITICAL: Ignore whatever model name the caller sends (e.g., "onnx-community/Qwen3-0.6B-ONNX"
		// from advisor-engine) — QwenProxy only accepts "qwen3.6-plus" or "qwen3.6-plus-no-thinking"
		const model = DEFAULT_MODEL;
		// Force stream: true for QwenProxy (it only supports SSE)
		const proxyBody = { ...reqObj, model, stream: true };

		LOG_DEBUG && console.error(`[qwenproxy-adapter] POST /v1/chat/completions model=${model}`);

		try {
			// Timeout: 60s for advisor, research may need more
			const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '60000');
			const result = await collectSSE(`${QWENPROXY_URL}/v1/chat/completions`, proxyBody, timeoutMs);

			const response = {
				id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: result.model,
				choices: [{
					index: 0,
					message: { role: 'assistant', content: result.content },
					finish_reason: result.finishReason,
				}],
				usage: result.usage,
			};

			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify(response));
		} catch (err) {
			LOG_DEBUG && console.error(`[qwenproxy-adapter] Error: ${err.message}`);
			// Return a fallback response so callers don't crash
			const fallback = {
				id: `chatcmpl-fallback-${Date.now()}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model,
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

	// 404 for everything else
	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(ADAPTER_PORT, '127.0.0.1', () => {
	console.log(`[qwenproxy-adapter] Listening on http://127.0.0.1:${ADAPTER_PORT}`);
	console.log(`[qwenproxy-adapter] Proxying to ${QWENPROXY_URL}`);
	console.log(`[qwenproxy-adapter] Default model: ${DEFAULT_MODEL}`);
});

// Graceful shutdown
function shutdown() {
	LOG_DEBUG && console.error('[qwenproxy-adapter] Shutting down...');
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
