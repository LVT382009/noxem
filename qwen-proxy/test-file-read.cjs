// End-to-end: pass a local file INLINE as a data: URI in /v1/chat/completions,
// verify the Qwen model actually reads it. This is the "upload file for AI to
// understand" path — processImagesForQwen decodes the data URI, uploads to Qwen
// OSS, and attaches the file ref to the chat payload (files: [...]).
const fs = require('fs')

const filePath = process.argv[2] || 'test-upload.txt'
const buf = fs.readFileSync(filePath)
const b64 = buf.toString('base64')
const mime = 'text/plain'
const dataUri = `data:${mime};base64,${b64}`
const expectedMarker = String(buf.toString('utf8').split('\n')[0]).trim() // first line = secret marker
console.log(`file=${filePath} bytes=${buf.length} dataUriLen=${dataUri.length} marker="${expectedMarker}"`)

const body = JSON.stringify({
  model: 'qwen3.7-plus',
  stream: false,
  messages: [{
    role: 'user',
    content: [
      { type: 'file_url', file_url: { url: dataUri } },
      { type: 'text', text: 'Read the attached file. Quote its exact first line verbatim, then summarize its contents in one sentence.' },
    ],
  }],
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
    console.log('content:', JSON.stringify(c).slice(0, 700))
    console.log('completion_tokens:', j.usage?.completion_tokens)
    console.log(c && c.includes(expectedMarker) ? '>>> FILE READ BY AI — PASS' : '>>> file marker missing in answer')
  } else {
    console.log('raw', t.slice(0, 500))
  }
}).catch(e => console.log('err', e.message))
