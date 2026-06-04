/**
 * noxem-adapter.mjs — LEANN-inspired vector compression adapted for Noxem
 *
 * Adapts five LEANN techniques into the Noxem (better-sqlite3 + sqlite-vec) stack:
 *   1. Embedding eviction — drop low-importance memories.embedding BLOBs, recompute on search
 *   2. Hub-node caching — top-K by recall_count always resident, ~1.5x search speedup
 *   3. PQ-approximate pre-filter — product quantization codes for cheap first-pass KNN
 *   4. AST-aware code chunking — split code memories on function/class boundaries
 *   5. Dedup optimization — KNN-based dedup with lower threshold (~50 vs 500 cutoff)
 *
 * References:
 *   - LEANN (arXiv:2506.08276): hub-preserving graph pruning, PQ approximate queue,
 *     dynamic embedding recomputation
 *   - Jegou et al., "Product Quantization for Nearest Neighbor Search" (IEEE 2011)
 *
 * All functions receive a `db` reference (the better-sqlite3 Database exported by
 * memory-store.mjs) and use prepared statements for production throughput.
 */

// ── Configuration ──────────────────────────────────────────────────────────

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const PQ_NUM_SUBSPACES = parseInt(process.env.PQ_NUM_SUBSPACES || '8');
const PQ_CENTROIDS_PER_SUBSPACE = parseInt(process.env.PQ_CENTROIDS || '256'); // 256 = 8-bit codes
const PQ_CANDIDATE_MULTIPLIER = parseInt(process.env.PQ_CANDIDATE_MULTIPLIER || '4');

const EVICTION_THRESHOLD_DAYS = parseInt(process.env.EMBEDDING_EVICTION_THRESHOLD_DAYS || '60');
const EVICTION_MIN_RECALL = parseInt(process.env.EMBEDDING_EVICTION_MIN_RECALL || '2');
const EVICTION_MIN_IMPORTANCE = parseFloat(process.env.EMBEDDING_EVICTION_MIN_IMPORTANCE || '0.3');

const HUB_TOP_K = parseInt(process.env.HUB_NODE_TOP_K || '50');
const HUB_MIN_RECALL = parseInt(process.env.HUB_NODE_MIN_RECALL || '5');

const DEDUP_KNN_CANDIDATES = parseInt(process.env.DEDUP_KNN_CANDIDATES || '5');
const DEDUP_KNN_THRESHOLD = parseFloat(process.env.DEDUP_KNN_THRESHOLD || '0.85');

const CODE_CHUNK_MAX_LINES = parseInt(process.env.CODE_CHUNK_MAX_LINES || '60');
const CODE_CHUNK_OVERLAP_LINES = parseInt(process.env.CODE_CHUNK_OVERLAP_LINES || '5');

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Schema migration (adds PQ table + hub flag + has_embedding flag) ───────

const SCHEMA_VERSION = 1;

const _stmtCache = new WeakMap();

function _prepare(db, sql) {
  let cache = _stmtCache.get(db);
  if (!cache) { cache = new Map(); _stmtCache.set(db, cache); }
  let stmt = cache.get(sql);
  if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
  return stmt;
}

/**
 * Run schema migration to create the PQ table and add columns.
 * Idempotent — safe to call multiple times.
 */
export function ensureSchema(db) {
  const currentVersion = db.pragma('noxem_adapter_version', { simple: true }) || 0;
  if (currentVersion >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_pq_codes (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      pq_code BLOB NOT NULL,
      subspace_count INTEGER NOT NULL DEFAULT ${PQ_NUM_SUBSPACES},
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pq_codebooks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      codebook BLOB NOT NULL,
      subspace_dim INTEGER NOT NULL,
      num_subspaces INTEGER NOT NULL,
      centroids_per_subspace INTEGER NOT NULL,
      trained_at TEXT NOT NULL DEFAULT (datetime('now')),
      training_sample_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Add has_embedding and is_hub columns if missing
  const addColumn = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) {
      if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
    }
  };
  addColumn('memories', 'has_embedding', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memories', 'is_hub', 'INTEGER NOT NULL DEFAULT 0');

  // Backfill has_embedding from existing embedding column
  db.exec(`UPDATE memories SET has_embedding = CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END WHERE has_embedding = 0`);

  db.pragma(`noxem_adapter_version = ${SCHEMA_VERSION}`);
  LOG_DEBUG && console.log(`[NoxemAdapter] Schema v${SCHEMA_VERSION} applied`);
}


// ── 1. Embedding Eviction ──────────────────────────────────────────────────

/**
 * Evict (drop) embedding BLOBs for low-importance, low-recall memories.
 * Keeps the sqlite-vec rowid entry and the memory text intact.
 * Recompute-on-search is handled by ensureEmbeddingOnSearch().
 *
 * @param {Database} db — better-sqlite3 Database
 * @param {object} [options]
 * @param {number} [options.olderThanDays] — minimum age in days (default: EMBEDDING_EVICTION_THRESHOLD_DAYS)
 * @param {number} [options.minRecall] — skip memories with recall_count >= this (default: EVICTION_MIN_RECALL)
 * @param {number} [options.minImportance] — skip memories with importance >= this (default: EVICTION_MIN_IMPORTANCE)
 * @returns {{ evicted: number, kept_hub: number, total_candidate: number }}
 */
export function evictEmbeddings(db, options = {}) {
  ensureSchema(db);
  const olderThanDays = options.olderThanDays ?? EVICTION_THRESHOLD_DAYS;
  const minRecall = options.minRecall ?? EVICTION_MIN_RECALL;
  const minImportance = options.minImportance ?? EVICTION_MIN_IMPORTANCE;

  // Find candidates: active, has embedding, not a hub, low recall and low importance
  const candidates = _prepare(db, `
    SELECT id FROM memories
    WHERE status = 'active'
      AND has_embedding = 1
      AND is_hub = 0
      AND recall_count < ?
      AND importance < ?
      AND created_at < datetime('now', '-' || ? || ' days')
  `).all(minRecall, minImportance, olderThanDays);

  if (candidates.length === 0) return { evicted: 0, kept_hub: 0, total_candidate: 0 };

  const evictStmt = _prepare(db, `
    UPDATE memories SET embedding = NULL, has_embedding = 0, updated_at = datetime('now')
    WHERE id = ? AND is_hub = 0
  `);

  let evicted = 0;
  const evictTx = db.transaction((ids) => {
    for (const { id } of ids) {
      const r = evictStmt.run(id);
      evicted += r.changes;
    }
  });
  evictTx(candidates);

  LOG_DEBUG && console.log(`[NoxemAdapter] Evicted ${evicted} embeddings (of ${candidates.length} candidates)`);
  return { evicted, kept_hub: candidates.length - evicted, total_candidate: candidates.length };
}

/**
 * Ensure a memory has an embedding before search. If embedding was evicted,
 * call the provided embedFn to recompute it.
 *
 * @param {Database} db
 * @param {number} memoryId
 * @param {Function} embedFn — async (text) => Float32Array
 * @returns {Promise<Float32Array|null>} — the embedding (existing or recomputed)
 */
export async function ensureEmbeddingOnSearch(db, memoryId, embedFn) {
  const mem = _prepare(db, `SELECT id, text, has_embedding, embedding FROM memories WHERE id = ?`).get(memoryId);
  if (!mem) return null;

  if (mem.has_embedding && mem.embedding) {
    // Convert BLOB to Float32Array
    return new Float32Array(mem.embedding.buffer, mem.embedding.byteOffset, Math.floor(mem.embedding.byteLength / 4));
  }

  // Embedding was evicted — recompute
  if (!embedFn) return null;
  try {
    const vec = await embedFn(mem.text);
    if (!vec) return null;

    const buf = Buffer.from(new Float32Array(vec).buffer);
    _prepare(db, `
      UPDATE memories SET embedding = ?, has_embedding = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(buf, memoryId);

    LOG_DEBUG && console.log(`[NoxemAdapter] Recomputed embedding for memory ${memoryId}`);
    return new Float32Array(vec);
  } catch (e) {
    LOG_DEBUG && console.error(`[NoxemAdapter] Recompute failed for memory ${memoryId}:`, e.message);
    return null;
  }
}


// ── 2. Hub-Node Caching ───────────────────────────────────────────────────

/**
 * Identify and mark hub nodes — the top-K memories by recall_count.
 * Hub embeddings are always kept resident (never evicted).
 * Per LEANN paper: ~10% of memories cached yield ~40% cache hit rate.
 *
 * @param {Database} db
 * @param {object} [options]
 * @param {number} [options.topK] — number of hubs to mark (default: HUB_TOP_K)
 * @param {number} [options.minRecall] — minimum recall_count to be considered (default: HUB_MIN_RECALL)
 * @returns {{ hubs_marked: number, total_candidates: number }}
 */
export function markHubNodes(db, options = {}) {
  ensureSchema(db);
  const topK = options.topK ?? HUB_TOP_K;
  const minRecall = options.minRecall ?? HUB_MIN_RECALL;

  // Clear existing hub flags
  _prepare(db, `UPDATE memories SET is_hub = 0 WHERE is_hub = 1`).run();

  // Mark top-K by recall_count (among active memories with sufficient recall)
  const result = _prepare(db, `
    UPDATE memories SET is_hub = 1
    WHERE id IN (
      SELECT id FROM memories
      WHERE status = 'active' AND recall_count >= ?
      ORDER BY recall_count DESC, importance DESC
      LIMIT ?
    )
  `).run(minRecall, topK);

  LOG_DEBUG && console.log(`[NoxemAdapter] Marked ${result.changes} hub nodes`);
  return { hubs_marked: result.changes, total_candidates: topK };
}

/**
 * Get hub memory IDs — the set of always-resident embeddings.
 *
 * @param {Database} db
 * @returns {number[]} — array of memory IDs marked as hubs
 */
export function getHubNodeIds(db) {
  return _prepare(db, `SELECT id FROM memories WHERE is_hub = 1 AND status = 'active' ORDER BY recall_count DESC`).all().map(r => r.id);
}


// ── 3. PQ-Approximate Pre-filter ───────────────────────────────────────────

/**
 * Train PQ codebooks from existing embeddings using K-means per subspace.
 * Pure JS implementation — no native dependencies beyond better-sqlite3.
 *
 * Algorithm (per Jegou et al. 2011):
 *   1. Split each 256d vector into 8 subspaces of 32 dimensions each
 *   2. Run K-means (k=256) independently on each subspace
 *   3. Store codebook: 8 subspaces x 256 centroids x 32 floats = 64KB
 *   4. Encode each vector as 8 bytes (one 8-bit centroid index per subspace)
 *
 * @param {Database} db
 * @param {object} [options]
 * @param {number} [options.numSubspaces] — default PQ_NUM_SUBSPACES (8)
 * @param {number} [options.centroids] — default PQ_CENTROIDS_PER_SUBSPACE (256)
 * @param {number} [options.maxIterations] — K-means iterations (default: 20)
 * @param {number} [options.sampleLimit] — max vectors to train on (default: 5000)
 * @returns {{ subspaces: number, centroids: number, sampleCount: number }}
 */
export function trainPQCodebooks(db, options = {}) {
  ensureSchema(db);
  const numSubspaces = options.numSubspaces ?? PQ_NUM_SUBSPACES;
  const centroidsPerSub = options.centroids ?? PQ_CENTROIDS_PER_SUBSPACE;
  const maxIter = options.maxIterations ?? 20;
  const sampleLimit = options.sampleLimit ?? 5000;

  const subspaceDim = Math.floor(EMBED_DIM / numSubspaces);
  if (subspaceDim * numSubspaces !== EMBED_DIM) {
    throw new Error(`EMBED_DIM (${EMBED_DIM}) must be divisible by numSubspaces (${numSubspaces})`);
  }

  // Load embeddings
  const rows = _prepare(db, `
    SELECT id, embedding FROM memories
    WHERE status = 'active' AND embedding IS NOT NULL
    ORDER BY random()
    LIMIT ?
  `).all(sampleLimit);

  if (rows.length < centroidsPerSub) {
    LOG_DEBUG && console.warn(`[NoxemAdapter] PQ training skipped: only ${rows.length} vectors (need >= ${centroidsPerSub})`);
    return { subspaces: numSubspaces, centroids: centroidsPerSub, sampleCount: rows.length };
  }

  // Decode embeddings into Float32Array[]
  const vectors = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    vectors.push(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, Math.floor(row.embedding.byteLength / 4)));
  }

  // K-means per subspace
  const codebook = new Float32Array(numSubspaces * centroidsPerSub * subspaceDim);

  for (let s = 0; s < numSubspaces; s++) {
    const offset = s * subspaceDim;
    const centroids = _kmeans(vectors, offset, subspaceDim, centroidsPerSub, maxIter);
    codebook.set(centroids, s * centroidsPerSub * subspaceDim);
  }

  // Store codebook
  const codebookBuf = Buffer.from(codebook.buffer);
  _prepare(db, `
    INSERT OR REPLACE INTO pq_codebooks (id, codebook, subspace_dim, num_subspaces, centroids_per_subspace, trained_at, training_sample_count)
    VALUES (1, ?, ?, ?, ?, datetime('now'), ?)
  `).run(codebookBuf, subspaceDim, numSubspaces, centroidsPerSub, vectors.length);

  LOG_DEBUG && console.log(`[NoxemAdapter] PQ codebooks trained: ${numSubspaces} subspaces x ${centroidsPerSub} centroids, ${vectors.length} samples`);
  return { subspaces: numSubspaces, centroids: centroidsPerSub, sampleCount: vectors.length };
}

/**
 * Encode all active embeddings into PQ codes and store them.
 * Must be called after trainPQCodebooks().
 *
 * @param {Database} db
 * @returns {{ encoded: number, skipped: number }}
 */
export function encodePQCodes(db) {
  ensureSchema(db);

  const cbRow = _prepare(db, `SELECT * FROM pq_codebooks WHERE id = 1`).get();
  if (!cbRow) throw new Error('PQ codebooks not trained — call trainPQCodebooks() first');

  const codebook = new Float32Array(cbRow.codebook.buffer, cbRow.codebook.byteOffset,
    Math.floor(cbRow.codebook.byteLength / 4));
  const { subspace_dim: subDim, num_subspaces: numSub, centroids_per_subspace: numCent } = cbRow;

  // Load all active embeddings
  const rows = _prepare(db, `
    SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL
  `).all();

  const insertCode = _prepare(db, `
    INSERT OR REPLACE INTO memory_pq_codes (memory_id, pq_code, subspace_count, computed_at)
    VALUES (?, ?, ?, datetime('now'))
  `);

  let encoded = 0;
  let skipped = 0;
  const encodeTx = db.transaction(() => {
    for (const row of rows) {
      if (!row.embedding) { skipped++; continue; }
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset,
        Math.floor(row.embedding.byteLength / 4));
      const pqCode = _encodeVectorPQ(vec, codebook, numSub, subDim, numCent);
      insertCode.run(row.id, pqCode, numSub);
      encoded++;
    }
  });
  encodeTx();

  LOG_DEBUG && console.log(`[NoxemAdapter] PQ encoded: ${encoded} vectors, ${skipped} skipped`);
  return { encoded, skipped };
}

/**
 * PQ-approximate KNN search: cheap first-pass using PQ distance estimation,
 * then full cosine reranking on the top candidates.
 *
 * This is the Noxem equivalent of LEANN's two-level search with PQ-compressed
 * approximate queue. PQ distance is asymmetric distance estimation (ADE):
 *   d_PQ(q, x) = sum_s || q_s - c_s(code_s(x)) ||^2
 *
 * @param {Database} db
 * @param {Float32Array} queryVec — the query embedding (EMBED_DIM dimensions)
 * @param {number} topK — number of results to return
 * @param {object} [options]
 * @param {number} [options.candidateMultiplier] — PQ returns topK * this many candidates (default: 4)
 * @returns {{ id: number, score: number }[]|null} — null if PQ not available
 */
export function knnSearchPQ(db, queryVec, topK = 5, options = {}) {
  const cbRow = _prepare(db, `SELECT * FROM pq_codebooks WHERE id = 1`).get();
  if (!cbRow) return null; // PQ not trained — caller should fall back to full search

  const codebook = new Float32Array(cbRow.codebook.buffer, cbRow.codebook.byteOffset,
    Math.floor(cbRow.codebook.byteLength / 4));
  const { subspace_dim: subDim, num_subspaces: numSub, centroids_per_subspace: numCent } = cbRow;
  const candidateMultiplier = options.candidateMultiplier ?? PQ_CANDIDATE_MULTIPLIER;
  const numCandidates = topK * candidateMultiplier;

  // Precompute query subvectors' distances to each centroid in each subspace
  // lookupTable[s][c] = || q_s - centroid_s_c ||^2
  const lookupTable = _buildPQLookupTable(queryVec, codebook, numSub, subDim, numCent);

  // Load all PQ codes
  const pqRows = _prepare(db, `
    SELECT mc.memory_id, mc.pq_code
    FROM memory_pq_codes mc
    JOIN memories m ON m.id = mc.memory_id
    WHERE m.status = 'active'
  `).all();

  if (pqRows.length === 0) return null;

  // Compute approximate distances using lookup table
  const scored = [];
  for (const row of pqRows) {
    const pqCode = new Uint8Array(row.pq_code.buffer, row.pq_code.byteOffset, row.pq_code.byteLength);
    let distSq = 0;
    for (let s = 0; s < numSub && s < pqCode.length; s++) {
      distSq += lookupTable[s * numCent + pqCode[s]];
    }
    scored.push({ id: row.memory_id, approxDist: distSq });
  }

  // Sort by approximate distance (ascending = closer = better)
  scored.sort((a, b) => a.approxDist - b.approxDist);
  const candidates = scored.slice(0, numCandidates);

  // Full cosine rerank on candidates
  const cosineScored = [];
  for (const c of candidates) {
    const mem = _prepare(db, `SELECT embedding, has_embedding FROM memories WHERE id = ?`).get(c.id);
    if (!mem || !mem.has_embedding || !mem.embedding) continue;
    const emb = new Float32Array(mem.embedding.buffer, mem.embedding.byteOffset,
      Math.floor(mem.embedding.byteLength / 4));
    const score = _cosineSimilarity(queryVec, emb);
    if (Number.isNaN(score)) continue;
    cosineScored.push({ id: c.id, score: Math.round(score * 1000) / 1000 });
  }

  cosineScored.sort((a, b) => b.score - a.score);
  return cosineScored.slice(0, topK);
}


// ── 4. AST-Aware Code Chunking ─────────────────────────────────────────────

/**
 * Regex-based AST-aware chunking for code memories.
 * Splits on function/class/method boundaries to avoid mid-function splits.
 * Falls back gracefully to line-based splitting for non-structural code.
 *
 * Adapted from LEANN's astchunk integration (chunking_utils.py) but uses
 * regex instead of tree-sitter to avoid native dependencies.
 *
 * @param {string} codeText — the source code to chunk
 * @param {object} [options]
 * @param {string} [options.language] — 'javascript', 'python', 'typescript', etc. (auto-detected if omitted)
 * @param {number} [options.maxLines] — maximum lines per chunk (default: CODE_CHUNK_MAX_LINES)
 * @param {number} [options.overlapLines] — overlap lines between chunks (default: CODE_CHUNK_OVERLAP_LINES)
 * @returns {{ text: string, metadata: { startLine: number, endLine: number, language: string } }[]}
 */
export function chunkCodeAST(codeText, options = {}) {
  const maxLines = options.maxLines ?? CODE_CHUNK_MAX_LINES;
  const overlapLines = options.overlapLines ?? CODE_CHUNK_OVERLAP_LINES;
  const language = options.language || _detectCodeLanguage(codeText);

  const lines = codeText.split('\n');
  if (lines.length <= maxLines) {
    return [{
      text: codeText,
      metadata: { startLine: 1, endLine: lines.length, language },
    }];
  }

  // Find AST boundary lines: function/class/method/export declarations
  const boundaryPattern = _getBoundaryPattern(language);
  const boundaries = [0]; // always start from line 0
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && boundaryPattern.test(lines[i])) {
      boundaries.push(i);
    }
  }
  boundaries.push(lines.length); // sentinel

  // Build chunks that respect AST boundaries but stay within maxLines
  const chunks = [];
  let chunkStart = 0;

  while (chunkStart < lines.length) {
    // Find the farthest boundary that fits within maxLines
    let chunkEnd = Math.min(chunkStart + maxLines, lines.length);
    let bestBoundary = chunkEnd;

    for (const b of boundaries) {
      if (b > chunkStart && b <= chunkStart + maxLines) {
        bestBoundary = b;
      } else if (b > chunkStart + maxLines) {
        break;
      }
    }
    chunkEnd = bestBoundary;

    // Extract chunk with overlap from previous
    const overlapStart = Math.max(0, chunkStart - (chunks.length > 0 ? overlapLines : 0));
    const chunkLines = lines.slice(overlapStart, chunkEnd);

    chunks.push({
      text: chunkLines.join('\n'),
      metadata: {
        startLine: overlapStart + 1,
        endLine: chunkEnd,
        language,
      },
    });

    chunkStart = chunkEnd;
  }

  return chunks;
}

/**
 * Detect if text contains code and identify its language.
 * Used by categorizeText() integration to route code through AST chunking.
 *
 * @param {string} text
 * @returns {{ isCode: boolean, language: string }}
 */
export function detectCodeContent(text) {
  // Code fence detection
  const fenceMatch = text.match(/^```(\w+)\s*$/m);
  if (fenceMatch) {
    return { isCode: true, language: _normalizeLanguage(fenceMatch[1]) };
  }

  // Heuristic: function/class declarations, import statements, significant indentation
  const codeIndicators = [
    /^(export\s+)?(function|class|const|let|var|interface|type|enum)\s/m,
    /^(import|from|require|def |async def |class )\s/m,
    /^\s+(return|if|for|while|try|catch|else|elif)\s/m,
    /[{}\[\];]\s*$/m,
  ];

  let score = 0;
  for (const p of codeIndicators) {
    if (p.test(text)) score++;
  }

  const isCode = score >= 2;
  return { isCode, language: isCode ? _detectCodeLanguage(text) : 'text' };
}


// ── 5. Dedup Optimization ──────────────────────────────────────────────────

/**
 * KNN-based deduplication: uses vector KNN to find near-duplicates
 * instead of O(n^2) brute-force. Works for any corpus size.
 *
 * For each memory, find its K nearest neighbors. If any neighbor has
 * cosine similarity > threshold, mark as duplicate.
 *
 * @param {Database} db
 * @param {Function} knnFn — async (queryEmbedding, topK) => [{id, score}]
 *   This should be vectorKnnSearchAsync or knnSearchHybrid from vector-index.mjs
 * @param {object} [options]
 * @param {number} [options.candidates] — KNN candidates per query (default: DEDUP_KNN_CANDIDATES)
 * @param {number} [options.threshold] — cosine threshold for duplicates (default: DEDUP_KNN_THRESHOLD)
 * @param {number} [options.batchSize] — process memories in batches (default: 100)
 * @returns {Promise<{ a: object, b: object, similarity: number }[]>}
 */
export async function findDuplicatesKNN(db, knnFn, options = {}) {
  const candidates = options.candidates ?? DEDUP_KNN_CANDIDATES;
  const threshold = options.threshold ?? DEDUP_KNN_THRESHOLD;
  const batchSize = options.batchSize ?? 100;

  const allMemories = _prepare(db, `
    SELECT id, text, type, session_id, embedding, importance, recall_count, created_at
    FROM memories WHERE status = 'active' AND embedding IS NOT NULL
    ORDER BY id
  `).all();

  // Decode embeddings
  const mems = allMemories.map(m => ({
    ...m,
    embedding: new Float32Array(m.embedding.buffer, m.embedding.byteOffset,
      Math.floor(m.embedding.byteLength / 4)),
  }));

  const seen = new Set();
  const duplicates = [];

  for (let i = 0; i < mems.length; i += batchSize) {
    const batch = mems.slice(i, i + batchSize);

    for (const mem of batch) {
      const key = mem.id;
      if (seen.has(key)) continue;

      try {
        const hits = await knnFn(mem.embedding, candidates + 1);
        if (!hits) continue;

        for (const hit of hits) {
          const hitId = typeof hit.id === 'bigint' ? Number(hit.id) : hit.id;
          if (hitId === mem.id) continue; // skip self

          const pairKey = [Math.min(mem.id, hitId), Math.max(mem.id, hitId)].join(':');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);

          if (hit.score >= threshold) {
            const other = mems.find(m => m.id === hitId);
            if (other) {
              duplicates.push({
                a: { id: mem.id, text: mem.text, type: mem.type, importance: mem.importance },
                b: { id: other.id, text: other.text, type: other.type, importance: other.importance },
                similarity: hit.score,
              });
            }
          }
        }
      } catch (e) {
        LOG_DEBUG && console.error(`[NoxemAdapter] KNN dedup failed for memory ${mem.id}:`, e.message);
      }
    }
  }

  LOG_DEBUG && console.log(`[NoxemAdapter] KNN dedup found ${duplicates.length} duplicate pairs`);
  return duplicates;
}


// ── Internal helpers ────────────────────────────────────────────────────────

/** Cosine similarity between two Float32Arrays */
function _cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-10) return 0;
  return dot / denom;
}

/** K-means clustering for a single PQ subspace */
function _kmeans(vectors, offset, dim, k, maxIter) {
  const n = vectors.length;
  if (n === 0) return new Float32Array(k * dim);

  // Initialize centroids with random samples (forgy method)
  const centroids = new Float32Array(k * dim);
  const used = new Set();
  for (let c = 0; c < k; c++) {
    let idx;
    do { idx = Math.floor(Math.random() * n); } while (used.has(idx) && used.size < n);
    used.add(idx);
    const vec = vectors[idx];
    for (let d = 0; d < dim; d++) {
      centroids[c * dim + d] = vec[offset + d];
    }
  }

  const assignments = new Uint16Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each vector to nearest centroid
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestDist = Infinity;
      const vec = vectors[i];
      for (let c = 0; c < k; c++) {
        let distSq = 0;
        for (let d = 0; d < dim; d++) {
          const diff = vec[offset + d] - centroids[c * dim + d];
          distSq += diff * diff;
        }
        if (distSq < bestDist) { bestDist = distSq; bestC = c; }
      }
      assignments[i] = bestC;
    }

    // Recompute centroids
    const counts = new Uint32Array(k);
    const sums = new Float32Array(k * dim);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const vec = vectors[i];
      for (let d = 0; d < dim; d++) {
        sums[c * dim + d] += vec[offset + d];
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c * dim + d] = sums[c * dim + d] / counts[c];
      }
    }
  }

  return centroids;
}

/** Encode a single vector into PQ codes (8-bit per subspace) */
function _encodeVectorPQ(vec, codebook, numSub, subDim, numCent) {
  const pqCode = new Uint8Array(numSub);
  for (let s = 0; s < numSub; s++) {
    const offset = s * subDim;
    const centOffset = s * numCent * subDim;
    let bestC = 0;
    let bestDist = Infinity;
    for (let c = 0; c < numCent; c++) {
      let distSq = 0;
      for (let d = 0; d < subDim; d++) {
        const diff = vec[offset + d] - codebook[centOffset + c * subDim + d];
        distSq += diff * diff;
      }
      if (distSq < bestDist) { bestDist = distSq; bestC = c; }
    }
    pqCode[s] = bestC;
  }
  return Buffer.from(pqCode);
}

/** Build PQ lookup table: precompute distance from each query subspace to each centroid */
function _buildPQLookupTable(queryVec, codebook, numSub, subDim, numCent) {
  const table = new Float32Array(numSub * numCent);
  for (let s = 0; s < numSub; s++) {
    const qOffset = s * subDim;
    const centOffset = s * numCent * subDim;
    for (let c = 0; c < numCent; c++) {
      let distSq = 0;
      for (let d = 0; d < subDim; d++) {
        const diff = queryVec[qOffset + d] - codebook[centOffset + c * subDim + d];
        distSq += diff * diff;
      }
      table[s * numCent + c] = distSq;
    }
  }
  return table;
}

/** Regex patterns for AST boundary detection by language */
function _getBoundaryPattern(language) {
  const patterns = {
    javascript: /^(export\s+)?(function|class|const|let|var|interface|type|enum)\s/,
    typescript: /^(export\s+)?(function|class|const|let|var|interface|type|enum|namespace)\s/,
    python: /^(def |async def |class |@)/,
    java: /^(public |private |protected |static )?(class |interface |enum |void |[A-Z])/,
    csharp: /^(public |private |protected |internal |static )?(class |interface |enum |struct |void )/,
    default: /^(function |class |def |export |import |public |module )/,
  };
  return patterns[language] || patterns.default;
}

/** Detect programming language from code text content */
function _detectCodeLanguage(text) {
  if (/^import\s.*from\s+['"]|\bexports?\.\w+|require\s*\(/m.test(text)) return 'javascript';
  if (/^import\s+.*from\s+['"]|:\s*(string|number|boolean|any|void)\b|interface\s+\w+/m.test(text)) return 'typescript';
  if (/^def\s|^class\s|import\s+\w+|^from\s+\w+\s+import/m.test(text)) return 'python';
  if (/^(public|private)\s+(class|static|void)\s|System\.out\.print/m.test(text)) return 'java';
  if (/^(using|namespace)\s|static\s+(void|int|string)\s+Main/m.test(text)) return 'csharp';
  return 'javascript'; // default
}

/** Normalize language name from code fence identifier */
function _normalizeLanguage(lang) {
  const map = { js: 'javascript', ts: 'typescript', py: 'python', cs: 'csharp', rb: 'ruby' };
  return map[lang?.toLowerCase()] || lang?.toLowerCase() || 'javascript';
}


// ── Convenience: Full integration pipeline ──────────────────────────────────

/**
 * Run the full Noxem-adapter optimization pipeline.
 * Called during maintenance to keep PQ codes, hub flags, and eviction state current.
 *
 * @param {Database} db
 * @param {Function} [embedFn] — async (text) => Float32Array — for recomputation
 * @returns {Promise<object>} — summary of all operations
 */
export async function runMaintenancePipeline(db, embedFn) {
  const results = {};

  // 1. Mark hub nodes
  results.hubs = markHubNodes(db);

  // 2. Evict low-importance embeddings
  results.eviction = evictEmbeddings(db);

  // 3. Train PQ codebooks (if enough embeddings exist)
  try {
    const trainingResult = trainPQCodebooks(db);
    results.pq_training = trainingResult;

    // 4. Encode all embeddings into PQ codes
    if (trainingResult.sampleCount >= PQ_CENTROIDS_PER_SUBSPACE) {
      results.pq_encoding = encodePQCodes(db);
    }
  } catch (e) {
    results.pq_error = e.message;
  }

  // 5. Re-embed hub nodes that lost their embeddings (safety net)
  if (embedFn) {
    const hubRows = _prepare(db, `
      SELECT id, text FROM memories WHERE is_hub = 1 AND has_embedding = 0 AND status = 'active'
    `).all();
    let reembedded = 0;
    for (const row of hubRows) {
      try {
        const vec = await embedFn(row.text);
        if (vec) {
          const buf = Buffer.from(new Float32Array(vec).buffer);
          _prepare(db, `UPDATE memories SET embedding = ?, has_embedding = 1, updated_at = datetime('now') WHERE id = ?`).run(buf, row.id);
          reembedded++;
        }
      } catch (e) {
        LOG_DEBUG && console.error(`[NoxemAdapter] Hub re-embed failed for ${row.id}:`, e.message);
      }
    }
    results.hub_reembedded = reembedded;
  }

  return results;
}
