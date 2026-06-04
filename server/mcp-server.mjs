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

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ── Initialize DB + embeddings ──────────────────────────

await initVectorIndex(db);
const embeddingReady = await initEmbeddingEngine();
if (LOG_DEBUG) console.error(`[MCP] Embedding: ${embeddingReady ? 'ready' : 'not available'}, Vector: ${isVecReady()}`);

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
