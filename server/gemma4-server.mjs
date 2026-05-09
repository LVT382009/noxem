#!/usr/bin/env node
// Qwen3 0.6B — OpenAI-compatible API server using Transformers.js
// Provides /v1/chat/completions endpoint for the Noxem advisor.

// Prefer IPv4 for HuggingFace CDN downloads — WSL IPv6 can cause ConnectTimeoutError
// Must be set before any fetch() calls (i.e., before transformers.js imports)
if (!process.env.NODE_OPTIONS?.includes('ipv4first')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim();
}

// Patch globalThis.fetch to add per-request timeout + retry for HuggingFace CDN downloads
// Without this, a single stalled connection to xethub.hf.co can block the entire model load
const FETCH_TIMEOUT_MS = parseInt(process.env.HF_FETCH_TIMEOUT || '180000'); // 3 min default
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.HF_MAX_CONCURRENT || '3');
const HF_FETCH_RETRIES = parseInt(process.env.HF_FETCH_RETRIES || '3');
const HF_FETCH_BACKOFF_MS = parseInt(process.env.HF_FETCH_BACKOFF || '2000');
const _origFetch = globalThis.fetch;
let _hfActiveFetches = 0;
const _hfFetchQueue = [];

function dequeueFetch() {
  if (_hfFetchQueue.length === 0 || _hfActiveFetches >= MAX_CONCURRENT_DOWNLOADS) return;
  const { url, opts, resolve, reject } = _hfFetchQueue.shift();
  _hfActiveFetches++;
  _origFetch(url, opts)
  .then(resolve)
  .catch(reject)
  .finally(() => { _hfActiveFetches--; dequeueFetch(); });
}

// Retry a failed HuggingFace fetch with exponential backoff
async function fetchWithRetry(url, opts, retries = HF_FETCH_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const retryOpts = { ...opts };
      if (!opts.signal) {
        retryOpts.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      }
      const result = await _origFetch(url, retryOpts);
      return result;
    } catch (err) {
      const isRetryable = err.message?.includes('fetch failed')
        || err.message?.includes('ECONNREFUSED')
        || err.message?.includes('ECONNRESET')
        || err.message?.includes('ETIMEDOUT')
        || err.message?.includes('ConnectTimeoutError')
        || err.name === 'AbortError';
      if (!isRetryable || attempt >= retries) throw err;
      const delay = HF_FETCH_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`[HF Fetch] Retry ${attempt + 1}/${retries} for ${String(url).substring(0, 80)}... (wait ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

globalThis.fetch = function patchedFetch(url, opts = {}) {
  // Rewrite HF URLs to mirror if active
  let fetchUrl = url;
  if (typeof url === 'string' && _effectiveMirror && url.startsWith('https://huggingface.co/')) {
    fetchUrl = url.replace('https://huggingface.co/', _effectiveMirror);
  } else if (typeof url === 'string' && _effectiveMirror && url.includes('hf.co')) {
      fetchUrl = url.replace(/https?:\/\/[^/]*hf\.co/, _effectiveMirror.replace(/\/$/, ''));
  }
  const isHF = typeof fetchUrl === 'string' && (fetchUrl.includes('huggingface') || fetchUrl.includes('hf.co'));
  if (isHF) {
    if (_hfActiveFetches >= MAX_CONCURRENT_DOWNLOADS) {
      return new Promise((resolve, reject) => {
        _hfFetchQueue.push({ url: fetchUrl, opts, resolve, reject });
      });
    }
    _hfActiveFetches++;
    return fetchWithRetry(fetchUrl, opts).finally(() => { _hfActiveFetches--; dequeueFetch(); });
  }
  return _origFetch(fetchUrl, opts);
};

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, basename } from 'path';
import fs from 'fs';
import { runNetworkDiagnostics } from './network-diagnostics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root is one level up from server/ directory
const PROJECT_ROOT = resolve(__dirname, '..');

const HF_MIRROR = process.env.HF_ENDPOINT || '';
let _effectiveMirror = HF_MIRROR || '';
const PORT = process.env.LLM_PORT || process.env.GEMMA4_PORT || 8000;
const MODEL_ID = process.env.LLM_MODEL || process.env.GEMMA4_MODEL || 'onnx-community/Qwen3-0.6B-ONNX';
const DTYPE = process.env.LLM_DTYPE || process.env.GEMMA4_DTYPE || 'q4f16';
const MAX_NEW_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || process.env.GEMMA4_MAX_TOKENS || '1024');
// Resolve cache dir relative to project root (not CWD) — prevents "cache not found" when launched from different CWD
const CACHE_DIR = process.env.LLM_CACHE || process.env.GEMMA4_CACHE || resolve(PROJECT_ROOT, '.cache/llm');
const MAX_RETRIES = parseInt(process.env.LLM_LOAD_RETRIES || process.env.GEMMA4_LOAD_RETRIES || '3');

// In Node.js, onnxruntime-node auto-selects the best EP (CUDA > DirectML > CPU).
// WebGPU is browser-only — setting device:'webgpu' in Node causes "fetch failed".
function detectDevice() {
  if (process.env.LLM_DEVICE || process.env.GEMMA4_DEVICE) return process.env.LLM_DEVICE || process.env.GEMMA4_DEVICE;
  // Node.js uses onnxruntime-native — don't pass device, let it auto-detect
  return undefined;
}
const DEVICE = detectDevice();
if (DEVICE) {
  console.log(`Device override: ${DEVICE}`);
} else {
  console.log('Device: auto (onnxruntime-node selects best EP)');
}

let generator = null; // text-generation pipeline (tokenizer + model)
let loadPromise = null;
let ready = false;
let loadError = null;

// Deduplicate uncaught exceptions — log first occurrence, count repeats
const errorCounts = new Map();
let errorLogInterval = null;

function startErrorLogger() {
  if (errorLogInterval) return;
  errorLogInterval = setInterval(() => {
    for (const [msg, count] of errorCounts) {
      if (count > 1) {
        console.error(`Uncaught exception (non-fatal, ${count}x): ${msg}`);
      }
      errorCounts.delete(msg);
    }
  }, 5000).unref();
}


// Validate cache directory: check if tokenizer_config.json exists and is non-empty.
// If missing or empty, the cache is corrupted — clear it before loading.
function validateCacheDir(cacheDir) {
  try {
    const resolved = resolve(cacheDir);
    if (!fs.existsSync(resolved)) return; // no cache yet — fine

  // 1. Find .tmp files from interrupted downloads
  // Transformers.js downloads to .tmp.RANDOM.suffix, then renames on completion.
  // If process is killed before rename, the .tmp lingers and target file is missing.
  // Since .tmp files may be incomplete (download interrupted mid-write), we can't
  // safely rename them — clearing the entire cache is the only safe recovery.
  const tmpFiles = [];
  function findTmpFiles(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) findTmpFiles(full);
        else if (/\.tmp\.[a-z0-9]+\.[a-z0-9]+$/i.test(entry.name)) tmpFiles.push(full);
      }
    } catch {}
  }
  findTmpFiles(resolved);
  if (tmpFiles.length > 0) {
    console.log(`Cache validator: found ${tmpFiles.length} temp file(s) from interrupted download(s) — clearing cache`);
    for (const f of tmpFiles) console.log(`  ${basename(f)}`);
    fs.rmSync(resolved, { recursive: true, force: true });
    return;
  }

    // 2. Walk directories looking for empty or corrupt tokenizer_config.json
    function checkDir(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const tcPath = join(dir, entry.name, 'tokenizer_config.json');
          if (fs.existsSync(tcPath)) {
            const stat = fs.statSync(tcPath);
            if (stat.size === 0) {
              console.log('Cache validator: empty tokenizer_config.json — clearing cache');
              fs.rmSync(resolved, { recursive: true, force: true });
              return true;
            }
            try { JSON.parse(fs.readFileSync(tcPath, 'utf8')); }
            catch {
              console.log('Cache validator: corrupt tokenizer_config.json — clearing cache');
              fs.rmSync(resolved, { recursive: true, force: true });
              return true;
            }
          }
          if (entry.name.startsWith('models--')) {
            const snapDir = join(dir, entry.name, 'snapshots');
            if (fs.existsSync(snapDir)) {
              for (const hash of fs.readdirSync(snapDir)) {
                const tcFile = join(snapDir, hash, 'tokenizer_config.json');
                if (fs.existsSync(tcFile)) {
                  if (fs.statSync(tcFile).size === 0) {
                    console.log('Cache validator: empty tokenizer_config.json — clearing cache');
                    fs.rmSync(resolved, { recursive: true, force: true });
                    return true;
                  }
                  try { JSON.parse(fs.readFileSync(tcFile, 'utf8')); }
                  catch {
                    console.log('Cache validator: corrupt tokenizer_config.json — clearing cache');
                    fs.rmSync(resolved, { recursive: true, force: true });
                    return true;
                  }
                }
              }
            }
          }
          if (checkDir(join(dir, entry.name))) return true;
        }
      } catch {}
      return false;
    }
    checkDir(resolved);
  } catch (e) {
    console.error('Cache validator error:', e.message);
  }
}

async function loadModel() {
  if (loadPromise) return loadPromise;
  runNetworkDiagnostics();
  validateCacheDir(CACHE_DIR);
  loadPromise = (async () => {
  // Dynamic import — pipeline() is the standard transformers.js API
  let pipeline, transformers;
    try {
      transformers = await import('@huggingface/transformers');
    pipeline = transformers.pipeline;

      if (HF_MIRROR && transformers.env) {
          transformers.env.remoteHost = HF_MIRROR;
          _effectiveMirror = HF_MIRROR;
          console.log(`Model download: using mirror ${HF_MIRROR}`);
      }
    } catch (err) {
      loadError = err;
      console.error(`Failed to import transformers.js: ${err.message}`);
      console.error('Run: npm install @huggingface/transformers@latest');
      return;
    }

  if (!pipeline) {
    loadError = new Error('pipeline not available — update @huggingface/transformers');
      console.error(loadError.message);
      return;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Model load retry ${attempt}/${MAX_RETRIES}...`);
          // Only clear cache on second+ attempt if explicitly requested
          // Auto-detect corrupted cache: if previous error was "fetch failed" or "tokenizer_class",
          // the cache is corrupt — clear it regardless of GEMMA4_CLEAR_CACHE_ON_RETRY setting
          const prevError = loadError?.message || '';
          const cacheCorrupted = prevError.includes('fetch failed') || prevError.includes('tokenizer_class') || prevError.includes('Cannot read properties') || prevError.includes('Unable to fetch file metadata');
          // Always clear cache on mirror fallback — old host downloads are incomplete
          const mirrorSwitched = !HF_MIRROR && _effectiveMirror && _effectiveMirror !== 'https://huggingface.co/';
          if (cacheCorrupted || mirrorSwitched || process.env.LLM_CLEAR_CACHE_ON_RETRY === 'true' || process.env.GEMMA4_CLEAR_CACHE_ON_RETRY === 'true') {
            const fs = await import('fs');
            const path = await import('path');
            const cachePath = path.resolve(CACHE_DIR);
            if (fs.existsSync(cachePath)) {
              fs.rmSync(cachePath, { recursive: true, force: true });
          console.log(' Cleared model cache (' + (mirrorSwitched ? 'mirror switch' : cacheCorrupted ? 'auto-detected corruption' : 'GEMMA4_CLEAR_CACHE_ON_RETRY=true') + ')');
            }
          } else {
            console.log('  Retrying with existing cache...');
          }
      // Mirror fallback: on 2nd+ retry, switch to hf-mirror.com if not already set
      if (!HF_MIRROR && transformers?.env?.remoteHost === 'https://huggingface.co/') {
        transformers.env.remoteHost = 'https://hf-mirror.com/';
        _effectiveMirror = 'https://hf-mirror.com/';
        console.log('  Switched to hf-mirror.com for this retry');
      }
          }

        console.log(`Loading ${MODEL_ID} (dtype=${DTYPE})...`);
        const start = Date.now();

        const loadOpts = {
          dtype: DTYPE,
          cache_dir: CACHE_DIR,
        };
        // Only pass device if explicitly set — in Node.js, onnxruntime-node
        // auto-selects the best execution provider (CUDA/DirectML/CPU)
        if (DEVICE) loadOpts.device = DEVICE;

      // Use pipeline() API — handles tokenizer + model loading internally.
      // Qwen3-0.6B is a decoder-only text-generation model (Qwen3ForCausalLM).


      generator = await pipeline('text-generation', MODEL_ID, loadOpts);

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Qwen3 0.6B ready in ${elapsed}s`);
        ready = true;
        loadError = null;
        return;
      } catch (err) {
        loadError = err;
        console.error(`Model load attempt ${attempt + 1} failed: ${err.message}`);
      }
    }

    console.error('All model load attempts failed. Advisor will use fallback mode.');
  })();
  return loadPromise;
}

function formatMessages(messages) {
  return messages.map(m => {
    const role = (m.role || 'user').toUpperCase();
    const content = Array.isArray(m.content)
      ? m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n')
      : String(m.content ?? '');
    return `${role}: ${content}`;
  }).join('\n\n') + '\n\nASSISTANT:';
}

function fallbackResponse(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = (lastUser?.content || '').substring(0, 200);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: `[LLM unavailable] ${loadError?.message || 'model not loaded'}. Query: "${text}"` },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Express app ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, ready, model: MODEL_ID, device: DEVICE || 'auto', error: loadError?.message || null }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    await loadModel();

    if (!ready) {
      return res.json(fallbackResponse(req.body?.messages || []));
    }

    const messages = req.body?.messages || [];
      const maxTokens = req.body?.max_tokens || MAX_NEW_TOKENS;

      // pipeline() handles chat template + tokenization + generation internally
      const output = await generator(messages, {
        max_new_tokens: maxTokens,
        do_sample: false,
            enable_thinking: false,
      });

      // Pipeline returns [{ generated_text: [...messages, {role:'assistant', content:'...'}] }]
      const lastMsg = output?.[0]?.generated_text?.at(-1);
      const text = (lastMsg?.content || '').trim();

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    console.error('LLM inference error:', err.message);
    res.json(fallbackResponse(req.body?.messages || []));
  }
});

// ── Start ──
const server = app.listen(PORT, '127.0.0.1', async () => {
  console.log(`Qwen3 0.6B API at http://127.0.0.1:${PORT}/v1`);
  loadModel().catch(err => console.error('Model load failed:', err.message));
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down LLM server...`);
  if (errorLogInterval) clearInterval(errorLogInterval);
  server.close(() => {
    generator = null;
    console.log('LLM server stopped.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Don't crash on uncaught exceptions — debounce and count repeated errors
process.on('uncaughtException', (err) => {
  const msg = err.message || String(err);
  const count = (errorCounts.get(msg) || 0) + 1;
  errorCounts.set(msg, count);
  if (count === 1) {
    console.error(`Uncaught exception (non-fatal): ${msg}`);
    startErrorLogger();
  }
  // Repeated errors are batch-logged every 5s by the interval
});
