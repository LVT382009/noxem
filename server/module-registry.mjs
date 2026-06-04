/**
 * Module Registry — wires all 15 Noxem adapter modules with server dependencies.
 *
 * Call initModules(embedFn) once at startup after the embedding engine is ready.
 * Adapter namespaces are re-exported for convenient access.
 *
 * @module module-registry
 */

// ── Adapter imports (namespaces) ──────────────────────────────────────

import * as multiSourceRouter from '../modules/retrieval/multi-source-router/noxem-adapter.mjs';
import * as crossModalExtractor from '../modules/retrieval/cross-modal-extractor/noxem-adapter.mjs';
import * as deltaProcessor from '../modules/retrieval/delta-processor/noxem-adapter.mjs';
import * as entityRanker from '../modules/management/entity-ranker/noxem-adapter.mjs';
import * as spatialFilter from '../modules/management/spatial-filter/noxem-adapter.mjs';
import * as ambientInjector from '../modules/management/ambient-injector/noxem-adapter.mjs';
import * as graphPruner from '../modules/vector-compress/graph-pruner/noxem-adapter.mjs';
import * as capsuleBuilder from '../modules/vector-compress/capsule-builder/noxem-adapter.mjs';
import * as contextCompressor from '../modules/vector-compress/context-compressor/noxem-adapter.mjs';
import * as strategyDistiller from '../modules/reasoning/strategy-distiller/noxem-adapter.mjs';
import * as ingestPipeline from '../modules/reasoning/ingest-pipeline/noxem-adapter.mjs';
import * as compactionCoordinator from '../modules/reasoning/compaction-coordinator/noxem-adapter.mjs';
import * as lessonVault from '../modules/infra/lesson-vault/noxem-adapter.mjs';
import * as declarativeGateway from '../modules/infra/declarative-gateway/noxem-adapter.mjs';
import * as diagnosticCompiler from '../modules/infra/diagnostic-compiler/noxem-adapter.mjs';

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

// ── Initialization ────────────────────────────────────────────────────

/**
 * Initialize all DI-enabled adapter modules with their server dependencies.
 *
 * Must be called once at startup after the embedding engine is ready.
 * Adapters that receive db/deps per function call (multi-source-router,
 * cross-modal-extractor, graph-pruner, capsule-builder, lesson-vault,
 * compaction-coordinator) do NOT need init — they are stateless namespaces.
 *
 * @param {Function} embedFn - The embed() function from embedding-engine
 */
export function initModules(embedFn) {
  const _embed = embedFn || embed;

  // ── 1. Entity Ranker (Memary) ──────────────────────────────────────
  entityRanker.initEntityRanker(db, {
    listEntities,
    getEntity,
    touchEntity,
    traverseMemoryGraph,
    storeEdge,
    getActiveMemories,
    incrementRecallCounts,
    extractEntityAttribute,
  });

  // ── 2. Spatial Filter (MemPalace) ──────────────────────────────────
  spatialFilter.initSpatialFilter(db, {
    getMemoriesByEntityAttr,
    searchMemories,
    storeMemory,
    storeEdge,
    getActiveMemories,
    getAllCoreBlocks,
    extractEntityAttribute,
    findDuplicates,
    getEntityRanking: entityRanker.getEntityRanking,
  });

  // ── 3. Ambient Injector (Lemma) ────────────────────────────────────
  ambientInjector.initAmbientInjector(db, {
    storeEdge,
    searchMemories,
    getActiveMemories,
    incrementRecallCounts,
    traverseMemoryGraph,
    getAllCoreBlocks,
    getMemory,
    getEdgesFromMemory,
    getEdgesToMemory,
    getEntityRanking: entityRanker.getEntityRanking,
  });

  // ── 4. Strategy Distiller (ReasoningBank) ──────────────────────────
  strategyDistiller.initStrategyDistiller(db, { llmFetch });

  // ── 5. Ingest Pipeline (LLM Wiki) ──────────────────────────────────
  ingestPipeline.initIngestPipeline(db, { llmFetch });

  // ── 6. Schema bootstrap: delta-processor (CocoIndex) ───────────────
  deltaProcessor.bootstrapSchema(db);
  deltaProcessor.initStaleEmbeddingDetector(db);
  deltaProcessor.initLogicVersioning(db);
  deltaProcessor.initSourceLineage(db);
  deltaProcessor.initDeltaSync(db);
  deltaProcessor.initModelVersionGate(db);

  // ── 7. Schema bootstrap: graph-pruner (LEANN) ──────────────────────
  graphPruner.ensureSchema(db);

  // ── 8. Schema bootstrap: capsule-builder (Memvid) ──────────────────
  capsuleBuilder.installSchema(db);

  // ── 9. Schema bootstrap: context-compressor (Headroom) ─────────────
  contextCompressor.initCompressionPatternsTable(db);

  // ── 10. Schema bootstrap: compaction-coordinator (MARM) ─────────────
  compactionCoordinator.initCompactionTables(db);

  // ── 11. Schema bootstrap: diagnostic-compiler (zerolang) ───────────
  diagnosticCompiler.initDiagnosticAdapter(db);

  // ── 12. Declarative Gateway (MCP Toolbox) ──────────────────────────
  // Async init — call without await so startup is not blocked.
  // The gateway sets _ready=true internally when complete.
  declarativeGateway.initDeclarativeGateway(db, { brain2Fn: null });

  // lesson-vault and multi-source-router are pass-by-param — no init needed.

  _initialized = true;
}

// ── Namespace re-exports ──────────────────────────────────────────────

export {
  multiSourceRouter,
  crossModalExtractor,
  deltaProcessor,
  entityRanker,
  spatialFilter,
  ambientInjector,
  graphPruner,
  capsuleBuilder,
  contextCompressor,
  strategyDistiller,
  ingestPipeline,
  compactionCoordinator,
  lessonVault,
  declarativeGateway,
  diagnosticCompiler,
};

// ── Status ────────────────────────────────────────────────────────────

/**
 * Return the initialization state of all adapter modules.
 * @returns {{ initialized: boolean, moduleCount: number, modules: string[] }}
 */
export function getModuleStatus() {
  const modules = [
    'multiSourceRouter',
    'crossModalExtractor',
    'deltaProcessor',
    'entityRanker',
    'spatialFilter',
    'ambientInjector',
    'graphPruner',
    'capsuleBuilder',
    'contextCompressor',
    'strategyDistiller',
    'ingestPipeline',
    'compactionCoordinator',
    'lessonVault',
    'declarativeGateway',
    'diagnosticCompiler',
  ];
  return {
    initialized: _initialized,
    moduleCount: modules.length,
    modules,
  };
}
