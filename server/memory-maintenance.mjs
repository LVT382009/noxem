import { getActiveWithEmbedding, updateMemoryStatus, updateMemoryType, deleteMemory, storeMemories, getMemoryStats, deleteInvalid, archiveStaleMemories, storeMemory, getMemoriesByEntityAttr, db } from './memory-store.mjs';
import { initEmbeddingEngine, isEmbeddingReady, embed, embedBatch, findDuplicates, findContradictions, categorizeText, estimateImportance, extractEntityAttribute, normalize, cosineSimilarity } from './embedding-engine.mjs';

let maintenanceInterval = null;
let initialTimeout = null;
let maintenanceRunning = false;
const RUN_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL || '300000'); // 5 min default

export async function runMaintenance() {
  if (maintenanceRunning) {
    console.log('[Maintenance] Already running — skipping');
    return { skipped: true, reason: 'already running' };
  }
  maintenanceRunning = true;

  try {
    if (!isEmbeddingReady()) {
      console.log('Maintenance skipped: embedding engine not ready');
      return { skipped: true, reason: 'embedding not ready' };
    }

    console.log('[Maintenance] Starting memory maintenance...');
    const start = Date.now();
    const results = { duplicates: 0, contradictions: 0, invalid: 0, categorized: 0 };

    const memories = getActiveWithEmbedding();

    if (memories.length < 2) {
      console.log(`[Maintenance] Only ${memories.length} memories — skipping dedup/contradiction`);
      results.message = 'too few memories';
      return results;
    }

    // 1. Deduplication
    try {
      const dupes = findDuplicates(memories);
      for (const d of dupes) {
        const [older, newer] = d.a.id < d.b.id ? [d.a, d.b] : [d.b, d.a];
        updateMemoryStatus(older.id, 'invalid');
        results.duplicates++;
      }
      if (dupes.length > 0) console.log(`[Maintenance] Marked ${dupes.length} duplicates as invalid`);
    } catch (err) {
      console.error('[Maintenance] Dedup error:', err.message);
    }

    // 2. Contradiction detection
    try {
      const contradictions = findContradictions(memories);
      for (const c of contradictions) {
        const [older, newer] = c.a.id < c.b.id ? [c.a, c.b] : [c.b, c.a];
        updateMemoryStatus(older.id, 'superseded', newer.id);
        results.contradictions++;
        console.log(`[Maintenance] Contradiction: "${older.text}" → superseded by "${newer.text}" (sim: ${c.similarity.toFixed(3)})`);
      }
    } catch (err) {
      console.error('[Maintenance] Contradiction error:', err.message);
    }

    // 3. Categorize uncategorized memories
    try {
      for (const m of memories) {
        if (m.type === 'general' || m.type === 'fact') {
          const newType = categorizeText(m.text);
          if (newType !== m.type && newType !== 'fact') {
            updateMemoryType(m.id, newType);
            results.categorized++;
          }
        }
      }
    } catch (err) {
      console.error('[Maintenance] Categorization error:', err.message);
    }

    // 4. Clean invalid
    try {
      const cleaned = deleteInvalid();
      results.invalid = cleaned;
    } catch (err) {
      console.error('[Maintenance] Cleanup error:', err.message);
    }

    // 5. Archive stale memories (90+ days old, never recalled)
    try {
      const archived = archiveStaleMemories();
      results.archived = archived;
      if (archived > 0) console.log(`[Maintenance] Archived ${archived} stale memories (90+ days, 0 recalls)`);
    } catch (err) {
      console.error('[Maintenance] Archive error:', err.message);
    }

    // 6. Significance-gated consolidation: cluster related low-importance memories
    try {
      const consolidated = await consolidateMemories(memories);
      results.consolidated = consolidated;
      if (consolidated > 0) console.log(`[Maintenance] Consolidated ${consolidated} memory clusters`);
    } catch (err) {
      console.error('[Maintenance] Consolidation error:', err.message);
    }

    const elapsed = Date.now() - start;
    console.log(`[Maintenance] Complete in ${elapsed}ms: ${results.duplicates} dupes, ${results.contradictions} contradictions, ${results.invalid} cleaned`);
    return results;
  } finally {
    maintenanceRunning = false;
  }
}

// Significance-gated consolidation:
// When 3+ low-importance memories (importance < 0.5) cluster together
// about the same entity (cosine > 0.75), consolidate into a single
// higher-importance summary and mark originals as superseded.
const CONSOLIDATION_MIN_CLUSTER = 3;
const CONSOLIDATION_SIM_THRESHOLD = 0.75;
const CONSOLIDATION_MAX_IMPORTANCE = 0.5;

async function consolidateMemories(memories) {
  if (!isEmbeddingReady() || memories.length < CONSOLIDATION_MIN_CLUSTER) return 0;

  const byEntity = new Map();
  for (const m of memories) {
    if (m.importance >= CONSOLIDATION_MAX_IMPORTANCE) continue;
    if (!m.entity || !m.embedding) continue;
    const key = m.entity;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(m);
  }

  let consolidatedCount = 0;

  // Pre-prepare statements outside the loop
  const updateSourceIds = db.prepare('UPDATE memories SET source_memory_ids = ? WHERE id = ?');
  const setValidUntil = db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?');

  for (const [entity, entityMems] of byEntity) {
    if (entityMems.length < CONSOLIDATION_MIN_CLUSTER) continue;

    const visited = new Set();
    const clusters = [];

    for (let i = 0; i < entityMems.length; i++) {
      if (visited.has(i)) continue;
      const cluster = [entityMems[i]];
      visited.add(i);

      for (let j = i + 1; j < entityMems.length; j++) {
        if (visited.has(j)) continue;
        const sim = cosineSimilarity(
          entityMems[i].embedding,
          entityMems[j].embedding
        );
        if (sim > CONSOLIDATION_SIM_THRESHOLD) {
          cluster.push(entityMems[j]);
          visited.add(j);
        }
      }

      if (cluster.length >= CONSOLIDATION_MIN_CLUSTER) {
        clusters.push(cluster);
      }
    }

    for (const cluster of clusters) {
      try {
        cluster.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const texts = cluster.map(m => m.text);
        const summaryText = texts.join(' | ');

        const typePriority = ['profile', 'preference', 'setup', 'project', 'goal', 'pattern', 'entity', 'learning', 'issue', 'fact', 'event', 'request'];
        let bestType = 'fact';
        for (const m of cluster) {
          if (typePriority.indexOf(m.type) < typePriority.indexOf(bestType)) {
            bestType = m.type;
          }
        }

        const newImportance = Math.min(1.0, Math.max(...cluster.map(m => m.importance)) + 0.2);
        const clusterIds = cluster.map(m => m.id);

        let embedding = null;
        try {
          const vec = await embed(summaryText);
          embedding = new Float32Array(vec);
        } catch {}

        const newId = storeMemory({
          session_id: cluster[0].session_id || '',
          type: bestType,
          text: summaryText,
          embedding,
          metadata: {
            source: 'consolidation',
            extraction_method: 'significance_gated',
            origin_session_id: cluster[0].session_id || '',
            consolidated_from: clusterIds,
            stored_at: new Date().toISOString(),
          },
          importance: newImportance,
          context_prefix: `Consolidated ${cluster.length} memories about ${entity}:`,
          entity,
          attribute: cluster[0].attribute || '',
        });

        updateSourceIds.run(JSON.stringify(clusterIds), newId);

        for (const m of cluster) {
          updateMemoryStatus(m.id, 'superseded', newId);
          setValidUntil.run(new Date().toISOString(), m.id);
        }

        consolidatedCount++;
        console.log(`[Maintenance] Consolidated ${cluster.length} memories about "${entity}" → #${newId} (importance: ${newImportance})`);
      } catch (err) {
        console.error('[Maintenance] Cluster consolidation error:', err.message);
      }
    }
  }

  return consolidatedCount;
}

export function startMaintenanceCron(intervalMs = RUN_INTERVAL_MS) {
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  if (initialTimeout) clearTimeout(initialTimeout);

  // Run first maintenance after 30s (give server time to load)
  initialTimeout = setTimeout(() => {
    runMaintenance().catch(err => console.error('[Maintenance] Initial run error:', err.message));
  }, 30000);

  maintenanceInterval = setInterval(() => {
    runMaintenance().catch(err => console.error('[Maintenance] Cron run error:', err.message));
  }, intervalMs);

  console.log(`[Maintenance] Cron started: every ${Math.round(intervalMs / 1000)}s`);
}

export function stopMaintenanceCron() {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}
