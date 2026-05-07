import { pipeline } from '@huggingface/transformers';

const MODEL_ID = process.env.EMBEDDING_MODEL || 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = process.env.EMBEDDING_DTYPE || 'fp32';
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '768');
const EMBED_CACHE_DIR = process.env.EMBEDDING_CACHE || './.cache/embedding';
const MAX_RETRIES = parseInt(process.env.EMBEDDING_LOAD_RETRIES || '2');
const SIMILARITY_THRESHOLD = parseFloat(process.env.DUP_THRESHOLD || '0.92');
const CONTRADICTION_THRESHOLD = parseFloat(process.env.CONTRADICT_THRESHOLD || '0.80');

const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
};

let extractor = null;
let modelReady = false;
let loadError = null;
let loadPromise = null;

export async function initEmbeddingEngine() {
  if (modelReady) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Embedding model load retry ${attempt}/${MAX_RETRIES}...`);
          const fs = await import('fs');
          const path = await import('path');
          const cachePath = path.resolve(EMBED_CACHE_DIR);
          if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true });
            console.log('  Cleared corrupted embedding model cache');
          }
          // Also clear HuggingFace hub cache for this model
          const hfCache = path.join(process.env.HF_HOME || path.join(process.env.HOME || '.', '.cache', 'huggingface'), 'hub');
          const modelSlug = MODEL_ID.replace('/', '--');
          const modelCacheDir = path.join(hfCache, `models--${modelSlug}`);
          if (fs.existsSync(modelCacheDir)) {
            fs.rmSync(modelCacheDir, { recursive: true, force: true });
            console.log('  Cleared HuggingFace hub cache for embedding model');
          }
        }

        console.log(`Loading EmbeddingGemma 300M (${DTYPE}, dim=${EMBED_DIM})...`);
        const start = Date.now();
        extractor = await pipeline('feature-extraction', MODEL_ID, {
          dtype: DTYPE,
          cache_dir: EMBED_CACHE_DIR,
        });
        modelReady = true;
        loadError = null;
        console.log(`Embedding model ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      } catch (err) {
        loadError = err;
        console.error(`Embedding model load attempt ${attempt + 1} failed: ${err.message}`);
      }
    }
    console.error('All embedding model load attempts failed. Vector search will be unavailable.');
  })();

  return loadPromise;
}

export function isEmbeddingReady() {
  return modelReady;
}

export function getEmbeddingError() {
  return loadError;
}

function normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm < 1e-10) return v;
  return v.map(x => x / norm);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-10 ? 0 : dot / denom;
}

export async function embed(text, role = 'document') {
  if (!modelReady) throw new Error('Embedding engine not initialized');
  const prefix = role === 'query' ? PREFIXES.query : PREFIXES.document;
  const output = await extractor(prefix + text, {
    pooling: 'mean',
    normalize: true,
  });
  // output: [1, 768] Float32Array — already normalized by pipeline
  const arr = Array.from(output.data);
  return normalize(arr.slice(0, EMBED_DIM));
}

export async function embedBatch(texts, role = 'document') {
  if (!modelReady) throw new Error('Embedding engine not initialized');
  const prefixed = texts.map(t => (role === 'query' ? PREFIXES.query : PREFIXES.document) + t);
  const output = await extractor(prefixed, {
    pooling: 'mean',
    normalize: true,
  });
  // output: [batch, 768]
  const dim = output.dims[1];
  const flat = Array.from(output.data);
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    const start = i * dim;
    vectors.push(normalize(flat.slice(start, start + EMBED_DIM)));
  }
  return vectors;
}

// Search by embedding: compare query embedding against all stored embeddings
export function searchByEmbedding(queryEmbedding, storedMemories, topK = 5) {
  const scored = storedMemories
    .filter(m => m.embedding)
    .map(m => ({
      id: m.id,
      text: m.text,
      type: m.type,
      session_id: m.session_id,
      created_at: m.created_at,
      score: cosineSimilarity(queryEmbedding, m.embedding),
    }))
    .filter(m => m.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

// Find duplicates: memories with similarity > threshold
export function findDuplicates(memories) {
  const dupes = [];
  for (let i = 0; i < memories.length; i++) {
    if (!memories[i].embedding) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (!memories[j].embedding) continue;
      const sim = cosineSimilarity(memories[i].embedding, memories[j].embedding);
      if (sim > SIMILARITY_THRESHOLD) {
        dupes.push({
          a: memories[i],
          b: memories[j],
          similarity: sim,
        });
      }
    }
  }
  return dupes;
}

// Find contradictions: memories with similarity above contradiction threshold
// that express opposite preferences/opinions about the same entity
export function findContradictions(memories) {
  const contradictions = [];
  for (let i = 0; i < memories.length; i++) {
    if (!memories[i].embedding || memories[i].type === 'general') continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (!memories[j].embedding || memories[j].type === 'general') continue;
      const sim = cosineSimilarity(memories[i].embedding, memories[j].embedding);
      if (sim > CONTRADICTION_THRESHOLD) {
        // Check if they express opposing views about the same topic
        const texts = [memories[i].text.toLowerCase(), memories[j].text.toLowerCase()];
        const prefers = [/prefer/, /like/, /love/, /hate/, /dislike/, /favorite/, /use /, /using /];
        const hasPreference = prefers.some(p => texts.some(t => p.test(t)));
        if (hasPreference) {
          contradictions.push({
            a: memories[i],
            b: memories[j],
            similarity: sim,
          });
        }
      }
    }
  }
  return contradictions;
}

// Categorize a memory based on its text content
export function categorizeText(text) {
  const lower = text.toLowerCase();

  if (/prefer|like |love |hate |dislike|favorite|enjoy|don't like|not a fan/i.test(lower)) return 'preference';
  if (/project|building|working on|creating|app |tool |system |repo|github/i.test(lower)) return 'project';
  if (/name is|my name|called|i am |i'm |works as|role |job /i.test(lower)) return 'profile';
  if (/need |want |please |can you|could you|help me/i.test(lower)) return 'request';
  if (/learn|studying|studied|reading|research|course|tutorial|guide/i.test(lower)) return 'learning';
  if (/tech |stack|language|framework|library|tool |using |installed|setup|config/i.test(lower)) return 'setup';
  if (/goal |aim |plan |want to|going to|will |future/i.test(lower)) return 'goal';
  if (/error|bug|issue|problem|fail|crash|broken|fix/i.test(lower)) return 'issue';
  if (/workflow|habit|always|usually|typically|every |each /i.test(lower)) return 'pattern';
  if (/entity|person|company|website|product|service/i.test(lower)) return 'entity';
  if (/yesterday|today|tomorrow|last week|meeting|call |event|schedule/i.test(lower)) return 'event';

  return 'fact';
}

export { cosineSimilarity, normalize, SIMILARITY_THRESHOLD, CONTRADICTION_THRESHOLD };
