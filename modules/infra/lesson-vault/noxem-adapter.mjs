/**
 * Noxem Adapter — LESSON Vault: RAG & Memory Architecture Lessons (ESM)
 *
 * Adapts LESSON.txt reference patterns into Noxem-compatible functions:
 *   1. d_eff-aware embedding compression: PCA on embeddings, project to effective dimensions
 *   2. Write-pipeline governance: 3-gate filter (system prompt rejection, hallucinated profile gate, loop detection)
 *   3. Memory poisoning audit MCP tool: check injection patterns, unattributed memories, contradictions
 *   4. Table-aware extraction: detect tabular data, split by rows with header carry-forward
 *   5. Post-retrieval reranking: final_score = 0.6*vec + 0.2*fts + 0.1*recency + 0.1*entity_boost
 *   6. Short-term sliding window: last N L0 verbatim + older L1 summaries
 *
 * All functions are exported for Noxem server to import.
 * Uses better-sqlite3 prepared statements. No standalone server.
 */

import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);


// ─── 1. d_eff-Aware Embedding Compression ──────────────────────────────
// LESSON insight: only ~80-90 of 256-3072 embedding dimensions carry signal.
// 97% of vector space is noise. PCA whitening removes noise dimensions
// that cause false positives in cosine similarity.

const D_EFF_ENABLED = process.env.EMBEDDING_D_EFF_ENABLED !== 'false';
const D_EFF_VARIANCE_THRESHOLD = parseFloat(process.env.D_EFF_VARIANCE_THRESHOLD || '0.95');
const D_EFF_MAX_SAMPLE = 200; // cap sample size for PCA computation

/**
 * Compute PCA via power iteration on the covariance matrix.
 * Returns eigenvectors and eigenvalues for the top components
 * that explain the target variance.
 *
 * This is a lightweight JS implementation — no numpy dependency.
 * For a 256d embedding with 200 samples, this runs in <100ms.
 *
 * @param {number[][]} samples  Array of embedding vectors (each length d)
 * @param {number} [varianceThreshold=0.95]  Cumulative variance to retain
 * @returns {{ d_eff: number, components: number[][], eigenvalues: number[], mean: number[], totalVariance: number }}
 */
export function computePCA(samples, varianceThreshold = D_EFF_VARIANCE_THRESHOLD) {
  const n = samples.length;
  if (n < 10) return { d_eff: samples[0]?.length || 0, components: [], eigenvalues: [], mean: [], totalVariance: 0 };

  const d = samples[0].length;

  // Step 1: Compute column means
  const mean = new Array(d).fill(0);
  for (const s of samples) {
    for (let j = 0; j < d; j++) mean[j] += s[j];
  }
  for (let j = 0; j < d; j++) mean[j] /= n;

  // Step 2: Center the data
  const centered = samples.map(s => s.map((v, j) => v - mean[j]));

  // Step 3: Compute covariance matrix (d x d) — only diagonal and off-diagonal
  // For efficiency, compute dot products directly rather than forming the full matrix
  const cov = Array.from({ length: d }, () => new Float64Array(d));
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += centered[k][i] * centered[k][j];
      cov[i][j] = sum / (n - 1);
      cov[j][i] = cov[i][j];
    }
  }

  // Step 4: Power iteration to find top eigenvalues/eigenvectors
  const eigenvalues = [];
  const eigenvectors = [];

  // Deflated covariance: subtract found components
  const remaining = cov.map(row => new Float64Array(row));

  for (let comp = 0; comp < d; comp++) {
    // Initialize with random vector
    let v = new Float64Array(d);
    for (let j = 0; j < d; j++) v[j] = Math.random() - 0.5;

    // Normalize
    let norm = 0;
    for (let j = 0; j < d; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) break;
    for (let j = 0; j < d; j++) v[j] /= norm;

    // Power iteration (max 100 steps)
    let eigenvalue = 0;
    for (let iter = 0; iter < 100; iter++) {
      // Multiply by remaining covariance
      const Av = new Float64Array(d);
      for (let i = 0; i < d; i++) {
        for (let j = 0; j < d; j++) {
          Av[i] += remaining[i][j] * v[j];
        }
      }

      // Compute eigenvalue estimate (Rayleigh quotient)
      let num = 0, den = 0;
      for (let j = 0; j < d; j++) { num += v[j] * Av[j]; den += v[j] * v[j]; }
      eigenvalue = den > 0 ? num / den : 0;

      // Normalize Av to get next v
      norm = 0;
      for (let j = 0; j < d; j++) norm += Av[j] * Av[j];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let j = 0; j < d; j++) v[j] = Av[j] / norm;

      // Convergence check
      if (iter > 10 && eigenvalues.length > 0) {
        const ratio = eigenvalue / (eigenvalues[0] || 1);
        if (ratio < 1e-6) break; // remaining variance is negligible
      }
    }

    if (eigenvalue < 1e-10) break; // no more signal

    eigenvalues.push(eigenvalue);
    eigenvectors.push(Array.from(v));

    // Deflate: subtract this component from the remaining covariance
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) {
        remaining[i][j] -= eigenvalue * v[i] * v[j];
      }
    }

    // Check cumulative variance
    const totalVariance = eigenvalues.reduce((a, b) => a + b, 0);
    const fullVariance = Array.from({ length: d }, (_, j) => cov[j][j]).reduce((a, b) => a + b, 0);
    if (fullVariance > 0 && totalVariance / fullVariance >= varianceThreshold) break;
  }

  const totalVariance = eigenvalues.reduce((a, b) => a + b, 0);
  const fullVariance = Array.from({ length: d }, (_, j) => cov[j][j]).reduce((a, b) => a + b, 0);
  const varianceExplained = fullVariance > 0 ? totalVariance / fullVariance : 0;

  return {
    d_eff: eigenvalues.length,
    components: eigenvectors,
    eigenvalues,
    mean,
    totalVariance,
    varianceExplained: Math.round(varianceExplained * 10000) / 10000,
  };
}

/**
 * Project an embedding vector to d_eff dimensions using PCA components.
 * @param {number[]} embedding  Original embedding
 * @param {{ components: number[][], mean: number[], d_eff: number }} pca  Output of computePCA()
 * @returns {number[]}  Projected embedding (d_eff dimensions)
 */
export function projectToDEff(embedding, pca) {
  if (!pca.components.length || pca.d_eff >= embedding.length) return embedding;

  const centered = embedding.map((v, j) => v - (pca.mean[j] || 0));
  const projected = new Array(pca.d_eff);

  for (let k = 0; k < pca.d_eff; k++) {
    let sum = 0;
    const comp = pca.components[k];
    for (let j = 0; j < centered.length; j++) {
      sum += centered[j] * (comp[j] || 0);
    }
    projected[k] = sum;
  }

  return projected;
}

/**
 * Measure effective dimensions from stored embeddings.
 * Should be called during maintenance, not on every search.
 *
 * @param {Array} memoriesWithEmbeddings  Output of getActiveWithEmbedding()
 * @param {import('better-sqlite3').Database} db
 * @returns {{ d_eff: number, variance_explained: number, computed_at: string }}
 */
export function measureEffectiveDim(memoriesWithEmbeddings, db) {
  if (!D_EFF_ENABLED) return { d_eff: 0, variance_explained: 0, computed_at: '' };

  const withVec = memoriesWithEmbeddings.filter(m => m.embedding && m.embedding.length > 0);
  if (withVec.length < 10) return { d_eff: withVec[0]?.embedding?.length || 0, variance_explained: 0, computed_at: new Date().toISOString() };

  // Sample up to D_EFF_MAX_SAMPLE embeddings
  const sample = withVec.length > D_EFF_MAX_SAMPLE
    ? withVec.sort(() => Math.random() - 0.5).slice(0, D_EFF_MAX_SAMPLE)
    : withVec;

  const embeddings = sample.map(m => m.embedding);
  const pca = computePCA(embeddings, D_EFF_VARIANCE_THRESHOLD);

  // Store result in noxem_meta table
  _upsertMeta(db, 'd_eff', JSON.stringify({
    d_eff: pca.d_eff,
    variance_explained: pca.varianceExplained,
    components_count: pca.components.length,
    sample_size: sample.length,
    embed_dim: embeddings[0]?.length || 0,
  }));
  _upsertMeta(db, 'd_eff_computed_at', new Date().toISOString());

  // Store PCA projection data if d_eff is significantly less than embed_dim
  const embedDim = embeddings[0]?.length || 256;
  if (pca.d_eff < embedDim * 0.5 && pca.components.length > 0) {
    _upsertMeta(db, 'd_eff_components', JSON.stringify(pca.components.slice(0, pca.d_eff)));
    _upsertMeta(db, 'd_eff_mean', JSON.stringify(pca.mean));
  }

  LOG_DEBUG && console.log(`[d_eff] Measured: ${pca.d_eff}/${embedDim} dims, ${Math.round(pca.varianceExplained * 100)}% variance, sample=${sample.length}`);

  return {
    d_eff: pca.d_eff,
    variance_explained: pca.varianceExplained,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Apply d_eff projection to a query embedding before KNN search.
 * Transparent wrapper — projects only if d_eff < embed_dim / 2 and
 * PCA data is available in noxem_meta.
 *
 * @param {number[]} queryEmbedding  Original query embedding
 * @param {import('better-sqlite3').Database} db
 * @returns {number[]}  Projected or original embedding
 */
export function applyDEffProjection(queryEmbedding, db) {
  if (!D_EFF_ENABLED) return queryEmbedding;

  const dEffStr = _getMeta(db, 'd_eff');
  if (!dEffStr) return queryEmbedding;

  try {
    const dEffData = JSON.parse(dEffStr);
    const embedDim = dEffData.embed_dim || queryEmbedding.length;
    if (dEffData.d_eff >= embedDim * 0.5) return queryEmbedding; // No projection needed

    const componentsStr = _getMeta(db, 'd_eff_components');
    const meanStr = _getMeta(db, 'd_eff_mean');
    if (!componentsStr || !meanStr) return queryEmbedding;

    const components = JSON.parse(componentsStr);
    const mean = JSON.parse(meanStr);

    return projectToDEff(queryEmbedding, {
      d_eff: dEffData.d_eff,
      components,
      mean,
    });
  } catch {
    return queryEmbedding; // Graceful fallback
  }
}


// ─── 2. Write-Pipeline Governance ──────────────────────────────────────
// LESSON insight: mem0 audit found 52.7% system prompts stored as memory,
// 5.2% hallucinated profiles, echo loops where recall -> re-store.
// 3-gate filter: system prompt rejection, hallucinated profile gate, loop detection.

const WRITE_GOVERNANCE_ENABLED = process.env.WRITE_GOVERNANCE_ENABLED !== 'false';

// Gate 1: System prompt / instruction patterns
const SYSTEM_PROMPT_PATTERNS = [
  /^you are\b/i,
  /^you're a\b/i,
  /^you must/i,
  /^you should always/i,
  /^IMPORTANT:/i,
  /^NEVER /i,
  /^ALWAYS /i,
  /^DO NOT /i,
  /^INSTRUCTIONS?:/i,
  /^SYSTEM:/i,
  /^<\?xml/i,
  /^\[INST\]/i,
  /^(you are|act as|pretend to|roleplay|ignore|forget|disregard)\b/i,
];

// Gate 2: Hallucinated profile patterns (LLM-generated profiles without explicit entity)
const HALLUCINATED_PROFILE_PATTERNS = [
  /^(the user|this user|our user)\s+(is|has|works|lives|prefers|enjoys|likes|uses)\b/i,
  /^(the person|this person)\s+(is|has|works)\b/i,
  /^based on (our|the|this) (conversation|interaction|chat)/i,
  /^i (infer|assume|deduce|believe|think) (the user|this user|they)/i,
];

// Write governance stats
const _writeStats = { accepted: 0, rejected: 0, flagged: 0, loop_blocked: 0 };
const _recentWrites = []; // { textHash, timestamp } for loop detection

/**
 * Run the 3-gate write-pipeline governance check.
 * Called BEFORE storeMemory() inserts a new memory.
 *
 * @param {string} text  Memory text to validate
 * @param {string} type  Memory type
 * @param {string} [entity]  Explicit entity from caller (bypasses gate 2 if provided)
 * @returns {{ allowed: boolean, reason?: string, gate?: string }}
 */
export function validateWrite(text, type, entity = '') {
  if (!WRITE_GOVERNANCE_ENABLED) {
    _writeStats.accepted++;
    return { allowed: true };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    _writeStats.rejected++;
    return { allowed: false, reason: 'empty text', gate: 'pre' };
  }

  // Gate 1: System prompt / instruction filter
  for (const pattern of SYSTEM_PROMPT_PATTERNS) {
    if (pattern.test(trimmed)) {
      _writeStats.rejected++;
      return { allowed: false, reason: 'text matches system prompt / instruction pattern', gate: 'system_prompt' };
    }
  }

  // Also check if >50% of sentences look like instructions
  const sentences = trimmed.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length >= 2) {
    const instructionCount = sentences.filter(s => SYSTEM_PROMPT_PATTERNS.some(p => p.test(s.trim()))).length;
    if (instructionCount / sentences.length > 0.5) {
      _writeStats.rejected++;
      return { allowed: false, reason: 'text is >50% instruction-like sentences', gate: 'system_prompt' };
    }
  }

  // Gate 2: Hallucinated profile filter
  // If type is 'profile' and no explicit entity was provided by the caller, flag for review
  if (type === 'profile' && !entity) {
    for (const pattern of HALLUCINATED_PROFILE_PATTERNS) {
      if (pattern.test(trimmed)) {
        _writeStats.flagged++;
        return { allowed: true, reason: 'flagged: possible hallucinated profile without entity', gate: 'hallucinated_profile', flagged: true };
      }
    }
  }

  // Gate 3: Loop detection — check if very similar text was stored in the last 60 seconds
  const textHash = createHash('sha256').update(trimmed).digest('hex').substring(0, 16);
  const now = Date.now();
  const LOOP_WINDOW_MS = 60_000;
  const recentDuplicate = _recentWrites.find(w => w.textHash === textHash && (now - w.timestamp) < LOOP_WINDOW_MS);
  if (recentDuplicate) {
    _writeStats.loop_blocked++;
    return { allowed: false, reason: 'loop detected: near-identical text stored within 60 seconds', gate: 'loop_detection' };
  }

  // Track this write for future loop detection
  _recentWrites.push({ textHash, timestamp: now });
  // Prune old entries
  while (_recentWrites.length > 0 && (now - _recentWrites[0].timestamp) > LOOP_WINDOW_MS * 2) {
    _recentWrites.shift();
  }

  _writeStats.accepted++;
  return { allowed: true };
}

/**
 * Get write-pipeline governance stats.
 * @returns {Object}
 */
export function getWriteStats() {
  return { ..._writeStats, governance_enabled: WRITE_GOVERNANCE_ENABLED };
}


// ─── 3. Memory Poisoning Audit ─────────────────────────────────────────
// LESSON insight: prompt injection into memory stores is a real attack vector.
// Audit checks for: unattributed memories, injection patterns, contradictions, junk.

const INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|above|earlier|all)\s+(instructions?|rules?|directions?|constraints?)/i,
  /forget\s+(everything|all|previous|prior)/i,
  /you\s+are\s+now\b/i,
  /disregard\s+(all|any|previous|prior)/i,
  /new\s+instructions?:/i,
  /override\s+(previous|prior|all|default)/i,
  /system\s+prompt\s*(is|has been|was)?\s*(changed|updated|modified|overridden)/i,
  /<\/?system>/i,
  /\<\|im_start\|>/i,
  /\[COMPROMISED\]/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/**
 * Run a memory poisoning security audit.
 * Returns a structured risk report.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ risks: Array, summary: Object }}
 */
export function auditMemoryPoisoning(db) {
  const risks = [];
  const summary = { injection_suspects: 0, unattributed: 0, contradictions: 0, stale_junk: 0, total_risks: 0 };

  // Check 1: Memories containing known injection patterns
  const activeMems = db.prepare(
    "SELECT id, text, session_id, entity, created_at FROM memories WHERE status = 'active'"
  ).all();

  for (const m of activeMems) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(m.text)) {
        risks.push({
          memory_id: m.id,
          risk_type: 'injection_pattern',
          severity: 'high',
          detail: `Text matches injection pattern: ${pattern.source}`,
          text_preview: m.text.substring(0, 100),
        });
        summary.injection_suspects++;
        break;
      }
    }
  }

  // Check 2: Unattributed memories (no session_id, no entity)
  for (const m of activeMems) {
    if (!m.session_id && !m.entity) {
      // Only flag if also low importance and never recalled
      const meta = db.prepare('SELECT importance, recall_count FROM memories WHERE id = ?').get(m.id);
      if (meta && (meta.importance || 0) < 0.3 && (meta.recall_count || 0) === 0) {
        risks.push({
          memory_id: m.id,
          risk_type: 'unattributed',
          severity: 'low',
          detail: 'Memory has no session_id and no entity, low importance, never recalled',
          text_preview: m.text.substring(0, 100),
        });
        summary.unattributed++;
      }
    }
  }

  // Check 3: Entity contradictions (same entity+attribute, contradictory values, same session)
  const entityAttrMap = new Map();
  for (const m of activeMems) {
    if (!m.entity) continue;
    const attr = db.prepare('SELECT attribute FROM memories WHERE id = ?').get(m.id);
    const key = `${m.entity}::${attr?.attribute || ''}`;
    if (!entityAttrMap.has(key)) entityAttrMap.set(key, []);
    entityAttrMap.get(key).push(m);
  }

  for (const [key, mems] of entityAttrMap) {
    if (mems.length < 2) continue;
    for (let i = 0; i < mems.length - 1; i++) {
      const a = mems[i];
      const b = mems[i + 1];
      if (a.session_id && a.session_id === b.session_id && a.text !== b.text) {
        // Simple negation check
        const aHas = a.text.match(/(?:don't|not|never|no longer)\s/i);
        const bHas = b.text.match(/(?:don't|not|never|no longer)\s/i);
        if (aHas && !bHas || !aHas && bHas) {
          risks.push({
            risk_type: 'contradiction',
            severity: 'medium',
            detail: `Possible contradiction for ${key} in session ${a.session_id}`,
            memory_ids: [a.id, b.id],
            text_previews: [a.text.substring(0, 80), b.text.substring(0, 80)],
          });
          summary.contradictions++;
        }
      }
    }
  }

  // Check 4: Stale memories (never recalled, age > 30 days) — likely junk
  const staleRows = db.prepare(
    "SELECT id, text, type, created_at FROM memories WHERE status = 'active' AND recall_count = 0 AND created_at < datetime('now', '-30 days')"
  ).all();

  // Cap at 20 to avoid flooding the report
  for (const m of staleRows.slice(0, 20)) {
    risks.push({
      memory_id: m.id,
      risk_type: 'stale_junk',
      severity: 'low',
      detail: `Never recalled since ${m.created_at}, likely junk`,
      text_preview: m.text.substring(0, 80),
    });
    summary.stale_junk++;
  }
  if (staleRows.length > 20) {
    summary.stale_junk_total = staleRows.length;
  }

  summary.total_risks = risks.length;
  return { risks, summary };
}


// ─── 4. Table-Aware Extraction ──────────────────────────────────────────
// LESSON insight: tables must be chunked by row structure, not text length.
// Header carry-forward preserves column semantics.

/**
 * Detect if text contains tabular data.
 * @param {string} text
 * @returns {{ isTable: boolean, format: string, headers: string[], rowCount: number }}
 */
export function detectTableData(text) {
  if (!text || typeof text !== 'string') return { isTable: false, format: '', headers: [], rowCount: 0 };

  // Pipe table: | header | header |
  const pipeTableMatch = text.match(/^\|?\s*[\w\s]+\s*\|\s*[\w\s]+/m);
  if (pipeTableMatch) {
    const lines = text.split('\n').filter(l => l.trim());
    const headerLine = lines.find(l => /\|/.test(l));
    if (!headerLine) return { isTable: false, format: '', headers: [], rowCount: 0 };

    const headers = headerLine.split('|').map(s => s.trim()).filter(Boolean);
    // Skip separator line (| --- | --- |)
    const dataLines = lines.filter(l => /\|/.test(l) && !/^\|?\s*[-:]+\s*\|/.test(l) && l !== headerLine);
    return { isTable: true, format: 'pipe', headers, rowCount: dataLines.length };
  }

  // CSV/TSV: consistent separators across lines
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length >= 3) {
    // Tab-separated
    const tabCounts = lines.slice(0, 5).map(l => (l.match(/\t/g) || []).length);
    if (tabCounts.every(c => c >= 2 && c === tabCounts[0])) {
      const headers = lines[0].split('\t').map(s => s.trim());
      return { isTable: true, format: 'tsv', headers, rowCount: lines.length - 1 };
    }

    // Comma-separated (with heuristic: at least 2 commas, consistent count)
    const commaCounts = lines.slice(0, 5).map(l => (l.match(/,/g) || []).length);
    if (commaCounts.every(c => c >= 2 && c === commaCounts[0])) {
      const headers = lines[0].split(',').map(s => s.trim());
      return { isTable: true, format: 'csv', headers, rowCount: lines.length - 1 };
    }
  }

  return { isTable: false, format: '', headers: [], rowCount: 0 };
}

/**
 * Extract table data into row-based chunks with header carry-forward.
 * Each row becomes a separate chunk preserving column semantics.
 *
 * @param {string} text  Text containing table data
 * @param {{ headers?: string[], format?: string, maxChunkRows?: number }} [options]
 * @returns {Array<{ content: string, metadata: { table_name?: string, row_idx: number, columns: string[] } }>}
 */
export function extractTableChunks(text, options = {}) {
  if (!text) return [];

  const detected = detectTableData(text);
  if (!detected.isTable) return [{ content: text, metadata: { row_idx: 0, columns: [] } }];

  const headers = options.headers || detected.headers;
  const maxChunkRows = options.maxChunkRows || 1; // One row per chunk by default
  const lines = text.split('\n').filter(l => l.trim());

  if (!headers.length || lines.length < 2) return [{ content: text, metadata: { row_idx: 0, columns: headers } }];

  // Separate header line(s) from data lines
  let dataStart = 1;
  if (detected.format === 'pipe') {
    // Skip separator line
    const sepLine = lines.findIndex((l, i) => i > 0 && /^\|?\s*[-:]+/.test(l));
    dataStart = sepLine >= 0 ? sepLine + 1 : 1;
  }

  const separator = detected.format === 'tsv' ? '\t' : detected.format === 'csv' ? ',' : '|';
  const chunks = [];

  let rowIdx = 0;
  for (let i = dataStart; i < lines.length; i++) {
    const cells = lines[i].split(separator).map(s => s.trim()).filter(s => s.length > 0);
    if (cells.length === 0) continue;

    // Build human-readable row text with header carry-forward
    const rowParts = [];
    for (let j = 0; j < Math.min(cells.length, headers.length); j++) {
      rowParts.push(`${headers[j]}: ${cells[j]}`);
    }
    // Extra cells without matching headers
    for (let j = headers.length; j < cells.length; j++) {
      rowParts.push(`col${j}: ${cells[j]}`);
    }

    chunks.push({
      content: rowParts.join(', '),
      metadata: {
        row_idx: rowIdx,
        columns: headers,
      },
    });
    rowIdx++;
  }

  return chunks;
}


// ─── 5. Post-Retrieval Reranking ────────────────────────────────────────
// LESSON insight: HNSW ANN search is "near enough but not exact".
// Reranking after retrieval compensates for approximation errors.
// final_score = 0.6*vec + 0.2*fts + 0.1*recency + 0.1*entity_boost

const RERANK_ENABLED = process.env.RERANK_ENABLED !== 'false';

// Reranking weights (can be tuned via env)
const RERANK_WEIGHT_VEC = parseFloat(process.env.RERANK_WEIGHT_VEC || '0.6');
const RERANK_WEIGHT_FTS = parseFloat(process.env.RERANK_WEIGHT_FTS || '0.2');
const RERANK_WEIGHT_RECENCY = parseFloat(process.env.RERANK_WEIGHT_RECENCY || '0.1');
const RERANK_WEIGHT_ENTITY = parseFloat(process.env.RERANK_WEIGHT_ENTITY || '0.1');

/**
 * Apply post-retrieval reranking to merged search results.
 * Each result should have: vec_score, fts_rank, recency_score (0-1), entity_boost (0-1).
 *
 * @param {Array} results  Merged results with individual scores
 * @param {Object} [weights]  Override default weights
 * @returns {Array}  Re-sorted results with final_score
 */
export function rerankResults(results, weights = {}) {
  if (!RERANK_ENABLED || !results || results.length === 0) return results;

  const wVec = weights.vec ?? RERANK_WEIGHT_VEC;
  const wFts = weights.fts ?? RERANK_WEIGHT_FTS;
  const wRecency = weights.recency ?? RERANK_WEIGHT_RECENCY;
  const wEntity = weights.entity ?? RERANK_WEIGHT_ENTITY;

  return results.map(r => {
    const vecScore = r.vec_score ?? r.score ?? 0.5;
    const ftsRank = r.fts_rank ?? r.fts_score ?? 0;
    const recencyScore = r.recency_score ?? _computeSimpleRecency(r.created_at);
    const entityBoost = r.entity_boost ?? (r.entity ? 0.1 : 0);

    // Normalize FTS rank to 0-1 (higher = better)
    const ftsScore = Math.max(0, Math.min(1, typeof ftsRank === 'number' && ftsRank < 0
      ? 1 + ftsRank / 10  // FTS5 rank is negative
      : ftsRank
    ));

    const finalScore = (vecScore * wVec) + (ftsScore * wFts) + (recencyScore * wRecency) + (entityBoost * wEntity);

    return {
      ...r,
      final_score: Math.round(finalScore * 10000) / 10000,
      _rerank: { vec: vecScore, fts: ftsScore, recency: recencyScore, entity: entityBoost },
    };
  }).sort((a, b) => (b.final_score || 0) - (a.final_score || 0));
}

/**
 * Simple Weibull-inspired recency score for reranking.
 * @param {string} createdAt
 * @returns {number}  0..1
 */
function _computeSimpleRecency(createdAt) {
  if (!createdAt) return 0.3;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0.3;
  // Simple exponential decay with 30-day half-life
  return Math.exp(-0.693 * ageDays / 30);
}

/**
 * Build reranking-compatible result objects from FTS + vector merged results.
 * Converts internal Noxem result format into the structure rerankResults() expects.
 *
 * @param {Array} results  Results from hybrid search
 * @param {string} method  Search method string (e.g. 'hybrid+mixed')
 * @param {string} query  Original query
 * @returns {Array}  Results with vec_score/fts_rank fields for reranking
 */
export function prepareForReranking(results, method, query) {
  if (!results || results.length === 0) return results;

  return results.map(r => {
    // Decompose the existing score based on search method
    const isVec = method?.includes('embedding') || method?.includes('hybrid');
    const isFts = method?.includes('fts');

    return {
      ...r,
      vec_score: isVec ? (r.score || 0.5) : 0.1,
      fts_rank: isFts ? (r.score || 0.5) : 0.1,
      recency_score: _computeSimpleRecency(r.created_at),
      // Entity boost: if the result's entity matches a word in the query
      entity_boost: r.entity && query.toLowerCase().includes(r.entity.toLowerCase()) ? 0.15 : 0,
    };
  });
}


// ─── 6. Short-Term Sliding Window ──────────────────────────────────────
// LESSON insight: last N verbatim + older summaries = efficient context.
// Not all-or-nothing compression, but incremental eviction.

const SLIDING_WINDOW_SIZE = parseInt(process.env.CONTEXT_WINDOW_SIZE || '10');

/**
 * Get a sliding window of recent conversation context.
 * Last N L0 memories verbatim + older L1 summaries for the same session.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} sessionId
 * @param {number} [windowSize=10]  Number of verbatim L0 memories to keep
 * @returns {{ recent: Array, summaries: Array, total_omitted: number }}
 */
export function getSlidingWindow(db, sessionId, windowSize = SLIDING_WINDOW_SIZE) {
  if (!sessionId) return { recent: [], summaries: [], total_omitted: 0 };

  const limit = Math.max(1, Math.min(windowSize, 100));

  // Get recent L0 (cone_layer = 0) memories verbatim
  const recentMemories = db.prepare(
    `SELECT id, type, text, entity, attribute, created_at, importance
     FROM memories
     WHERE session_id = ? AND status = 'active' AND (cone_layer = 0 OR cone_layer IS NULL)
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(sessionId, limit * 3); // Fetch more than needed to filter

  // Split into verbatim window and older
  const recent = recentMemories.slice(0, limit);
  const older = recentMemories.slice(limit);

  // Get L1 summaries for the session (cone_layer = 1)
  const l1Summaries = db.prepare(
    `SELECT id, type, text, entity, attribute, created_at, importance, summary
     FROM memories
     WHERE session_id = ? AND status = 'active' AND cone_layer = 1
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(sessionId, limit * 2);

  // Build summary items: use summary field if available, otherwise truncate text
  const summaries = [
    ...older.map(m => ({
      id: m.id,
      type: m.type,
      text: m.summary || _truncateForSummary(m.text),
      entity: m.entity,
      created_at: m.created_at,
      _window: 'older_l0_summary',
    })),
    ...l1Summaries.map(m => ({
      id: m.id,
      type: m.type,
      text: m.summary || _truncateForSummary(m.text),
      entity: m.entity,
      created_at: m.created_at,
      _window: 'l1_summary',
    })),
  ].slice(0, limit * 2); // Cap total summaries

  const totalOmitted = Math.max(0, recentMemories.length - limit) + Math.max(0, l1Summaries.length - limit * 2);

  return {
    recent: recent.map(m => ({
      id: m.id,
      type: m.type,
      text: m.text, // Full verbatim
      entity: m.entity,
      attribute: m.attribute,
      importance: m.importance,
      created_at: m.created_at,
      _window: 'verbatim',
    })),
    summaries,
    total_omitted: totalOmitted,
  };
}

/**
 * Truncate text for summary representation.
 * @param {string} text
 * @returns {string}
 */
function _truncateForSummary(text) {
  if (!text || text.length <= 120) return text;
  return text.substring(0, 117) + '...';
}


// ─── Metadata Helpers ───────────────────────────────────────────────────

const _metaStmts = new WeakMap();

function _getMetaStmts(db) {
  if (_metaStmts.has(db)) return _metaStmts.get(db);
  // Ensure noxem_meta table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS noxem_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
  const stmts = {
    upsert: db.prepare('INSERT OR REPLACE INTO noxem_meta (key, value) VALUES (?, ?)'),
    get: db.prepare('SELECT value FROM noxem_meta WHERE key = ?'),
  };
  _metaStmts.set(db, stmts);
  return stmts;
}

function _upsertMeta(db, key, value) {
  const s = _getMetaStmts(db);
  s.upsert.run(key, value);
}

function _getMeta(db, key) {
  const s = _getMetaStmts(db);
  const row = s.get.get(key);
  return row?.value || null;
}
