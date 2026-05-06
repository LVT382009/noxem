import { getActiveWithEmbedding, updateMemoryStatus, updateMemoryType, deleteMemory, storeMemories, getMemoryStats, deleteInvalid } from './memory-store.mjs';
import { initEmbeddingEngine, isEmbeddingReady, embed, embedBatch, findDuplicates, findContradictions, categorizeText, normalize, cosineSimilarity } from './embedding-engine.mjs';

let maintenanceInterval = null;
const RUN_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL || '300000'); // 5 min default

export async function runMaintenance() {
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
      // Keep the newer one (by id)
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
      // Mark older preference as superseded
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

  const elapsed = Date.now() - start;
  console.log(`[Maintenance] Complete in ${elapsed}ms: ${results.duplicates} dupes, ${results.contradictions} contradictions, ${results.invalid} cleaned`);
  return results;
}

export function startMaintenanceCron(intervalMs = RUN_INTERVAL_MS) {
  if (maintenanceInterval) clearInterval(maintenanceInterval);

  // Run first maintenance after 30s (give server time to load)
  setTimeout(async () => {
    await runMaintenance();
  }, 30000);

  maintenanceInterval = setInterval(async () => {
    await runMaintenance();
  }, intervalMs);

  console.log(`[Maintenance] Cron started: every ${Math.round(intervalMs / 1000)}s`);
}

export function stopMaintenanceCron() {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}