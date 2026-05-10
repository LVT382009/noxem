#!/usr/bin/env node
// Hermes Shell Hook: pre_llm_call
// Injects relevant memories into the LLM context before each turn.
// Phase 1: Enhanced with entity expansion, session warm-up, association prefetch.

const MEMORY_SERVER = process.env.MEMORY_SERVER || 'http://127.0.0.1:3001';
const MAX_RESULTS = parseInt(process.env.MEMORY_MAX_RESULTS, 10) || 5;
const MAX_MEMORY_TOKENS = parseInt(process.env.MEMORY_MAX_TOKENS, 10) || 2000;
const SESSION_ID = process.env.HERMES_SESSION_ID || '';

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return res.json();
}

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(chunks.join(''));
  } catch {
    process.stdout.write('{}');
    return;
  }

  const extra = input.extra || {};
  const userMessage = extra.user_message || '';
  const sessionId = extra.session_id || input.session_id || SESSION_ID;

  if (!userMessage.trim()) {
    process.stdout.write('{}');
    return;
  }

  try {
    // 1. Core memory blocks (always in context, zero-latency)
    let coreLines = [];
    try {
      const coreData = await fetchJSON(MEMORY_SERVER + '/memory/core');
      if (coreData?.blocks?.length) {
        coreLines = coreData.blocks.map(b => '[core:' + b.key + '] ' + b.value);
      }
    } catch {}

    // 2. Primary search — hybrid search for the user message
    const searchUrl = MEMORY_SERVER + '/memory/search?q=' +
      encodeURIComponent(userMessage.trim().substring(0, 500)) +
      '&limit=' + MAX_RESULTS + '&method=hybrid';
    const searchData = await fetchJSON(searchUrl);
    const results = searchData?.results || [];
    const searchedIds = new Set(results.map(r => r.id));

    // 3. Entity expansion — if search results have entities, fetch related memories
    let entityLines = [];
    const entities = [...new Set(results.filter(r => r.entity).map(r => r.entity))];
    if (entities.length > 0) {
      try {
        for (const entity of entities.slice(0, 3)) {
          const entityUrl = MEMORY_SERVER + '/memory/type/entity?limit=3';
          const entityData = await fetchJSON(entityUrl);
          if (entityData?.results) {
            for (const m of entityData.results) {
              if (!searchedIds.has(m.id)) {
                entityLines.push('(' + m.type + ') ' + m.text);
                searchedIds.add(m.id);
              }
            }
          }
        }
      } catch {}
    }

    // 4. Graph neighbor expansion — for top result, get related memories via edges
    let graphLines = [];
    if (results.length > 0 && results[0].id) {
      try {
        const graphUrl = MEMORY_SERVER + '/memory/graph/neighbors/' + results[0].id;
        const graphData = await fetchJSON(graphUrl);
        if (graphData?.outgoing?.length) {
          for (const edge of graphData.outgoing.slice(0, 3)) {
            if (edge.to_id && !searchedIds.has(edge.to_id)) {
              const memUrl = MEMORY_SERVER + '/memory/' + edge.to_id;
              const memData = await fetchJSON(memUrl);
              if (memData?.text) {
                graphLines.push('(' + edge.relation + '→' + memData.type + ') ' + memData.text);
                searchedIds.add(edge.to_id);
              }
            }
          }
        }
      } catch {}
    }

    // 5. Release endpoint — curated context (includes core blocks automatically)
    let releaseLines = [];
    try {
      const releaseUrl = MEMORY_SERVER + '/memory/release?tokens=' + MAX_MEMORY_TOKENS;
      const releaseData = await fetchJSON(releaseUrl);
      if (releaseData?.text) {
        releaseLines = releaseData.text.split('\n').filter(l => l.trim());
      }
    } catch {}

    // Combine: core + search + entity + graph, within token budget
    // Prefer the release endpoint (already deduplicated + scored) as the main content
    const maxChars = MAX_MEMORY_TOKENS * 4;
    const allLines = releaseLines.length > 0
      ? releaseLines
      : [...coreLines, ...results.map((r, i) => '[' + (i+1) + '] (' + r.type + ') ' + r.text), ...entityLines, ...graphLines];

    let usedChars = 0;
    const finalLines = [];
    for (const line of allLines) {
      if (usedChars + line.length + 1 > maxChars) break;
      finalLines.push(line);
      usedChars += line.length + 1;
    }

    if (finalLines.length === 0) {
      process.stdout.write('{}');
      return;
    }

    const context = '[Memory Recall]\n' + finalLines.join('\n');
    process.stdout.write(JSON.stringify({ context }));
  } catch {
    process.stdout.write('{}');
  }
}

main();
