// Optional sqlite-vec integration for native vector KNN search
// Falls back to JS cosine similarity if sqlite-vec is unavailable

let sqliteVec = null;
let vecAvailable = false;
let vecTableReady = false;

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

export async function initVectorIndex(db) {
  try {
    sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);

    // Check for EMBED_DIM mismatch: if vec0 table already exists with different dimension
    try {
      const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_vecs'").get();
      if (existing?.sql) {
        const dimMatch = existing.sql.match(/float\[(\d+)\]/);
        if (dimMatch && parseInt(dimMatch[1]) !== EMBED_DIM) {
          console.warn(`[VectorIndex] EMBED_DIM mismatch: table has ${dimMatch[1]}d but config is ${EMBED_DIM}d. Dropping and recreating.`);
          db.exec('DROP TABLE IF EXISTS memory_vecs');
        }
      }
    } catch (e) { LOG_DEBUG && console.error('[VectorIndex] Dim check error:', e.message); }

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vecs USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine)`);
    vecAvailable = true;
    vecTableReady = true;
    if (LOG_DEBUG) console.log(`[VectorIndex] sqlite-vec loaded — native KNN search enabled (${EMBED_DIM}d, cosine)`);
  } catch (err) {
    vecAvailable = false;
    if (LOG_DEBUG) console.log(`[VectorIndex] sqlite-vec unavailable — JS cosine fallback active (install sqlite-vec for native KNN)`);
    if (LOG_DEBUG) console.error(`[VectorIndex] Load error: ${err.message}`);
  }
}

export function isVecReady() {
  return vecTableReady;
}

// Insert embedding into vec0 table — must call after storing in memories table
export function insertVec(db, memoryId, embeddingArray) {
  if (!vecTableReady || !embeddingArray) return;
  try {
    const vec = new Float32Array(embeddingArray.slice(0, EMBED_DIM));
    db.prepare('INSERT OR REPLACE INTO memory_vecs(rowid, embedding) VALUES (?, ?)').run(BigInt(memoryId), vec);
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] insertVec failed:', err.message);
  }
}

// Batch insert embeddings — call after storeMemories
export function insertVecBatch(db, ids, embeddings) {
  if (!vecTableReady || !embeddings) return;
  const stmt = db.prepare('INSERT OR REPLACE INTO memory_vecs(rowid, embedding) VALUES (?, ?)');
  const batch = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      if (embeddings[i]) {
        try {
          stmt.run(BigInt(ids[i]), new Float32Array(embeddings[i].slice(0, EMBED_DIM)));
        } catch (err) { LOG_DEBUG && console.error('[VectorIndex] batch insert failed for', ids[i], err.message); }
      }
    }
  });
  batch();
}

// KNN search using sqlite-vec — returns [{id, distance, score}]
// distance is cosine distance (1 - similarity), convert to similarity score
export function knnSearch(db, queryEmbedding, topK = 5) {
  if (!vecTableReady) return null;
  try {
    const vec = new Float32Array(queryEmbedding.slice(0, EMBED_DIM));
    // Some sqlite-vec builds require AND k = ?; others work with LIMIT ?
    let results;
    try {
      results = db.prepare(`
  SELECT rowid as id, distance
  FROM memory_vecs
  WHERE embedding MATCH ? AND k = ?
  ORDER BY distance
`).all(vec, topK);
    } catch {
      results = db.prepare(`
  SELECT rowid as id, distance
  FROM memory_vecs
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(vec, topK);
    }
    // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
    // Convert to similarity: score = 1 - distance
    return results.map(r => ({
      id: Number(r.id),
      score: Math.max(0, Math.round((1 - r.distance) * 1000) / 1000),
    }));
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] knnSearch error:', err.message);
    return null;
  }
}

// Delete a vector from the index
export function deleteVec(db, memoryId) {
  if (!vecTableReady) return;
  try {
    db.prepare('DELETE FROM memory_vecs WHERE rowid = ?').run(BigInt(memoryId));
  } catch (err) { LOG_DEBUG && console.error('[VectorIndex] deleteVec failed:', err.message); }
}



// ── TurboVec Sidecar Integration ────────────────────────

const TURBOVEC_URL = process.env.TURBOVEC_URL || 'http://127.0.0.1:3003';
const VECTOR_BACKEND = process.env.VECTOR_BACKEND || 'hybrid'; // sqlite | turbovec | hybrid (default: hybrid for TurboVec + sqlite-vec)
let turboVecHealthy = false;

/**
 * Check if TurboVec sidecar is alive.
 */
export async function checkTurboVecHealth() {
  try {
    const res = await fetch(`${TURBOVEC_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    turboVecHealthy = data.ok && data.index_loaded;
    return data;
  } catch {
    turboVecHealthy = false;
    return { ok: false, turbovec_installed: false };
  }
}

/**
 * Add vectors to TurboVec sidecar.
 */
export async function addToTurboVec(ids, vectors) {
  if (!turboVecHealthy) return { added: 0 };
  try {
    const res = await fetch(`${TURBOVEC_URL}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, vectors: vectors.map(v => Array.from(v)) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`TurboVec add returned ${res.status}`);
    return await res.json();
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] addToTurboVec failed:', err.message);
    return { added: 0, error: err.message };
  }
}

/**
 * KNN search via TurboVec sidecar. Returns [{id, score}].
 */
export async function knnSearchTurbo(queryEmbedding, topK = 10, allowlist = null) {
  if (!turboVecHealthy) return null;
  try {
    const body = {
      query: Array.from(queryEmbedding.slice(0, EMBED_DIM)),
      k: topK,
    };
    if (allowlist && allowlist.length > 0) body.allowlist = allowlist;
    const res = await fetch(`${TURBOVEC_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] knnSearchTurbo error:', err.message);
    return null;
  }
}

/**
 * Remove a vector from TurboVec sidecar.
 */
export async function removeFromTurboVec(id) {
  if (!turboVecHealthy) return false;
  try {
    const res = await fetch(`${TURBOVEC_URL}/remove/${id}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data.removed || false;
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] removeFromTurboVec failed:', err.message);
    return false;
  }
}

/**
 * Save TurboVec index to disk.
 */
export async function saveTurboVec() {
  if (!turboVecHealthy) return false;
  try {
    const res = await fetch(`${TURBOVEC_URL}/save`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return data.ok || false;
  } catch (err) {
    LOG_DEBUG && console.error('[VectorIndex] saveTurboVec failed:', err.message);
    return false;
  }
}

/**
 * Hybrid KNN search: combines sqlite-vec and TurboVec results.
 * Routes based on VECTOR_BACKEND env: sqlite (default), turbovec, or hybrid.
 * Returns [{id, score}] sorted by score descending.
 */
export async function knnSearchHybrid(db, queryEmbedding, topK = 10, allowlist = null) {
  const backend = VECTOR_BACKEND;

  if (backend === 'turbovec') {
    const results = await knnSearchTurbo(queryEmbedding, topK, allowlist);
    return results || [];
  }

  if (backend === 'hybrid') {
    // Query both backends in parallel
    const [sqliteResults, turboResults] = await Promise.all([
      Promise.resolve(knnSearch(db, queryEmbedding, topK)),
      knnSearchTurbo(queryEmbedding, topK, allowlist),
    ]);

    // Merge by ID, keeping best score per ID
    const byId = new Map();
    for (const r of (sqliteResults || [])) {
      if (allowlist && !allowlist.includes(r.id)) continue;
      byId.set(r.id, r.score);
    }
    for (const r of (turboResults || [])) {
      if (allowlist && !allowlist.includes(r.id)) continue;
      const existing = byId.get(r.id);
      if (existing === undefined || r.score > existing) {
        byId.set(r.id, r.score);
      }
    }

    return Array.from(byId.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // Default: sqlite only
  const results = knnSearch(db, queryEmbedding, topK);
  if (allowlist && results) {
    return results.filter(r => allowlist.includes(r.id));
  }
  return results || [];
}

export function isTurboVecHealthy() { return turboVecHealthy; }
export function getVectorBackend() { return VECTOR_BACKEND; }

export default { initVectorIndex, isVecReady, insertVec, insertVecBatch, knnSearch, deleteVec, knnSearchHybrid, knnSearchTurbo, addToTurboVec, removeFromTurboVec, saveTurboVec, checkTurboVecHealth, isTurboVecHealthy, getVectorBackend };
