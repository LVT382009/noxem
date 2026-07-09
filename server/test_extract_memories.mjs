// test_extract_memories.mjs — regression for the "extractMemories returns undefined on []" bug
// (audit-trail find). The /memory/extract handler crashed (TypeError -> HTTP 500) when the LLM
// returned "[]" — extractMemories fell through to an implicit `return undefined` because the
// early-out only fired when the array was NON-empty (`length > 0`). Now the inner try always
// resolves to an Array: non-array -> [], empty -> [], unparseable -> [] (catch), valid ->
// filtered/mapped memories.
//
// This is the ownership rule in action: every fix ships a permanent regression test. No db, no
// native deps — a mock LLM stands up inline so it runs anywhere node runs.
//
// Run: ENABLE_EMBEDDING=false node test_extract_memories.mjs
import http from 'node:http';
import { extractMemories } from './memory-extract.mjs';

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// Round-robin mock: each request pulls the next raw `content` string.
const RAW_RESPONSES = [
  '[]',                                                        // case 0: empty array (the bug)
  '[{"text":"User prefers dark mode","type":"preference"}]',  // case 1: one valid memory
  'no json here at all',                                       // case 2: unparseable -> extractBalancedArray null -> []
  '[{"text":"orphan text"}]',                                  // case 3: missing type -> filtered out -> []
];
let cursor = 0;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const content = RAW_RESPONSES[cursor++ % RAW_RESPONSES.length];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

await new Promise((resolve, reject) => {
  server.on('error', reject);
  server.listen(0, '127.0.0.1', resolve);
}).catch(e => { console.error('mock server failed:', e.message); process.exit(2); });
const port = server.address().port;
const url = `http://127.0.0.1:${port}/v1/chat/completions`;
const opts = () => ({ userMessage: 'hello there', assistantResponse: 'hi back', llmUrl: url, llmModel: 'test' });

console.log('── Bug 3 regression: extractMemories must return an Array, never undefined ──');

// case 0 — empty array: THE regression. Must be [] not undefined, and .length must not throw.
const r0 = await extractMemories(opts());
check('empty-array returns Array (not undefined)', Array.isArray(r0), `got ${typeof r0}`);
check('empty-array length === 0', Array.isArray(r0) && r0.length === 0, `len=${r0?.length}`);

// case 1 — one valid memory: filtered + mapped to {text, type}.
const r1 = await extractMemories(opts());
check('valid-memory returns Array', Array.isArray(r1));
check('valid-memory length === 1', Array.isArray(r1) && r1.length === 1, `len=${r1?.length}`);
check('valid-memory text preserved', r1?.[0]?.text === 'User prefers dark mode', `text=${r1?.[0]?.text}`);
check('valid-memory type preserved', r1?.[0]?.type === 'preference', `type=${r1?.[0]?.type}`);

// case 2 — unparseable: extractBalancedArray -> null -> [].
const r2 = await extractMemories(opts());
check('unparseable returns Array (not undefined)', Array.isArray(r2), `got ${typeof r2}`);
check('unparseable length === 0', Array.isArray(r2) && r2.length === 0, `len=${r2?.length}`);

// case 3 — missing type: filter drops it -> [].
const r3 = await extractMemories(opts());
check('missing-type returns Array', Array.isArray(r3), `got ${typeof r3}`);
check('missing-type filtered to length 0', Array.isArray(r3) && r3.length === 0, `len=${r3?.length}`);

console.log(`\n═══ extractMemories regression: ${PASS} pass, ${FAIL} fail ═══`);

// Drain cleanly so a hard process.exit doesn't race a libuv `UV_HANDLE_CLOSING` assertion
// against the keep-alive sockets Node's global fetch leaves open. Close connections, close the
// server, set the exit code, and let the event loop wind down on its own (no process.exit).
if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
server.unref();
await new Promise(r => server.close(r));
process.exitCode = FAIL > 0 ? 1 : 0;
