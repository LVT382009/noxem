import { AutoModel, AutoTokenizer } from '@xenova/transformers';

const MODEL_ID = process.env.EMBEDDING_MODEL || 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = process.env.EMBEDDING_DTYPE || 'fp32';
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '768');
const SIMILARITY_THRESHOLD = parseFloat(process.env.DUP_THRESHOLD || '0.92');
const CONTRADICTION_THRESHOLD = parseFloat(process.env.CONTRADICT_THRESHOLD || '0.80');

const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
};

let model = null;
let tokenizer = null;
let modelReady = false;

export async function initEmbeddingEngine() {
  if (modelReady) return;
  console.log(`Loading EmbeddingGemma 300M (${DTYPE}, dim=${EMBED_DIM})...`);
  const start = Date.now();
  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  model = await AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE });
  modelReady = true;
  console.log(`Embedding model ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

export function isEmbeddingReady() {
  return modelReady;
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
  const inputs = await tokenizer(prefix + text, { padding: true, truncation: true, max_length: 2048 });
  const { sentence_embedding } = await model(inputs);
  // sentence_embedding: [1, 768] → Float32Array
  const arr = Array.from(sentence_embedding.data);
  return normalize(arr.slice(0, EMBED_DIM));
}

export async function embedBatch(texts, role = 'document') {
  if (!modelReady) throw new Error('Embedding engine not initialized');
  const prefixed = texts.map(t => (role === 'query' ? PREFIXES.query : PREFIXES.document) + t);
  const inputs = await tokenizer(prefixed, { padding: true, truncation: true, max_length: 2048 });
  const { sentence_embedding } = await model(inputs);
  // sentence_embedding: [batch, 768]
  const dim = sentence_embedding.dims[1];
  const flat = Array.from(sentence_embedding.data);
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