#!/usr/bin/env node
// Gemma 4 E2B — OpenAI-compatible API server using Transformers.js
// Provides /v1/chat/completions endpoint for the Noxem advisor.

import express from 'express';
import cors from 'cors';

const PORT = process.env.GEMMA4_PORT || 8000;
const MODEL_ID = process.env.GEMMA4_MODEL || 'onnx-community/gemma-4-E2B-it-ONNX';
const DTYPE = process.env.GEMMA4_DTYPE || 'q4f16';
const MAX_NEW_TOKENS = parseInt(process.env.GEMMA4_MAX_TOKENS || '1024');
const CACHE_DIR = process.env.GEMMA4_CACHE || './.cache/gemma4';
const MAX_RETRIES = parseInt(process.env.GEMMA4_LOAD_RETRIES || '2');

// Device detection: macOS defaults to CPU (Apple Silicon) unless user overrides
function detectDevice() {
  if (process.env.GEMMA4_DEVICE) return process.env.GEMMA4_DEVICE;
  const isMac = process.platform === 'darwin';
  if (isMac) {
    console.log('  macOS detected — defaulting to CPU (Apple Silicon CPU handles q4f16 efficiently)');
    console.log('  Override: export GEMMA4_DEVICE=webgpu');
    return 'cpu';
  }
  return 'webgpu';
}
const DEVICE = detectDevice();

let model = null;
let processor = null;
let loadPromise = null;
let ready = false;
let loadError = null;

async function loadModel() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { AutoProcessor, Gemma4ForConditionalGeneration } = await import('@huggingface/transformers');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Model load retry ${attempt}/${MAX_RETRIES}...`);
          // Clear cache on retry to force fresh download
          const fs = await import('fs');
          const path = await import('path');
          const cachePath = path.resolve(CACHE_DIR);
          if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true });
            console.log('  Cleared corrupted model cache');
          }
        }

        console.log(`Loading ${MODEL_ID} (dtype=${DTYPE}, device=${DEVICE})...`);
        const start = Date.now();

        [processor, model] = await Promise.all([
          AutoProcessor.from_pretrained(MODEL_ID, { cache_dir: CACHE_DIR }),
          Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
            dtype: DTYPE,
            device: DEVICE,
            cache_dir: CACHE_DIR,
          }),
        ]);

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Gemma 4 ready in ${elapsed}s on ${DEVICE}`);
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

// Fallback response when model is unavailable
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
      message: { role: 'assistant', content: `[Gemma 4 unavailable] Model failed to load: ${loadError?.message || 'unknown error'}. Query was: "${text}"` },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Express app ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, ready, model: MODEL_ID, device: DEVICE, error: loadError?.message || null }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    await loadModel();

    if (!ready) {
      return res.json(fallbackResponse(req.body?.messages || []));
    }

    const messages = req.body?.messages || [];
    const prompt = formatMessages(messages);
    const maxTokens = req.body?.max_tokens || MAX_NEW_TOKENS;

    const inputs = await processor(prompt, { add_special_tokens: false });
    const inputLen = inputs.input_ids.dims.at(-1) || 0;

    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: maxTokens,
      do_sample: false,
    });

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
    // Return fallback instead of 500 — advisor can still function with degraded mode
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
  server.close(() => {
    // Free model resources
    model = null;
    processor = null;
    console.log('Gemma 4 server stopped.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  shutdown('UNCAUGHT_EXCEPTION');
});
