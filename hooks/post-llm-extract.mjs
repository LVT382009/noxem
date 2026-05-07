#!/usr/bin/env node
// Hermes Shell Hook: post_llm_call
// Syncs conversation turns to memory server after each response.

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
  const userMessage = (extra.user_message || '').substring(0, 2000);
  const assistantResponse = (extra.assistant_response || '').substring(0, 4000);
  const sessionId = extra.session_id || input.session_id || '';

  if (!userMessage.trim() && !assistantResponse.trim()) {
    process.stdout.write('{}');
    return;
  }

  try {
    const res = await fetch(`${MEMORY_SERVER}/memory/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_message: userMessage,
        assistant_response: assistantResponse,
        session_id: sessionId,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      process.stderr.write(`post-llm-extract error: ${res.status}\n`);
    }

    process.stdout.write('{}');
  } catch (err) {
    process.stderr.write(`post-llm-extract error: ${err.message}\n`);
    process.stdout.write('{}');
  }
}

main();
