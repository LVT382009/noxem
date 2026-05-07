#!/usr/bin/env node
// Hermes Shell Hook: pre_llm_call
// Injects relevant memories into the LLM context before each turn.

const MEMORY_SERVER = process.env.MEMORY_SERVER || 'http://127.0.0.1:3001';
const MAX_RESULTS = parseInt(process.env.MEMORY_MAX_RESULTS, 10) || 5;

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
  const sessionId = extra.session_id || input.session_id || '';

  if (!userMessage.trim()) {
    process.stdout.write('{}');
    return;
  }

  try {
    const url = `${MEMORY_SERVER}/memory/search?q=${encodeURIComponent(userMessage.trim().substring(0, 500))}&limit=${MAX_RESULTS}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      process.stdout.write('{}');
      return;
    }

    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      process.stdout.write('{}');
      return;
    }

    // Format memories as context block
    const lines = results.map((m, i) =>
      `[${i + 1}] (${m.type}) ${m.text}`
    );

    const context = `[Memory Recall]\n${lines.join('\n')}`;

    process.stdout.write(JSON.stringify({ context }));
  } catch {
    // Silently fail — memory is additive
    process.stdout.write('{}');
  }
}

main();
