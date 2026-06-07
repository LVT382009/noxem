/**
 * Noxem Adapter — Headroom context compression for Noxem memory system.
 *
 * Adapts Headroom's content-type-aware compression, CCR reversible compression,
 * KV-cache prefix alignment, and structural fingerprinting into Noxem-compatible
 * ESM .mjs modules. Pure JavaScript — no Python/Rust/Magika dependencies.
 *
 * Features:
 * 1. Content-type routing: classify content as JSON/code/logs/prose, apply
 *    type-specific pure-JS compressors BEFORE sending to Brain 2 LLM.
 * 2. CCR reversible compression: insert [ref:hash] markers in compressed output,
 *    store originals via existing memory_raw, expose memory_retrieve_original.
 * 3. KV-cache prefix alignment: normalize timestamps/UUIDs before Brain 2 calls
 *    to increase Anthropic/OpenAI prompt cache hits.
 * 4. Structural fingerprinting: hash compression structure, track which patterns
 *    produce the best recall scores from /memory/search/feedback.
 *
 * IMPORTANT: memory_raw already stores originals by default in Noxem — this
 * adapter does NOT re-implement raw storage. It adds [ref:hash] markers and
 * the retrieval endpoint on top of the existing infrastructure.
 */

import { createHash } from 'node:crypto';

// ── Constants ──────────────────────────────────────────────────────

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// Minimum content length (chars) to attempt type-specific compression.
// Below this threshold, compression overhead exceeds savings.
const MIN_COMPRESS_LENGTH = 100;

// CCR hash length — 24 hex chars (96 bits) matching Headroom convention.
// Provides collision resistance for up to ~16M unique compressions.
const CCR_HASH_LENGTH = 24;

// KV-cache alignment: regex patterns for volatile tokens.
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?![T\d])/g;
const SESSION_ID_RE = /session[_-]?id[:\s]*[a-zA-Z0-9_-]{8,}/gi;

// ── 1. Content-Type Detection (FallbackDetector port) ──────────────

/**
 * Content type categories derived from Headroom's ContentType enum.
 * @enum {string}
 */
export const ContentType = Object.freeze({
  JSON: 'json',
  CODE: 'code',
  LOG: 'log',
  DIFF: 'diff',
  MARKDOWN: 'markdown',
  PROSE: 'prose',
  UNKNOWN: 'unknown',
});

/**
 * Classify content type using pure-JS heuristics (no Magika dependency).
 * Ported from Headroom's FallbackDetector — same logic, JS not Python.
 *
 * Priority: JSON > Code > Diff > Log > Markdown > Prose > Unknown.
 * When multiple types match, the first match wins (order matters).
 *
 * @param {string} text - Content to classify.
 * @returns {{ type: string, confidence: number, language: string|null }}
 */
export function classifyContentType(text) {
  if (!text || !text.trim()) {
    return { type: ContentType.UNKNOWN, confidence: 0, language: null };
  }

  const stripped = text.trim();

  // JSON: starts with { or [ and parses as JSON
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    try {
      JSON.parse(stripped);
      return { type: ContentType.JSON, confidence: 1.0, language: null };
    } catch { /* not valid JSON */ }
  }

  // Diff: unified diff format
  if (/^diff --git|^--- a\/|^\+\+\+ b\/|^\@\@ /m.test(stripped)) {
    return { type: ContentType.DIFF, confidence: 0.9, language: null };
  }

  // Code: look for language-keyword indicators
  const codeScores = {
    javascript: ['function ', 'const ', 'let ', 'var ', '=>', 'require(', 'module.exports'],
    typescript: ['interface ', 'type ', ': string', ': number', 'as ', 'enum '],
    python: ['def ', 'import ', 'from ', 'class ', 'async def', 'if __name__'],
    go: ['func ', 'package ', 'import (', 'func (', ':= '],
    rust: ['fn ', 'let mut', 'impl ', 'pub fn', 'use ::', 'struct '],
    java: ['public class', 'private ', 'protected ', 'void ', '@Override'],
  };

  let bestLang = null;
  let bestScore = 0;
  for (const [lang, markers] of Object.entries(codeScores)) {
    const score = markers.reduce((s, m) => s + (stripped.includes(m) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }
  if (bestScore >= 2) {
    return { type: ContentType.CODE, confidence: 0.6 + Math.min(bestScore * 0.05, 0.3), language: bestLang };
  }

  // Log: multiple lines with log-level prefixes
  const lines = stripped.split('\n');
  const logLines = lines.filter(l => /^\s*(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i.test(l));
  if (logLines.length >= 3 && logLines.length / lines.length > 0.3) {
    return { type: ContentType.LOG, confidence: 0.7, language: null };
  }

  // Markdown: heading or list markers
  if (/^#{1,6}\s/m.test(stripped) || /^\s*[-*]\s/m.test(stripped) || /\[.*\]\(.*\)/.test(stripped)) {
    return { type: ContentType.MARKDOWN, confidence: 0.6, language: null };
  }

  // Default: prose (natural language text)
  return { type: ContentType.PROSE, confidence: 0.5, language: null };
}


// ── 2. Content-Type-Specific Pure-JS Compressors ───────────────────

/**
 * Compress JSON content: strip null/default values, collapse large arrays,
 * preserve error fields intact. Ported from Headroom's JSONStructureHandler.
 *
 * Strategy:
 * - Parse JSON, walk recursively.
 * - Remove keys whose values are null, empty string, empty array, or empty object.
 * - Collapse arrays > maxFullItems: keep first N items, replace rest with count.
 * - Preserve keys that look like error/identifier fields regardless.
 * - Stringify result with no indentation.
 *
 * @param {string} text - JSON text to compress.
 * @param {{ maxFullItems?: number, preserveKeys?: string[] }} opts
 * @returns {string} Compressed JSON.
 */
export function compressJSON(text, opts = {}) {
  const maxFullItems = opts.maxFullItems ?? 3;
  const preserveKeys = new Set(opts.preserveKeys ?? ['error', 'errors', 'message', 'code', 'status', 'id', 'type', 'name']);

  try {
    const parsed = JSON.parse(text);
    const compressed = _compressJsonValue(parsed, maxFullItems, preserveKeys, 0);
    return JSON.stringify(compressed, null, 0);
  } catch {
    // Not valid JSON after all — return with whitespace stripped
    return text.replace(/\s+/g, ' ').trim();
  }
}

function _compressJsonValue(val, maxFull, preserveKeys, depth) {
  if (depth > 20) return val; // recursion guard

  if (Array.isArray(val)) {
    if (val.length === 0) return undefined; // strip empty arrays
    if (val.length <= maxFull) {
      return val.map(v => _compressJsonValue(v, maxFull, preserveKeys, depth + 1));
    }
    // Keep first N items fully, replace rest with collapsed marker
    const kept = val.slice(0, maxFull).map(v => _compressJsonValue(v, maxFull, preserveKeys, depth + 1));
    return [...kept, `...${val.length - maxFull} more items`];
  }

  if (val !== null && typeof val === 'object') {
    const result = {};
    const keys = Object.keys(val);
    for (const key of keys) {
      const v = val[key];
      // Preserve error/identifier fields regardless of value
      if (preserveKeys.has(key)) {
        const compressed = _compressJsonValue(v, maxFull, preserveKeys, depth + 1);
        if (compressed !== undefined) result[key] = compressed;
        continue;
      }
      // Strip null, empty string, empty object/array
      if (v === null) continue;
      if (v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
      const compressed = _compressJsonValue(v, maxFull, preserveKeys, depth + 1);
      if (compressed !== undefined) result[key] = compressed;
    }
    // If all keys were stripped, omit this object too
    return Object.keys(result).length > 0 ? result : undefined;
  }

  return val;
}


/**
 * Compress source code: remove blank lines, collapse consecutive imports,
 * abbreviate comments. Ported from Headroom's CodeStructureHandler (regex path).
 *
 * Preserves:
 * - Import/use statements (but collapses consecutive ones)
 * - Function/class signatures (not full bodies)
 * - Error-related lines (stack traces, exception messages)
 *
 * Compresses:
 * - Blank lines (collapse runs to single blank)
 * - Comment-only lines (replace with abbreviated form)
 * - Function bodies after first 3 non-trivial lines
 *
 * @param {string} text - Source code to compress.
 * @param {{ keepBodyLines?: number, abbreviateComments?: boolean }} opts
 * @returns {string} Compressed code.
 */
export function compressCode(text, opts = {}) {
  const keepBodyLines = opts.keepBodyLines ?? 3;
  const lines = text.split('\n');
  const result = [];

  let inImportBlock = false;
  let blankRun = 0;
  let inBody = false;
  let bodyLineCount = 0;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    // Collapse consecutive blank lines to max 1
    if (trimmed === '') {
      blankRun++;
      if (blankRun <= 1) result.push('');
      continue;
    }
    blankRun = 0;

    // Detect import lines (collapse consecutive imports to a summary)
    const isImport = /^\s*(import\s|from\s+\S+\s+import|require\s*\(|use\s+\w|using\s+)/.test(line);
    if (isImport) {
      if (!inImportBlock) {
        inImportBlock = true;
        result.push(line);
      }
      // Skip subsequent consecutive imports (they'll be summarized after)
      continue;
    }
    if (inImportBlock && !isImport) {
      inImportBlock = false;
      // Add import count summary if we skipped any
    }

    // Detect function/class/method signature — reset body tracking
    const isSignature = /^\s*(export\s+)?(async\s+)?(function\s|def\s|class\s|func\s|fn\s|pub\s+(fn|async))/.test(line);
    if (isSignature) {
      inBody = false;
      bodyLineCount = 0;
      result.push(line);
      continue;
    }

    // Detect opening brace/colon after signature (body start)
    if (trimmed === '{' || trimmed === ':') {
      inBody = true;
      bodyLineCount = 0;
      result.push(line);
      continue;
    }

    // Inside a function body — keep only first N non-trivial lines
    if (inBody) {
      bodyLineCount++;
      if (bodyLineCount <= keepBodyLines) {
        result.push(line);
      } else if (bodyLineCount === keepBodyLines + 1) {
        result.push(`  // ... body truncated ...`);
      }
      // Skip remaining body lines
      continue;
    }

    // Error-related lines are always preserved
    if (/Error|Exception|throw |catch\s*\(|raise\s|panic!|TODO|FIXME|HACK|BUG/i.test(trimmed)) {
      result.push(line);
      continue;
    }

    // Default: keep the line
    result.push(line);
  }

  return result.join('\n');
}


/**
 * Compress log output: keep first/last N lines + error/warning lines,
 * drop repeating patterns. Ported from Headroom's LogCompressor concept.
 *
 * @param {string} text - Log text to compress.
 * @param {{ headLines?: number, tailLines?: number }} opts
 * @returns {string} Compressed log.
 */
export function compressLogs(text, opts = {}) {
  const headLines = opts.headLines ?? 5;
  const tailLines = opts.tailLines ?? 5;

  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines + 2) return text;

  const kept = new Set();
  // Always keep error/warning/fatal lines
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(ERROR|FATAL|CRITICAL|WARN|SEVERE)\b/i.test(lines[i])) {
      kept.add(i);
    }
  }
  // Keep head
  for (let i = 0; i < headLines; i++) kept.add(i);
  // Keep tail
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) kept.add(i);

  // Drop consecutive identical lines (repeating log patterns)
  const result = [];
  let prevLine = '';
  let dupCount = 0;
  const sortedIndices = [...kept].sort((a, b) => a - b);

  for (const i of sortedIndices) {
    const line = lines[i];
    if (line === prevLine) {
      dupCount++;
      continue;
    }
    if (dupCount > 0) {
      result.push(`  ... ${dupCount} identical lines omitted ...`);
      dupCount = 0;
    }
    result.push(line);
    prevLine = line;
  }
  if (dupCount > 0) result.push(`  ... ${dupCount} identical lines omitted ...`);

  // Insert gap markers
  const final = [];
  for (let i = 0; i < result.length; i++) {
    const gap = (i === 0 && sortedIndices[0] > 0)
      ? `\n  ... ${sortedIndices[0]} lines omitted ...\n`
      : '';
    final.push(result[i]);
  }
  const totalOmitted = lines.length - sortedIndices.length;
  if (totalOmitted > 0 && !result.some(l => l.includes('lines omitted'))) {
    final.splice(headLines, 0, `  ... ${totalOmitted} lines omitted ...`);
  }

  return final.join('\n');
}


// ── 3. Content-Type Routing Compressor ─────────────────────────────

/**
 * Route content through the appropriate type-specific compressor.
 * This is the main entry point for pre-Brain-2 compression.
 *
 * Returns the compressed text PLUS metadata about what was done,
 * so the caller can decide whether to also send to Brain 2.
 *
 * @param {string} text - Content to compress.
 * @param {{ type?: string, jsonOpts?: object, codeOpts?: object, logOpts?: object }} [opts]
 * @returns {{ compressed: string, type: string, confidence: number,
 *             ratio: number, charsBefore: number, charsAfter: number,
 *             ccrHash: string|null, language: string|null }}
 */
export function compressByType(text, opts = {}) {
  if (!text || text.length < MIN_COMPRESS_LENGTH) {
    return {
      compressed: text,
      type: ContentType.UNKNOWN,
      confidence: 0,
      ratio: 1.0,
      charsBefore: text?.length ?? 0,
      charsAfter: text?.length ?? 0,
      ccrHash: null,
      language: null,
    };
  }

  const detection = opts.type
    ? { type: opts.type, confidence: 1.0, language: null }
    : classifyContentType(text);

  let compressed;
  switch (detection.type) {
    case ContentType.JSON:
      compressed = compressJSON(text, opts.jsonOpts);
      break;
    case ContentType.CODE:
      compressed = compressCode(text, opts.codeOpts);
      break;
    case ContentType.LOG:
      compressed = compressLogs(text, opts.logOpts);
      break;
    case ContentType.DIFF:
      // Diffs are already compact — just strip whitespace-only lines
      compressed = text.split('\n').filter(l => l.trim()).join('\n');
      break;
    case ContentType.MARKDOWN:
      // Markdown: strip excessive blank lines, keep structure
      compressed = text.replace(/\n{3,}/g, '\n\n');
      break;
    default:
      // Prose/unknown: no type-specific compression (leave to Brain 2)
      compressed = text;
      break;
  }

  const charsBefore = text.length;
  const charsAfter = compressed.length;
  const ratio = charsBefore > 0 ? charsAfter / charsBefore : 1.0;

  // CCR: store original and generate hash reference
  const ccrHash = (charsAfter < charsBefore) ? _computeCCRHash(text) : null;

  // Insert [ref:hash] marker if compression occurred and hash is available
  if (ccrHash && charsAfter < charsBefore) {
    compressed = compressed + `\n[ref:${ccrHash}]`;
  }

  return {
    compressed,
    type: detection.type,
    confidence: detection.confidence,
    ratio,
    charsBefore,
    charsAfter,
    ccrHash,
    language: detection.language,
  };
}

/**
 * Apply content-type compression to an array of conversation turns
 * BEFORE sending to Brain 2's analyzeBeforeCompress.
 *
 * This is the function Noxem's advisor-engine should call.
 * It routes each turn's content through the appropriate compressor
 * and returns the compressed turns + CCR metadata for later retrieval.
 *
 * @param {Array<{role: string, content: string}>} turns - Conversation turns.
 * @returns {{ turns: Array<{role: string, content: string}>,
 *             totalSaved: number, ccrEntries: Array<{hash: string, original: string}> }}
 */
export function compressConversationTurns(turns) {
  let totalSaved = 0;
  const ccrEntries = [];

  const compressedTurns = turns.map(turn => {
    if (!turn.content || turn.content.length < MIN_COMPRESS_LENGTH) {
      return turn; // short content unchanged
    }

    const result = compressByType(turn.content);
    const saved = turn.content.length - result.compressed.length;
    if (saved > 0) {
      totalSaved += saved;
      if (result.ccrHash) {
        ccrEntries.push({ hash: result.ccrHash, original: turn.content });
      }
      return { ...turn, content: result.compressed };
    }
    return turn;
  });

  return { turns: compressedTurns, totalSaved, ccrEntries };
}


// ── 4. CCR (Compress-Cache-Retrieve) ───────────────────────────────

/**
 * Compute a CCR hash for a piece of content.
 * Uses SHA-256 truncated to 24 hex chars (96 bits) — matching Headroom convention.
 *
 * @param {string} content - Original content to hash.
 * @returns {string} 24-character hex hash.
 */
function _computeCCRHash(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, CCR_HASH_LENGTH);
}

/**
 * Compression patterns table — stores structural fingerprints and
 * their performance metrics for compression learning.
 *
 * Table schema (created in Noxem's existing better-sqlite3 db):
 *   compression_patterns (
 *     structure_hash TEXT PRIMARY KEY,
 *     content_type   TEXT NOT NULL,
 *     strategy       TEXT NOT NULL,  -- 'json'|'code'|'log'|'prose'|'mixed'
 *     avg_recall     REAL DEFAULT 0, -- average recall score from feedback
 *     sample_count   INTEGER DEFAULT 0,
 *     avg_ratio      REAL DEFAULT 1, -- average compression ratio achieved
 *     updated_at     TEXT NOT NULL
 *   )
 *
 * @param {import('better-sqlite3').Database} db - Noxem's SQLite instance.
 */
export function initCompressionPatternsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compression_patterns (
      structure_hash TEXT PRIMARY KEY,
      content_type   TEXT NOT NULL,
      strategy       TEXT NOT NULL,
      avg_recall     REAL NOT NULL DEFAULT 0,
      sample_count   INTEGER NOT NULL DEFAULT 0,
      avg_ratio      REAL NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Compute a structural fingerprint for a piece of content.
 * Hashes the *structure* (not the values) so similar-shaped content
 * maps to the same fingerprint regardless of specific data.
 *
 * For JSON: extract key names only (no values).
 * For code: extract line patterns (import, def, class, blank, etc.).
 * For logs: extract log-level distribution.
 * For prose: extract paragraph/sentence count + average length.
 *
 * @param {string} text - Content to fingerprint.
 * @param {string} contentType - Content type from classifyContentType.
 * @returns {string} 16-char hex structural hash.
 */
export function structuralFingerprint(text, contentType) {
  let structure;

  switch (contentType) {
    case ContentType.JSON:
      structure = _jsonStructure(text);
      break;
    case ContentType.CODE:
      structure = _codeStructure(text);
      break;
    case ContentType.LOG:
      structure = _logStructure(text);
      break;
    default:
      structure = _proseStructure(text);
      break;
  }

  return createHash('sha256').update(structure).digest('hex').substring(0, 16);
}

function _jsonStructure(text) {
  // Extract key paths only (no values) — this is the "shape" of the JSON.
  try {
    const parsed = JSON.parse(text);
    return _extractKeyPaths(parsed, '');
  } catch {
    return 'invalid-json';
  }
}

function _extractKeyPaths(obj, prefix) {
  if (obj === null || typeof obj !== 'object') return prefix || 'scalar';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${prefix}[]:empty`;
    return `${prefix}[]:${_extractKeyPaths(obj[0], prefix + '[0]')}`;
  }
  return Object.keys(obj).sort().map(k => `${prefix}.${k}:${_extractKeyPaths(obj[k], prefix + '.' + k)}`).join('|');
}

function _codeStructure(text) {
  // Extract line-type pattern: I=import, S=signature, B=body, C=comment, _=blank, O=other
  return text.split('\n').map(l => {
    const t = l.trim();
    if (!t) return '_';
    if (/^\s*(import |from .+ import|require\(|use |using )/.test(l)) return 'I';
    if (/^\s*(export )?(async )?(function |def |class |func |fn |pub fn|interface |type )/.test(l)) return 'S';
    if (/^\s*(\/\/|#|\/\*|\*)\s/.test(l)) return 'C';
    return 'O';
  }).join('');
}

function _logStructure(text) {
  // Count log levels and line-count buckets
  const levels = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, OTHER: 0 };
  for (const line of text.split('\n')) {
    if (/ERROR|FATAL|CRITICAL/i.test(line)) levels.ERROR++;
    else if (/WARN/i.test(line)) levels.WARN++;
    else if (/INFO/i.test(line)) levels.INFO++;
    else if (/DEBUG|TRACE/i.test(line)) levels.DEBUG++;
    else levels.OTHER++;
  }
  const total = Object.values(levels).reduce((a, b) => a + b, 0) || 1;
  // Bucket the ratios to 2 decimal places
  return Object.entries(levels).map(([k, v]) => `${k}:${(v / total).toFixed(2)}`).join(',');
}

function _proseStructure(text) {
  // Paragraph count, average sentence length, question/exclamation counts
  const paragraphs = text.split(/\n\s*\n/).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim()).length || 1;
  const words = text.split(/\s+/).length || 1;
  const avgSentenceLen = Math.round(words / sentences);
  const questions = (text.match(/\?/g) || []).length;
  const exclamations = (text.match(/!/g) || []).length;
  return `p${paragraphs}:s${sentences}:w${avgSentenceLen}:q${questions}:e${exclamations}`;
}

/**
 * Record compression feedback for a structural pattern.
 * Called from /memory/search/feedback when compression_meta is present.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} structureHash - From structuralFingerprint()
 * @param {string} contentType - Content type that was compressed
 * @param {string} strategy - Compression strategy used
 * @param {number} recallScore - 0-1 recall quality score from feedback
 * @param {number} ratio - Compression ratio achieved
 */
export function recordCompressionFeedback(db, structureHash, contentType, strategy, recallScore, ratio) {
  const upsert = db.prepare(`
    INSERT INTO compression_patterns (structure_hash, content_type, strategy, avg_recall, sample_count, avg_ratio, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
    ON CONFLICT(structure_hash) DO UPDATE SET
      avg_recall = (avg_recall * sample_count + ?) / (sample_count + 1),
      sample_count = sample_count + 1,
      avg_ratio = (avg_ratio * sample_count + ?) / (sample_count + 1),
      updated_at = datetime('now')
  `);
  upsert.run(structureHash, contentType, strategy, recallScore, ratio, recallScore, ratio);
}

/**
 * Get the best-performing compression strategy for a content structure.
 * Returns null if no feedback data exists yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} structureHash - From structuralFingerprint()
 * @returns {{ strategy: string, avgRecall: number, avgRatio: number, sampleCount: number }|null}
 */
export function getBestStrategy(db, structureHash) {
  const row = db.prepare(
    'SELECT strategy, avg_recall, avg_ratio, sample_count FROM compression_patterns WHERE structure_hash = ?'
  ).get(structureHash);
  if (!row) return null;
  return {
    strategy: row.strategy,
    avgRecall: row.avg_recall,
    avgRatio: row.avg_ratio,
    sampleCount: row.sample_count,
  };
}


// ── 5. KV-Cache Prefix Alignment ──────────────────────────────────

/**
 * Normalize volatile prefixes in text before sending to Brain 2 LLM.
 * Increases Anthropic/OpenAI prompt cache hit rate by replacing
 * timestamps, UUIDs, and session IDs with stable canonical forms.
 *
 * This is a reversible transformation: use restoreKVCacheTokens()
 * to convert back to original values.
 *
 * @param {string} text - Text containing volatile tokens.
 * @returns {{ aligned: string, tokenMap: Map<string, string> }}
 *   aligned: text with volatile tokens replaced by stable placeholders
 *   tokenMap: original -> placeholder mapping for restoration
 */
export function alignKVCachePrefixes(text) {
  const tokenMap = new Map();
  let aligned = text;

  // Normalize ISO-8601 timestamps -> [TIMESTAMP_N]
  let tsIndex = 0;
  aligned = aligned.replace(TIMESTAMP_RE, (match) => {
    const placeholder = `[TS${tsIndex++}]`;
    tokenMap.set(placeholder, match);
    return placeholder;
  });

  // Normalize UUIDs -> [UUID_N]
  let uuidIndex = 0;
  aligned = aligned.replace(UUID_RE, (match) => {
    const placeholder = `[UUID${uuidIndex++}]`;
    tokenMap.set(placeholder, match);
    return placeholder;
  });

  // Normalize standalone ISO dates -> [DATE_N]
  let dateIndex = 0;
  aligned = aligned.replace(ISO_DATE_RE, (match) => {
    const placeholder = `[DATE${dateIndex++}]`;
    tokenMap.set(placeholder, match);
    return placeholder;
  });

  // Normalize session IDs -> [SESSION_N]
  let sessionIndex = 0;
  aligned = aligned.replace(SESSION_ID_RE, (match) => {
    const placeholder = `[SESSION${sessionIndex++}]`;
    tokenMap.set(placeholder, match);
    return placeholder;
  });

  return { aligned, tokenMap };
}

/**
 * Restore original volatile tokens from aligned text.
 * Reverses the transformations done by alignKVCachePrefixes().
 *
 * @param {string} alignedText - Text with [TS0], [UUID0], etc. placeholders.
 * @param {Map<string, string>} tokenMap - From alignKVCachePrefixes().
 * @returns {string} Text with original values restored.
 */
export function restoreKVCacheTokens(alignedText, tokenMap) {
  let restored = alignedText;
  for (const [placeholder, original] of tokenMap) {
    restored = restored.replaceAll(placeholder, original);
  }
  return restored;
}

/**
 * Apply KV-cache prefix alignment to an array of LLM messages
 * (system/user/assistant turns). Only aligns the content strings;
 * role and other fields are left unchanged.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{ messages: Array<{role: string, content: string}>, tokenMap: Map<string, string> }}
 */
export function alignMessagesForCache(messages) {
  const tokenMap = new Map();

  const aligned = messages.map(msg => {
    if (typeof msg.content !== 'string') return msg;
    const result = alignKVCachePrefixes(msg.content);
    // Merge token maps
    for (const [k, v] of result.tokenMap) tokenMap.set(k, v);
    return { ...msg, content: result.aligned };
  });

  return { messages: aligned, tokenMap };
}


// ── 6. Batch Compression for Memory Maintenance ────────────────────

/**
 * Compress multiple memories by type, applying the best strategy
 * for each content structure when feedback data is available.
 *
 * Designed to be called from memory-maintenance.mjs during
 * scheduled compression runs.
 *
 * @param {{ id: number, text: string, type: string }[]} memories
 * @param {import('better-sqlite3').Database} [db] - Optional, for strategy lookup.
 * @returns {{ id: number, compressed: string, type: string, ccrHash: string|null,
 *             ratio: number, strategy: string, structureHash: string }[]}
 */
export function batchCompressMemories(memories, db = null) {
  return memories.map(mem => {
    const detection = classifyContentType(mem.text);
    const structureHash = structuralFingerprint(mem.text, detection.type);

    // Check if we have a better strategy from feedback
    let strategy = detection.type; // default: use detected type as strategy
    if (db) {
      try {
        const best = getBestStrategy(db, structureHash);
        if (best && best.sampleCount >= 3 && best.avgRecall > 0.6) {
          strategy = best.strategy;
        }
      } catch { /* table may not exist yet */ }
    }

    const result = compressByType(mem.text, { type: strategy === 'mixed' ? detection.type : strategy });

    return {
      id: mem.id,
      compressed: result.compressed,
      type: detection.type,
      ccrHash: result.ccrHash,
      ratio: result.ratio,
      strategy,
      structureHash,
    };
  });
}


// ── 7. MCP Tool Definition for memory_retrieve_original ────────────

/**
 * Generate the MCP tool definition for CCR retrieval.
 * This follows the same pattern as Noxem's existing MCP tools
 * (see mcp-server.mjs registerTool calls).
 *
 * The tool allows an LLM to fetch the original uncompressed
 * content for any [ref:hash] marker found in compressed output.
 *
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
export function getCCRRetrieveToolDefinition() {
  return {
    name: 'memory_retrieve_original',
    description: 'Retrieve original uncompressed content that was compressed to save tokens. Use when you need more detail than the compressed summary provides. Look for [ref:hash] markers in compressed memories.',
    inputSchema: {
      type: 'object',
      properties: {
        hash: {
          type: 'string',
          description: 'Hash key from the [ref:hash] compression marker (e.g., "abc123" from [ref:abc123])',
        },
      },
      required: ['hash'],
    },
  };
}

/**
 * Parse a [ref:hash] marker from compressed text.
 * Returns the hash string if found, null otherwise.
 *
 * @param {string} text - Text potentially containing [ref:hash] markers.
 * @returns {string[]|null} Array of hash strings found, or null if none.
 */
export function extractCCRHashes(text) {
  const matches = text.matchAll(/\[ref:([a-f0-9]{24})\]/g);
  const hashes = [...matches].map(m => m[1]);
  return hashes.length > 0 ? hashes : null;
}

/**
 * Remove all [ref:hash] markers from text (for display purposes).
 *
 * @param {string} text - Text with CCR markers.
 * @returns {string} Clean text without markers.
 */
export function stripCCRMarkers(text) {
  return text.replace(/\[ref:[a-f0-9]{24}\]\s*/g, '').trim();
}


// ── 8. Integration Helpers ─────────────────────────────────────────

/**
 * Noxem integration: wrap analyzeBeforeCompress with type-specific
 * pre-compression. Call this FROM advisor-engine.mjs before the
 * existing Brain 2 LLM call.
 *
 * Usage in advisor-engine.mjs:
 *   import { compressConversationTurns, alignMessagesForCache } from '../modules/vector-compress/context-compressor/noxem-adapter.mjs';
 *
 *   // Before Brain 2 call:
 *   const { turns: preCompressed, totalSaved, ccrEntries } = compressConversationTurns(conversationHistory);
 *   const { messages: aligned, tokenMap } = alignMessagesForCache(preCompressed);
 *   // ... send aligned turns to LLM ...
 *   // After LLM response:
 *   const analysis = restoreKVCacheTokens(llmResponse, tokenMap);
 *   // Store ccrEntries in memory_raw via existing compressMemory()
 *
 * @param {Array<{role: string, content: string}>} conversationHistory
 * @param {Array} sessionMemories - Unused but kept for API compatibility.
 * @returns {{ compressedHistory: Array, totalSaved: number,
 *             ccrEntries: Array<{hash: string, original: string}>,
 *             tokenMap: Map<string, string> }}
 */
export function preCompressForAdvisor(conversationHistory, _sessionMemories = []) {
  const { turns, totalSaved, ccrEntries } = compressConversationTurns(conversationHistory || []);
  const { messages: compressedHistory, tokenMap } = alignMessagesForCache(turns);

  return { compressedHistory, totalSaved, ccrEntries, tokenMap };
}

/**
 * Compress a single memory's text for storage with CCR tracking.
 * Returns the compressed text with optional [ref:hash] marker.
 *
 * @param {string} text - Memory text to compress.
 * @returns {{ compressed: string, ccrHash: string|null, type: string, ratio: number }}
 */
export function compressMemoryText(text) {
  if (!text || text.length < MIN_COMPRESS_LENGTH) {
    return { compressed: text, ccrHash: null, type: ContentType.UNKNOWN, ratio: 1.0 };
  }
  const result = compressByType(text);
  return {
    compressed: result.compressed,
    ccrHash: result.ccrHash,
    type: result.type,
    ratio: result.ratio,
  };
}

/**
 * Retrieve original content for a CCR hash from the memory_raw table.
 * Uses Noxem's existing memory_raw infrastructure — no new storage.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} hash - 24-char hex CCR hash.
 * @returns {string|null} Original text, or null if not found.
 */
export function retrieveCCROriginal(db, hash) {
  // Validate hash format: exactly 24 hex chars
  if (!hash || !/^[a-f0-9]{24}$/.test(hash)) return null;

  // The CCR hash is a SHA-256 prefix of the original content.
  // We need to find the memory whose raw text hashes to this.
  // Since we store the hash in the compressed output (not in the DB),
  // we search memory_raw by hashing each raw_text.
  // For efficiency, we use a prepared statement that checks hashes
  // of recent raw texts (most recently stored first).

  // For large corpora, this would need a ccr_hashes index table.
  // For v2.1, we use a linear scan of recent entries (typically <10K).
  const rows = db.prepare(
    "SELECT memory_id, raw_text FROM memory_raw ORDER BY stored_at DESC LIMIT 5000"
  ).all();

  for (const row of rows) {
    const candidateHash = _computeCCRHash(row.raw_text);
    if (candidateHash === hash) return row.raw_text;
  }

  return null;
}
