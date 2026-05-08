import { getActiveWithEmbedding, updateMemoryStatus, updateMemoryType, deleteMemory, storeMemories, getMemoryStats, deleteInvalid, archiveStaleMemories, storeMemory, getMemoriesByEntityAttr, vectorKnnSearch, db, getActiveMemories } from './memory-store.mjs';
import { initEmbeddingEngine, isEmbeddingReady, embed, embedBatch, findDuplicates, findContradictions, categorizeText, estimateImportance, extractEntityAttribute, normalize, cosineSimilarity } from './embedding-engine.mjs';

let maintenanceInterval = null;
let initialTimeout = null;
let maintenanceRunning = false;
const RUN_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL || '300000'); // 5 min default

export async function runMaintenance() {
  if (maintenanceRunning) {
    console.log('[Maintenance] Already running - skipping');
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
      console.log(`[Maintenance] Only ${memories.length} memories - skipping dedup/contradiction`);
      results.message = 'too few memories';
      return results;
    }

    // 1. Deduplication
    // For small sets (<500): brute-force O(n²) pairwise cosine
    // For large sets (>=500): KNN-based — find nearest neighbors per memory via index
    try {
      const withEmbedding = memories.filter(m => m.embedding);
      const DUP_THRESHOLD = parseFloat(process.env.DUP_THRESHOLD || '0.92');
      let dupes = [];

      if (withEmbedding.length < 500 || !vectorKnnSearch) {
        // Brute-force for small sets
        dupes = findDuplicates(memories);
      } else {
        // KNN-based dedup: for each memory, find top-K nearest via index
        // Only compute cosine for candidates near the threshold
        const seen = new Set();
        for (const m of withEmbedding) {
          if (seen.has(m.id)) continue;
          const neighbors = vectorKnnSearch(m.embedding, 20);
          if (!neighbors) { dupes = findDuplicates(memories); break; }
          for (const n of neighbors) {
            if (n.id === m.id || seen.has(n.id)) continue;
            if (n.score > DUP_THRESHOLD) {
              const [older, newer] = m.id < n.id ? [m, n] : [n, m];
              dupes.push({ a: older, b: newer, similarity: n.score });
              seen.add(older.id);
            }
          }
        }
      }

      for (const d of dupes) {
        const [older, newer] = d.a.id < d.b.id ? [d.a, d.b] : [d.b, d.a];
        updateMemoryStatus(older.id, 'invalid');
        results.duplicates++;
      }
      if (dupes.length > 0) console.log(`[Maintenance] Marked ${dupes.length} duplicates as invalid`);
    } catch (err) {
      console.error('[Maintenance] Dedup error:', err.message);
    }

    // 2. Contradiction detection (entity-attribute matching - directional)
    // Handles: preference changes, negation flips, temporal updates, state changes
    try {
      const entityAttrMap = new Map();
      for (const m of memories) {
        if (!m.entity || !m.attribute) continue;
        const key = `${m.entity}::${m.attribute}`;
        if (!entityAttrMap.has(key)) entityAttrMap.set(key, []);
        entityAttrMap.get(key).push(m);
      }

      for (const [key, mems] of entityAttrMap) {
        if (mems.length < 2) continue;
        mems.sort((a, b) => a.id - b.id);

        for (let i = 0; i < mems.length - 1; i++) {
          const older = mems[i];
          const newer = mems[i + 1];
          const contradiction = detectContradiction(older.text, newer.text);
          if (contradiction) {
            updateMemoryStatus(older.id, 'superseded', newer.id);
            results.contradictions++;
            console.log(`[Maintenance] Contradiction (${contradiction}): "${older.text}" -> superseded by "${newer.text}" (${key})`);
          }
        }
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

  // 3b. Category auto-correction: validate typed memories against content
  try {
    const corrected = autoCorrectCategories(memories, 25);
    results.category_corrected = corrected;
    if (corrected > 0) console.log(`[Maintenance] Auto-corrected ${corrected} memory categories`);
  } catch (err) {
    console.error('[Maintenance] Category auto-correction error:', err.message);
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

// Category auto-correction: check if typed memories are misclassified
// Uses rule-based heuristics to detect common category mismatches
function autoCorrectCategories(memories, maxCorrections = 25) {
  let corrected = 0;
  const skipTypes = new Set(['profile', 'general']); // never auto-correct these

  // Rule-based heuristics for detecting misclassified memories
  const rules = [
    // "I prefer/like/dislike X" should be 'preference', not 'fact'
    { pattern: /(?:i |user )?(?:prefer|like|love|hate|dislike|favor|choose|can't stand)s/i, correctType: 'preference', wrongTypes: ['fact', 'entity', 'pattern'] },
    // "My name/is/am" should be 'profile'
    { pattern: /(?:my name|i'?m |i am |call me)s/i, correctType: 'profile', wrongTypes: ['fact', 'entity', 'preference'] },
    // Errors/bugs/issues should be 'issue'
    { pattern: /(?:error|bug|issue|fail|crash|broken|exception|stack trace|traceback)/i, correctType: 'issue', wrongTypes: ['fact', 'event', 'entity'] },
    // Goals/intentions
    { pattern: /(?:goal|planning to|want to|intend to|aim to|going to|will build|i need to)/i, correctType: 'goal', wrongTypes: ['fact', 'project'] },
    // Events with temporal markers
    { pattern: /(?:yesterday|last week|on w+day|at d{1,2}(?:am|pm)|happened|occurred)/i, correctType: 'event', wrongTypes: ['fact'] },
    // Setup/config
    { pattern: /(?:installed|configured|set up|setup|deployed|running on|using version|environment)/i, correctType: 'setup', wrongTypes: ['fact', 'entity'] },
    // Learning/research
    { pattern: /(?:learned|research|according to|documentation says|docs say|web search found)/i, correctType: 'learning', wrongTypes: ['fact', 'entity'] },
  ];

  for (const m of memories) {
    if (corrected >= maxCorrections) break;
    if (skipTypes.has(m.type)) continue;

    for (const rule of rules) {
      if (rule.pattern.test(m.text) && rule.wrongTypes.includes(m.type)) {
        updateMemoryType(m.id, rule.correctType);
        console.log(`[Maintenance] Category corrected: #${m.id} "${m.type}" -> "${rule.correctType}" (text: "${m.text.substring(0, 60)}...")`);
        corrected++;
        break; // Only apply first matching rule per memory
      }
    }
  }

  return corrected;
}

// Extract the value/polarity from a memory text about a preference or state
function extractValue(text) {
  const lower = text.toLowerCase();

  // Negated preference: "I don't like X", "I no longer use X"
  const negMatch = lower.match(/(?:don'?t|do not|not|never|no longer|used to)\s+(?:prefer|like|love|hate|dislike|use|using|favor|choose)\s+(\S+)/i);
  if (negMatch) return { value: negMatch[1], negated: true };

  // Temporal past: "I used to X", "previously X", "formerly X"
  const pastMatch = lower.match(/(?:used to|previously|formerly|before)\s+(?:prefer|like|love|use|using)\s+(\S+)/i);
  if (pastMatch) return { value: pastMatch[1], negated: true, temporal: 'past' };

  // State change: "switched from X to Y", "moved from X to Y"
  const switchMatch = lower.match(/(?:switched|moved|changed|migrated)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  if (switchMatch) return { value: switchMatch[2], negated: false, replaced: switchMatch[1] };

  // Positive preference: "I prefer/like/use X"
  const posMatch = lower.match(/(?:prefer|like|love|hate|dislike|use|using|favor|choose|chose)\s+(\S+)/i);
  if (posMatch) return { value: posMatch[1], negated: false };

  // Identity attribute: "My name is X"
  const idMatch = lower.match(/(?:my name is|i'?m |i am |call me)\s+(.+?)(?:\s*[.!?,;]|\s*$)/i);
  if (idMatch) return { value: idMatch[1].trim(), negated: false };

  return null;
}

// Detect contradiction between two memories about the same entity+attribute
// Returns the contradiction type or null if no contradiction
function detectContradiction(olderText, newerText) {
  const olderVal = extractValue(olderText);
  const newerVal = extractValue(newerText);
  if (!olderVal || !newerVal) return null;

  // Case 1: Different values for same attribute → newer supersedes older
  if (olderVal.value !== newerVal.value && !olderVal.negated && !newerVal.negated) {
    return 'preference_change';
  }
  // Case 2: Negation flip — "I like X" → "I don't like X" (or vice versa)
  if (olderVal.value === newerVal.value && olderVal.negated !== newerVal.negated) {
    return 'negation_flip';
  }
  // Case 3: Temporal update — past preference superseded by current
  if (olderVal.temporal === 'past' && !newerVal.temporal) {
    return 'temporal_update';
  }
  // Case 4: State change — "switched from X to Y" contradicts "I use X"
  if (newerVal.replaced && olderVal.value === newerVal.replaced) {
    return 'state_change';
  }

  return null;
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
        console.log(`[Maintenance] Consolidated ${cluster.length} memories about "${entity}" -> #${newId} (importance: ${newImportance})`);
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
