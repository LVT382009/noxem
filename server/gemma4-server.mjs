#!/usr/bin/env node
// Gemma 4 E2B — OpenAI-compatible API server using Transformers.js
// Provides /v1/chat/completions endpoint for the Noxem advisor.

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, basename } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root is one level up from server/ directory
const PROJECT_ROOT = resolve(__dirname, '..');

const PORT = process.env.GEMMA4_PORT || 8000;
const MODEL_ID = process.env.GEMMA4_MODEL || 'onnx-community/gemma-4-E2B-it-ONNX';
const DTYPE = process.env.GEMMA4_DTYPE || 'q4f16';
const MAX_NEW_TOKENS = parseInt(process.env.GEMMA4_MAX_TOKENS || '1024');
// Resolve cache dir relative to project root (not CWD) — prevents "cache not found" when launched from different CWD
const CACHE_DIR = process.env.GEMMA4_CACHE || resolve(PROJECT_ROOT, '.cache/gemma4');
const MAX_RETRIES = parseInt(process.env.GEMMA4_LOAD_RETRIES || '2');

// In Node.js, onnxruntime-node auto-selects the best EP (CUDA > DirectML > CPU).
// WebGPU is browser-only — setting device:'webgpu' in Node causes "fetch failed".
function detectDevice() {
  if (process.env.GEMMA4_DEVICE) return process.env.GEMMA4_DEVICE;
  // Node.js uses onnxruntime-native — don't pass device, let it auto-detect
  return undefined;
}
const DEVICE = detectDevice();
if (DEVICE) {
  console.log(`Device override: ${DEVICE}`);
} else {
  console.log('Device: auto (onnxruntime-node selects best EP)');
}

let model = null;
let processor = null;
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
  validateCacheDir(CACHE_DIR);
  loadPromise = (async () => {
    // Dynamic import — Gemma4ForConditionalGeneration may not exist in older versions
    let AutoProcessor, Gemma4ForConditionalGeneration;
    try {
      const transformers = await import('@huggingface/transformers');
      AutoProcessor = transformers.AutoProcessor;
      Gemma4ForConditionalGeneration = transformers.Gemma4ForConditionalGeneration;
    } catch (err) {
      loadError = err;
      console.error(`Failed to import transformers.js: ${err.message}`);
      console.error('Run: npm install @huggingface/transformers@latest');
      return;
    }

    if (!AutoProcessor || !Gemma4ForConditionalGeneration) {
      loadError = new Error('Gemma4ForConditionalGeneration not available — update @huggingface/transformers to v4+');
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
          const cacheCorrupted = prevError.includes('fetch failed') || prevError.includes('tokenizer_class') || prevError.includes('Cannot read properties');
          if (cacheCorrupted || process.env.GEMMA4_CLEAR_CACHE_ON_RETRY === 'true') {
            const fs = await import('fs');
            const path = await import('path');
            const cachePath = path.resolve(CACHE_DIR);
            if (fs.existsSync(cachePath)) {
              fs.rmSync(cachePath, { recursive: true, force: true });
              console.log('  Cleared model cache (corrupted — ' + (cacheCorrupted ? 'auto-detected' : 'GEMMA4_CLEAR_CACHE_ON_RETRY=true') + ')');
            }
          } else {
            console.log('  Retrying with existing cache...');
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

        [processor, model] = await Promise.all([
          AutoProcessor.from_pretrained(MODEL_ID, { cache_dir: CACHE_DIR }),
          Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, loadOpts),
        ]);

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Gemma 4 ready in ${elapsed}s`);
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
      message: { role: 'assistant', content: `[Gemma 4 unavailable] ${loadError?.message || 'model not loaded'}. Query: "${text}"` },
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
    const prompt = processor.apply_chat_template
      ? processor.apply_chat_template(messages, { enable_thinking: false, add_generation_prompt: true })
      : formatMessages(messages);
    const maxTokens = req.body?.max_tokens || MAX_NEW_TOKENS;

    const inputs = await processor(prompt, { add_special_tokens: false });
    const inputLen = inputs.input_ids?.dims?.at(-1) || 0;

    const TextStreamer = (await import('@huggingface/transformers')).TextStreamer;
    const streamer = TextStreamer
      ? new TextStreamer(processor.tokenizer, { skip_prompt: true, skip_special_tokens: false })
      : undefined;

    const generateOpts = {
      ...inputs,
      max_new_tokens: maxTokens,
      do_sample: false,
    };
    if (streamer) generateOpts.streamer = streamer;

    const outputs = await model.generate(generateOpts);

    const decoded = processor.batch_decode(
      outputs.slice(null, [inputLen, null]),
      { skip_special_tokens: true }
    );

    const text = (decoded?.[0] || '').trim();

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: inputLen, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    console.error('Gemma 4 inference error:', err.message);
    res.json(fallbackResponse(req.body?.messages || []));
  }
});

// ── Start ──
const server = app.listen(PORT, '127.0.0.1', async () => {
  console.log(`Gemma 4 API at http://127.0.0.1:${PORT}/v1`);
  loadModel().catch(err => console.error('Model load failed:', err.message));
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down Gemma 4 server...`);
  if (errorLogInterval) clearInterval(errorLogInterval);
  server.close(() => {
    model = null;
    processor = null;
    console.log('Gemma 4 server stopped.');
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
