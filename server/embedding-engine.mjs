const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
// Prefer IPv4 for HuggingFace CDN downloads — WSL IPv6 can cause ConnectTimeoutError
if (!process.env.NODE_OPTIONS?.includes('ipv4first')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim();
}
// Patch globalThis.fetch to add per-request timeout + retry for HuggingFace CDN downloads
// and limit concurrent connections to prevent CDN saturation
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
      // Always create a fresh timeout signal per attempt (signals are single-use)
      const retryOpts = { ...opts };
      const freshSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      retryOpts.signal = opts.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([freshSignal, opts.signal])
        : freshSignal;
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
      LOG_DEBUG && console.log(`[HF Fetch] Retry ${attempt + 1}/${retries} for ${String(url).substring(0, 80)}... (wait ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

globalThis.fetch = function patchedFetch(url, opts = {}) {
  // Rewrite HF URLs to mirror if env.remoteHost has been switched
  let fetchUrl = url;
  if (typeof url === 'string' && env.remoteHost && env.remoteHost !== 'https://huggingface.co/' && url.startsWith('https://huggingface.co/')) {
    fetchUrl = url.replace('https://huggingface.co/', env.remoteHost);
  } else if (typeof url === 'string' && env.remoteHost && env.remoteHost !== 'https://huggingface.co/' && url.includes('hf.co')) {
      fetchUrl = url.replace(/https?:\/\/[^/]*hf\.co/, env.remoteHost.replace(/\/$/, ''));
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
  return _origFetch(url, opts);
};

import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, basename } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root is one level up from server/ directory
const PROJECT_ROOT = resolve(__dirname, '..');

const MODEL_ID = process.env.EMBEDDING_MODEL || 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = process.env.EMBEDDING_DTYPE || 'q8'; // q8: 68.13 vs fp32: 68.36 on MTEB — negligible diff, much smaller/faster
const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256'); // MRL 256d: only 1.5% loss vs 768d, 3x less storage
// Resolve cache dir relative to project root (not CWD) — prevents "cache not found" when launched from different CWD
const EMBED_CACHE_DIR = process.env.EMBEDDING_CACHE || resolve(PROJECT_ROOT, '.cache/embedding');
const HF_MIRROR = process.env.HF_ENDPOINT || '';
if (HF_MIRROR) {
  env.remoteHost = HF_MIRROR;
  LOG_DEBUG && console.log(`Component download: using mirror ${HF_MIRROR}`);
}
const MAX_RETRIES = parseInt(process.env.EMBEDDING_LOAD_RETRIES || '2');

const LOAD_TIMEOUT_MS = parseInt(process.env.EMBEDDING_LOAD_TIMEOUT || '300000'); // 5 min default
const SIMILARITY_THRESHOLD = parseFloat(process.env.DUP_THRESHOLD || '0.92');
const CONTRADICTION_THRESHOLD = parseFloat(process.env.CONTRADICT_THRESHOLD || '0.80');

const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
};

let tokenizer = null;
let model = null;
let modelReady = false;
let loadError = null;
let loadPromise = null;

// Concurrency semaphore: serialize inference calls (transformers.js is NOT thread-safe)
let inferenceLock = Promise.resolve();
function withLock(fn) {
  let release;
  const next = new Promise(r => { release = r; });
  const prev = inferenceLock;
  inferenceLock = next;
  return prev.then(() => {
    let result;
    try {
      result = fn();
    } catch (syncErr) {
      release(); // Release lock on synchronous throw to prevent deadlock
      throw syncErr;
    }
    // Timeout returns error to caller but does NOT release the lock —
    // the inference may still be running in transformers.js (not thread-safe).
    // Release only when the actual inference completes.
    let _inferenceTimer; const timeout = new Promise((_, reject) => { _inferenceTimer = setTimeout(() => reject(new Error("Inference timeout")), 60000); });
    return Promise.race([result, timeout]).catch(err => {
      // On timeout, caller gets error but lock stays held until inference finishes
      result.catch(() => {}).then(() => { clearTimeout(_inferenceTimer); release(); });
      throw err;
    }).then(val => { clearTimeout(_inferenceTimer); release(); return val; });
  });
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
    LOG_DEBUG && console.log(`Cache validator: found ${tmpFiles.length} temp file(s) from interrupted download(s) — clearing cache`);
    for (const f of tmpFiles) LOG_DEBUG && console.log(`  ${basename(f)}`);
    fs.rmSync(resolved, { recursive: true, force: true });
    return;
  }

    // 2. Walk directories looking for empty or corrupt tokenizer_config.json
    function checkDir(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          // Direct structure: cache_dir/org/model/tokenizer_config.json
          const tcPath = join(dir, entry.name, 'tokenizer_config.json');
          if (fs.existsSync(tcPath)) {
            const stat = fs.statSync(tcPath);
            if (stat.size === 0) {
              LOG_DEBUG && console.log('Cache validator: empty tokenizer_config.json — clearing cache');
              fs.rmSync(resolved, { recursive: true, force: true });
              return true;
            }
            try { JSON.parse(fs.readFileSync(tcPath, 'utf8')); }
            catch {
              LOG_DEBUG && console.log('Cache validator: corrupt tokenizer_config.json — clearing cache');
              fs.rmSync(resolved, { recursive: true, force: true });
              return true;
            }
          }
          // HuggingFace hub structure: cache_dir/models--org--model/snapshots/<hash>/
          if (entry.name.startsWith('models--')) {
            const snapDir = join(dir, entry.name, 'snapshots');
            if (fs.existsSync(snapDir)) {
              for (const hash of fs.readdirSync(snapDir)) {
                const tcFile = join(snapDir, hash, 'tokenizer_config.json');
                if (fs.existsSync(tcFile)) {
                  if (fs.statSync(tcFile).size === 0) {
                    LOG_DEBUG && console.log('Cache validator: empty tokenizer_config.json — clearing cache');
                    fs.rmSync(resolved, { recursive: true, force: true });
                    return true;
                  }
                  try { JSON.parse(fs.readFileSync(tcFile, 'utf8')); }
                  catch {
                    LOG_DEBUG && console.log('Cache validator: corrupt tokenizer_config.json — clearing cache');
                    fs.rmSync(resolved, { recursive: true, force: true });
                    return true;
                  }
                }
              }
            }
          }
          // Recurse into subdirectories
          if (checkDir(join(dir, entry.name))) return true;
        }
      } catch {}
      return false;
    }
    checkDir(resolved);
  } catch (e) {
    LOG_DEBUG && console.error('Cache validator error:', e.message);
  }
}

export async function initEmbeddingEngine() {
  if (modelReady) return;
  // S-#39: Guard against race — if a concurrent caller already started loading, reuse their promise
  if (loadPromise) { await loadPromise; return; }
  validateCacheDir(EMBED_CACHE_DIR);

  loadPromise = (async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          LOG_DEBUG && console.log(`Brain-1 load retry ${attempt}/${MAX_RETRIES}...`);
          // Auto-detect corrupted cache: if previous error was "fetch failed" or "tokenizer_class",
          // the cache is corrupt — clear it regardless of EMBEDDING_CLEAR_CACHE_ON_RETRY setting
          const prevError = loadError?.message || '';
          const cacheCorrupted = prevError.includes('fetch failed') || prevError.includes('tokenizer_class') || prevError.includes('Cannot read properties') || prevError.includes('Unable to fetch file metadata');
          // Always clear cache on mirror fallback — old host downloads are incomplete
          const mirrorSwitched = !HF_MIRROR && env.remoteHost !== 'https://huggingface.co/';
          if (cacheCorrupted || mirrorSwitched || process.env.EMBEDDING_CLEAR_CACHE_ON_RETRY === 'true') {
            const fs = await import('fs');
            const path = await import('path');
            const cachePath = path.resolve(EMBED_CACHE_DIR);
            if (fs.existsSync(cachePath)) {
              fs.rmSync(cachePath, { recursive: true, force: true });
              LOG_DEBUG && console.log('  Cleared Brain-1 cache (corrupted — ' + (cacheCorrupted ? 'auto-detected' : 'EMBEDDING_CLEAR_CACHE_ON_RETRY=true') + ')');
            }
          } else {
            LOG_DEBUG && console.log('  Retrying with existing cache...');
          }
          // Mirror fallback: on 2nd+ retry, switch to hf-mirror.com if not already set
          if (!HF_MIRROR && env.remoteHost === 'https://huggingface.co/') {
            env.remoteHost = 'https://hf-mirror.com/';
            LOG_DEBUG && console.log('  Switched to hf-mirror.com for this retry');
          }
        }

        LOG_DEBUG && console.log(`Loading Brain-1 AI...`);
        const start = Date.now();
        // Load sequentially (not Promise.all) to avoid CDN connection timeouts.
        // Transformers.js fires many concurrent fetch() requests for model files;
        // loading tokenizer + model in parallel doubles the concurrent connections,
        // which triggers ConnectTimeoutError on HuggingFace CDN (xethub.hf.co).
      let loadTimeoutId;
      const loadWithTimeout = Promise.race([
        (async () => {
          const tok = await AutoTokenizer.from_pretrained(MODEL_ID, { cache_dir: EMBED_CACHE_DIR });
          const mod = await AutoModel.from_pretrained(MODEL_ID, {
            dtype: DTYPE,
            cache_dir: EMBED_CACHE_DIR,
          });
          return [tok, mod];
        })(),
        new Promise((_, reject) => {
          loadTimeoutId = setTimeout(() => reject(new Error(`Model load timed out after ${LOAD_TIMEOUT_MS / 1000}s`)), LOAD_TIMEOUT_MS);
        }),
      ]);
      [tokenizer, model] = await loadWithTimeout;
      clearTimeout(loadTimeoutId); // Clear timeout timer after successful load
      modelReady = true;
        loadError = null;
        LOG_DEBUG && console.log(`Brain-1 ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return;
      } catch (err) {
        loadError = err;
        LOG_DEBUG && console.error(`Brain-1 load attempt ${attempt + 1} failed: ${err.message}`);
      if (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('ECONNREFUSED')) {
        LOG_DEBUG && console.error('  This may be a network issue. Check internet connection and try EMBEDDING_CLEAR_CACHE_ON_RETRY=true');
      } else if (err.message.includes('timed out')) {
        LOG_DEBUG && console.error('  Model download took too long. Increase EMBEDDING_LOAD_TIMEOUT or check network speed.');
      }
      }
    }
    LOG_DEBUG && console.error('Brain-1: all load attempts failed. Vector search will be unavailable.');
	loadPromise = null; // Allow retry on next initEmbeddingEngine() call
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
  if (norm < 1e-10) return null;
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
  return withLock(async () => {
    const prefix = role === 'query' ? PREFIXES.query : PREFIXES.document;
    const inputs = await tokenizer(prefix + text, { padding: true });
    const { sentence_embedding } = await model(inputs);
    const arr = Array.from(sentence_embedding.data);
    const result = normalize(arr.slice(0, EMBED_DIM));
  return result || arr.slice(0, EMBED_DIM); // fallback to unnormalized if zero vector
  });
}

export async function embedBatch(texts, role = 'document') {
  if (!modelReady) throw new Error('Embedding engine not initialized');
  return withLock(async () => {
    const prefixed = texts.map(t => (role === 'query' ? PREFIXES.query : PREFIXES.document) + t);
    const inputs = await tokenizer(prefixed, { padding: true });
    const { sentence_embedding } = await model(inputs);
    const dim = sentence_embedding.dims[1];
    const flat = Array.from(sentence_embedding.data);
    // Guard: EMBED_DIM must not exceed model's native output dimension
    const truncDim = Math.min(EMBED_DIM, dim);
    const vectors = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * dim;
      const n = normalize(flat.slice(start, start + truncDim));
    vectors.push(n || flat.slice(start, start + truncDim));
    }
    return vectors;
  });
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
      importance: m.importance,
      recall_count: m.recall_count,
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

  // English patterns
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

// CJK patterns (Chinese + Japanese Hiragana/Katakana + Korean Hangul)
// Preference: 喜欢/偏好/爱/讨厌/不喜欢 + 好き/嫌い
if (/喜欢|偏好|爱|讨厌|不喜欢|最爱|喜好|倾向于|习惯用|常用|好き|嫌い/u.test(lower)) return 'preference';
// Project: 项目/在做/开发/构建 + プロジェクト/開発
if (/项目|在做|在开发|正在做|开发了|构建|工程|开发中|プロジェクト|開発/u.test(lower)) return 'project';
// Profile: 我叫/我的名字/我是/工作 + 名前/職業
if (/我叫|我的名字|我是|在.*工作|职位|从事|名为|名前|職業|仕事/u.test(lower)) return 'profile';
// Request: 需要/想要/请/帮我 + お願い/欲しい
if (/需要|想要|请|帮我|能不能|可以|帮帮忙|お願い|欲しい|ください/u.test(lower)) return 'request';
// Learning: 学习/研究/课程/教程 + 学習/勉強/研究
if (/学习|研究|课程|教程|学会了|在读|阅读|了解了|掌握了|学習|勉強|研究|授業/u.test(lower)) return 'learning';
// Setup: 技术/框架/环境/配置/安装 + 技術/環境/設定
if (/技术栈|框架|环境|配置|安装|部署|搭建|用的是|运行在|基于|技術|環境|設定|インストール/u.test(lower)) return 'setup';
// Goal: 目标/计划/打算/准备 + 目標/計画
if (/目标|计划|打算|准备|要做|未来|希望|期望|规划|目標|計画|予定/u.test(lower)) return 'goal';
// Issue: 错误/问题/报错/崩溃 + エラー/問題
if (/错误|问题|报错|崩溃|出错了|坏了|无法|失败|异常|エラー|問題|バグ|不具合/u.test(lower)) return 'issue';
// Pattern: 习惯/通常/一般/总是 + 習慣/通常
if (/习惯|通常|一般|总是|每次|经常|惯例|模式|習慣|通常|いつも|毎回|次々|喜恶/u.test(lower)) return 'pattern';
// Event: 昨天/今天/明天/上周/会议 + 昨日/今日/会議
if (/昨天|今天|明天|上周|下周|会议|日程|计划|约会|见面|昨日|今日|明日|会議|ミーティング/u.test(lower)) return 'event';

  return 'fact';
}

// Estimate memory importance (0-1) based on content analysis
// Used for retrieval weighting and consolidation priority
export function estimateImportance(text, type) {
  const lower = text.toLowerCase();
  let importance = 0.5; // baseline

  // Type-based defaults
  if (type === 'profile') importance = 0.9;     // who the user is — critical
  if (type === 'preference') importance = 0.8;  // user preferences — high
  if (type === 'setup') importance = 0.8;       // tech stack — high
  if (type === 'project') importance = 0.75;    // project context — high
  if (type === 'goal') importance = 0.7;        // goals — medium-high
  if (type === 'issue') importance = 0.6;       // issues — medium (may get resolved)
  if (type === 'pattern') importance = 0.65;    // habits — medium
  if (type === 'fact') importance = 0.5;        // generic facts — baseline
  if (type === 'event') importance = 0.4;       // events — decay fast
  if (type === 'request') importance = 0.3;     // requests — typically ephemeral
  if (type === 'learning') importance = 0.55;   // learning — medium

  // Boost for critical indicators
  if (/critical|essential|important|must|always|never|deadline|urgent/i.test(lower)) importance = Math.min(1.0, importance + 0.15);
  if (/password|secret|api.key|credential|token|auth/i.test(lower)) importance = Math.min(1.0, importance + 0.2); // security-critical
  if (/my name|i am |called |role |job title/i.test(lower)) importance = Math.min(1.0, importance + 0.1); // identity
// CJK+J security/identity boost
if (/密码|密钥|凭据|认证|パスワード|認証/u.test(lower)) importance = Math.min(1.0, importance + 0.2);
if (/我的名字|我叫|我是|职位|名前|職業/u.test(lower)) importance = Math.min(1.0, importance + 0.1);

  // Reduce for trivial indicators
  if (text.trim().length < 30) importance = Math.max(0.1, importance - 0.15);  // too short to be substantial
  if (/^(ok|okay|sure|yes|no|done|thanks|hi|hello|bye|good)\b/i.test(lower)) importance = 0.1; // trivial
  if (/maybe|might|perhaps|possibly/i.test(lower)) importance = Math.max(0.1, importance - 0.1); // uncertain
  // CJK trivial indicators
  if (/^(好的|对|嗯|谢|再见|没事|ok)/i.test(lower)) importance = 0.1;

  return Math.round(Math.max(0.1, Math.min(1.0, importance)) * 100) / 100;
}

// Maximal Marginal Relevance: diversify results by penalizing similarity to already-selected items
// lambda: 0.7 = relevance-heavy, 0.5 = balanced, 0.3 = diversity-heavy
export function mmrRerank(queryEmbedding, candidates, topK = 5, lambda = 0.7) {
  if (candidates.length <= topK) return candidates;

  const selected = [];
  const remaining = [...candidates];

  // Pick the most relevant first
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift());

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = lambda * remaining[i].score;
      // Max similarity to any already-selected item
      let maxSim = 0;
      if (remaining[i].embedding) {
        for (const s of selected) {
          if (s.embedding) {
            const sim = cosineSimilarity(remaining[i].embedding, s.embedding);
            if (sim > maxSim) maxSim = sim;
          }
        }
      }
      const diversity = (1 - lambda) * maxSim;
      const mmrScore = relevance - diversity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// Extract entity and attribute from text for contradiction detection
// Returns { entity, attribute } — e.g. "I prefer dark mode" → { entity: "user", attribute: "prefers_dark_mode" }
export function extractEntityAttribute(text) {
  const lower = text.toLowerCase();

  // 0. Negated preferences: "I don't like X", "I no longer use X"
  // Extract same attribute as positive form so contradiction detection can match
  const negMatch = lower.match(/(?:i |user )?(?:don'?t|do not|not|never|no longer|used to)\s+(prefer|like|love|hate|dislike|use|using|favor|choose)\s+(.+?)(?:\s+(?:for|when|while|because|over|instead|than|rather|$))/i);
  if (negMatch) {
    const verb = negMatch[1];
    const object = negMatch[2].trim().replace(/[.!?,;]+$/, '');
    return { entity: 'user', attribute: `${verb}_${object}`.replace(/\s+/g, '_') };
  }

  // 0b. State changes: "switched from X to Y" — attribute is the verb+object
  const switchMatch = lower.match(/(?:i |user )?(?:switched|moved|changed|migrated)\s+from\s+\S+\s+to\s+(.+?)(?:\s+(?:for|when|while|because|over|instead|than|rather|$))/i);
  if (switchMatch) {
    const object = switchMatch[1].trim().replace(/[.!?,;]+$/, '');
    return { entity: 'user', attribute: `use_${object}`.replace(/\s+/g, '_') };
  }

  // 1. Preferences: "I prefer X" / "I like X" / "I use X"
  const prefMatch = lower.match(/(?:i |user )?(prefer|like|love|hate|dislike|use|using|favor|choose|chose)\s+(.+?)(?:\s+(?:for|when|while|because|over|instead|than|rather|$))/i);
  if (prefMatch) {
    const verb = prefMatch[1];
    const object = prefMatch[2].trim().replace(/[.!?,;]+$/, '');
    return { entity: 'user', attribute: `${verb}_${object}`.replace(/\s+/g, '_') };
  }

  // 2. Identity: "My name is X" / "I am X" / "I work at X"
  const idMatch = lower.match(/(?:my name is|i'?m |i am |i work at|i work for|i'?m at)\s+(.+?)(?:\s*[.!?,;]|\s*$)/i);
  if (idMatch) {
    const value = idMatch[1].trim();
    if (/name|called/i.test(idMatch[0])) return { entity: 'user', attribute: 'name' };
    if (/work|job|employ/i.test(idMatch[0])) return { entity: 'user', attribute: 'employer' };
    return { entity: 'user', attribute: 'identity' };
  }

  // 3. Tech stack: "I use React" / "running Node 22"
  const techMatch = lower.match(/(?:use|using|running|built with|running on|stack is)\s+(\S+)/i);
  if (techMatch) {
    return { entity: 'user', attribute: `tech_${techMatch[1]}`.toLowerCase() };
  }

  // 4. Project: "building X" / "working on X"
  const projMatch = lower.match(/(?:building|working on|creating|developing|making)\s+(.+?)(?:\s+(?:with|using|for|called|named|\.|!|\?|,|;|$))/i);
  if (projMatch) {
    return { entity: 'user', attribute: `project_${projMatch[1].trim().replace(/\s+/g, '_')}` };
  }

  // CJK patterns
  // Negated preference: "不喜欢X" / "不再用X"
  const cjkNegMatch = text.match(/(?:不喜[欢迎]|不再|不用|讨厌)(.+?)(?:[，。、；\s]|$)/u);
  if (cjkNegMatch) {
    const object = cjkNegMatch[1].trim();
    if (object) return { entity: 'user', attribute: `dislike_${object}` };
  }

  // Preference: "喜欢X" / "偏好X" / "常用X"
  const cjkPrefMatch = text.match(/(?:喜欢|偏好|最[爱喜]|常用|习惯用|倾向[于]?)(.+?)(?:[，。、；\s]|$)/u);
  if (cjkPrefMatch) {
    const object = cjkPrefMatch[1].trim();
    if (object) return { entity: 'user', attribute: `prefer_${object}` };
  }

// Identity: "我叫X" / "我的名字是X" → name; "我是X" → identity
const cjkNameMatch = text.match(/(?:我叫|我的名字[是为])(.+?)(?:[，。、；\s]|$)/u);
if (cjkNameMatch) {
  const value = cjkNameMatch[1].trim();
  if (value) return { entity: 'user', attribute: 'name' };
}
const cjkIdentityMatch = text.match(/我是(.+?)(?:[，。、；\s]|$)/u);
if (cjkIdentityMatch) {
  const value = cjkIdentityMatch[1].trim();
  if (value) return { entity: 'user', attribute: 'identity' };
}
  const cjkWorkMatch = text.match(/我在(.+?)(?:工作|上班)/u);
  if (cjkWorkMatch) {
    return { entity: 'user', attribute: 'employer' };
  }

  // Tech: "用X" / "基于X" / "用的是X"
  const cjkTechMatch = text.match(/(?:用的是?|基于|运行在|采用)(.+?)(?:[，。、；\s开发构建]|$)/u);
  if (cjkTechMatch) {
    const tech = cjkTechMatch[1].trim();
    if (tech) return { entity: 'user', attribute: `tech_${tech}` };
  }

  // Project: "在做X" / "开发X" / "构建X"
  const cjkProjMatch = text.match(/(?:在做|在开发|正在做|开发了?|构建|开发中)(.+?)(?:[，。、；\s]|$)/u);
  if (cjkProjMatch) {
    const project = cjkProjMatch[1].trim();
    if (project) return { entity: 'user', attribute: `project_${project}` };
  }

  return { entity: '', attribute: '' };
}

// Generate a context prefix for contextual retrieval (Anthropic technique)
// Prepends a short anchor to the embedding input so the embedding captures origin context
export function generateContextPrefix(text, type, session_id = '') {
  const parts = [];
  if (type !== 'fact' && type !== 'general') {
    parts.push(type.charAt(0).toUpperCase() + type.slice(1));
  }
  // Add entity context from text
  const entAttr = extractEntityAttribute(text);
  if (entAttr.entity && entAttr.attribute) {
    parts.push(`about ${entAttr.entity}'s ${entAttr.attribute.replace(/_/g, ' ')}`);
  }
  if (session_id) {
    parts.push(`in session ${session_id.slice(0, 8)}`);
  }
  return parts.length > 0 ? parts.join(', ') + ':' : '';
}

export { cosineSimilarity, normalize, SIMILARITY_THRESHOLD, CONTRADICTION_THRESHOLD };
