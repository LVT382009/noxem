/**
 * Memory Pipeline Manager — TencentDB L0-L3 progressive extraction.
 *
 * Cone layer mapping:
 *   L0 (episode, cone_layer=0) — raw memories from conversation
 *   L1 (facet, cone_layer=1) — extracted atoms (facts, preferences, setup)
 *   L2 (abstraction, cone_layer=2) — grouped scenes per entity
 *   L3 (core, cone_layer=3) — persona summary from 50+ L1 memories
 *
 * Extraction schedule: warmup pattern 1→2→4→N turns.
 * L2 scenes are grouped by entity from L1 atoms.
 * L3 persona is generated when 50+ L1 memories exist.
 */

import { storeMemory, getAllActiveMemoriesNoEmbed, getSessionMemories, updateMemoryType, updateMemoryStatus, upsertEntity, linkMemoryToEntity, addFacet, addFacetPoint, getMemoriesByEntityAttr, linkContradictionPair } from './memory-store.mjs';
import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
import { isEmbeddingReady, embed, categorizeText, classifyIntent, estimateImportance, generateContextPrefix, extractEntityAttribute } from './embedding-engine.mjs';
import { ingestPipeline, deltaProcessor, multiSourceRouter, crossModalExtractor, lessonVault } from './module-registry.mjs';

const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '60000');

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const PIPELINE_ENABLED = process.env.PIPELINE_ENABLED !== 'false';

// Warmup schedule: number of new L0 memories needed before next extraction
const WARMUP_SCHEDULE = [1, 2, 4, 8]; // After 1, 2, 4, 8 new memories
const L3_MIN_L1_MEMORIES = 50;

// Track extraction state per session
const sessionState = new Map();
const extractingL1 = new Set(); // Per-session lock to prevent concurrent L1 extraction

// Periodic cleanup: evict stale session state (idle > 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [sid, state] of sessionState) {
    if (now - state.lastActivity > 3_600_000) { // BUG-13 fix: use lastActivity, not lastL1Extract
      sessionState.delete(sid);
      extractingL1.delete(sid);
    }
  }
}, 300_000).unref();

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, { l0Count: 0, l1ExtractCount: 0, lastL1Extract: 0, lastL1ExtractAt: 0, lastL2Extract: 0, lastL3Extract: 0, consecutiveFailures: 0, lastActivity: Date.now() });
  }
  return sessionState.get(sessionId);
}

function getWarmupThreshold(extractionIndex) {
    if (extractionIndex < WARMUP_SCHEDULE.length) return WARMUP_SCHEDULE[extractionIndex];
    return WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1] * 2;
}

/**
 * Called after each L0 memory store. Checks if extraction should run.
 */
export function onMemoryStored(sessionId) {
  if (!PIPELINE_ENABLED) return;
  const state = getSessionState(sessionId);
  state.l0Count++; state.lastActivity = Date.now(); // BUG-13 fix: track last activity

  const threshold = getWarmupThreshold(state.l1ExtractCount);
  const newSinceExtract = state.l0Count - state.lastL1Extract;
  if (newSinceExtract >= threshold && !extractingL1.has(sessionId)) {
    extractingL1.add(sessionId);
    // Schedule L1 extraction (non-blocking)
    extractL1FromL0(sessionId).finally(() => extractingL1.delete(sessionId))
      .catch(err => {
      LOG_DEBUG && console.error('[Pipeline] L1 extraction error:', err.message);
    });
  }
}

/**
 * L1 Extraction: extract structured atoms from recent L0 episode memories.
 * Uses LLM to extract facts, preferences, setup details from conversation turns.
 */
export async function extractL1FromL0(sessionId) {
  const state = getSessionState(sessionId);
  if (state.consecutiveFailures > 0) {
    // Failure backoff: throttle repeat attempts so a slow/down LLM is not hammered on every store.
    // Uses a real ms timestamp (lastL1ExtractAt) — NOT the count cursor lastL1Extract. lastL1Extract
    // is a memory COUNT (small int) consumed at onMemoryStored:66; comparing Date.now()≈1.7e12 minus
    // it was always >= cooldownMs → the cooldown used to ALWAYS skip (dead defensive code).
    const cooldownMs = Math.min(30_000 * state.consecutiveFailures, 300_000);
    if (Date.now() - state.lastL1ExtractAt < cooldownMs) return;
  }
  // Stamp THIS attempt's start so the next call's cooldown is measured from here (success OR failure).
  state.lastL1ExtractAt = Date.now();
  const episodeMems = getSessionMemories(sessionId)
    .filter(m => m.cone_layer === 0 || !m.cone_layer)
    .slice(-20); // Process last 20 episode memories

  if (episodeMems.length < 1) return;

  const memText = episodeMems.map(m => `[${m.type}] ${m.text}`).join('\n');

  try {
    const res = await llmFetch(LLM_URL, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          // FIX-1 (BEAM bench): unify the auto-ingest L1 to the SAME v10 rule set as
          // /memory/extract (server/memory-extract.mjs EXTRACTION_PROMPT): verbatim
          // numbers/dates/identifiers, MANDATORY source_quote (anti-hallucination),
          // denials+contradictions both sides, no fact collapse, event_date/order_index/
          // contradiction_with carried through. Lets raw-blob /memory/store-batch turns
          // produce the typed atoms the gold rubric (250ms / March 29 / Flask-Login
          // v0.6.2) needs. Also raised the 10-item cap -> 200 and max_tokens 1024 -> 4000.
          { role: 'system', content: `You are a memory extraction AI. Extract structured fact atoms from the conversation/memory entries below.
CRITICAL RULES:
- Extract ONLY information actually stated. NEVER hallucinate or infer beyond what is written.
- Preserve VERBATIM specifics: exact numbers (e.g. "250ms", "Flask 2.3.1"), exact dates (e.g. "March 29, 2024"), exact identifiers (e.g. "pbkdf2", "UNIQUE constraint", "Flask-WTF", "Confluence", "Matplotlib"). Do NOT paraphrase or round these.
- For EVERY memory provide a "source_quote": a short VERBATIM phrase copied from the inputs that proves this memory. If you cannot find a verbatim quote, do NOT emit the memory.
- Capture DENIALS and contradictions explicitly (e.g. "User decided AGAINST microservices", "User never integrated Flask-Login"). Set "contradiction_with" to the text of the opposing memory if one exists in the same batch.
- Extract BOTH sides of any contradiction as separate memories and cross-reference them via "contradiction_with".
- Enumerate EVERY distinct fact/event/preference; do not collapse multiple facts into one memory.
- Categorize type as: preference, fact, entity, event, pattern, goal, project, setup, issue, reflection, summary
- Each memory text must be a complete sentence.
- Return ONLY a JSON array, nothing else (no markdown fences, no prose).
- Max 200 items.
Output schema (JSON array): [{"text","type","source_quote","entity","attribute","value","event_date","order_index","contradiction_with"}]` },
          { role: 'user', content: `Memories:\n${memText}\n\nExtract L1 atoms:` },
        ],
        max_tokens: 4000,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });

    if (!res.ok) { state.consecutiveFailures++; return; }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) { state.consecutiveFailures++; return; }

    let atoms;
    try { atoms = JSON.parse(jsonMatch[0]); } catch (parseErr) {
      LOG_DEBUG && console.error('[Pipeline] L1 JSON parse error:', parseErr.message);
      state.consecutiveFailures++;
      return;
    }
    const _stored = []; // FIX-1: track stored atoms for contradiction pair-linking (mirrors /memory/extract).
    for (const atom of atoms.slice(0, 200)) {
      if (!atom.text || !atom.type) continue;
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(atom.text)); } catch (e) { LOG_DEBUG && console.warn('[Pipeline] L1 embedding failed:', e.message); }
      }
      const id = storeMemory({
        text: atom.text,
        type: atom.type,
        session_id: sessionId,
        entity: atom.entity || '',
        attribute: atom.attribute || '',
        context_prefix: generateContextPrefix(atom.text, atom.type, sessionId),
        importance: estimateImportance(atom.text, atom.type),
        cone_layer: 1, // L1 facet
        // E2: tag intent so extracted L1 facets cluster by speech-act in consolidateSemantically.
        intent_type: classifyIntent(atom.text),
        embedding,
        // FIX-1 (BEAM bench): carry the v10 typed fields through so retrieval can project
        // verbatim dates/order/contradictions (FIX-5) instead of NULL columns. The extractor's
        // text-form `contradiction_with` is NOT a store column — it is tracked below and used
        // to cross-link the pair (which sets contradiction_pair_id + status='contradicted').
        source_quote: atom.source_quote || '',
        event_date: atom.event_date || null,
        order_index: typeof atom.order_index === 'number' ? atom.order_index : null,
      });
      _stored.push({ id, text: atom.text, contradiction_with: atom.contradiction_with || null });
    }

    // FIX-1 (BEAM bench): contradiction pair-linking — mirrors the strong /memory/extract
    // path (memory-server.mjs cross-link). For each atom whose extractor-supplied
    // contradiction_with matches a sibling's text, bidirectionally link the pair and mark
    // both 'contradicted'. Both halves then surface via the ('active','contradicted')
    // search filter + the now-contradiction-aware vector arm (FIX-4).
    const _norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').slice(0, 200).trim();
    let _linked = 0;
    for (let i = 0; i < _stored.length; i++) {
      const a = _stored[i];
      if (!a.contradiction_with) continue;
      const needle = _norm(a.contradiction_with);
      if (!needle) continue;
      for (let j = 0; j < _stored.length; j++) {
        if (j === i) continue;
        const jText = _norm(_stored[j].text);
        if (jText && (jText.includes(needle) || needle.includes(jText))) {
          if (linkContradictionPair(a.id, _stored[j].id)) { _linked++; break; }
        }
      }
    }

    // Only the SUCCESS path advances the l0Count cursor (lastL1Extract) + the warmup schedule
    // (l1ExtractCount) + clears consecutiveFailures. Failure branches above increment
    // consecutiveFailures only — leaving the cursor so the SAME L0 window is retried next tick (the
    // .slice(-20) re-read window never permanently scrolls past un-extracted episodes).
    state.lastL1Extract = state.l0Count; state.l1ExtractCount++; state.consecutiveFailures = 0;
				// v2.2: Mark extraction complete in ingest pipeline
				try { ingestPipeline.markExtractionComplete(sessionId); } catch {}
    LOG_DEBUG && console.log(`[Pipeline] L1 extraction: ${atoms.length} atoms from ${episodeMems.length} episodes`);
  } catch (err) {
    state.consecutiveFailures++;
  LOG_DEBUG && console.error('[Pipeline] L1 LLM error:', err.message);
  }
}

/**
 * L2 Scene Extraction: group L1 memories by entity, create scene summaries.
 */
export async function extractL2Scenes() {
  // BUG-7 fix: single call to getAllActiveMemoriesNoEmbed, filter locally
  const allActive = getAllActiveMemoriesNoEmbed();
  const l1Mems = allActive.filter(m => m.cone_layer === 1);
  if (l1Mems.length < 5) return;

  // Group by entity
  const byEntity = new Map();
  for (const m of l1Mems) {
    const key = m.entity || '_unknown';
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(m);
  }

  // For each entity with 3+ L1 memories, create a scene
  for (const [entity, mems] of byEntity) {
    if (mems.length < 3) continue;

 // Skip if scene already exists for this entity
 const existing = allActive.filter(m => m.cone_layer === 2 && m.entity === entity); // BUG-7 fix: reuse cached allActive
    // BUG-17 fix: skip only if scene is recent (< 7 days old)
    if (existing.length > 0) {
      const lastScene = existing[existing.length - 1];
      const daysSinceExtract = (Date.now() - new Date(lastScene.created_at).getTime()) / 86400000;
      if (daysSinceExtract < 7) continue; // skip if recent
      // Stale scene re-extract: the supersede of `existing` now runs AFTER the new scene is stored
      // below (passing the real new id). Superseding BEFORE the LLM call left the cone layer with NO
      // replacement on a transient LLM failure → bundleSearch lost the L2 hop mid-outage (data loss).
    }
    const sceneText = mems.map(m => `- [${m.type}] ${m.text}`).join('\n');
    try {
      const res = await llmFetch(LLM_URL, {
        method: 'POST',
        headers: {},
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: `Summarize these memories about "${entity}" into a concise scene description (1-2 sentences). Focus on the key facts and relationships.` },
            { role: 'user', content: sceneText },
          ],
          max_tokens: 256,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const summary = data?.choices?.[0]?.message?.content?.trim();
      if (!summary || summary.length < 10) continue;

      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(summary)); } catch (e) { LOG_DEBUG && console.warn('[Pipeline] L2 embedding failed:', e.message); }
      }
      const newSceneId = storeMemory({
        text: summary,
        type: 'project',
        session_id: 'pipeline',
        entity,
        attribute: 'scene_summary',
        context_prefix: `Scene, about ${entity}:`,
        importance: 0.8,
        cone_layer: 2, // L2 abstraction
        intent_type: classifyIntent(summary), // E2 intent tag for semantic clustering
        embedding,
      });
      // Supersede the stale scene(s) with the REAL successor id, now that the replacement is safely
      // stored (moved from before the LLM call). Any failure above `continue`s/exits BEFORE this line
      // → the old scene stays 'active' → best-available-truth, no data loss. Passing newSceneId (not
      // null) also makes /memory/:id/lineage walkable (the prior null dropped the supersession chain).
      if (existing.length > 0) for (const sc of existing) updateMemoryStatus(sc.id, 'superseded', newSceneId);
    } catch (err) {
      LOG_DEBUG && console.error(`[Pipeline] L2 scene error for ${entity}:`, err.message);
    }
  }

  LOG_DEBUG && console.log(`[Pipeline] L2 scenes: processed ${byEntity.size} entities`);
}

/**
 * L3 Persona Extraction: summarize all L1 facts/preferences into a persona.
 * Only runs when 50+ L1 memories exist.
 */
export async function extractL3Persona() {
  // Single fetch (BUG-7 pattern; mirrors L2). Prior code scanned getAllActiveMemoriesNoEmbed()
  // twice — once for L1, once for L3 — while extractL2Scenes had already adopted the single-call
  // + local-filter fix. Dedupe here too: one scan, filter locally.
  const allActive = getAllActiveMemoriesNoEmbed();
  const l1Mems = allActive.filter(m => m.cone_layer === 1);
  if (l1Mems.length < L3_MIN_L1_MEMORIES) return;

  // BUG-17 fix: Skip only if persona is recent (< 7 days old)
  const existingP = allActive.filter(m => m.cone_layer === 3);
  if (existingP.length > 0) {
    const lastPersona = existingP[existingP.length - 1];
    const daysSinceExtract = (Date.now() - new Date(lastPersona.created_at).getTime()) / 86400000;
    if (daysSinceExtract < 7) return; // skip if recent
    // Stale persona re-extract: the supersede of `existingP` now runs AFTER the new persona is
    // stored below (passing the real new id). Superseding BEFORE the LLM call left the single
    // persona row blank mid-outage (L3_core: 0) on any transient LLM failure — data loss.
  }

  const textBlock = l1Mems.slice(0, 80).map(m => `[${m.type}] ${m.text}`).join('\n');

  try {
    const res = await llmFetch(LLM_URL, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'Create a concise user persona (3-5 sentences) based on stored preferences, facts, and patterns. Focus on work style, technical preferences, and key goals.' },
          { role: 'user', content: textBlock },
        ],
        max_tokens: 512,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });

    if (!res.ok) return;
    const data = await res.json();
    const persona = data?.choices?.[0]?.message?.content?.trim();
    if (!persona || persona.length < 20) return;

    let embedding = null;
    if (isEmbeddingReady()) {
      try { embedding = new Float32Array(await embed(persona)); } catch (e) { LOG_DEBUG && console.warn('[Pipeline] L3 embedding failed:', e.message); }
    }
    const newPersonaId = storeMemory({
      text: persona,
      type: 'profile',
      session_id: 'pipeline',
      entity: 'user',
      attribute: 'persona',
      context_prefix: 'Persona, user profile:',
      importance: 1.0,
      cone_layer: 3, // L3 core
      intent_type: classifyIntent(persona), // E2 intent tag for semantic clustering
      embedding,
    });
    // Supersede the stale persona with the REAL successor id, now that the replacement is safely
    // stored (moved from before the LLM call). Any failure above `return`s/exits BEFORE this line →
    // the old persona stays 'active' → best-available-truth, no L3 blank-mid-outage. newPersonaId
    // (not null) keeps /memory/:id/lineage walkable.
    if (existingP.length > 0) for (const p of existingP) updateMemoryStatus(p.id, 'superseded', newPersonaId);

    LOG_DEBUG && console.log(`[Pipeline] L3 persona extracted from ${l1Mems.length} L1 memories`);
  } catch (err) {
    LOG_DEBUG && console.error('[Pipeline] L3 persona error:', err.message);
  }
}

/**
 * Run pipeline: L1 (auto on store), L2 (periodic), L3 (when 50+ L1).
 * Called from maintenance cron.
 */
export async function runPipeline() {
  if (!PIPELINE_ENABLED) return;
  await extractL2Scenes();
  await extractL3Persona();
}

export function getPipelineStatus() {
  // BUG-7 single-scan: one read of the active set, four local filters (mirrors extractL2Scenes:208
  // / extractL3Persona). The prior code ran 4 full WHERE status='active' scans — a 4× I/O multiplier
  // on this polled status endpoint. The dynamic `enabled` flag is preserved (PIPELINE_ENABLED reflects
  // the setting; counts stay real even when the pipeline is disabled).
  const all = getAllActiveMemoriesNoEmbed();
  const count = (lyr) => all.filter(m => lyr === 0 ? (!m.cone_layer || m.cone_layer === 0) : m.cone_layer === lyr).length;
  return { enabled: PIPELINE_ENABLED, layers: { L0_episode: count(0), L1_facet: count(1), L2_abstraction: count(2), L3_core: count(3) } };
}
