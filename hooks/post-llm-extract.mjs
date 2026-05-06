#!/usr/bin/env node
// Hermes Shell Hook: post_llm_call
// Extracts memories from conversation turns after each response.

const MEMORY_SERVER = process.env.MEMORY_SERVER || 'http://127.0.0.1:3001';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(chunks.join(''));

  const extra = input.extra || {};
  const userMessage = (extra.user_message || '').substring(0, 2000);
  const assistantResponse = (extra.assistant_response || '').substring(0, 4000);
  const sessionId = extra.session_id || input.session_id || '';

  if (!userMessage.trim() && !assistantResponse.trim()) {
    process.stdout.write('{}');
    return;
  }

  try {
    const res = await fetch(`${MEMORY_SERVER}/memory/extract`, {
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
      process.stdout.write('{}');
      return;
    }

    const data = await res.json();
    if (data.memories && data.memories.length > 0) {
      process.stderr.write(`Extracted ${data.memories.length} memories\n`);
    }

    process.stdout.write('{}');
  } catch (err) {
    process.stderr.write(`post-llm-extract error: ${err.message}\n`);
    process.stdout.write('{}');
  }
}

main();