// Live test for pedrofariasx/qwenproxy — localhost, no auth (API_KEY empty in .env).
// Lists /v1/models, POSTs /v1/chat/completions (non-stream), checks tokens/content.
const BASE = process.env.QP_BASE || 'http://127.0.0.1:3000'

async function main() {
  console.log('=== GET /v1/models ===')
  let modelList = []
  try {
    const r = await fetch(`${BASE}/v1/models`)
    const j = await r.json()
    console.log('status', r.status)
    const data = j.data || j.models || j
    if (Array.isArray(data)) {
      modelList = data.map(m => m.id || m.name || m).filter(Boolean)
      console.log('models:', modelList.slice(0, 20).join(', '), modelList.length > 20 ? `... (+${modelList.length - 20})` : '')
    } else {
      console.log('models payload:', JSON.stringify(j).slice(0, 400))
    }
  } catch (e) {
    console.log('models fetch error:', e.message)
  }

  const model = process.env.QP_MODEL || modelList[0] || 'qwen3-max'
  console.log('\n=== POST /v1/chat/completions (model=' + model + ', non-stream) ===')
  try {
    const t0 = Date.now()
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: WAF-BYPASS-OK. Then one short sentence.' }],
        stream: false,
      }),
    })
    const txt = await r.text()
    console.log('status', r.status, `(${Date.now() - t0}ms)`)
    console.log('raw (first 600):', txt.slice(0, 600))
    let j
    try { j = JSON.parse(txt) } catch (_) {}
    if (j) {
      const content = j.choices?.[0]?.message?.content || ''
      const tokens = j.usage?.completion_tokens
      console.log('\n=== VERDICT ===')
      console.log('content:', JSON.stringify(content).slice(0, 300))
      console.log('completion_tokens:', tokens)
      console.log('usage:', JSON.stringify(j.usage))
      const ok = (tokens && tokens > 0) || content.length > 0
      console.log(ok ? '>>> PASS — proxy working, WAF bypassed.' : '>>> BLOCKED/EMPTY — no completion tokens.')
    }
  } catch (e) {
    console.log('completions fetch error:', e.message)
  }
}
main().catch(e => { console.error('fatal', e); process.exit(1) })
