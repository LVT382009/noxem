/**
 * Module Registry — wires all 15 Noxem adapter modules with server dependencies.
 *
 * Uses dynamic imports with graceful fallback so the server starts even if
 * some adapters are missing (e.g. fresh clone without vendor repos).
 * Call initModules(embedFn) once at startup after the embedding engine is ready.
 *
 * @module module-registry
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Server dependency imports ─────────────────────────────────────────

import {
  db,
  storeMemory,
  searchMemories,
  getMemory,
  getActiveMemories,
  getAllActiveMemories,
  incrementRecallCounts,
  traverseMemoryGraph,
  storeEdge,
  getEdgesFromMemory,
  getEdgesToMemory,
  getMemoriesByEntityAttr,
  getAllCoreBlocks,
  listEntities,
  getEntity,
  touchEntity,
} from './memory-store.mjs';

import {
  embed,
  embedBatch,
  searchByEmbedding,
  categorizeText,
  estimateImportance,
  mmrRerank,
  extractEntityAttribute,
  generateContextPrefix,
  cosineSimilarity,
  findDuplicates,
} from './embedding-engine.mjs';

import { llmFetch } from './llm-fetch.mjs';

import {
  analyzeBeforeCompress,
  getAdvice,
  analyzeSessionEnd,
} from './advisor-engine.mjs';

// ── State ─────────────────────────────────────────────────────────────

let _initialized = false;
const _modules = {};

// ── Adapter definitions ───────────────────────────────────────────────

const ADAPTER_DEFS = [
  { key: 'multiSourceRouter',    path: '../modules/retrieval/multi-source-router/noxem-adapter.mjs' },
  { key: 'crossModalExtractor',  path: '../modules/retrieval/cross-modal-extractor/noxem-adapter.mjs' },
  { key: 'deltaProcessor',       path: '../modules/retrieval/delta-processor/noxem-adapter.mjs' },
  { key: 'entityRanker',         path: '../modules/management/entity-ranker/noxem-adapter.mjs' },
  { key: 'spatialFilter',        path: '../modules/management/spatial-filter/noxem-adapter.mjs' },
  { key: 'ambientInjector',      path: '../modules/management/ambient-injector/noxem-adapter.mjs' },
  { key: 'graphPruner',          path: '../modules/vector-compress/graph-pruner/noxem-adapter.mjs' },
  { key: 'capsuleBuilder',       path: '../modules/vector-compress/capsule-builder/noxem-adapter.mjs' },
  { key: 'contextCompressor',    path: '../modules/vector-compress/context-compressor/noxem-adapter.mjs' },
  { key: 'strategyDistiller',    path: '../modules/reasoning/strategy-distiller/noxem-adapter.mjs' },
  { key: 'ingestPipeline',       path: '../modules/reasoning/ingest-pipeline/noxem-adapter.mjs' },
  { key: 'compactionCoordinator',path: '../modules/reasoning/compaction-coordinator/noxem-adapter.mjs' },
  { key: 'lessonVault',          path: '../modules/infra/lesson-vault/noxem-adapter.mjs' },
  { key: 'declarativeGateway',   path: '../modules/infra/declarative-gateway/noxem-adapter.mjs' },
  { key: 'diagnosticCompiler',   path: '../modules/infra/diagnostic-compiler/noxem-adapter.mjs' },
];

// ── Dynamic import with fallback ──────────────────────────────────────

async function _loadAdapter(def) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const absPath = join(__dirname, def.path);
  try {
    const mod = await import(absPath);
    _modules[def.key] = mod;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'ENOENT') {
      console.warn(`[module-registry] Adapter "${def.key}" not found — skipping (${def.path})`);
      _modules[def.key] = null;
    } else {
      console.error(`[module-registry] Adapter "${def.key}" load error:`, err.message);
      _modules[def.key] = null;
    }
  }
}

// ── Lazy namespace accessors ──────────────────────────────────────────

function _ns(key) {
  const mod = _modules[key];
  if (!mod) return new Proxy({}, { get: () => () => { console.warn(`[module-registry] ${key} not available`); return null; } });
  return mod;
}

// Lazy getters — these appear as namespace objects after initModules() completes
let _ready = false;

export const multiSourceRouter     = new Proxy({}, { get: (_, p) => _ns('multiSourceRouter')[p] });
export const crossModalExtractor   = new Proxy({}, { get: (_, p) => _ns('crossModalExtractor')[p] });
export const deltaProcessor        = new Proxy({}, { get: (_, p) => _ns('deltaProcessor')[p] });
export const entityRanker          = new Proxy({}, { get: (_, p) => _ns('entityRanker')[p] });
export const spatialFilter         = new Proxy({}, { get: (_, p) => _ns('spatialFilter')[p] });
export const ambientInjector       = new Proxy({}, { get: (_, p) => _ns('ambientInjector')[p] });
export const graphPruner           = new Proxy({}, { get: (_, p) => _ns('graphPruner')[p] });
export const capsuleBuilder        = new Proxy({}, { get: (_, p) => _ns('capsuleBuilder')[p] });
export const contextCompressor     = new Proxy({}, { get: (_, p) => _ns('contextCompressor')[p] });
export const strategyDistiller     = new Proxy({}, { get: (_, p) => _ns('strategyDistiller')[p] });
export const ingestPipeline        = new Proxy({}, { get: (_, p) => _ns('ingestPipeline')[p] });
export const compactionCoordinator = new Proxy({}, { get: (_, p) => _ns('compactionCoordinator')[p] });
export const lessonVault           = new Proxy({}, { get: (_, p) => _ns('lessonVault')[p] });
export const declarativeGateway    = new Proxy({}, { get: (_, p) => _ns('declarativeGateway')[p] });
export const diagnosticCompiler    = new Proxy({}, { get: (_, p) => _ns('diagnosticCompiler')[p] });

// ── Initialization ────────────────────────────────────────────────────

/**
 * Load and initialize all adapter modules.
 *
 * Must be called once at startup after the embedding engine is ready.
 * Missing adapters are silently skipped — the server stays functional.
 *
 * @param {Function} embedFn - The embed() function from embedding-engine
 */
export async function initModules(embedFn) {
  const _embed = embedFn || embed;

  // 1. Load all adapters dynamically
  await Promise.all(ADAPTER_DEFS.map(def => _loadAdapter(def)));

  const loaded = ADAPTER_DEFS.filter(d => _modules[d.key] !== null).length;
  const skipped = ADAPTER_DEFS.length - loaded;
  console.log(`[module-registry] Loaded ${loaded}/${ADAPTER_DEFS.length} adapters${skipped ? ` (${skipped} skipped)` : ''}`);

  // 2. Wire DI adapters with server dependencies
  const m = _modules;

if (m.entityRanker) { try {
  m.entityRanker.initEntityRanker(db, {
    listEntities, getEntity, touchEntity, traverseMemoryGraph,
    storeEdge, getActiveMemories, incrementRecallCounts, extractEntityAttribute,
  });
} catch (e) { console.error('[module-registry] entityRanker init failed:', e.message); } }

if (m.spatialFilter) { try {
  m.spatialFilter.initSpatialFilter(db, {
    getMemoriesByEntityAttr, searchMemories, storeMemory, storeEdge,
    getActiveMemories, getAllCoreBlocks, extractEntityAttribute, findDuplicates,
    getEntityRanking: m.entityRanker?.getEntityRanking,
  });
} catch (e) { console.error('[module-registry] spatialFilter init failed:', e.message); } }

if (m.ambientInjector) { try {
  m.ambientInjector.initAmbientInjector(db, {
    storeEdge, searchMemories, getActiveMemories, incrementRecallCounts,
    traverseMemoryGraph, getAllCoreBlocks, getMemory,
    getEdgesFromMemory, getEdgesToMemory,
    getEntityRanking: m.entityRanker?.getEntityRanking,
  });
} catch (e) { console.error('[module-registry] ambientInjector init failed:', e.message); } }

if (m.strategyDistiller) { try {
  m.strategyDistiller.initStrategyDistiller(db, { llmFetch });
} catch (e) { console.error('[module-registry] strategyDistiller init failed:', e.message); } }

if (m.ingestPipeline) { try {
  m.ingestPipeline.initIngestPipeline(db, { llmFetch });
} catch (e) { console.error('[module-registry] ingestPipeline init failed:', e.message); } }

// Schema bootstraps
if (m.deltaProcessor) { try {
  m.deltaProcessor.bootstrapSchema(db);
  m.deltaProcessor.initStaleEmbeddingDetector(db);
  m.deltaProcessor.initLogicVersioning(db);
  m.deltaProcessor.initSourceLineage(db);
  m.deltaProcessor.initDeltaSync(db);
  m.deltaProcessor.initModelVersionGate(db);
} catch (e) { console.error('[module-registry] deltaProcessor schema failed:', e.message); } }

if (m.graphPruner) { try { m.graphPruner.ensureSchema(db); } catch (e) { console.error('[module-registry] graphPruner schema failed:', e.message); } }
if (m.capsuleBuilder) { try { m.capsuleBuilder.installSchema(db); } catch (e) { console.error('[module-registry] capsuleBuilder schema failed:', e.message); } }
if (m.contextCompressor) { try { m.contextCompressor.initCompressionPatternsTable(db); } catch (e) { console.error('[module-registry] contextCompressor schema failed:', e.message); } }
if (m.compactionCoordinator) { try { m.compactionCoordinator.initCompactionTables(db); } catch (e) { console.error('[module-registry] compactionCoordinator schema failed:', e.message); } }
if (m.diagnosticCompiler) { try { m.diagnosticCompiler.initDiagnosticAdapter(db); } catch (e) { console.error('[module-registry] diagnosticCompiler init failed:', e.message); } }

if (m.declarativeGateway) { try {
  m.declarativeGateway.initDeclarativeGateway(db, { brain2Fn: null });
} catch (e) { console.error('[module-registry] declarativeGateway init failed:', e.message); } }

  _initialized = true;
  _ready = true;
}

// ── Status ────────────────────────────────────────────────────────────

/**
 * Return the initialization state of all adapter modules.
 * @returns {{ initialized: boolean, moduleCount: number, loaded: number, skipped: number, modules: string[] }}
 */
export function getModuleStatus() {
  const all = ADAPTER_DEFS.map(d => d.key);
  const loaded = all.filter(k => _modules[k] !== null);
  return {
    initialized: _initialized,
    moduleCount: all.length,
    loaded: loaded.length,
    skipped: all.length - loaded.length,
    modules: all,
    loadedModules: loaded,
  };
}
