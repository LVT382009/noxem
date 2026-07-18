import { getActiveWithEmbedding, updateMemoryStatus, updateMemoryType, deleteMemory, storeMemories, getMemoryStats, deleteInvalid, archiveStaleMemories, storeMemory, getMemoriesByEntityAttr, vectorKnnSearch, db, getActiveMemories, enforceActiveSetBound } from './memory-store.mjs';
import { initEmbeddingEngine, isEmbeddingReady, embed, embedBatch, findDuplicates, categorizeText, estimateImportance, extractEntityAttribute, cosineSimilarity, isTrivialIntent } from './embedding-engine.mjs';
import { appendEvolvedContext } from './memory-store.mjs';
import { synthesizeConsolidation } from './advisor-engine.mjs';
import { deltaProcessor, graphPruner, ambientInjector, ingestPipeline, strategyDistiller, capsuleBuilder, lessonVault, compactionCoordinator, multiSourceRouter } from './module-registry.mjs';
import { llmFetch } from './llm-fetch.mjs';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);


let maintenanceInterval = null;
let initialTimeout = null;
let maintenanceRunning = false;
const RUN_INTERVAL_MS = parseInt(process.env.MAINTENANCE_INTERVAL || '300000'); // 5 min default

export async function runMaintenance() {
  if (maintenanceRunning) {
    LOG_DEBUG && console.log('[Maintenance] Already running - skipping');
    return { skipped: true, reason: 'already running' };
  }
  maintenanceRunning = true;

  try {
    if (!isEmbeddingReady()) {
      LOG_DEBUG && console.log('Maintenance skipped: Brain-1 not ready');
      return { skipped: true, reason: 'embedding not ready' };
    }

    LOG_DEBUG && console.log('[Maintenance] Starting memory maintenance...');
    const start = Date.now();
    const results = { duplicates: 0, contradictions: 0, invalid: 0, categorized: 0 };

    const memories = getActiveWithEmbedding();

    if (memories.length < 2) {
      LOG_DEBUG && console.log(`[Maintenance] Only ${memories.length} memories - skipping dedup/contradiction`);
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
          if (!neighbors) { dupes.push(...findDuplicates(withEmbedding.filter(m => !seen.has(m.id)))); break; } // BUG-8 fix: use filtered list, preserve progress
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

      const alreadySuperseded = new Set(); // S-#28
    for (const d of dupes) {
        const [older, newer] = d.a.id < d.b.id ? [d.a, d.b] : [d.b, d.a];
        if (alreadySuperseded.has(older.id)) continue;
        if (alreadySuperseded.has(newer.id)) continue;
        updateMemoryStatus(older.id, 'superseded', newer.id);
        alreadySuperseded.add(older.id); alreadySuperseded.add(newer.id); // BUG-14 fix: prevent newer from being superseded in another pair
        results.duplicates++;
      }
      if (dupes.length > 0) LOG_DEBUG && console.log(`[Maintenance] Marked ${dupes.length} duplicates as superseded`);
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] Dedup error:', err.message);
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
            LOG_DEBUG && console.log(`[Maintenance] Contradiction (${contradiction}): "${older.text}" -> superseded by "${newer.text}" (${key})`);
          }
        }
      }
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] Contradiction error:', err.message);
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
      LOG_DEBUG && console.error('[Maintenance] Categorization error:', err.message);
  }

  // 3b. Category auto-correction: validate typed memories against content
  try {
    const corrected = autoCorrectCategories(memories, 25);
    results.category_corrected = corrected;
    if (corrected > 0) LOG_DEBUG && console.log(`[Maintenance] Auto-corrected ${corrected} memory categories`);
  } catch (err) {
    LOG_DEBUG && console.error('[Maintenance] Category auto-correction error:', err.message);
  }
    // 4. Clean invalid
    try {
      const cleaned = deleteInvalid();
      results.invalid = cleaned;
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] Cleanup error:', err.message);
    }

    // 5. Archive stale memories (90+ days old, never recalled)
    try {
      const archived = archiveStaleMemories();
      results.archived = archived;
      if (archived > 0) LOG_DEBUG && console.log(`[Maintenance] Archived ${archived} stale memories (90+ days, 0 recalls)`);
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] Archive error:', err.message);
    }

    // 6. Significance-gated consolidation: cluster related low-importance memories
    try {
      const consolidated = await consolidateMemories(memories);
      results.consolidated = consolidated;
      if (consolidated > 0) LOG_DEBUG && console.log(`[Maintenance] Consolidated ${consolidated} memory clusters`);
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] Consolidation error:', err.message);
    }

    // 6b. E2 semantic-intent consolidation: A-MEM evolve + intent-cluster merge over L1/L2 facets.
    //     Runs AFTER the legacy entity consolidation so it sees the post-merge facet set. It is its
    //     own gate (ENABLE_CONSOLIDATION_SEMANTIC) and is SILENT-LOSS-SAFE (content clusters only
    //     merge on a clean J3 synth). Never aborts maintenance on error.
    try {
      const semantic = await consolidateSemantically(memories);
      results.semanticConsolidated = semantic;
      if (semantic > 0) LOG_DEBUG && console.log(`[Maintenance] E2 semantic-consolidated ${semantic} clusters`);
    } catch (err) {
      LOG_DEBUG && console.error('[Maintenance] E2 semantic consolidation error:', err.message);
    }

    // ── v2.1 Module Maintenance ────────────────────
  try {
    // Stale embedding detection + re-embed
    const staleResult = await deltaProcessor.runStaleEmbeddingMaintenance({ db, embedFn: embed });
    if (LOG_DEBUG && staleResult.reembedded > 0) console.log(`[Maintenance] Re-embedded ${staleResult.reembedded} stale memories`);
  } catch (e) {
    if (LOG_DEBUG) console.error('[Maintenance] Stale embedding scan failed:', e.message);
  }

  try {
    // Hub-node marking + embedding eviction
    graphPruner.markHubNodes(db);
    const evicted = graphPruner.evictEmbeddings(db);
    if (LOG_DEBUG && evicted > 0) console.log(`[Maintenance] Evicted ${evicted} low-importance embeddings`);
  } catch (e) {
    if (LOG_DEBUG) console.error('[Maintenance] Graph pruner maintenance failed:', e.message);
  }

  try {
    // Co-recall edge creation + idle session expiry
    ambientInjector.createCorecallEdges(db);
    ambientInjector.expireInactiveSessions(db);
  } catch (e) {
    if (LOG_DEBUG) console.error('[Maintenance] Ambient maintenance failed:', e.message);
  }

  try {
    // Cross-link auto-generation for shared entities
    const linked = ingestPipeline.autoLinkMemoriesBySharedEntity(db);
    if (LOG_DEBUG && linked > 0) console.log(`[Maintenance] Auto-linked ${linked} shared-entity pairs`);
  } catch (e) {
    if (LOG_DEBUG) console.error('[Maintenance] Cross-link generation failed:', e.message);
  }

  // v2.2: Delta processor startup checks + logic re-evaluation
	try {
		const categorizeSrc = String(categorizeText.toString().slice(0, 200));
		const importanceSrc = String(estimateImportance.toString().slice(0, 200));
		const startupResult = deltaProcessor.runStartupChecks({ db, categorizeSrc, importanceSrc, modelId: 'local', embedDim: 256, dtype: 'float32', hasExistingEmbeddings: memories.length > 0 });
		if (LOG_DEBUG && startupResult) console.log('[Maintenance] Delta startup checks:', JSON.stringify(startupResult));
		const reevalResult = deltaProcessor.runLogicReevaluation({ db, categorizeFn: categorizeText, estimateFn: estimateImportance, limit: 1000 });
		if (LOG_DEBUG && reevalResult?.rereaded > 0) console.log(`[Maintenance] Logic re-evaluated ${reevalResult.rereaded} memories`);
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Delta processor maintenance failed:', e.message); }

	try {
		// Graph pruner: full maintenance pipeline + PQ training
		const pipelineResult = await graphPruner.runMaintenancePipeline(db, embed);
		if (LOG_DEBUG && pipelineResult) console.log('[Maintenance] Graph pruner pipeline:', JSON.stringify(pipelineResult));
		const pqResult = graphPruner.trainPQCodebooks(db);
		if (LOG_DEBUG && pqResult?.trained) console.log(`[Maintenance] PQ codebooks trained (${pqResult.subspaces} subspaces)`);
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Graph pruner full pipeline failed:', e.message); }

	try {
		// Capsule builder: hot cache preload + triplet extraction
		capsuleBuilder.preloadHotCache(db);
		await capsuleBuilder.extractTripletsAsync('');
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Capsule builder maintenance failed:', e.message); }

	try {
		// Ambient injector: distill guides + ambient maintenance
		await ambientInjector.distillAllEligible(llmFetch);
		ambientInjector.runAmbientMaintenance(db);
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Ambient distiller maintenance failed:', e.message); }

	try {
		// Strategy distiller: contrast trajectories + quality judgment
		await strategyDistiller.contrastTrajectories('');
		await strategyDistiller.judgeReasoningQuality([]);
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Strategy distiller maintenance failed:', e.message); }

	try {
		// Lesson vault: audit memory poisoning + write stats
		const poisoning = lessonVault.auditMemoryPoisoning(db);
		if (LOG_DEBUG && poisoning?.issues?.length > 0) console.log(`[Maintenance] Memory poisoning audit: ${poisoning.issues.length} issues`);
		const writeStats = lessonVault.getWriteStats();
		if (LOG_DEBUG) results.writeStats = writeStats;
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Lesson vault maintenance failed:', e.message); }

	try {
		// Compaction coordinator: preview candidates
		const preview = compactionCoordinator.previewCompactionCandidates(memories);
		if (LOG_DEBUG && preview?.length > 0) console.log(`[Maintenance] Compaction preview: ${preview.length} candidates`);
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Compaction preview failed:', e.message); }

	try {
		// Multi-source router: refresh source catalog
		multiSourceRouter.getSourceCatalog();
	} catch (e) { /* source catalog refresh is optional */ }

	try {
		// Ingest pipeline status check
		const ingestStatus = ingestPipeline.getIngestStatus();
		if (LOG_DEBUG) results.ingestStatus = ingestStatus;
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] Ingest status check failed:', e.message); }

	// 7. E5: bounded active set — final step. See runActiveSetBoundStep (extracted so the regression
	// test can exercise the REAL maintenance wiring without booting the embedding engine —
	// runMaintenance early-returns when Brain-1 is not ready, which would otherwise hide it).
	runActiveSetBoundStep(results);

const elapsed = Date.now() - start;
    LOG_DEBUG && console.log(`[Maintenance] Complete in ${elapsed}ms: ${results.duplicates} dupes, ${results.contradictions} contradictions, ${results.invalid} cleaned`);
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
    { pattern: /(?:yesterday|last week|on \w+day|at \d{1,2}(?:am|pm)|happened|occurred)/i, correctType: 'event', wrongTypes: ['fact'] },
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
        LOG_DEBUG && console.log(`[Maintenance] Category corrected: #${m.id} "${m.type}" -> "${rule.correctType}" (text: "${m.text.substring(0, 60)}...")`);
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
export function detectContradiction(olderText, newerText) {
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

    // S-#37: Union-Find for transitive closure (prevents single-link misses)
    const parent = Array.from({ length: entityMems.length }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { parent[find(a)] = find(b); }

    for (let i = 0; i < entityMems.length; i++) {
        for (let j = i + 1; j < entityMems.length; j++) {
            const sim = cosineSimilarity(entityMems[i].embedding, entityMems[j].embedding);
            if (sim > CONSOLIDATION_SIM_THRESHOLD) union(i, j);
        }
    }

    const groups = new Map();
    for (let i = 0; i < entityMems.length; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(entityMems[i]);
    }

    const clusters = [...groups.values()].filter(c => c.length >= CONSOLIDATION_MIN_CLUSTER);
    for (const cluster of clusters) {
      try {
        cluster.sort((a, b) => { // BUG-9 fix: null-safe date sort
        const da = a.created_at ? new Date(a.created_at.replace(' ', 'T')).getTime() : 0;
        const db2 = b.created_at ? new Date(b.created_at.replace(' ', 'T')).getTime() : 0;
        return (da || 0) - (db2 || 0);
      });
        // J3 synth REQUIRED — silent-loss gate: on degraded, NO merge (keep all originals active). Mirrors
        // consolidateSemantically (memory-maintenance.mjs:568-570). Old Path-3 folded same-entity clusters
        // with texts.join(' | ') and no Brain 2 judgment; a distinct-attribute cluster (budget vs recipe,
        // same entity) was folded on cosine alone and the distinct facts were lost from active retrieval
        // with no error. On degraded skip the cluster entirely — no consolidation row, no supersede — so
        // both originals stay active. On clean synth, synth.text replaces the ' | '-joined string.
        const synth = await synthesizeConsolidation(cluster, { maxTokens: 256 }).catch(() => ({ degraded: true, text: null, reason: 'throw' }));
        if (synth.degraded) { LOG_DEBUG && console.log(`[Maintenance] Consolidate cluster about "${entity}" synth degraded (${synth.reason}) — no merge (silent-loss gate)`); continue; }
        const summaryText = synth.text;

        const typePriority = ['profile', 'preference', 'setup', 'project', 'goal', 'pattern', 'entity', 'learning', 'issue', 'fact', 'event', 'request'];
        const typePriorityMap = new Map(typePriority.map((t, i) => [t, i]));
        const getPriority = (type) => typePriorityMap.has(type) ? typePriorityMap.get(type) : typePriority.length;
        let bestType = 'fact';
        for (const m of cluster) {
          if (getPriority(m.type) < getPriority(bestType)) {
            bestType = m.type;
          }
        }

        let maxImportance = cluster[0].importance;
      for (let i = 1; i < cluster.length; i++) {
        if (cluster[i].importance > maxImportance) maxImportance = cluster[i].importance;
      }
      const newImportance = Math.min(1.0, maxImportance + 0.2);
        const clusterIds = cluster.map(m => m.id);

        let embedding = null;
        try {
          const vec = await embed(summaryText);
          embedding = vec; // S-#53: storeMemory->ensureEmbeddingBuffer converts array to Buffer
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
          updateMemoryStatus(m.id, 'superseded', newId); // E1: prunes vectors (both backends) same-tx
          setValidUntil.run(new Date().toISOString(), m.id);
        }

        consolidatedCount++;
        LOG_DEBUG && console.log(`[Maintenance] Consolidated ${cluster.length} memories about "${entity}" -> #${newId} (importance: ${newImportance})`);
      } catch (err) {
        LOG_DEBUG && console.error('[Maintenance] Cluster consolidation error:', err.message);
      }
    }
  }

  return consolidatedCount;
}

// E2 consolidateSemantically — A-MEM evolve + intent-cluster merge (CRON). Parallels the legacy
// consolidateMemories (same-source entity merge) with an intent-aware pass: clusters L1/L2 *facet*
// rows by intent BUCKET + entity and, for agreeing (non-contradicting) clusters, EVOLVES the oldest
// anchor IN PLACE (metadata.evolved_context + evolved_from_ids + optional J3 canonical) and
// SUPERSEDES-AS-AUDIT the rest (audit kept, vec pruned). Cardinal guards: L0 raw episodes and L3
// persona are NEVER touched here (L0 = raw audit, handled by the store-time A-MEM evolve; L3 =
// persona cardinal). This is the SILENT-LOSS-SAFE consolidation — content clusters require a clean
// J3 synth (degraded===false) before any merge; on any LLM miss the cluster is left untouched
// (today's behavior preserved = zero data loss). Trivial clusters (greetings/ack/farewell/...) are
// interchangeable and merge even when synth is degraded (they carry no fact to lose).
//
// Gate: ENABLE_CONSOLIDATION_SEMANTIC (default on, independent of the legacy consolidation toggle).
// Returns the count of clusters merged. Never throws — runs on the maintenance cron hot path.
const E2_TRIVIAL_MIN_CLUSTER = 2;
const E2_CONTENT_MIN_CLUSTER = 3;
const E2_CONTENT_COSINE = parseFloat(process.env.E2_CONSOLIDATE_COSINE || '0.60');
const E2_CONTENT_MAX_IMPORTANCE = parseFloat(process.env.E2_CONSOLIDATE_MAX_IMPORTANCE || '0.5');
const E2_CONTENT_IMPORTANCE_BUMP = 0.05;

export async function consolidateSemantically(memories) {
  if (process.env.ENABLE_CONSOLIDATION_SEMANTIC === 'false') return 0;
  if (!Array.isArray(memories) || memories.length < 2) return 0;
  // operate on L1/L2 facets that have embeddings + an intent tag (L0 raw + L3 persona excluded)
  const rows = memories.filter(m =>
    (m.cone_layer === 1 || m.cone_layer === 2)
    && m.embedding && m.intent_type
  );
  if (rows.length < 2) return 0;

  // group by intent bucket + entity (trivials collapse into one '__trivial__' bucket)
  const groups = new Map();
  for (const m of rows) {
    const bucket = isTrivialIntent(m.intent_type) ? '__trivial__' : m.intent_type;
    const k = `${bucket}::${m.entity || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const _ts = x => { try { return new Date(String(x?.created_at || '').replace(' ', 'T')).getTime() || 0; } catch { return 0; } };
  const byOldest = (a, b) => (_ts(a) - _ts(b)) || (String(a.id) < String(b.id) ? -1 : 1);

  let merged = 0;
  for (const [, group] of groups) {
    const trivial = isTrivialIntent(group[0].intent_type);
    group.sort(byOldest);

    if (trivial) {
      if (group.length < E2_TRIVIAL_MIN_CLUSTER) continue;
      const anchor = group[0];
      const extras = group.slice(1).map(m => ({ id: m.id, text: m.text }));
      // trivials are interchangeable and carry no fact -> merge even if the LLM is disabled/degraded
      const ok = appendEvolvedContext(anchor.id, extras, { importanceBump: 0 });
      if (ok) {
        for (const m of group.slice(1)) updateMemoryStatus(m.id, 'superseded', anchor.id);
        merged++;
        LOG_DEBUG && console.log(`[E2] consolidate trivial: folded ${extras.length} facets -> anchor #${anchor.id}`);
      }
      continue;
    }

    // content: connected components over all-pairs cosine >= E2_CONTENT_COSINE (Union-Find)
    const comps = _e2UnionFind(group, E2_CONTENT_COSINE);
    for (const cluster of comps) {
      if (cluster.length < E2_CONTENT_MIN_CLUSTER) continue;
      // all-pairs non-contradicting (a single contradicting pair disqualifies the whole cluster)
      let contradict = false;
      for (let i = 0; i < cluster.length && !contradict; i++)
        for (let j = i + 1; j < cluster.length; j++)
          if (detectContradiction(cluster[i].text, cluster[j].text) != null) { contradict = true; break; }
      if (contradict) { LOG_DEBUG && console.log('[E2] content cluster skipped (contradiction pair)'); continue; }
      // low-importance only (never silently merge a high-stakes fact)
      if (cluster.some(m => Number(m.importance ?? 0) >= E2_CONTENT_MAX_IMPORTANCE)) continue;
      // J3 synth REQUIRED — silent-loss gate: on degraded, NO merge (today's behavior preserved)
      const synth = await synthesizeConsolidation(cluster).catch(() => ({ degraded: true, text: null, reason: 'throw' }));
      if (synth.degraded) { LOG_DEBUG && console.log(`[E2] content cluster synth degraded (${synth.reason}) — no merge (silent-loss gate)`); continue; }
      cluster.sort(byOldest);
      const anchor = cluster[0];
      const extras = cluster.slice(1).map(m => ({ id: m.id, text: m.text }));
      const ok = appendEvolvedContext(anchor.id, extras, { canonical: synth.text, importanceBump: E2_CONTENT_IMPORTANCE_BUMP });
      if (ok) {
        for (const m of cluster.slice(1)) updateMemoryStatus(m.id, 'superseded', anchor.id);
        merged++;
        LOG_DEBUG && console.log(`[E2] consolidate content: folded ${extras.length} facets -> anchor #${anchor.id} (canonical synthed)`);
      }
    }
  }
  return merged;
}

// E2 helper — Union-Find over `items`: union i,j when cosineSimilarity(items[i].embedding,
// items[j].embedding) >= threshold. Returns connected components as arrays of the original rows,
// each length >= 1. Embeddings are Float32Array from getActiveWithEmbedding; rows missing one are
// singletons (never merged). O(n^2) but n is per-(bucket,entity) so small.
function _e2UnionFind(items, threshold) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    const ei = items[i].embedding;
    if (!ei) continue;
    for (let j = i + 1; j < n; j++) {
      const ej = items[j].embedding;
      if (!ej) continue;
      if (cosineSimilarity(ei, ej) >= threshold) union(i, j);
    }
  }
  const buckets = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(items[i]); }
  return [...buckets.values()];
}

// E5 maintenance step — the bounded-active-set enforcement run as runMaintenance's final step.
// Extracted to a named export so the regression test drives the REAL wiring (the
// ENABLE_ACTIVE_SET_BOUND gate + the enforceActiveSetBound call) directly, without booting the
// embedding engine (runMaintenance early-returns when Brain-1 is not ready). NEVER demotes L0/L3
// (E6 cardinal) — that guard lives in enforceActiveSetBound itself.
export function runActiveSetBoundStep(results = {}) {
	if (process.env.ENABLE_ACTIVE_SET_BOUND === 'false') {
		results.activeSetBound = { gated: false, reason: 'gate disabled (ENABLE_ACTIVE_SET_BOUND=false)' };
		return results;
	}
	try {
		const bound = enforceActiveSetBound();
		if (LOG_DEBUG && bound?.gated) console.log(`[Maintenance] E5 bounded active set: demoted ${bound.demoted} (active ${bound.activeCount}, remaining ${bound.remaining ?? 'n/a'})`);
		if (bound?.gated) results.activeSetBound = bound;
	} catch (e) { if (LOG_DEBUG) console.error('[Maintenance] E5 bounded active set error:', e.message); }
	return results;
}

export function startMaintenanceCron(intervalMs = RUN_INTERVAL_MS) {
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  if (initialTimeout) clearTimeout(initialTimeout);

  // Run first maintenance after 30s (give server time to load)
  initialTimeout = setTimeout(() => {
    runMaintenance().catch(err => LOG_DEBUG && console.error('[Maintenance] Initial run error:', err.message));
  }, 30000);

  maintenanceInterval = setInterval(() => {
    runMaintenance().catch(err => LOG_DEBUG && console.error('[Maintenance] Cron run error:', err.message));
  }, intervalMs);

  LOG_DEBUG && console.log(`[Maintenance] Cron started: every ${Math.round(intervalMs / 1000)}s`);
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
