#!/usr/bin/env node
/**
 * QwenProxy Adapter — full OpenAI-compatible API base URL on port 8000.
 *
 * This adapter makes QwenProxy usable as a standard OpenAI API base URL:
 *   base_url = http://127.0.0.1:8000/v1
 *
 * It handles two roles:
 * 1. **Non-streaming bridge** (for Noxem internals): advisor-engine, research-engine,
 *    and memory-extract send stream:false — adapter collects SSE from QwenProxy
 *    and returns a single JSON response.
 * 2. **Streaming passthrough** (for external tools): when stream:true is requested,
 *    adapter forwards SSE chunks directly to the client, making it a drop-in
 *    OpenAI-compatible endpoint for any tool that supports custom base URLs.
 *
 * Model name normalization: whatever model name the caller sends, the adapter
 * maps it to a valid QwenProxy model (qwen3.6-plus or qwen3.6-plus-no-thinking).
 */

import { createServer } from 'http';

const QWENPROXY_URL = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';
const ADAPTER_PORT = parseInt(process.env.LLM_PORT || process.env.GEMMA4_PORT || '8000');
const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Model normalization ──────────────────────────────────────
// QwenProxy only accepts "qwen3.6-plus" or "qwen3.6-plus-no-thinking"
// Map any incoming model name to a valid one
function normalizeModel(requestedModel) {
	if (!requestedModel) return DEFAULT_MODEL;
	const m = requestedModel.toLowerCase();
	if (m.includes('thinking') && !m.includes('no-thinking')) return 'qwen3.6-plus';
	return 'qwen3.6-plus-no-thinking';
}

// ── SSE collection (for non-streaming mode) ──────────────────

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

	if (!content && reasoning) content = reasoning;

	return { content, reasoning, model, finishReason, usage };
}

// ── SSE streaming passthrough ─────────────────────────────────

async function streamSSE(upstreamUrl, bodyObj, clientRes, timeoutMs = 120000) {
	const upstream = await fetch(upstreamUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bodyObj),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		clientRes.writeHead(upstream.status, { 'Content-Type': 'application/json' });
		return clientRes.end(JSON.stringify({ error: { message: `QwenProxy error: ${text.substring(0, 300)}`, type: 'upstream_error' } }));
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
		LOG_DEBUG && console.error(`[qwenproxy-adapter] Stream error: ${err.message}`);
	} finally {
		clientRes.end();
	}
}

// ── Read request body ────────────────────────────────────────

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', () => resolve(body));
		req.on('error', reject);
	});
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
		} catch {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ object: 'list', data: [
				{ id: 'qwen3.6-plus', object: 'model', created: Date.now(), owned_by: 'qwen' },
				{ id: 'qwen3.6-plus-no-thinking', object: 'model', created: Date.now(), owned_by: 'qwen' },
			]}));
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

		const model = normalizeModel(reqObj.model);
		const wantStream = reqObj.stream === true;
		const proxyBody = { ...reqObj, model, stream: true };

		LOG_DEBUG && console.error(`[qwenproxy-adapter] POST /v1/chat/completions model=${model} stream=${wantStream}`);

		try {
			const timeoutMs = parseInt(process.env.LLM_TIMEOUT || '120000');

			if (wantStream) {
				// Streaming: pass SSE through directly — works as OpenAI base URL
				return await streamSSE(`${QWENPROXY_URL}/v1/chat/completions`, proxyBody, res, timeoutMs);
			} else {
				// Non-streaming: collect SSE, return single JSON (for Noxem internals)
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
			}
		} catch (err) {
			LOG_DEBUG && console.error(`[qwenproxy-adapter] Error: ${err.message}`);
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

	// 404
	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
});

server.listen(ADAPTER_PORT, '127.0.0.1', () => {
	console.log(`[qwenproxy-adapter] Listening on http://127.0.0.1:${ADAPTER_PORT}`);
	console.log(`[qwenproxy-adapter] Proxying to ${QWENPROXY_URL}`);
	console.log(`[qwenproxy-adapter] Default model: ${DEFAULT_MODEL}`);
	console.log(`[qwenproxy-adapter] OpenAI base URL: http://127.0.0.1:${ADAPTER_PORT}/v1`);
});

// Graceful shutdown
function shutdown() {
	LOG_DEBUG && console.error('[qwenproxy-adapter] Shutting down...');
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
