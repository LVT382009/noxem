/**
 * Cross-Modal Extractor — Noxem adapter
 *
 * Adapts RAG-Anything's multimodal content processing into Noxem's
 * SQLite + better-sqlite3 architecture. Provides:
 *
 * 1. Multimodal memory fields — content_type (text/image/table/code/equation),
 *    content_data (JSON payload), content_caption (description)
 * 2. Cross-modal edge typing — auto-create 'illustrates', 'belongs_to',
 *    'depicts' edges between non-text and text memories
 * 3. Modality-aware search reranking — boost non-text results when query
 *    contains visual keywords, slight penalty for text-focused queries
 * 4. Structured content embedding — serialize tables as Markdown, code in
 *    fenced blocks, images via caption text for richer semantic matching
 * 5. Document hierarchy via scene_name — activate existing but unused
 *    scene_name column with hierarchical paths and bonus scoring
 *
 * Integrates with: memory-server.mjs (search pipeline),
 * memory-store.mjs (prepared statements + db handle),
 * embedding-engine.mjs (embed / categorizeText / generateContextPrefix)
 */

import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Content types and their properties ──

const CONTENT_TYPES = new Set(['text', 'image', 'table', 'code', 'equation']);

const MODALITY_BOOST_MAP = {
  image:   1.3,
  table:   1.2,
  code:    1.1,
  equation: 1.05,
};

const VISUAL_KEYWORDS = [
  'screenshot', 'diagram', 'chart', 'image', 'look', 'see', 'show',
  'visual', 'picture', 'photo', 'figure', 'illustration', 'graph',
  'plot', 'drawing', 'snapshot', 'display', 'render', 'preview',
  'table', 'spreadsheet', 'grid', 'rows', 'columns', 'data',
  'code', 'snippet', 'function', 'class', 'method', 'script',
  'equation', 'formula', 'math', 'expression', 'calculation',
];

const TEXT_FOCUS_KEYWORDS = [
  'explain', 'describe', 'tell me', 'what is', 'who is', 'when did',
  'why does', 'how does', 'meaning of', 'definition',
];

// ── 1. Multimodal memory fields ──

/**
 * Validate and normalize content_type + content_data + content_caption
 * before storing. Returns a safe object with defaults.
 *
 * RAG-Anything insight: each modality has required fields — images need
 * url/caption, tables need headers/rows, code needs language/snippet.
 * This validator enforces those constraints without blocking storage.
 *
 * @param {object} params
 * @param {string} [params.content_type='text'] - One of CONTENT_TYPES
 * @param {string|object} [params.content_data=''] - JSON payload for the modality
 * @param {string} [params.content_caption=''] - VLM-generated or manual description
 * @returns {{ content_type: string, content_data: string, content_caption: string }}
 */
export function validateMultimodalFields({ content_type = 'text', content_data = '', content_caption = '' }) {
  const type = CONTENT_TYPES.has(content_type) ? content_type : 'text';

  let data = content_data;
  if (typeof data === 'object' && data !== null) {
    data = JSON.stringify(data);
  } else if (typeof data !== 'string') {
    data = '';
  }

  // Enforce required fields per content_type
  if (type === 'image' && data) {
    const parsed = _safeParseJSON(data);
    if (parsed && !parsed.url && !parsed.caption) {
      LOG_DEBUG && console.warn('[CrossModal] Image content_data missing url/caption, storing as-is');
    }
  }

  if (type === 'table' && data) {
    const parsed = _safeParseJSON(data);
    if (parsed && !parsed.headers && !parsed.rows && !parsed.markdown) {
      LOG_DEBUG && console.warn('[CrossModal] Table content_data missing headers/rows/markdown');
    }
  }

  if (type === 'code' && data) {
    const parsed = _safeParseJSON(data);
    if (parsed && !parsed.language && !parsed.snippet) {
      LOG_DEBUG && console.warn('[CrossModal] Code content_data missing language/snippet');
    }
  }

  return {
    content_type: type,
    content_data: data,
    content_caption: String(content_caption || ''),
  };
}

/**
 * Store a memory with multimodal fields. Wraps the existing storeMemory
 * but handles content_type, content_data, content_caption columns.
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {object} memory - Memory row to insert
 * @param {Function} storeMemoryFn - Original storeMemory function
 * @returns {object} Stored memory record
 */
export function storeMultimodalMemory(db, memory, storeMemoryFn) {
  const { content_type, content_data, content_caption } = validateMultimodalFields({
    content_type: memory.content_type,
    content_data: memory.content_data,
    content_caption: memory.content_caption,
  });

  const result = storeMemoryFn({
    ...memory,
    content_type,
    content_data,
    content_caption,
  });

  return result;
}

// ── 2. Cross-modal edge typing ──

/**
 * Auto-create cross-modal edges between a non-text memory and its
 * related text memory. RAG-Anything's "belongs_to" relationship adapted
 * for Noxem's memory_edges table.
 *
 * Relation types:
 * - 'illustrates' : image/code that visually demonstrates a text concept
 * - 'belongs_to'  : table/equation that is part of a text document
 * - 'depicts'     : image that shows something described in text
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {number} textMemId - ID of the text memory
 * @param {number} visualMemId - ID of the non-text memory
 * @param {string} [relation='illustrates'] - Edge relation type
 * @param {string} [sessionId=''] - Source session ID
 * @returns {object|null} Created edge record, or null on failure
 */
export function linkMultimodalMemory(db, textMemId, visualMemId, relation = 'illustrates', sessionId = '') {
  const validRelations = new Set(['illustrates', 'belongs_to', 'depicts']);
  if (!validRelations.has(relation)) {
    LOG_DEBUG && console.warn('[CrossModal] Invalid relation:', relation, '— using illustrates');
    relation = 'illustrates';
  }

  // Validate both memories exist
  const textMem = db.prepare('SELECT id, content_type FROM memories WHERE id = ?').get(textMemId);
  const visualMem = db.prepare('SELECT id, content_type FROM memories WHERE id = ?').get(visualMemId);

  if (!textMem || !visualMem) {
    LOG_DEBUG && console.warn('[CrossModal] Cannot link: memory not found', { textMemId, visualMemId });
    return null;
  }

  // Check for duplicate edge
  const existing = db.prepare(
    'SELECT id FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = ?'
  ).get(visualMemId, textMemId, relation);

  if (existing) {
    LOG_DEBUG && console.log('[CrossModal] Edge already exists:', existing.id);
    return existing;
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO memory_edges (from_id, to_id, relation, from_type, to_type, strength, source_session_id, confidence)
      VALUES (?, ?, ?, ?, ?, 1.0, ?, 0.9)
    `);
    const info = stmt.run(visualMemId, textMemId, relation, visualMem.content_type || 'episode', textMem.content_type || 'episode', sessionId);
    LOG_DEBUG && console.log('[CrossModal] Created', relation, 'edge:', visualMemId, '->', textMemId);
    return { id: info.lastInsertRowid, from_id: visualMemId, to_id: textMemId, relation };
  } catch (err) {
    LOG_DEBUG && console.error('[CrossModal] Failed to create edge:', err.message);
    return null;
  }
}

/**
 * Auto-detect and create cross-modal edges when a non-text memory
 * references an existing text memory by entity or scene.
 * Scans the most recent text memories in the same session for overlap.
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {object} newMemory - The newly stored memory with content_type
 * @returns {number} Count of edges created
 */
export function autoLinkCrossModal(db, newMemory) {
  if (!newMemory || newMemory.content_type === 'text' || !newMemory.content_type) return 0;
  if (!newMemory.session_id && !newMemory.entity) return 0;

  const relation = _inferRelationFromType(newMemory.content_type);
  let linksCreated = 0;

  // Strategy 1: Same session, most recent text memories
  if (newMemory.session_id) {
    const recentText = db.prepare(`
      SELECT id FROM memories
      WHERE session_id = ? AND content_type = 'text' AND status = 'active'
      ORDER BY created_at DESC LIMIT 5
    `).all(newMemory.session_id);

    for (const mem of recentText) {
      const edge = linkMultimodalMemory(db, mem.id, newMemory.id, relation, newMemory.session_id);
      if (edge) linksCreated++;
    }
  }

  // Strategy 2: Same entity, text memories
  if (newMemory.entity) {
    const entityText = db.prepare(`
      SELECT id FROM memories
      WHERE entity = ? AND content_type = 'text' AND status = 'active'
      AND id != ?
      ORDER BY importance DESC LIMIT 3
    `).all(newMemory.entity, newMemory.id);

    for (const mem of entityText) {
      const edge = linkMultimodalMemory(db, mem.id, newMemory.id, relation, newMemory.session_id || '');
      if (edge) linksCreated++;
    }
  }

  LOG_DEBUG && console.log('[CrossModal] Auto-linked', linksCreated, 'edges for memory', newMemory.id);
  return linksCreated;
}

function _inferRelationFromType(contentType) {
  switch (contentType) {
    case 'image': return 'illustrates';
    case 'table': return 'belongs_to';
    case 'code':  return 'illustrates';
    case 'equation': return 'belongs_to';
    default: return 'illustrates';
  }
}

// ── 3. Modality-aware search reranking ──

/**
 * RAG-Anything insight: adjust result weights based on content type
 * and query intent. Visual queries boost image/table results; text-
 * focused queries slightly penalize non-text results.
 *
 * @param {Array} results - Search results (each may have content_type, score)
 * @param {string} query - Original search query
 * @returns {Array} Results with modality-adjusted scores
 */
export function modalityBoost(results, query) {
  if (!results || results.length === 0) return results;
  if (!query || typeof query !== 'string') return results;

  const lowerQ = query.toLowerCase();
  const isVisualQuery = VISUAL_KEYWORDS.some(kw => lowerQ.includes(kw));
  const isTextQuery = TEXT_FOCUS_KEYWORDS.some(kw => lowerQ.includes(kw));

  // No adjustment needed if no non-text results
  const hasNonText = results.some(r => r.content_type && r.content_type !== 'text');
  if (!hasNonText && !isVisualQuery) return results;

  return results.map(r => {
    const ct = r.content_type || 'text';
    const baseScore = r.score || 0.5;

    if (ct === 'text') {
      // Text results: slight boost for text-focused queries, no change otherwise
      return { ...r, score: isTextQuery ? baseScore * 1.05 : baseScore };
    }

    // Non-text results
    if (isVisualQuery) {
      const multiplier = MODALITY_BOOST_MAP[ct] || 1.0;
      // Extra boost if the query explicitly mentions this modality
      const explicitMention = lowerQ.includes(ct);
      return { ...r, score: baseScore * multiplier * (explicitMention ? 1.15 : 1.0) };
    }

    if (isTextQuery) {
      // Slight penalty: text-focused queries don't benefit from non-text
      return { ...r, score: baseScore * 0.9 };
    }

    // Neutral query: tiny penalty for non-text (text is the default modality)
    return { ...r, score: baseScore * 0.95 };
  });
}

// ── 4. Structured content embedding ──

/**
 * Prepare content for embedding by serializing it in its modality-optimal
 * text format. RAG-Anything shows that specialized serialization (tables
 * as Markdown, code with language tags) captures structural semantics.
 *
 * For images: embed the caption text (not the URL).
 * For tables: serialize as Markdown table (headers | row data).
 * For code: wrap in fenced code block with language identifier.
 * For equations: embed both the raw expression and caption.
 * For text: prefix with context_prefix as normal.
 *
 * @param {object} memory - Memory row with content_type, content_data, etc.
 * @returns {string} Text to embed
 */
export function prepareEmbeddingText(memory) {
  const ct = memory.content_type || 'text';
  const text = memory.text || '';
  const ctxPrefix = memory.context_prefix || '';

  switch (ct) {
    case 'image': {
      // Embed the caption, not the raw URL
      const caption = memory.content_caption || '';
      const data = _safeParseJSON(memory.content_data || '{}');
      const url = data?.url || '';
      const parts = [];
      if (caption) parts.push(caption);
      if (url) parts.push(`[image: ${url}]`);
      if (text && text !== caption) parts.push(text);
      const combined = parts.filter(Boolean).join(' | ');
      return ctxPrefix ? `${ctxPrefix} ${combined}` : combined;
    }

    case 'table': {
      const data = _safeParseJSON(memory.content_data || '{}');
      // Prefer pre-rendered Markdown, else construct from headers + rows
      if (data.markdown) {
        return ctxPrefix ? `${ctxPrefix} ${data.markdown}` : data.markdown;
      }
      if (data.headers && data.rows) {
        const md = _tableToMarkdown(data.headers, data.rows);
        const caption = memory.content_caption || data.caption || '';
        const full = caption ? `${caption}\n\n${md}` : md;
        return ctxPrefix ? `${ctxPrefix} ${full}` : full;
      }
      // Fallback: embed the raw text
      return ctxPrefix ? `${ctxPrefix} ${text}` : text;
    }

    case 'code': {
      const data = _safeParseJSON(memory.content_data || '{}');
      const lang = data.language || '';
      const snippet = data.snippet || text;
      const fenced = `\`\`\`${lang}\n${snippet}\n\`\`\``;
      const caption = memory.content_caption || '';
      const full = caption ? `${caption}\n\n${fenced}` : fenced;
      return ctxPrefix ? `${ctxPrefix} ${full}` : full;
    }

    case 'equation': {
      const data = _safeParseJSON(memory.content_data || '{}');
      const latex = data.latex || data.expression || text;
      const caption = memory.content_caption || '';
      const parts = [];
      if (caption) parts.push(caption);
      parts.push(`[equation] ${latex}`);
      const combined = parts.join(' | ');
      return ctxPrefix ? `${ctxPrefix} ${combined}` : combined;
    }

    default: // 'text'
      return ctxPrefix ? `${ctxPrefix} ${text}` : text;
  }
}

/**
 * Detect content type from text content markers.
 * RAG-Anything's modality classification adapted for Noxem's categorizeText.
 *
 * @param {string} text - Memory text to analyze
 * @returns {string} Detected content_type
 */
export function detectContentType(text) {
  if (!text || typeof text !== 'string') return 'text';

  // Code detection: fenced blocks, common patterns
  if (/^```[\s\S]*```$/m.test(text) || /^(function |class |import |const |let |def |async |export )/m.test(text)) {
    return 'code';
  }

  // Table detection: Markdown tables or CSV-like patterns
  if (/^\|.+\|$/m.test(text) && /^\|[-:| ]+\|$/m.test(text)) {
    return 'table';
  }
  if (/^[A-Za-z_]\w*(,[A-Za-z_]\w*)*\n/m.test(text) && text.split('\n').length > 3) {
    return 'table';
  }

  // Equation detection: LaTeX markers
  if (/^\$[^$]+\$$/m.test(text) || /^\\\[[\s\S]*\\\]$/m.test(text) || /\\(?:frac|sum|prod|int|sqrt|alpha|beta|gamma)/.test(text)) {
    return 'equation';
  }

  // Image detection: URL patterns ending in image extensions
  if (/\bhttps?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg|bmp)\b/i.test(text)) {
    return 'image';
  }

  return 'text';
}

function _tableToMarkdown(headers, rows) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) return '';
  const headerLine = `| ${headers.join(' | ')} |`;
  const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataLines = rows.slice(0, 20).map(row => {
    const cells = Array.isArray(row) ? row : headers.map(h => row[h] || '');
    return `| ${cells.join(' | ')} |`;
  });
  return [headerLine, separatorLine, ...dataLines].join('\n');
}

// ── 5. Document hierarchy via scene_name ──

/**
 * Build a hierarchical scene_name path for a memory, adapted from
 * RAG-Anything's section path and context window concept.
 * Format: `doc:{source}:{section}` — activates the existing scene_name
 * column that is currently unused.
 *
 * @param {object} params
 * @param {string} params.source - Source identifier (filename, conversation ID)
 * @param {string} [params.section] - Section or topic within the source
 * @param {string} [params.prefix='doc'] - Path prefix
 * @returns {string} Hierarchical scene_name path
 */
export function buildSceneName({ source, section = '', prefix = 'doc' }) {
  const cleanSource = String(source || '').replace(/[{}|\\^~[\]]/g, '').substring(0, 80);
  if (!cleanSource) return '';
  const parts = [prefix, cleanSource];
  if (section) {
    const cleanSection = String(section).replace(/[{}|\\^~[\]]/g, '').substring(0, 60);
    parts.push(cleanSection);
  }
  return parts.join(':');
}

/**
 * Extract the source prefix from a scene_name for grouping.
 * "doc:handbook:intro" -> "doc:handbook"
 *
 * @param {string} sceneName - Full scene_name path
 * @returns {string} Source prefix (first two segments)
 */
export function getSceneSource(sceneName) {
  if (!sceneName || typeof sceneName !== 'string') return '';
  const parts = sceneName.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : sceneName;
}

/**
 * Apply scene_name grouping bonus to search results.
 * RAG-Anything insight: memories from the same document/section are
 * contextually related and should get a small score bonus.
 *
 * @param {Array} results - Search results with scene_name field
 * @param {number} [bonus=0.05] - Score bonus for same-scene grouping
 * @returns {Array} Results with scene bonus applied
 */
export function applySceneGroupingBonus(results, bonus = 0.05) {
  if (!results || results.length <= 1) return results;

  // Count how many results share each scene source
  const sourceCounts = new Map();
  for (const r of results) {
    const source = getSceneSource(r.scene_name);
    if (source) {
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }
  }

  // Apply bonus to results whose scene source has 2+ hits
  return results.map(r => {
    const source = getSceneSource(r.scene_name);
    if (source && (sourceCounts.get(source) || 0) >= 2) {
      return { ...r, score: (r.score || 0.5) + bonus };
    }
    return r;
  });
}

// ── Migration v6 support ──

/**
 * Run migration v6 to add multimodal content columns to memories table.
 * Safe to call multiple times (uses IF NOT EXISTS logic).
 *
 * @param {object} db - better-sqlite3 database handle
 */
export function runCrossModalMigration(db) {
  const addCol = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e; }
  };

  addCol('memories', 'content_type', "TEXT NOT NULL DEFAULT 'text'");
  addCol('memories', 'content_data', "TEXT DEFAULT ''");
  addCol('memories', 'content_caption', "TEXT DEFAULT ''");

  // Index for filtering by content type
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_content_type ON memories(content_type) WHERE content_type != \'text\'');
  } catch (e) { if (!e.message.includes('already exists')) throw e; }

  // Expand FTS5 to include content_caption
  try {
    db.exec('DROP TABLE IF EXISTS memories_fts');
  } catch (_) {}
  try { db.exec('DROP TRIGGER IF EXISTS memories_ai'); } catch (_) {}
  try { db.exec('DROP TRIGGER IF EXISTS memories_ad'); } catch (_) {}
  try { db.exec('DROP TRIGGER IF EXISTS memories_au'); } catch (_) {}

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, context_prefix, entity, scene_name, content_caption, content='memories', content_rowid='id')`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text, context_prefix, entity, scene_name, content_caption)
    VALUES (new.id, new.text, new.context_prefix, new.entity, new.scene_name, new.content_caption);
  END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, context_prefix, entity, scene_name, content_caption)
    VALUES ('delete', old.id, old.text, old.context_prefix, old.entity, old.scene_name, old.content_caption);
  END`);

  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, context_prefix, entity, scene_name, content_caption)
    VALUES ('delete', old.id, old.text, old.context_prefix, old.entity, old.scene_name, old.content_caption);
    INSERT INTO memories_fts(rowid, text, context_prefix, entity, scene_name, content_caption)
    VALUES (new.id, new.text, new.context_prefix, new.entity, new.scene_name, new.content_caption);
  END`);

  LOG_DEBUG && console.log('[CrossModal] Migration v6 complete: content_type, content_data, content_caption columns + FTS5 expanded');
}

// ── Utility: safe JSON parse ──

function _safeParseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); }
  catch { return null; }
}

export default {
  validateMultimodalFields,
  storeMultimodalMemory,
  linkMultimodalMemory,
  autoLinkCrossModal,
  modalityBoost,
  prepareEmbeddingText,
  detectContentType,
  buildSceneName,
  getSceneSource,
  applySceneGroupingBonus,
  runCrossModalMigration,
};
