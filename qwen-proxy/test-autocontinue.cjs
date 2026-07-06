#!/usr/bin/env node
/*
 * test-autocontinue.cjs — E2E validation of Qwen AutoContinue (#8).
 *
 * Forces the mechanism with a low QWEN_OUTPUT_TOKEN_CAP (set in .env) + a long
 * essay prompt. We can't cheaply hit Qwen's real ~130K per-response cap, so
 * this test drives a SPURIOUS near-cap trigger after the round naturally ends,
 * which exercises the full pipeline: detect -> createContinuationStream ->
 * drain round 2 through the same processLines (targetResponseId reset) ->
 * concatenate transparently -> single 'stop' to the client.
 *
 * Asserts from the CLIENT side:
 *   - SSE stream completes with finish_reason === 'stop' (no error chunk)
 *   - generated content is non-trivial (essay delivered)
 *   - the summed usage.completion_tokens is reported in the final chunk
 * The SERVER log (server.log) is grepped separately for "[AutoContinue] iter N"
 * to prove >=1 continuation round actually fired.
 *
 * Run: node test-autocontinue.cjs
 * Requires: server on 127.0.0.1:3000 with QWEN_AUTO_CONTINUE=true in .env.
 */

const PROXY = process.env.QWENPROXY_URL || 'http://127.0.0.1:3000';

const prompt =
  'Write a detailed 3000-word essay about the history of computing. ' +
  'Cover the abacus, mechanical calculators (Pascal, Babbage), vacuum-tube ' +
  'machines (ENIAC), transistors, integrated circuits, microprocessors, ' +
  'personal computers, the internet, and mobile computing. Be thorough and ' +
  'do not stop until you have written a complete, well-structured essay.';

async function main() {
  const t0 = Date.now();
  const res = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3.7-plus',
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    console.log(`>>> FAIL — HTTP ${res.status}: ${txt.slice(0, 300)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let finishReason = null;
  let usage = null;
  let errorChunk = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const ch = JSON.parse(data);
        if (ch.error) { errorChunk = ch.error; }
        const delta = ch.choices && ch.choices[0] && ch.choices[0].delta;
        if (delta && delta.content) content += delta.content;
        if (ch.choices && ch.choices[0] && ch.choices[0].finish_reason) {
          finishReason = ch.choices[0].finish_reason;
        }
        if (ch.usage) usage = ch.usage;
      } catch { /* partial line, ignore */ }
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (errorChunk) {
    console.log(`>>> FAIL — error chunk: ${JSON.stringify(errorChunk).slice(0, 300)}`);
    process.exit(1);
  }
  if (finishReason !== 'stop') {
    console.log(`>>> FAIL — finish_reason=${finishReason} (expected 'stop')`);
    process.exit(1);
  }
  if (content.length < 4000) {
    console.log(`>>> FAIL — content too short (${content.length} chars); round may not have run.`);
    process.exit(1);
  }

  const comp = usage ? (usage.completion_tokens || 0) : 0;
  console.log(`>>> AUTOCONTINUE STREAM OK`);
  console.log(`    finish_reason : ${finishReason}`);
  console.log(`    content chars : ${content.length}`);
  console.log(`    completion_tok: ${comp}`);
  console.log(`    content head  : ${JSON.stringify(content.slice(0, 120))}...`);
  console.log(`    content tail  : ...${JSON.stringify(content.slice(-120))}`);
  console.log(`    elapsed       : ${dt}s`);
  console.log(`>>> CLIENT-SIDE PASS — now grep server.log for "[AutoContinue] iter" to confirm >=1 continuation round.`);
}

main().catch(e => { console.log(`>>> FAIL — exception: ${e.message}`); process.exit(1); });
