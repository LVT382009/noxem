#!/usr/bin/env node
/**
 * Hermes Memory MCP Server — stdio transport for AI agent tool access.
 *
 * Wraps core memory operations as MCP tools using @modelcontextprotocol/sdk.
 * Shares the same SQLite store + embedding + advisor modules as the Express server.
 *
 * Tools: memory_search, memory_store, memory_release, memory_sync,
 *        advisor_advice, search_web, research_hints, memory_graph_traverse
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import z from 'zod';

import { initEmbeddingEngine, isEmbeddingReady, embed, searchByEmbedding, generateContextPrefix, extractEntityAttribute, categorizeText, estimateImportance } from './embedding-engine.mjs';
import { initVectorIndex, isVecReady } from './vector-index.mjs';
import {
  storeMemory, searchMemories, getActiveMemories, getSessionMemories,
  getMemoryStats, deleteMemory, getAllActiveMemoriesNoEmbed, traverseMemoryGraph,
  storeEdge, getEdgesByRel, getMemory, getRawText,
  upsertCoreBlock, getCoreBlock, getAllCoreBlocks, deleteCoreBlock,
  getActiveWithEmbedding, updateMemoryStatus, incrementRecallCounts,
  close, db, getMemoriesByEntityAttr, compressMemory,
  getEdgesFromMemory, getEdgesToMemory,
} from './memory-store.mjs';
import { getAdvice, analyzeBeforeCompress } from './advisor-engine.mjs';
import { searchWeb, formatSearchResults } from './ddg-search.mjs';
import { getResearchStatus, getRecentResearch } from './research-engine.mjs';
import { initModules, ambientInjector, strategyDistiller, compactionCoordinator, contextCompressor, declarativeGateway, diagnosticCompiler } from './module-registry.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Initialize DB + embeddings ──────────────────────────

await initVectorIndex(db);
const embeddingReady = await initEmbeddingEngine();
if (LOG_DEBUG) console.error(`[MCP] Embedding: ${embeddingReady ? 'ready' : 'not available'}, Vector: ${isVecReady()}`);
initModules(embed);

// ── Create MCP Server ──────────────────────────────────

const server = new McpServer({
  name: 'hermes-memory',
  version: '2.1.0',
});

// ── Tool 1: memory_search ───────────────────────────────

server.registerTool(
  'memory_search',
  {
    description: 'Search memories using hybrid semantic + keyword search. Supports intent-based tuning (identifier, exact, mixed, conceptual).',
    inputSchema: {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().default(10).describe('Max results to return'),
      intent: z.enum(['identifier', 'exact', 'mixed', 'conceptual']).optional().default('mixed').describe('Search intent — identifier=strict, conceptual=explore'),
      type: z.string().optional().describe('Filter by memory type (fact, preference, setup, project, goal, entity, profile, pattern, event, issue, learning, request)'),
      session_id: z.string().optional().describe('Filter by session ID'),
      expand: z.boolean().optional().default(false).describe('Enable multi-query expansion for broader recall'),
    },
  },
  async ({ query, limit = 10, intent = 'mixed', type, session_id }) => {
    try {
      // Step 1: FTS5 keyword search
      const ftsResults = searchMemories({ query, limit: limit * 2 });
      // Step 2: Vector semantic search (if embeddings ready)
      let vecResults = [];
      if (isEmbeddingReady()) {
        const queryEmbedding = await embed(query);
        vecResults = searchByEmbedding(queryEmbedding, getActiveWithEmbedding(), limit, intent);
      }
      // Step 3: Merge with simple dedup (FTS first, then vector fill)
      const seen = new Set();
      const merged = [];
      for (const r of ftsResults) {
        if (type && r.type !== type) continue;
        if (session_id && r.session_id !== session_id) continue;
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
      }
      for (const r of vecResults) {
        if (type && r.type !== type) continue;
        if (session_id && r.session_id !== session_id) continue;
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
      }
      const results = merged.slice(0, limit).map(m => ({
        id: m.id, type: m.type, text: m.summary || m.text,
        entity: m.entity, attribute: m.attribute,
        importance: m.importance, context_prefix: m.context_prefix,
      }));
      if (results.length > 0) incrementRecallCounts(results.map(r => r.id));
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 2: memory_store ────────────────────────────────

server.registerTool(
  'memory_store',
  {
    description: 'Store a new memory with automatic categorization, importance scoring, and entity extraction.',
    inputSchema: {
      text: z.string().describe('The memory text to store'),
      type: z.string().optional().describe('Memory type override (auto-detected if omitted)'),
      session_id: z.string().optional().describe('Session ID for grouping'),
      entity: z.string().optional().describe('Entity name (e.g., "user", "project-x")'),
      attribute: z.string().optional().describe('Entity attribute (e.g., "name", "tech_stack")'),
      importance: z.number().optional().describe('Importance score 0-1 (auto-estimated if omitted)'),
    },
  },
  async ({ text, type, session_id, entity, attribute, importance }) => {
    try {
      const memType = type || categorizeText(text);
      const imp = importance ?? estimateImportance(text, memType);
      const { entity: ent, attribute: attr } = (entity && attribute)
        ? { entity, attribute }
        : extractEntityAttribute(text);
        const id = storeMemory({
        text,
        type: memType,
        session_id: session_id || '',
        entity: ent || '',
        attribute: attr || '',
        context_prefix: generateContextPrefix(text, memType, session_id || ''),
        importance: imp,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, id, type: memType, importance: imp, entity: ent, attribute: attr }) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 3: memory_release ──────────────────────────────

server.registerTool(
  'memory_release',
  {
    description: 'Get context-release summary of active memories. Returns condensed bullet points for token-efficient context injection.',
    inputSchema: {
      token_budget: z.number().optional().default(2000).describe('Token budget for the release text (100-8000)'),
      session_id: z.string().optional().describe('Release memories for specific session only'),
    },
  },
  async ({ token_budget = 2000, session_id }) => {
    try {
      const memories = session_id
        ? getSessionMemories(session_id)
        : getActiveMemories(50);
      const maxMems = Math.max(5, Math.min(100, Math.floor(token_budget / 30)));
const bullets = memories.slice(0, maxMems).map(m => {
        const prefix = m.context_prefix || `[${m.type}]`;
        const text = m.summary || m.text;
        const sessionTag = (session_id && m.session_id && m.session_id !== session_id)
          ? `[from session ${m.session_id.slice(0, 8)}]` : '';
        return `- ${prefix}${sessionTag ? ' ' + sessionTag : ''} ${text}`;
      });
      return {
        content: [{ type: 'text', text: bullets.join('\n') || 'No active memories.' }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 4: memory_sync ─────────────────────────────────

server.registerTool(
  'memory_sync',
  {
    description: 'Synchronize multiple memories at once — batch store with dedup and contradiction checking.',
    inputSchema: {
      memories: z.array(z.object({
        text: z.string(),
        type: z.string().optional(),
        session_id: z.string().optional(),
        entity: z.string().optional(),
        attribute: z.string().optional(),
        importance: z.number().optional(),
      })).describe('Array of memories to sync'),
      session_id: z.string().optional().describe('Default session ID for all memories'),
    },
  },
  async ({ memories, session_id }) => {
    try {
      const results = [];
      for (const m of memories) {
        const memType = m.type || categorizeText(m.text);
        const imp = m.importance ?? estimateImportance(m.text, memType);
        const { entity, attribute } = extractEntityAttribute(m.text);
        const id = storeMemory({
          text: m.text,
          type: memType,
          session_id: m.session_id || session_id || '',
          entity: m.entity || entity || '',
          attribute: m.attribute || attribute || '',
          context_prefix: generateContextPrefix(m.text, memType, m.session_id || session_id || ''),
          importance: imp,
        });
        results.push({ id, type: memType });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, stored: results.length, results }) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 5: advisor_advice ──────────────────────────────

server.registerTool(
  'advisor_advice',
  {
    description: 'Get advice from Brain 2 advisor — checks for task drift, provides context recovery hints, and reminds about forgotten information.',
    inputSchema: {
      user_message: z.string().describe('Current user message or task description'),
      conversation_history: z.array(z.object({
        role: z.string(),
        content: z.string(),
      })).optional().describe('Recent conversation turns for context'),
      task_context: z.string().optional().describe('Current task description'),
    },
  },
  async ({ user_message, conversation_history = [], task_context = '' }) => {
    try {
      const activeMemories = getActiveMemories(15);
      const advice = await getAdvice({
        userMessage: user_message,
        conversationHistory: conversation_history,
        activeMemories,
        currentTaskContext: task_context,
      });
      return {
        content: [{ type: 'text', text: typeof advice === 'string' ? advice : JSON.stringify(advice) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 6: search_web ──────────────────────────────────

server.registerTool(
  'search_web',
  {
    description: 'Search the web using DuckDuckGo. Returns formatted search results with titles, URLs, and snippets.',
    inputSchema: {
      query: z.string().describe('Search query'),
      max_results: z.number().optional().default(5).describe('Max results to return'),
    },
  },
  async ({ query, max_results = 5 }) => {
    try {
      const results = await searchWeb(query, max_results);
      const formatted = formatSearchResults(results);
      return {
        content: [{ type: 'text', text: formatted }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 7: research_hints ──────────────────────────────

server.registerTool(
  'research_hints',
  {
    description: 'Get background research hints and recent research status. Shows what topics have been researched and what might need investigation.',
    inputSchema: {
      status_only: z.boolean().optional().default(false).describe('Return only research pipeline status'),
    },
  },
  async ({ status_only = false }) => {
    try {
      const status = getResearchStatus();
      if (status_only) {
        return { content: [{ type: 'text', text: JSON.stringify(status) }] };
      }
      const recent = getRecentResearch(5);
      return {
        content: [{ type: 'text', text: JSON.stringify({ status, recent_research: recent }) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 8: memory_graph_traverse ───────────────────────

server.registerTool(
  'memory_graph_traverse',
  {
    description: 'Traverse the memory graph — find related memories via edges (references, implements, derives_from, contradicts, etc.).',
    inputSchema: {
      memory_id: z.number().int().positive().describe('Starting memory ID (positive integer)'),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().default('both').describe('Edge direction to follow'),
      relation: z.string().optional().describe('Filter by relation type (references, implements, derives_from, contradicts, clarifies, supersedes)'),
      max_depth: z.number().int().positive().optional().default(2).describe('Max traversal depth'),
      limit: z.number().int().positive().optional().default(20).describe('Max results'),
    },
  },
  async ({ memory_id, direction = 'both', relation, max_depth = 2, limit = 20 }) => {
    try {
      const results = traverseMemoryGraph(memory_id, max_depth, limit, direction, relation);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 9: memory_audit ─────────────────────────────────

server.registerTool(
  'memory_audit',
  {
    description: 'Run a 5-category memory audit: orphaned memories, broken edges, duplicate pairs, stale entries, invalid embeddings.',
    inputSchema: {
      scope: z.string().optional().describe('Audit scope: all, orphans, edges, duplicates, stale, embeddings'),
    },
  },
  async ({ scope }) => {
    try {
      const fullReport = ambientInjector.runMemoryAudit();
      if (scope && scope !== 'all') {
        const key = scope === 'orphans' ? 'orphaned_memories'
          : scope === 'edges' ? 'broken_edges'
          : scope === 'duplicates' ? 'duplicate_pairs'
          : scope === 'stale' ? 'stale_memories'
          : scope === 'embeddings' ? 'invalid_embeddings'
          : null;
        if (key) {
          const subset = { [key]: fullReport[key], total_checked: fullReport.total_checked, checked_at: fullReport.checked_at };
          return { content: [{ type: 'text', text: ambientInjector.formatAuditReport(subset) }] };
        }
      }
      return { content: [{ type: 'text', text: ambientInjector.formatAuditReport(fullReport) }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 10: memory_feedback ─────────────────────────────

server.registerTool(
  'memory_feedback',
  {
    description: 'Submit positive or negative feedback on a memory. Positive boosts importance + recall; negative decays importance and archives if below threshold.',
    inputSchema: {
      memory_id: z.number().int().positive().describe('Memory ID to provide feedback on'),
      signal: z.enum(['positive', 'negative']).describe('Feedback signal'),
    },
  },
  async ({ memory_id, signal }) => {
    try {
      const result = ambientInjector.processMemoryFeedback(memory_id, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 11: memory_reasoning_recall ──────────────────────

server.registerTool(
  'memory_reasoning_recall',
  {
    description: 'Retrieve reasoning memories (strategies, failures, learnings) relevant to the current task. Returns success/failure/consolidated breakdown.',
    inputSchema: {
      entity: z.string().optional().describe('Filter by entity name'),
      task_type: z.string().optional().describe('Filter by task type (e.g., debugging, refactoring, deployment)'),
      limit: z.number().optional().default(5).describe('Max memories per outcome category'),
    },
  },
  async ({ entity, task_type, limit = 5 }) => {
    try {
      const description = [entity, task_type].filter(Boolean).join(' ') || 'general';
      const recalled = await strategyDistiller.reasoningRecall(description, { limit, task_type });
      const formatted = strategyDistiller.formatReasoningContext(recalled);
      return { content: [{ type: 'text', text: formatted }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 12: memory_compaction_review ─────────────────────

server.registerTool(
  'memory_compaction_review',
  {
    description: 'Agent-assisted dedup review: check status, list candidates, review staged compactions, apply or discard merges.',
    inputSchema: {
      action: z.enum(['status', 'candidates', 'review', 'apply', 'discard']).describe('Compaction action to perform'),
      data: z.object({}).optional().describe('Action-specific data: { candidate_id, suggested_summary, limit }'),
    },
  },
  async ({ action, data = {} }) => {
    try {
      const compactionDeps = { storeMemory, updateMemoryStatus };
      const result = compactionCoordinator.compactionDispatch(db, action, data, compactionDeps);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 13: memory_nl_query ──────────────────────────────

server.registerTool(
  'memory_nl_query',
  {
    description: 'Natural language SQL query via Brain 2 — ask questions about memories in plain English, get structured results.',
    inputSchema: {
      query: z.string().describe('Natural language question about memories'),
    },
  },
  async ({ query }) => {
    try {
      const result = await declarativeGateway.nlQuery(query);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 14: memory_diagnostic_explain ────────────────────

server.registerTool(
  'memory_diagnostic_explain',
  {
    description: 'Explain a diagnostic code (e.g., STORE_001, EDGE_002) with description, severity, and remediation steps.',
    inputSchema: {
      code: z.string().describe('Diagnostic code like STORE_001'),
    },
  },
  async ({ code }) => {
    try {
      const explanation = diagnosticCompiler.explainDiagnostic(code);
      if (!explanation) {
        return { content: [{ type: 'text', text: `No diagnostic found for code: ${code}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(explanation, null, 2) }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 15: memory_retrieve_original ─────────────────────

server.registerTool(
  'memory_retrieve_original',
  {
    description: 'Retrieve original content from a CCR [ref:hash] marker in compressed text. Returns the full uncompressed text.',
    inputSchema: {
      hash: z.string().describe('24-hex CCR hash from compressed text'),
    },
  },
  async ({ hash }) => {
    try {
      const original = contextCompressor.retrieveCCROriginal(db, hash);
      if (!original) {
        return { content: [{ type: 'text', text: `No original content found for hash: ${hash}. Ensure the hash is a valid 24-character hex string.` }] };
      }
      return { content: [{ type: 'text', text: original }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Tool 16: ambient_context ──────────────────────────────

server.registerTool(
  'ambient_context',
  {
    description: 'Get ambient context for tools/list injection — ranked, compressed memory summaries within a token budget.',
    inputSchema: {
      token_budget: z.number().optional().default(4500).describe('Token budget for the ambient context output'),
    },
  },
  async ({ token_budget = 4500 }) => {
    try {
      const injection = ambientInjector.buildAmbientInjection(false);
      const text = typeof injection === 'string' ? injection : JSON.stringify(injection);
      // Rough token-aware truncation (~4 chars per token)
      const maxChars = token_budget * 4;
      const trimmed = text.length > maxChars ? text.slice(0, maxChars) + '\n[truncated]' : text;
      return { content: [{ type: 'text', text: trimmed }] };
    } catch (err) {
      console.error('[MCP] Tool error:', err); return { content: [{ type: 'text', text: 'Internal error processing request' }], isError: true };
    }
  }
);

// ── Start ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (LOG_DEBUG) console.error('[MCP] Hermes Memory MCP server connected via stdio');
}

main().catch(err => {
  console.error('[MCP] Fatal:', err.message);
  process.exit(1);
});
