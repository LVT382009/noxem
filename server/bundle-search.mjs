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


import { storeMemory, getAllActiveMemoriesNoEmbed, getMemoriesByEntityAttr, traverseMemoryGraph, getActiveMemories, db } from './memory-store.mjs';
import { isEmbeddingReady, embed, searchByEmbedding } from './embedding-engine.mjs';
import { knnSearch, knnSearchHybrid, getVectorBackend } from './vector-index.mjs';
import { vectorKnnSearchAsync } from './memory-store.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const BUNDLE_TOP_K = parseInt(process.env.BUNDLE_TOP_K || '5');
const BUNDLE_MIN_SCORE = parseFloat(process.env.BUNDLE_MIN_SCORE || '0.15');

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
  const hitIds = new Set(allHits.map(h => h.id));
  const graph = new Map(); // id -> [{targetId, edgeWeight}]

  for (const hit of allHits) {
    const edges = traverseMemoryGraph(hit.id, 1, 10);
    const neighbors = [];
    for (const edge of (edges || [])) {
      if (hitIds.has(edge.to_id)) {
        neighbors.push({ targetId: edge.to_id, weight: 1 - (edge.strength || 0.5) });
      }
      if (hitIds.has(edge.from_id)) {
        neighbors.push({ targetId: edge.from_id, weight: 1 - (edge.strength || 0.5) });
      }
    }
    graph.set(hit.id, neighbors);
  }

  // Step 3: Propagate cost — Dijkstra from query node (virtual source connected to all hits)
  // Query node = id 0; connect to each hit with weight = 1 - score
  for (const hit of allHits) {
    const queryCost = 1 - hit.score;
    if (!graph.has(0)) graph.set(0, []);
    graph.get(0).push({ targetId: hit.id, weight: queryCost });
  }

  const costs = dijkstra(graph, 0, allHits.map(h => h.id));

  // Step 4: Rank L0 episodes by minimum cost path
  const l0ById = new Map(l0Hits.map(h => [h.id, h]));
  const rankedEpisodes = [];
  for (const hit of l0Hits) {
    const cost = costs.get(hit.id);
    if (cost !== undefined && cost < Infinity) {
      rankedEpisodes.push({
        id: hit.id,
        text: hit.text?.substring(0, 200) || '',
        type: hit.type,
        entity: hit.entity,
        cost,
        score: 1 / (1 + cost),
        evidence: buildEvidencePath(hit.id, allHits, graph),
      });
    }
  }

  rankedEpisodes.sort((a, b) => a.cost - b.cost);

  return {
    episodes: rankedEpisodes.slice(0, topK),
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
 * Search a single cone layer using vector KNN.
 */
async function searchLayer(queryVec, layer, limit) {
  try {
    // Use sqlite-vec KNN and filter by cone_layer
    const allVecResults = knnSearch(db, Array.from(queryVec), limit * 3);
    if (!allVecResults) return [];

    // Filter to specific layer
    const layerIds = allVecResults
      .filter(r => r.score >= BUNDLE_MIN_SCORE)
      .map(r => r.id);

    if (layerIds.length === 0) return [];

    // Fetch memories and filter by cone_layer
    const { getMemory } = await import('./memory-store.mjs');
    const results = [];
    for (const r of allVecResults.filter(r => r.score >= BUNDLE_MIN_SCORE)) {
      const mem = getMemory(r.id);
      if (mem && (mem.cone_layer === layer || (layer === 0 && !mem.cone_layer))) {
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
 * Simple Dijkstra shortest path from source to targets.
 */
function dijkstra(graph, source, targets) {
  const dist = new Map();
  dist.set(source, 0);
  const targetSet = new Set(targets);
  const visited = new Set();
  // Simple priority queue via sorted array (sufficient for small graphs)
  const pq = [{ id: source, cost: 0 }];

  while (pq.length > 0) {
    pq.sort((a, b) => a.cost - b.cost);
    const { id, cost } = pq.shift();
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
  const evidence = [];
  const connected = graph.get(episodeId) || [];
  for (const { targetId } of connected) {
    if (targetId === 0) continue; // Skip virtual query node
    const hit = allHits.find(h => h.id === targetId);
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
