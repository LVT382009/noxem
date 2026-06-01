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

import { storeMemory, getAllActiveMemoriesNoEmbed, getSessionMemories, updateMemoryType, upsertEntity, linkMemoryToEntity, addFacet, addFacetPoint, getMemoriesByEntityAttr } from './memory-store.mjs';
import { isEmbeddingReady, embed, categorizeText, estimateImportance, generateContextPrefix, extractEntityAttribute } from './embedding-engine.mjs';

const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const PIPELINE_ENABLED = process.env.PIPELINE_ENABLED !== 'false';

// Warmup schedule: number of new L0 memories needed before next extraction
const WARMUP_SCHEDULE = [1, 2, 4, 8]; // After 1, 2, 4, 8 new memories
const L3_MIN_L1_MEMORIES = 50;

// Track extraction state per session
const sessionState = new Map();

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, { l0Count: 0, lastL1Extract: 0, lastL2Extract: 0, lastL3Extract: 0 });
  }
  return sessionState.get(sessionId);
}

function getWarmupThreshold(count) {
  for (const threshold of WARMUP_SCHEDULE) {
    if (count <= threshold) return threshold;
  }
  return WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1] * 2;
}

/**
 * Called after each L0 memory store. Checks if extraction should run.
 */
export function onMemoryStored(sessionId) {
  if (!PIPELINE_ENABLED) return;
  const state = getSessionState(sessionId);
  state.l0Count++;

  const threshold = getWarmupThreshold(state.lastL1Extract);
  const newSinceExtract = state.l0Count - state.lastL1Extract;
  if (newSinceExtract >= threshold) {
    // Schedule L1 extraction (non-blocking)
    extractL1FromL0(sessionId).catch(err => {
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
  const episodeMems = getSessionMemories(sessionId)
    .filter(m => m.cone_layer === 0 || !m.cone_layer)
    .slice(-20); // Process last 20 episode memories

  if (episodeMems.length < 1) return;

  const memText = episodeMems.map(m => `[${m.type}] ${m.text}`).join('\n');

  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'Extract structured facts from these conversation memories. Return ONLY a JSON array: [{"text":"...","type":"fact|preference|setup|project|goal|entity","entity":"...","attribute":"..."}]. Extract only non-obvious, durable information. Max 10 items.' },
          { role: 'user', content: `Memories:\n${memText}\n\nExtract L1 atoms:` },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return;

    const atoms = JSON.parse(jsonMatch[0]);
    for (const atom of atoms.slice(0, 10)) {
      if (!atom.text || !atom.type) continue;
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(atom.text)); } catch {}
      }
      storeMemory({
        text: atom.text,
        type: atom.type,
        session_id: sessionId,
        entity: atom.entity || '',
        attribute: atom.attribute || '',
        context_prefix: generateContextPrefix(atom.text, atom.type, sessionId),
        importance: estimateImportance(atom.text, atom.type),
        cone_layer: 1, // L1 facet
        embedding,
      });
    }

    state.lastL1Extract = state.l0Count;
    LOG_DEBUG && console.log(`[Pipeline] L1 extraction: ${atoms.length} atoms from ${episodeMems.length} episodes`);
  } catch (err) {
    LOG_DEBUG && console.error('[Pipeline] L1 LLM error:', err.message);
  }
}

/**
 * L2 Scene Extraction: group L1 memories by entity, create scene summaries.
 */
export async function extractL2Scenes() {
  const l1Mems = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 1);
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

    const sceneText = mems.map(m => `- [${m.type}] ${m.text}`).join('\n');
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: `Summarize these memories about "${entity}" into a concise scene description (1-2 sentences). Focus on the key facts and relationships.` },
            { role: 'user', content: sceneText },
          ],
          max_tokens: 256,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const summary = data?.choices?.[0]?.message?.content?.trim();
      if (!summary || summary.length < 10) continue;

      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(summary)); } catch {}
      }
      storeMemory({
        text: summary,
        type: 'project',
        session_id: 'pipeline',
        entity,
        attribute: 'scene_summary',
        context_prefix: `Scene, about ${entity}:`,
        importance: 0.8,
        cone_layer: 2, // L2 abstraction
        embedding,
      });
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
  const l1Mems = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 1);
  if (l1Mems.length < L3_MIN_L1_MEMORIES) return;

  const textBlock = l1Mems.slice(0, 80).map(m => `[${m.type}] ${m.text}`).join('\n');

  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'Create a concise user persona (3-5 sentences) based on stored preferences, facts, and patterns. Focus on work style, technical preferences, and key goals.' },
          { role: 'user', content: textBlock },
        ],
        max_tokens: 512,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return;
    const data = await res.json();
    const persona = data?.choices?.[0]?.message?.content?.trim();
    if (!persona || persona.length < 20) return;

    let embedding = null;
    if (isEmbeddingReady()) {
      try { embedding = new Float32Array(await embed(persona)); } catch {}
    }
    storeMemory({
      text: persona,
      type: 'profile',
      session_id: 'pipeline',
      entity: 'user',
      attribute: 'persona',
      context_prefix: 'Persona, user profile:',
      importance: 1.0,
      cone_layer: 3, // L3 core
      embedding,
    });

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
  const l0 = getAllActiveMemoriesNoEmbed().filter(m => !m.cone_layer || m.cone_layer === 0).length;
  const l1 = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 1).length;
  const l2 = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 2).length;
  const l3 = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 3).length;
  return { enabled: PIPELINE_ENABLED, layers: { L0_episode: l0, L1_facet: l1, L2_abstraction: l2, L3_core: l3 } };
}
