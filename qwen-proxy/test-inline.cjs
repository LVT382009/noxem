// Decisive diagnostic: inject file text DIRECTLY into user content string
// (no file_url part, no OSS upload). Bypasses the file machinery entirely.
// If model quotes ZEBRA-MANGO-7777 -> prompt/stream path is CLEAN, file_url path is the bug.
// If model quotes CDP garbage -> prompt/stream path itself is corrupted.
const fs = require('fs')
const filePath = process.argv[2] || 'test-unique.txt'
const fileText = fs.readFileSync(filePath, 'utf8')
const inline =
  `You will be tested. Here are the FULL EXACT CONTENTS of a file, delimited by <<< and >>>:\n<<<\n${fileText}\n>>>\n` +
  `What is the first line of the file between the delimiters? Quote it verbatim only, nothing else.`

const body = JSON.stringify({
  model: process.env.QP_MODEL || 'qwen3.7-plus',
  stream: false,
  messages: [{ role: 'user', content: inline }],
})

const t0 = Date.now()
fetch('http://127.0.0.1:3000/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
}).then(async r => {
  const t = await r.text()
  console.log('status', r.status, `(${Date.now() - t0}ms)`)
  let j; try { j = JSON.parse(t) } catch (_) {}
  if (j) {
    const c = j.choices?.[0]?.message?.content || ''
    console.log('content:', JSON.stringify(c).slice(0, 500))
    console.log('completion_tokens:', j.usage?.completion_tokens)
    console.log(/ZEBRA-MANGO-7777/.test(c) ? '>>> INLINE TEXT READ BY AI — prompt path CLEAN' : '>>> marker MISSING')
  } else {
    console.log('raw', t.slice(0, 500))
  }
}).catch(e => console.log('err', e.message))
