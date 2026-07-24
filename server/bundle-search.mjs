/**
 * Bundle Search — M-Flow inspired retrieval engine.
 *
 * Multi-collection vector search across cone layers → project hits into
 * graph → propagate cost from tip to base → rank episodes by min cost path.
 *
 * Layers: episodes (L0), facets (L1), abstractions (L2), core (L3).
 * Search flow: query → vector search each layer → build hit graph →
 *   Dijkstra from query tip → base episodes → sort by min path cost.
 */


import { storeMemory, getAllActiveMemoriesNoEmbed, getMemoriesByEntityAttr, traverseMemoryGraph, getActiveMemories, getMemoriesByIds, isForeignEmbeddingModel, db } from './memory-store.mjs';
import { isEmbeddingReady, embed, searchByEmbedding } from './embedding-engine.mjs';
import { tryReactivateCandidates } from './reactivation-engine.mjs';

import { knnSearch, knnSearchHybrid, getVectorBackend } from './vector-index.mjs';
import { spatialFilter, multiSourceRouter } from './module-registry.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const BUNDLE_TOP_K = parseInt(process.env.BUNDLE_TOP_K || '5');
const BUNDLE_MIN_SCORE = parseFloat(process.env.BUNDLE_MIN_SCORE || '0.15');
const QUERY_NODE_ID = '__query_tip__';

/**
 * Perform Bundle Search: search across all cone layers, build hit graph,
 * propagate cost, return ranked episodes.
 *
 * @param {string} query - Natural language query
 * @param {number} topK - Max episodes to return
 * @returns {Promise<Array>} Ranked episodes with evidence paths
 */
export async function bundleSearch(query, topK = BUNDLE_TOP_K) {
  if (!isEmbeddingReady()) {
    // The not-ready branch: no KNN/embedding results exist to enhance. The four v2.2 enhancement
    // lines that used to live here all READ `allHits`, but `allHits` is a `const` declared at line 56
    // (after this early return) → Temporal Dead Zone → each line threw `ReferenceError`, swallowed by
    // its own empty `catch {}` → silent dead no-ops. Deleted. If these enhancers are ever wanted,
    // they belong on the READY path after `allHits` exists, using the append-not-replace form, never
    // a bare `allHits = expandHitGraphByEntities(...)` replace (the result-wipe shape fixed at
    // memory-server.mjs:1212).
    return { episodes: [], error: 'embedding not ready' };
  }

  const queryVec = new Float32Array(await embed(query));

  // Step 1: Multi-layer vector search
  const [l0Hits, l1Hits, l2Hits, l3Hits] = await Promise.all([
    searchLayer(queryVec, 0, 20),
    searchLayer(queryVec, 1, 15),
    searchLayer(queryVec, 2, 10),
    searchLayer(queryVec, 3, 5),
  ]);

  const allHits = [...l0Hits, ...l1Hits, ...l2Hits, ...l3Hits];
  if (allHits.length === 0) return { episodes: [], layers_searched: { L0: 0, L1: 0, L2: 0, L3: 0 } };

  // Step 2: Build hit graph — connect hits via memory edges
  // Normalize all IDs to String to avoid BigInt/Number/String mismatch
  const hitIds = new Set(allHits.map(h => String(h.id)));
  const graph = new Map(); // id (String) -> [{targetId, edgeWeight}]

  for (const hit of allHits) {
    const hitKey = String(hit.id);
    const edges = traverseMemoryGraph(hit.id, 1, 10);
    const neighbors = [];
    for (const edge of (edges || [])) {
      if (hitIds.has(String(edge.to_id))) {
        neighbors.push({ targetId: String(edge.to_id), weight: Math.max(0, 1 - (edge.strength || 0.5)) });
      }
      if (hitIds.has(String(edge.from_id))) {
        neighbors.push({ targetId: String(edge.from_id), weight: Math.max(0, 1 - (edge.strength || 0.5)) });
      }
    }
    graph.set(hitKey, neighbors);
  }

  // Step 3: Propagate cost — Dijkstra from query node (virtual source connected to all hits)
  // Query node = id 0; connect to each hit with weight = 1 - score
  for (const hit of allHits) {
    const hitKey = String(hit.id);
    const queryCost = Math.max(0, 1 - hit.score);
    if (!graph.has(QUERY_NODE_ID)) graph.set(QUERY_NODE_ID, []);
    graph.get(QUERY_NODE_ID).push({ targetId: hitKey, weight: queryCost });
  }

  const costs = dijkstra(graph, QUERY_NODE_ID, allHits.map(h => String(h.id)));

  // Step 4: Rank L0 episodes by minimum cost path
  const l0ById = new Map(l0Hits.map(h => [String(h.id), h]));
  const rankedEpisodes = [];
  for (const hit of l0Hits) {
    const cost = costs.get(String(hit.id));
    if (cost !== undefined && cost < Infinity) {
      rankedEpisodes.push({
        id: hit.id,
        // FIX-5 (BEAM bench): drop the 200-char truncation so long budget/code atoms survive
        // intact, and project the v10 typed fields (verbatim date/order/quote/contradiction)
        // so the M-Flow episode hits carry the same provenance the direct search arms do.
        text: hit.text || '',
        type: hit.type,
        entity: hit.entity,
        event_date: hit.event_date,
        order_index: hit.order_index,
        source_quote: hit.source_quote,
        contradiction_pair_id: hit.contradiction_pair_id,
        cost,
        score: 1 / (1 + cost),
        evidence: buildEvidencePath(String(hit.id), allHits, graph),
      });
    }
  }

  rankedEpisodes.sort((a, b) => a.cost - b.cost);

  // E7: reactivation-on-reference — archived rows referenced by this M-Flow query get reactivated
  // (flipped active, recall++, importance bump, vec re-inserted) instead of staying lost + causing
  // a silent duplicate on a later store. J2 contradiction gate blocks stale facts. Surfaced in a
  // separate `reactivated` field. Gated by ENABLE_REACTIVATION (default on).
  let reactivatedRows = [];
  if (queryVec && process.env.ENABLE_REACTIVATION !== 'false') {
    try { reactivatedRows = tryReactivateCandidates(queryVec, { coneLayers: [1, 2] }); }
    catch (e) { if (LOG_DEBUG) console.error('[E7 bundle] reactivation error:', e.message); }
  }

  return {
    episodes: rankedEpisodes.slice(0, topK),
    // Strip the raw embedding BLOB (and vec_id) before shipping — tryReactivateCandidates returns
    // raw SELECT * rows whose embedding column is a ~3KB Buffer (same class as the /memory/search
    // `related`/`reactivated` leaks; strip pattern from memory-server.mjs:1222).
    reactivated: reactivatedRows.length > 0 ? reactivatedRows.map(m => {
      if (!m) return m; const { embedding, vec_id, ..._r } = m; return _r;
    }) : undefined,
    layers_searched: {
      L0: l0Hits.length,
      L1: l1Hits.length,
      L2: l2Hits.length,
      L3: l3Hits.length,
    },
    total_hits: allHits.length,
  };
}

/**
 * Search a single cone layer using vector KNN. Exported (E20, 2026-06-24) so the D1 status-gate fix
 * is deterministically unit-testable WITHOUT the embedding-ready gate that wraps bundleSearch.
 * The KNN candidates + cone_layer + status gate run the exact same path bundleSearch uses.
 */
export async function searchLayer(queryVec, layer, limit) {
  try {
    // Use sqlite-vec KNN and filter by cone_layer
    const allVecResults = knnSearch(db, Array.from(queryVec), limit * 10);
    if (!allVecResults) return [];

    // Batch fetch memories and filter by cone_layer (avoids N+1 queries)
    const scored = allVecResults.filter(r => r.score >= BUNDLE_MIN_SCORE);
    const ids = scored.map(r => r.id);
    const mems = ids.length > 0 ? getMemoriesByIds(ids) : [];
    const memById = new Map(mems.map(m => [String(m.id), m]));
    const results = [];
    for (const r of scored) {
      const mem = memById.get(String(r.id));
      // E1: bundle search must gate on status like the vectorKnn paths — without this,
      // superseded/archived rows returned by knnSearch surfaced dead memories in cone layers.
      // D1 (E19, 2026-06-24): include 'contradicted' alongside 'active' (mirror the FIX-4 arms in
      // memory-store vectorKnnSearch / getActiveWithEmbedding). A contradiction pair has BOTH halves
      // status='contradicted'; gating only on 'active' would drop the whole pair from M-Flow, hiding
      // the very tension the D1 flip surfaces. Superseded / archived / invalid stay excluded (dead).
      if (mem && (mem.status === 'active' || mem.status === 'contradicted' || mem.status === 'similar_pending') && (mem.cone_layer === layer || (layer === 0 && !mem.cone_layer)) && !isForeignEmbeddingModel(mem)) {
        results.push({ ...mem, score: r.score });
        if (results.length >= limit) break;
      }
    }
    return results;
  } catch (err) {
    LOG_DEBUG && console.error(`[BundleSearch] Layer ${layer} error:`, err.message);
    return [];
  }
}

/**
 * Simple min-heap priority queue for Dijkstra.
 * O(log n) push/pop instead of O(n log n) sort + O(n) shift.
 */
class MinHeap {
  constructor() { this._h = []; }
  get length() { return this._h.length; }
  push(item) {
    this._h.push(item);
    let i = this._h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._h[p].cost <= this._h[i].cost) break;
      [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
      i = p;
    }
  }
  pop() {
    const top = this._h[0];
    const last = this._h.pop();
    if (this._h.length > 0) {
      this._h[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this._h.length && this._h[l].cost < this._h[smallest].cost) smallest = l;
        if (r < this._h.length && this._h[r].cost < this._h[smallest].cost) smallest = r;
        if (smallest === i) break;
        [this._h[i], this._h[smallest]] = [this._h[smallest], this._h[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Dijkstra shortest path from source to targets using min-heap.
 */
function dijkstra(graph, source, targets) {
  const dist = new Map();
  dist.set(source, 0);
  const targetSet = new Set(targets);
  const visited = new Set();
  const pq = new MinHeap();
  pq.push({ id: source, cost: 0 });

  while (pq.length > 0) {
    const { id, cost } = pq.pop();
    if (visited.has(id)) continue;
    visited.add(id);

    // Early termination: if all targets visited
    if (targetSet.has(id)) targetSet.delete(id);
    if (targetSet.size === 0 && id !== source) break;

    const neighbors = graph.get(id) || [];
    for (const { targetId, weight } of neighbors) {
      const newCost = cost + weight;
      if (!dist.has(targetId) || newCost < dist.get(targetId)) {
        dist.set(targetId, newCost);
        pq.push({ id: targetId, cost: newCost });
      }
    }
  }

  return dist;
}

/**
 * Build evidence path for an episode: which higher-layer memories support it.
 */
function buildEvidencePath(episodeId, allHits, graph) {
  const hitById = new Map(allHits.map(h => [String(h.id), h]));
  const evidence = [];
  const connected = graph.get(episodeId) || [];
  for (const { targetId } of connected) {
    if (targetId === '__query_tip__') continue; // Skip virtual query node
    const hit = hitById.get(targetId);
    if (hit && hit.cone_layer > 0) {
      evidence.push({
        id: hit.id,
        layer: hit.cone_layer,
        type: hit.type,
        text: (hit.text || '').substring(0, 100),
      });
    }
  }
  return evidence.slice(0, 3);
}

export default { bundleSearch };
