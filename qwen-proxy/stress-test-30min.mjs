#!/usr/bin/env node
/**
 * Qwen-Proxy 30-minute endurance test
 * Simulates realistic Claude Code usage: multi-turn tool sessions,
 * context buildup, and periodic context-loss probing.
 *
 * Tracks: success rate, tool-call accuracy, context retention, errors.
 * Logs everything to D:/Qwen-Proxy/stress-test-log.jsonl
 */
const API = 'http://localhost:3000/v1/messages'
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': 'test',
  'anthropic-version': '2023-06-01'
}

const DURATION_MS = 30 * 60 * 1000  // 30 minutes
const LOG_FILE = 'D:/Qwen-Proxy/stress-test-log.jsonl'
const REPORT_FILE = 'D:/Qwen-Proxy/stress-test-report.txt'

// Realistic Claude Code tool set
const tools = [
  { name: 'Bash', description: 'Execute a bash command', input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a file from disk', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Edit', description: 'Edit a file by replacing old_string with new_string', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Write', description: 'Write content to a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Grep', description: 'Search file contents with regex', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Glob', description: 'Find files matching a glob pattern', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
]

// Task scenarios — rotated to simulate varied Claude Code sessions
const TASKS = [
  {
    name: 'explore-project',
    prompt: 'Explore the Qwen-Proxy project. Start by finding all .js files with Glob, then read package.json.',
    expectTool: ['Glob', 'Read', 'Bash'],
  },
  {
    name: 'fix-bug',
    prompt: 'I need to find where MAX_CHARS is defined. Use Grep to search for it in D:/Qwen-Proxy/src/',
    expectTool: ['Grep'],
  },
  {
    name: 'read-file',
    prompt: 'Read the file D:/Qwen-Proxy/src/utils/toolcall.js and tell me what TOOL_TAG_OPEN is set to.',
    expectTool: ['Read'],
  },
  {
    name: 'syntax-check',
    prompt: 'Run a syntax check on D:/Qwen-Proxy/src/routes/anthropic.js using Bash with node -c',
    expectTool: ['Bash'],
  },
  {
    name: 'multi-tool',
    prompt: 'Do three things: (1) Glob for **/*.js in D:/Qwen-Proxy/src, (2) Grep for "function " in that dir, (3) Read D:/Qwen-Proxy/package.json',
    expectTool: ['Glob', 'Grep', 'Read'],
  },
  {
    name: 'context-probe',
    // This one tests context retention — we inject a "fact" and later ask about it
    prompt: null, // Dynamically set
    expectTool: [],
  },
]

// ---- State ----
let toolUseCounter = 0
function makeToolUseId() { return `toolu_stress_${++toolUseCounter}` }

let stats = {
  startTime: Date.now(),
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  toolCallRequests: 0,
  toolCallSuccess: 0,
  toolCallFailed: 0,
  contextProbes: 0,
  contextRetained: 0,
  contextLost: 0,
  errors: [],
  latencies: [],
  minutes: {},  // per-minute stats
}

// Conversation history — simulates a real session building up
let conversationMessages = []
let injectedFacts = []  // { turn, fact }
let turnNumber = 0

// ---- Logging ----
const fs = await import('fs')
function log(entry) {
  fs.default.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}

function minuteKey(ts) {
  const d = new Date(ts)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---- API calls ----
async function callAPI(messages, stream = false) {
  const start = Date.now()
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        stream,
        tools,
        messages,
      }),
      signal: AbortSignal.timeout(180000), // 3 min timeout
    })
    const latency = Date.now() - start
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: errText, latency }
    }

    if (stream) {
      // Read the full stream as text, parse final message
      const text = await res.text()
      // Extract the complete message from SSE events
      const blocks = []
      let currentToolId = null
      let currentToolName = null
      let currentToolInput = ''
      let currentText = ''
      let stopReason = null

      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const evt = JSON.parse(line.slice(6))
          if (evt.type === 'content_block_start') {
            const block = evt.content_block
            if (block.type === 'tool_use') {
              currentToolId = block.id
              currentToolName = block.name
              currentToolInput = ''
            } else if (block.type === 'text') {
              currentText = ''
            }
          } else if (evt.type === 'content_block_delta') {
            const delta = evt.delta
            if (delta.type === 'input_json_delta') {
              currentToolInput += delta.partial_json
            } else if (delta.type === 'text_delta') {
              currentText += delta.text
            }
          } else if (evt.type === 'content_block_stop') {
            if (currentToolId) {
              let parsedInput = {}
              try { parsedInput = JSON.parse(currentToolInput) } catch {}
              blocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: parsedInput })
              currentToolId = null
              currentToolName = null
              currentToolInput = ''
            } else if (currentText) {
              blocks.push({ type: 'text', text: currentText })
              currentText = ''
            }
          } else if (evt.type === 'message_delta') {
            stopReason = evt.delta?.stop_reason
          }
        } catch {}
      }

      return {
        ok: true,
        latency,
        stopReason,
        content: blocks,
        stream: true,
      }
    } else {
      const data = await res.json()
      return { ok: true, latency, ...data }
    }
  } catch (err) {
    const latency = Date.now() - start
    return { ok: false, error: err.message, latency }
  }
}

// ---- Turn logic ----
async function runTurn(taskDef, useStream = true) {
  turnNumber++
  const turnStart = Date.now()
  const minKey = minuteKey(turnStart)
  if (!stats.minutes[minKey]) {
    stats.minutes[minKey] = { requests: 0, success: 0, failed: 0, toolCalls: 0, toolSuccess: 0, errors: [] }
  }
  const minStat = stats.minutes[minKey]

  stats.totalRequests++
  minStat.requests++

  let userPrompt = taskDef.prompt

  // Handle context-probe tasks
  if (taskDef.name === 'context-probe') {
    if (injectedFacts.length === 0) {
      // Inject a fact first
      const fact = `SECRET_${turnNumber}: The hidden value is ${Math.floor(Math.random() * 9000 + 1000)}`
      injectedFacts.push({ turn: turnNumber, fact })
      userPrompt = `Remember this for later: "${fact}". Acknowledge you have stored it.`
      taskDef = { ...taskDef, expectTool: [] }
    } else {
      // Ask about the oldest fact
      const oldFact = injectedFacts[0]
      userPrompt = `What was the secret I told you at turn ${oldFact.turn}? Reply with the exact value.`
    }
  }

  // Add user message to conversation
  conversationMessages.push({ role: 'user', content: userPrompt })

  log({
    ts: new Date().toISOString(),
    turn: turnNumber,
    phase: 'request',
    task: taskDef.name,
    msgCount: conversationMessages.length,
    promptLen: userPrompt.length,
    historySize: JSON.stringify(conversationMessages).length,
  })

  const result = await callAPI(conversationMessages, useStream)
  stats.latencies.push(result.latency)

  if (!result.ok) {
    stats.failedRequests++
    minStat.failed++
    minStat.errors.push(result.error?.slice(0, 200))
    stats.errors.push({
      turn: turnNumber,
      ts: new Date().toISOString(),
      error: (result.error || '').slice(0, 500),
      status: result.status,
      latency: result.latency,
    })
    log({
      ts: new Date().toISOString(),
      turn: turnNumber,
      phase: 'error',
      error: result.error?.slice(0, 500),
      status: result.status,
      latency: result.latency,
    })
    // Remove last user message on error so conversation doesn't break
    conversationMessages.pop()
    return false
  }

  stats.successRequests++
  minStat.success++

  // Parse response and add to conversation
  let assistantContent = result.content || []
  let stopReason = result.stopReason || result.stop_reason
  let responseText = ''

  // Extract tool calls and text from response
  const toolCalls = assistantContent.filter(b => b.type === 'tool_use')
  const textBlocks = assistantContent.filter(b => b.type === 'text')
  responseText = textBlocks.map(b => b.text || '').join('\n')

  // Add assistant response to conversation
  if (assistantContent.length > 0) {
    conversationMessages.push({ role: 'assistant', content: assistantContent })
  }

  // If tool calls, simulate tool results and add them
  if (toolCalls.length > 0) {
    stats.toolCallRequests++
    minStat.toolCalls++

    const toolResults = []
    for (const tc of toolCalls) {
      const expected = taskDef.expectTool || []
      const toolOk = expected.length === 0 || expected.includes(tc.name)
      if (toolOk) {
        stats.toolCallSuccess++
        minStat.toolSuccess++
      } else {
        stats.toolCallFailed++
      }

      // Simulate tool result
      let resultContent = 'OK'
      if (tc.name === 'Read') resultContent = `// File content of ${tc.input?.file_path || 'unknown'}\nconst version = "1.1.2";\n// ... file content ...`
      else if (tc.name === 'Grep') resultContent = `D:\\Qwen-Proxy\\src\\routes\\anthropic.js:145:const MAX_CHARS = 40000\nD:\\Qwen-Proxy\\src\\utils\\toolcall.js:18:const TOOL_TAG_OPEN = "##TOOL_CALL##"`
      else if (tc.name === 'Glob') resultContent = 'src/index.js\nsrc/routes/anthropic.js\nsrc/utils/toolcall.js\nsrc/utils/accumulate.js'
      else if (tc.name === 'Bash') resultContent = 'Syntax OK'
      else if (tc.name === 'Edit') resultContent = 'File edited successfully'
      else if (tc.name === 'Write') resultContent = 'File written successfully'
      else resultContent = `Result of ${tc.name}: OK`

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: resultContent,
      })

      log({
        ts: new Date().toISOString(),
        turn: turnNumber,
        phase: 'tool_call',
        toolName: tc.name,
        toolInput: JSON.stringify(tc.input).slice(0, 200),
        expectedTools: expected,
        matched: toolOk,
        latency: result.latency,
      })
    }

    conversationMessages.push({ role: 'user', content: toolResults })
  }

  // Check context retention for probe tasks
  if (taskDef.name === 'context-probe' && injectedFacts.length > 0 && !userPrompt.includes('Remember this')) {
    stats.contextProbes++
    const oldFact = injectedFacts[0]
    const factValue = oldFact.fact.match(/is (\d+)/)?.[1] || ''
    if (factValue && responseText.includes(factValue)) {
      stats.contextRetained++
      log({ ts: new Date().toISOString(), turn: turnNumber, phase: 'context_retained', fact: oldFact.fact, response: responseText.slice(0, 300) })
    } else {
      stats.contextLost++
      log({ ts: new Date().toISOString(), turn: turnNumber, phase: 'context_lost', fact: oldFact.fact, response: responseText.slice(0, 300) })
    }
  }

  log({
    ts: new Date().toISOString(),
    turn: turnNumber,
    phase: 'response',
    stopReason,
    toolCount: toolCalls.length,
    toolNames: toolCalls.map(t => t.name),
    textLen: responseText.length,
    latency: result.latency,
    msgCount: conversationMessages.length,
    historyKB: (JSON.stringify(conversationMessages).length / 1024).toFixed(1),
  })

  const elapsed = Date.now() - stats.startTime
  const mins = (elapsed / 60000).toFixed(1)
  console.log(`[${mins}m] Turn ${turnNumber}: ${taskDef.name} | ${result.latency}ms | tools: ${toolCalls.map(t => t.name).join(',') || 'none'} | msgs: ${conversationMessages.length} | hist: ${(JSON.stringify(conversationMessages).length / 1024).toFixed(1)}KB | ${result.ok ? 'OK' : 'FAIL'}`)

  return true
}

// ---- Main loop ----
console.log('='.repeat(80))
console.log('Qwen-Proxy 30-Minute Endurance Test')
console.log('='.repeat(80))
console.log(`Start: ${new Date().toISOString()}`)
console.log(`Duration: 30 minutes`)
console.log(`API: ${API}`)
console.log(`Log: ${LOG_FILE}`)
console.log('='.repeat(80))

// Clean previous log
fs.default.writeFileSync(LOG_FILE, '')

// Alternate between streaming and non-streaming
let useStream = true
// Cycle through task types
let taskIdx = 0

const deadline = Date.now() + DURATION_MS

while (Date.now() < deadline) {
  const remaining = Math.max(0, deadline - Date.now())
  const minsLeft = (remaining / 60000).toFixed(1)

  // Pick next task — cycle through, inject context probes every 5th turn
  let task
  if (turnNumber > 0 && turnNumber % 5 === 0 && injectedFacts.length < 6) {
    task = TASKS.find(t => t.name === 'context-probe')
  } else if (turnNumber > 8 && turnNumber % 7 === 0 && injectedFacts.length > 0) {
    // Probe for context retention
    task = TASKS.find(t => t.name === 'context-probe')
  } else {
    task = TASKS[taskIdx % (TASKS.length - 1)]  // Skip context-probe in normal rotation
    taskIdx++
  }

  const ok = await runTurn(task, useStream)
  useStream = !useStream  // Alternate streaming/non-streaming

  // If conversation gets too large (>200KB), trim oldest messages but keep first user msg
  const histSize = JSON.stringify(conversationMessages).length
  if (histSize > 200000) {
    console.log(`  [trim] History ${Math.round(histSize/1024)}KB exceeds 200KB — trimming oldest messages`)
    const firstUser = conversationMessages.findIndex(m => m.role === 'user')
    if (firstUser >= 0 && conversationMessages.length > 10) {
      // Keep first user msg + last 10 message groups
      const first = conversationMessages.slice(0, firstUser + 1)
      const rest = conversationMessages.slice(-10)
      conversationMessages = [...first, ...rest]
    }
  }

  // Wait 5-15 seconds between requests (simulates human thinking time)
  const waitMs = 5000 + Math.floor(Math.random() * 10000)
  const sleepMins = (waitMs / 60000).toFixed(1)
  console.log(`  [sleep] ${sleepMins}m until next turn (${minsLeft}m remaining)`)
  await new Promise(r => setTimeout(r, waitMs))
}

// ---- Final report ----
const elapsed = Date.now() - stats.startTime
const report = []
const p = (s) => report.push(s)

p('='.repeat(80))
p('QWEN-PROXY 30-MINUTE ENDURANCE TEST — FINAL REPORT')
p('='.repeat(80))
p(`Duration: ${(elapsed / 60000).toFixed(1)} minutes`)
p(`Total turns: ${turnNumber}`)
p('')
p('--- SUCCESS RATE ---')
p(`Total requests: ${stats.totalRequests}`)
p(`Success: ${stats.successRequests} (${((stats.successRequests / stats.totalRequests) * 100).toFixed(1)}%)`)
p(`Failed: ${stats.failedRequests} (${((stats.failedRequests / stats.totalRequests) * 100).toFixed(1)}%)`)
p('')
p('--- TOOL CALLING ---')
p(`Requests with tools: ${stats.toolCallRequests}`)
p(`Tool calls correct: ${stats.toolCallSuccess}`)
p(`Tool calls wrong: ${stats.toolCallFailed}`)
if (stats.toolCallRequests > 0) {
  p(`Tool accuracy: ${((stats.toolCallSuccess / (stats.toolCallSuccess + stats.toolCallFailed)) * 100).toFixed(1)}%`)
}
p('')
p('--- CONTEXT RETENTION ---')
p(`Context probes: ${stats.contextProbes}`)
p(`Context retained: ${stats.contextRetained}`)
p(`Context lost: ${stats.contextLost}`)
if (stats.contextProbes > 0) {
  p(`Retention rate: ${((stats.contextRetained / stats.contextProbes) * 100).toFixed(1)}%`)
}
p('')
p('--- LATENCY ---')
if (stats.latencies.length > 0) {
  const sorted = [...stats.latencies].sort((a, b) => a - b)
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  const max = sorted[sorted.length - 1]
  p(`Average: ${avg}ms`)
  p(`P50: ${p50}ms | P90: ${p90}ms | P99: ${p99}ms | Max: ${max}ms`)
}
p('')
p('--- PER-MINUTE BREAKDOWN ---')
for (const [min, ms] of Object.entries(stats.minutes)) {
  p(`  ${min}: ${ms.requests} reqs, ${ms.success} ok, ${ms.failed} fail, ${ms.toolCalls} tools, ${ms.toolSuccess} tools-ok`)
}
p('')
p('--- ERRORS ---')
if (stats.errors.length === 0) {
  p('No errors!')
} else {
  for (const err of stats.errors) {
    p(`  Turn ${err.turn}: ${err.status || 'N/A'} ${err.error?.slice(0, 200)}`)
  }
}
p('')
p('='.repeat(80))

const reportText = report.join('\n')
fs.default.writeFileSync(REPORT_FILE, reportText)
console.log('\n' + reportText)
console.log(`\nFull log: ${LOG_FILE}`)
console.log(`Report: ${REPORT_FILE}`)
