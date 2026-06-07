/**
 * Noxem Adapter — Declarative Gateway
 *
 * Adapts Google MCP Toolbox patterns into Noxem-compatible ESM module:
 *   - Declarative MCP tool config from YAML (or JSON fallback)
 *   - Toolset/per-agent access scoping (readonly / standard / admin)
 *   - Parameterized query templates with safe SQL + params schema
 *   - NL2SQL bridge via Brain 2
 *   - Agent skill package export
 *
 * Inspired by: github.com/googleapis/mcp-toolbox (tools.yaml, toolsets, skills-generate)
 * Designed for: Noxem v2.1 (better-sqlite3, ESM, Brain 1/2, SQLite WAL)
 */

import { createHash } from 'node:crypto';

// ── Constants ─────────────────────────────────────────────

const TOOLSET_PRESETS = {
  readonly: {
    description: 'Read-only access: search, traverse, advisor only',
    tools: ['memory_search', 'memory_graph_traverse', 'advisor_advice'],
    access_level: 'read',
  },
  standard: {
    description: 'Standard agent: read + store + sync',
    tools: [
      'memory_search', 'memory_store', 'memory_sync',
      'memory_graph_traverse', 'advisor_advice',
    ],
    access_level: 'write',
  },
  admin: {
    description: 'Admin agent: all tools including maintenance and purge',
    tools: [
      'memory_search', 'memory_store', 'memory_release', 'memory_sync',
      'memory_graph_traverse', 'advisor_advice', 'search_web', 'research_hints',
    ],
    access_level: 'admin',
  },
};

// SQL safety: only these keywords are allowed in generated SQL
const SQL_ALLOWED_PREFIXES = ['SELECT', 'WITH'];
const SQL_FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|REPLACE|VACUUM)\b/i;
const SQL_MAX_ROWS = 500;

// ── State ─────────────────────────────────────────────────

let _db = null;
let _stmts = null;
let _toolConfig = null;   // parsed from YAML/JSON
let _toolsets = null;     // name -> { tools, access_level }
let _brain2Fn = null;     // async (prompt) => string  — Brain 2 call
let _watchers = [];       // file watchers for dynamic reload
let _ready = false;

// ── Schema ────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT    NOT NULL DEFAULT '',
      sql_template TEXT   NOT NULL,
      params_schema TEXT  NOT NULL DEFAULT '{}',
      access_level TEXT   NOT NULL DEFAULT 'read',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS toolset_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_query_templates_name ON query_templates(name);
  `);

  // Seed built-in templates if table is empty
  const count = db.prepare('SELECT COUNT(*) AS c FROM query_templates').get().c;
  if (count === 0) seedBuiltInTemplates(db);

  // Track schema version
  const v = db.prepare("SELECT value FROM toolset_meta WHERE key = 'schema_version'").get();
  if (!v) db.prepare("INSERT INTO toolset_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

function seedBuiltInTemplates(db) {
  const seeds = [
    {
      name: 'memories_by_entity_recent',
      description: 'Active memories for an entity within a time period, ordered by importance',
      sql_template: 'SELECT id, type, text, entity, attribute, importance, created_at FROM memories WHERE entity = :entity AND status = :status AND created_at > datetime(:now, :period) ORDER BY importance DESC LIMIT :limit',
      params_schema: JSON.stringify({
        entity: { type: 'string', required: true, description: 'Entity name' },
        status: { type: 'string', default: 'active', description: 'Memory status filter' },
        period: { type: 'string', default: '-30 days', description: 'SQLite datetime modifier' },
        limit: { type: 'integer', default: 20, max: 200, description: 'Max results' },
      }),
      access_level: 'read',
    },
    {
      name: 'memory_counts_by_type',
      description: 'Count of active memories grouped by type',
      sql_template: 'SELECT type, COUNT(*) AS count FROM memories WHERE status = :status GROUP BY type ORDER BY count DESC',
      params_schema: JSON.stringify({
        status: { type: 'string', default: 'active', description: 'Memory status filter' },
      }),
      access_level: 'read',
    },
    {
      name: 'entities_by_mention',
      description: 'Top entities ordered by mention count',
      sql_template: 'SELECT canonical_name, entity_type, mention_count FROM entities ORDER BY mention_count DESC LIMIT :limit',
      params_schema: JSON.stringify({
        limit: { type: 'integer', default: 20, max: 200, description: 'Max results' },
      }),
      access_level: 'read',
    },
    {
      name: 'procedures_by_use',
      description: 'Stored procedures ordered by usage count',
      sql_template: 'SELECT id, name, description, trigger_context, use_count FROM procedures ORDER BY use_count DESC LIMIT :limit',
      params_schema: JSON.stringify({
        limit: { type: 'integer', default: 10, max: 100, description: 'Max results' },
      }),
      access_level: 'read',
    },
    {
      name: 'edge_counts_by_relation',
      description: 'Counts of edges grouped by relation type',
      sql_template: 'SELECT relation, COUNT(*) AS count FROM memory_edges GROUP BY relation ORDER BY count DESC',
      params_schema: JSON.stringify({}),
      access_level: 'read',
    },
  ];

  const insert = db.prepare(
    'INSERT INTO query_templates (name, description, sql_template, params_schema, access_level) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const s of seeds) insert.run(s.name, s.description, s.sql_template, s.params_schema, s.access_level);
  })();
}

// ── Prepared statements ───────────────────────────────────

function prepareStatements(db) {
  return {
    getTemplate:     db.prepare('SELECT * FROM query_templates WHERE name = ?'),
    listTemplates:   db.prepare('SELECT id, name, description, access_level FROM query_templates ORDER BY name'),
    insertTemplate:  db.prepare(
      'INSERT INTO query_templates (name, description, sql_template, params_schema, access_level) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description=excluded.description, sql_template=excluded.sql_template, params_schema=excluded.params_schema, access_level=excluded.access_level, updated_at=datetime(\'now\')'
    ),
    deleteTemplate:  db.prepare('DELETE FROM query_templates WHERE name = ?'),
    getToolsetMeta:  db.prepare('SELECT value FROM toolset_meta WHERE key = ?'),
    setToolsetMeta:  db.prepare('INSERT INTO toolset_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  };
}

// ── YAML/JSON Config Parsing ──────────────────────────────

/**
 * Parse a tools configuration from YAML or JSON.
 * Tries yaml (dynamic import), falls back to JSON.parse.
 * Returns { tools: { [name]: ToolDef }, toolsets: { [name]: ToolsetDef } }
 */
export async function parseToolConfig(source) {
  // source can be: file path (string), or parsed object
  if (typeof source === 'object' && source !== null) return normalizeConfig(source);

  let text;
  if (typeof source === 'string') {
    const { readFileSync } = await import('node:fs');
    try { text = readFileSync(source, 'utf-8'); } catch (e) {
      console.warn(`[DeclarativeGateway] Config file not found: ${source}`);
      return { tools: {}, toolsets: {} };
    }
  } else {
    return { tools: {}, toolsets: {} };
  }

  // Try YAML first
  try {
    const yaml = await import('yaml');
    const parsed = yaml.parse(text);
    return normalizeConfig(parsed);
  } catch (_) {
    // yaml not available or parse error — try JSON
  }

  try {
    return normalizeConfig(JSON.parse(text));
  } catch (e) {
    console.warn('[DeclarativeGateway] Config parse failed, using empty config:', e.message);
    return { tools: {}, toolsets: {} };
  }
}

function normalizeConfig(parsed) {
  const tools = {};
  const toolsets = {};

  // Handle multi-document (array of kind objects) or single object
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.kind === 'tool') {
      tools[entry.name] = {
        name: entry.name,
        type: entry.type || 'noxem-sql',
        description: entry.description || '',
        statement: entry.statement || '',
        source: entry.source || '',
        templateParameters: (entry.templateParameters || []).map(p => ({
          name: p.name,
          type: p.type || 'string',
          description: p.description || '',
          required: p.required ?? false,
          default: p.default,
        })),
        access_level: entry.access_level || 'read',
      };
    } else if (entry.kind === 'toolset') {
      toolsets[entry.name] = {
        name: entry.name,
        description: entry.description || '',
        tools: entry.tools || [],
        access_level: entry.access_level || 'read',
      };
    }
  }

  return { tools, toolsets };
}

// ── Init ──────────────────────────────────────────────────

/**
 * Initialize the declarative gateway adapter.
 * @param {import('better-sqlite3').Database} db - Noxem's better-sqlite3 instance
 * @param {object} [options]
 * @param {string}   [options.configPath] - Path to tools YAML/JSON config
 * @param {Function} [options.brain2Fn]   - async (prompt) => string  for NL2SQL
 * @param {string}   [options.defaultToolset] - Toolset name for unscoped agents
 */
export async function initDeclarativeGateway(db, options = {}) {
  _db = db;
  ensureSchema(db);
  _stmts = prepareStatements(db);

  // Merge presets into toolsets
  _toolsets = { ...TOOLSET_PRESETS };

  // Load config if provided
  if (options.configPath) {
    const cfg = await parseToolConfig(options.configPath);
    _toolConfig = cfg.tools;
    Object.assign(_toolsets, cfg.toolsets);

    // Sync config-defined templates into DB
    db.transaction(() => {
      for (const [name, t] of Object.entries(cfg.tools)) {
        if (t.statement) {
          _stmts.insertTemplate.run(
            name, t.description, t.statement,
            JSON.stringify(t.templateParameters || []),
            t.access_level
          );
        }
      }
    })();
  } else {
    _toolConfig = {};
  }

  // Set Brain 2 function for NL2SQL
  _brain2Fn = options.brain2Fn || null;

  // Default toolset
  if (options.defaultToolset && _toolsets[options.defaultToolset]) {
    _stmts.setToolsetMeta.run('default_toolset', options.defaultToolset);
  }

  _ready = true;
  return { ok: true, templates: _stmts.listTemplates.all().length, toolsets: Object.keys(_toolsets).length };
}

export function isDeclarativeGatewayReady() { return _ready; }

// ── Toolset Access Scoping ────────────────────────────────

/**
 * Resolve the toolset for an agent, returning which tools it may access.
 * @param {string} [toolsetName] - Requested toolset name
 * @returns {{ name: string, tools: string[], access_level: string, description: string }}
 */
export function resolveToolset(toolsetName) {
  if (!toolsetName) {
    const defaultName = _stmts?.getToolsetMeta.get('default_toolset')?.value || 'standard';
    toolsetName = defaultName;
  }
  const ts = _toolsets[toolsetName] || TOOLSET_PRESETS.standard;
  return { name: toolsetName, tools: ts.tools, access_level: ts.access_level, description: ts.description };
}

/**
 * Filter a list of MCP tool names by toolset access.
 * @param {string[]} toolNames - Full list of available tools
 * @param {string}   toolsetName - Toolset to scope by
 * @returns {string[]} Allowed tools
 */
export function filterToolsByAccess(toolNames, toolsetName) {
  const ts = resolveToolset(toolsetName);
  const allowedSet = new Set(ts.tools);
  return toolNames.filter(n => allowedSet.has(n));
}

/**
 * Register or update a toolset at runtime.
 * @param {string} name
 * @param {string[]} tools
 * @param {string} access_level - 'read' | 'write' | 'admin'
 * @param {string} [description]
 */
export function registerToolset(name, tools, access_level = 'read', description = '') {
  _toolsets[name] = { name, tools, access_level, description };
  return _toolsets[name];
}

/**
 * List all known toolsets.
 */
export function listToolsets() {
  return Object.entries(_toolsets).map(([name, ts]) => ({
    name,
    tools: ts.tools,
    access_level: ts.access_level,
    description: ts.description,
  }));
}

// ── Parameterized Query Templates ─────────────────────────

/**
 * Execute a parameterized query template safely.
 *
 * SQL template uses :param_name placeholders. Only SELECT/WITH statements
 * are allowed. LIMIT is enforced. Params are validated against the schema.
 *
 * @param {string} templateName - Name of stored template
 * @param {object} params - Key-value params to bind
 * @param {string} [toolsetAccess] - Access level of requesting agent ('read'/'write'/'admin')
 * @returns {{ rows: object[], template: string, params Applied: object }}
 */
export function executeQueryTemplate(templateName, params = {}, toolsetAccess = 'read') {
  if (!_stmts) throw new Error('DeclarativeGateway not initialized');

  const template = _stmts.getTemplate.get(templateName);
  if (!template) throw new Error(`Query template not found: ${templateName}`);

  // Access check: 'write' and 'admin' can use any template; 'read' can only use 'read' templates
  if (toolsetAccess === 'read' && template.access_level !== 'read') {
    throw new Error(`Access denied: template '${templateName}' requires write+ access (agent has read)`);
  }

  return runParameterizedQuery(template.sql_template, template.params_schema, params);
}

/**
 * Low-level: run a parameterized SQL query with :param substitution.
 * Public so NL2SQL can use it too.
 */
export function runParameterizedQuery(sqlTemplate, paramsSchemaJson, params = {}) {
  // Parse params schema (may be JSON array or JSON object)
  let schema;
  try { schema = JSON.parse(paramsSchemaJson); } catch (_) { schema = {}; }
  const schemaIsArray = Array.isArray(schema);
  const schemaMap = schemaIsArray
    ? Object.fromEntries(schema.map(p => [p.name, p]))
    : schema;

  // Validate + apply defaults + coerce types
  const applied = {};
  const namedParams = {};

  for (const [key, def] of Object.entries(schemaMap)) {
    if (params[key] !== undefined) {
      // Coerce type
      if (def.type === 'integer') {
        applied[key] = Math.floor(Number(params[key]));
        if (Number.isNaN(applied[key])) throw new Error(`Param '${key}' must be an integer`);
      } else {
        applied[key] = String(params[key]);
      }
    } else if (def.default !== undefined) {
      applied[key] = def.type === 'integer' ? Math.floor(Number(def.default)) : String(def.default);
    } else if (def.required) {
      throw new Error(`Required param '${key}' not provided`);
    } else {
      applied[key] = def.type === 'integer' ? 0 : '';
    }

    // Range check
    if (def.type === 'integer' && def.max !== undefined && applied[key] > def.max) {
      applied[key] = def.max;
    }

    namedParams[key] = applied[key];
  }

  // Inject :now param if referenced
  if (sqlTemplate.includes(':now')) {
    namedParams.now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    applied.now = namedParams.now;
  }

  // Safety: only SELECT / WITH allowed
  const trimmedSql = sqlTemplate.trim();
  const prefixOk = SQL_ALLOWED_PREFIXES.some(p => trimmedSql.toUpperCase().startsWith(p));
  if (!prefixOk) throw new Error('Only SELECT and WITH queries are allowed in templates');
  if (SQL_FORBIDDEN.test(trimmedSql)) throw new Error('Forbidden SQL keywords detected in template');

  // Enforce LIMIT
  const hasLimit = /\bLIMIT\s/i.test(trimmedSql);
  let finalSql = trimmedSql;
  if (!hasLimit) finalSql += ` LIMIT ${SQL_MAX_ROWS}`;

  // Replace :param_name with $param_name for better-sqlite3 named binding
  // But better-sqlite3 uses $prefix, so we convert :name -> $name
  finalSql = finalSql.replace(/:(\w+)/g, (_, name) => `$${name}`);

  // Convert namedParams to $-prefixed keys for better-sqlite3
  const bindParams = {};
  for (const [k, v] of Object.entries(namedParams)) {
    bindParams[`$${k}`] = v;
  }

  // Execute
  const stmt = _db.prepare(finalSql);
  const rows = stmt.all(bindParams);

  return { rows, template: trimmedSql, paramsApplied: applied };
}

/**
 * Add or update a query template at runtime.
 */
export function upsertQueryTemplate({ name, description = '', sql_template, params_schema = {}, access_level = 'read' }) {
  if (!_stmts) throw new Error('DeclarativeGateway not initialized');

  // Validate SQL safety before storing
  const trimmed = sql_template.trim();
  const prefixOk = SQL_ALLOWED_PREFIXES.some(p => trimmed.toUpperCase().startsWith(p));
  if (!prefixOk) throw new Error('Only SELECT and WITH queries are allowed');
  if (SQL_FORBIDDEN.test(trimmed)) throw new Error('Forbidden SQL keywords detected');

  const schemaJson = typeof params_schema === 'string' ? params_schema : JSON.stringify(params_schema);
  _stmts.insertTemplate.run(name, description, sql_template, schemaJson, access_level);
  return { ok: true, name };
}

/**
 * Delete a query template.
 */
export function deleteQueryTemplate(name) {
  if (!_stmts) throw new Error('DeclarativeGateway not initialized');
  const changes = _stmts.deleteTemplate.run(name).changes;
  return { ok: changes > 0, name, deleted: changes };
}

/**
 * List all available query templates (metadata only, no SQL).
 */
export function listQueryTemplates() {
  if (!_stmts) return [];
  return _stmts.listTemplates.all();
}

// ── NL2SQL Bridge ─────────────────────────────────────────

// Schema hint included in the Brain 2 prompt for NL2SQL
const NOXEM_SCHEMA_HINT = `
Noxem SQLite schema (read-only tables for NL queries):

memories(id, session_id, type, text, status, importance, entity, attribute,
  context_prefix, recall_count, created_at, cone_layer, scene_name, summary,
  superseded_by, valid_from, valid_until)

entities(id, canonical_name, entity_type, mention_count)

memory_edges(id, from_id, to_id, relation, strength, confidence)

procedures(id, name, description, trigger_context, use_count, session_id)

core_memory(id, key, value, description)

Rules: SELECT only. Always include LIMIT (max 500). Use :param_name for any
user-provided values (never interpolate). Status filter default: status='active'.
For date ranges, use SQLite datetime('now', '-N days') syntax.
`;

/**
 * Translate a natural language question into a SQL query and execute it.
 *
 * Uses Brain 2 (injected via init options) to translate. Falls back to
 * template matching if Brain 2 is unavailable.
 *
 * @param {string} question - Natural language question about the memory corpus
 * @param {object} [options]
 * @param {string} [options.toolsetAccess] - Access level of requesting agent
 * @param {number} [options.timeout] - Brain 2 timeout in ms (default 10000)
 * @returns {{ rows: object[], sql: string, source: 'brain2'|'template'|'none' }}
 */
export async function nlQuery(question, options = {}) {
  const access = options.toolsetAccess || 'read';

  // Try Brain 2 first
  if (_brain2Fn) {
    try {
      const prompt = [
        NOXEM_SCHEMA_HINT,
        '',
        `Question: ${question}`,
        '',
        'Respond with ONLY the SQL query using :param_name for user values.',
        'Example: SELECT COUNT(*) AS count FROM memories WHERE entity = :entity AND status = :status LIMIT 10',
      ].join('\n');

      const raw = await Promise.race([
        _brain2Fn(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), options.timeout || 10000)),
      ]);

      // Extract SQL from the response (might have markdown fences)
      const sqlMatch = raw.match(/```sql\s*([\s\S]*?)```/) || raw.match(/```\s*([\s\S]*?)```/);
      let sql = sqlMatch ? sqlMatch[1].trim() : raw.trim();
      sql = sql.replace(/^```/).replace(/```$/).trim();

      // Safety validation
      const prefixOk = SQL_ALLOWED_PREFIXES.some(p => sql.toUpperCase().startsWith(p));
      if (!prefixOk || SQL_FORBIDDEN.test(sql)) {
        return { rows: [], sql: '', source: 'brain2', error: 'Generated SQL failed safety check' };
      }

      // Enforce LIMIT
      if (!/\bLIMIT\s/i.test(sql)) sql += ` LIMIT ${SQL_MAX_ROWS}`;

      // Convert :params to $params for better-sqlite3
      const finalSql = sql.replace(/:(\w+)/g, (_, name) => `$${name}`);

      // No user params in NL2SQL (all values are inferred by Brain 2)
      const stmt = _db.prepare(finalSql);
      const rows = stmt.all();
      return { rows, sql, source: 'brain2' };
    } catch (e) {
      // Brain 2 failed — fall through to template matching
    }
  }

  // Fallback: simple keyword-based template matching
  const q = question.toLowerCase();
  const templates = _stmts.listTemplates.all();
  for (const t of templates) {
    const keywords = t.description.toLowerCase().split(/\s+/);
    const matchCount = keywords.filter(kw => kw.length > 3 && q.includes(kw)).length;
    if (matchCount >= 2) {
      try {
        const result = executeQueryTemplate(t.name, {}, access);
        return { rows: result.rows, sql: result.template, source: 'template' };
      } catch (_) { /* try next */ }
    }
  }

  return { rows: [], sql: '', source: 'none', error: 'No matching template and Brain 2 unavailable' };
}

// ── Skill Package Export ──────────────────────────────────

/**
 * Export Noxem memory tools as a portable skill package (JSON).
 * Inspired by MCP Toolbox's `skills-generate` which converts toolsets
 * into installable skill packages.
 *
 * @param {object} [options]
 * @param {string} [options.toolsetName] - Export only this toolset (default: all)
 * @param {string} [options.format] - 'json' (default) or 'markdown'
 * @returns {object} Skill package with tools, schema, and metadata
 */
export function exportSkillPackage(options = {}) {
  const toolsetName = options.toolsetName || 'admin';
  const ts = resolveToolset(toolsetName);

  // Core tool definitions (matching MCP tool schema format)
  const toolDefs = ts.tools.map(name => ({
    name,
    description: getToolDescription(name),
    inputSchema: getToolSchema(name),
  }));

  // Include any config-defined tools in this toolset
  if (_toolConfig) {
    for (const [name, def] of Object.entries(_toolConfig)) {
      if (ts.tools.includes(name)) continue; // already included
      if (def.access_level === 'read' || ts.access_level !== 'read') {
        toolDefs.push({
          name,
          description: def.description,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(
              (def.templateParameters || []).map(p => [p.name, { type: p.type, description: p.description }])
            ),
          },
        });
      }
    }
  }

  // Include query templates available at this access level
  const templates = _stmts ? _stmts.listTemplates.all().filter(t => {
    if (ts.access_level === 'read') return t.access_level === 'read';
    return true;
  }) : [];

  const pkg = {
    schemaVersion: 1,
    name: 'noxem-memory',
    version: '2.1.0',
    description: 'Noxem hierarchical memory system — semantic search, graph traversal, procedures, and advisor',
    toolset: ts.name,
    access_level: ts.access_level,
    tools: toolDefs,
    queryTemplates: templates.map(t => ({ name: t.name, description: t.description, access_level: t.access_level })),
    connection: {
      transport: 'stdio',
      command: 'node',
      args: ['server/mcp-server.mjs'],
      env: { NOXEM_TOOLSET: ts.name },
    },
    exportedAt: new Date().toISOString(),
  };

  return pkg;
}

// ── Tool Metadata Helpers ─────────────────────────────────

const TOOL_DESCRIPTIONS = {
  memory_search:          'Search memories using hybrid semantic + keyword search',
  memory_store:           'Store a new memory with automatic categorization and importance scoring',
  memory_release:         'Get context-release summary of active memories',
  memory_sync:            'Synchronize multiple memories at once with dedup checking',
  memory_graph_traverse:  'Traverse the memory graph edges to find related memories',
  advisor_advice:         'Get advice from the reasoning engine about task drift and context',
  search_web:             'Search the web via DuckDuckGo',
  research_hints:         'Get background research hints and research pipeline status',
};

const TOOL_SCHEMAS = {
  memory_search: {
    type: 'object',
    properties: {
      query:    { type: 'string',  description: 'Natural language search query' },
      limit:    { type: 'integer', description: 'Max results to return', default: 10 },
      intent:   { type: 'string',  description: 'Search intent', enum: ['identifier', 'exact', 'mixed', 'conceptual'] },
      type:     { type: 'string',  description: 'Filter by memory type' },
    },
    required: ['query'],
  },
  memory_store: {
    type: 'object',
    properties: {
      text:        { type: 'string',  description: 'The memory text to store' },
      type:        { type: 'string',  description: 'Memory type override' },
      session_id:  { type: 'string',  description: 'Session ID for grouping' },
      entity:      { type: 'string',  description: 'Entity name' },
      attribute:   { type: 'string',  description: 'Entity attribute' },
      importance:  { type: 'number',  description: 'Importance score 0-1' },
    },
    required: ['text'],
  },
  memory_release: {
    type: 'object',
    properties: {
      token_budget: { type: 'integer', description: 'Token budget (100-8000)', default: 2000 },
      session_id:   { type: 'string',  description: 'Session ID filter' },
    },
  },
  memory_sync: {
    type: 'object',
    properties: {
      memories:    { type: 'array',  description: 'Array of memories to sync', items: { type: 'object' } },
      session_id:  { type: 'string', description: 'Default session ID' },
    },
    required: ['memories'],
  },
  memory_graph_traverse: {
    type: 'object',
    properties: {
      memory_id:  { type: 'integer', description: 'Starting memory ID' },
      direction:  { type: 'string',  description: 'Edge direction', enum: ['outgoing', 'incoming', 'both'] },
      relation:   { type: 'string',  description: 'Filter by relation type' },
      max_depth:  { type: 'integer', description: 'Max traversal depth', default: 2 },
      limit:      { type: 'integer', description: 'Max results', default: 20 },
    },
    required: ['memory_id'],
  },
  advisor_advice: {
    type: 'object',
    properties: {
      user_message:         { type: 'string', description: 'Current user message or task' },
      conversation_history: { type: 'array',  description: 'Recent conversation turns' },
      task_context:         { type: 'string', description: 'Current task description' },
    },
    required: ['user_message'],
  },
  search_web: {
    type: 'object',
    properties: {
      query:        { type: 'string',  description: 'Search query' },
      max_results:  { type: 'integer', description: 'Max results', default: 5 },
    },
    required: ['query'],
  },
  research_hints: {
    type: 'object',
    properties: {
      status_only: { type: 'boolean', description: 'Return only pipeline status', default: false },
    },
  },
};

function getToolDescription(name) { return TOOL_DESCRIPTIONS[name] || name; }
function getToolSchema(name) { return TOOL_SCHEMAS[name] || { type: 'object', properties: {} }; }

// ── Dynamic Reload ────────────────────────────────────────

/**
 * Reload tool configuration from file (hot reload without restart).
 * @param {string} [configPath] - New config path, or reuse existing
 */
export async function reloadToolConfig(configPath) {
  if (!_db) throw new Error('DeclarativeGateway not initialized');

  const cfg = await parseToolConfig(configPath);
  _toolConfig = cfg.tools;
  Object.assign(_toolsets, cfg.toolsets);

  // Sync new templates
  _db.transaction(() => {
    for (const [name, t] of Object.entries(cfg.tools)) {
      if (t.statement) {
        _stmts.insertTemplate.run(
          name, t.description, t.statement,
          JSON.stringify(t.templateParameters || []),
          t.access_level
        );
      }
    }
  })();

  return { ok: true, tools: Object.keys(_toolConfig).length, toolsets: Object.keys(_toolsets).length };
}

// ── Stats ─────────────────────────────────────────────────

export function getDeclarativeGatewayStats() {
  return {
    ready: _ready,
    toolsets: Object.keys(_toolsets || {}).length,
    configTools: Object.keys(_toolConfig || {}).length,
    queryTemplates: _stmts ? _stmts.listTemplates.all().length : 0,
    brain2Available: !!_brain2Fn,
  };
}
