// Reproduction/verification test for QwenProxy streaming sieve:
//  - inter-word spaces preserved (was the missing-space bug)
//  - [Tool Result] blocks stripped even when split across chunks (was the leak)
// Run: node test-sieve-repro.js  (from qwen-proxy/ dir)
const { createSieve } = require('./src/utils/toolcall.js')

function feed(chunks) {
  const sieve = createSieve()
  let out = ''
  const toolDeltas = []
  for (const c of chunks) {
    const r = sieve.push(c)
    if (r.textDelta) out += r.textDelta
    if (r.toolCallsDelta) toolDeltas.push(...r.toolCallsDelta)
  }
  const f = sieve.flush()
  if (f.textDelta) out += f.textDelta
  if (f.toolCallsDelta) toolDeltas.push(...f.toolCallsDelta)
  return { out, toolDeltas }
}

function run(name, chunks, expectContains, expectNotContains) {
  const { out } = feed(chunks)
  let ok = true
  const fails = []
  for (const s of expectContains) if (!out.includes(s)) { ok = false; fails.push(`MISSING: ${JSON.stringify(s)}`) }
  for (const s of expectNotContains) if (out.includes(s)) { ok = false; fails.push(`LEAKED: ${JSON.stringify(s)}`) }
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}\n  out=${JSON.stringify(out)}`)
  for (const m of fails) console.log(`  -> ${m}`)
  return ok
}

let allPass = true

// 1. spaces preserved across chunk boundary
allPass &= run('spaces preserved across boundary',
  ['Let me', ' systematically test'],
  ['Let me systematically test'], [])

// 2. full block in one chunk
allPass &= run('full block one chunk stripped',
  ['hello [Tool Result]junk[/Tool Result] world'],
  ['hello', 'world'], ['[Tool Result', '[/Tool Result]', 'junk'])

// 3. block split open...close across chunks
allPass &= run('block split across chunks',
  ['hello [Tool Result', ']junk[/Tool Result] world'],
  ['hello', 'world'], ['[Tool Result', '[/Tool Result]', 'junk'])

// 4. tool call emitted, surrounding text intact
allPass &= run('tool call parsed',
  ['before <tool>{"id":"x","function":{"name":"get_weather","arguments":"{}"}}</tool> after'],
  ['before', 'after'], ['<tool>', '"get_weather"'])

// 5. block with attributes, split across many chunks
allPass &= run('attr block split many chunks',
  ['a [Tool Result', ' tool_call_id="1"', ' name="reader">]', '\nline\n', 'more', '[/Tool Result] b'],
  ['a', 'b', 'line', 'more'].filter(x => x !== 'line' && x !== 'more'),
  // NOTE: content inside block (line/more) must be DISCARDED, not kept.
  ['[Tool Result', '[/Tool Result]', 'reader', 'line', 'more'])

// 6. consecutive blocks
allPass &= run('consecutive blocks',
  ['x [Tool Result]a[/Tool Result] y [Tool Result]b[/Tool Result] z'],
  ['x', 'y', 'z'], ['[Tool Result', '[/Tool Result]', '"a"', '"b"'])

// 7. partial opener split mid-marker then completed
allPass &= run('partial opener completed next chunk',
  ['text [Tool Res', 'ult]secret[/Tool Result] tail'],
  ['text', 'tail'], ['[Tool Result', 'secret', '[/Tool Result'])

// 8. never-closed block -> discarded at flush, pre-block text kept
allPass &= run('never-closed block discarded',
  ['kept [Tool Result] abandoned'],
  ['kept'], ['[Tool Result', 'abandoned'])

// 9. false-positive check: a stray "[" should NOT be held back / mangled
allPass &= run('harmless bracket preserved',
  ['see [1, 2, 3] list here'],
  ['see [1, 2, 3] list here'], [])

// 10. real-world: tool call then a result block interleaved
allPass &= run('tool call then tool-result echo',
  ['Sure <tool>{"id":"1","function":{"name":"f","arguments":"{}"}}</tool>\n[Tool Result', ']result-data[/Tool Result]\nDone'],
  ['Sure', 'Done'], ['<tool>', '"name":"f"', '[Tool Result', 'result-data', '[/Tool Result'])

console.log(`\n=== ${allPass ? 'ALL PASS' : 'SOME FAILED'} ===`)
process.exit(allPass ? 0 : 1)
