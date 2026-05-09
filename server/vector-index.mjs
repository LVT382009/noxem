// Optional sqlite-vec integration for native vector KNN search
// Falls back to JS cosine similarity if sqlite-vec is unavailable

let sqliteVec = null;
let vecAvailable = false;
let vecTableReady = false;

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');

export async function initVectorIndex(db) {
  try {
    sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vecs USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine)`);
    vecAvailable = true;
    vecTableReady = true;
    if (process.env.LOG_LEVEL === 'debug') console.log(`[VectorIndex] sqlite-vec loaded — native KNN search enabled (${EMBED_DIM}d, cosine)`);
  } catch (err) {
    vecAvailable = false;
    if (process.env.LOG_LEVEL === 'debug') console.log(`[VectorIndex] sqlite-vec unavailable — JS cosine fallback active (install sqlite-vec for native KNN)`);
    if (process.env.LOG_LEVEL === 'debug') console.error(`[VectorIndex] Load error: ${err.message}`);
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
    db.prepare('INSERT OR REPLACE INTO memory_vecs(rowid, embedding) VALUES (?, ?)').run(memoryId, vec);
  } catch (err) {
    // Silently fail — vector index is best-effort
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
          stmt.run(ids[i], new Float32Array(embeddings[i].slice(0, EMBED_DIM)));
        } catch {}
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
    const results = db.prepare(`
      SELECT rowid as id, distance
      FROM memory_vecs
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vec, topK);
    // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
    // Convert to similarity: score = 1 - distance
    return results.map(r => ({
      id: r.id,
      score: Math.max(0, Math.round((1 - r.distance) * 1000) / 1000),
    }));
  } catch (err) {
    return null;
  }
}

// Delete a vector from the index
export function deleteVec(db, memoryId) {
  if (!vecTableReady) return;
  try {
    db.prepare('DELETE FROM memory_vecs WHERE rowid = ?').run(memoryId);
  } catch {}
}

export default { initVectorIndex, isVecReady, insertVec, insertVecBatch, knnSearch, deleteVec };
