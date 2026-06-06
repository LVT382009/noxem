#!/usr/bin/env node
// Remove ALL upstream truncation — send full context to Qwen
// Set MAX_CHARS to Infinity, remove per-role limits
const fs = require('fs')
const path = 'D:/Qwen-Proxy/src/routes/anthropic.js'
let content = fs.readFileSync(path, 'utf-8')

// 1. Set MAX_CHARS to Infinity (no cap)
content = content.replace(
  "const MAX_CHARS = hasToolsActive ? 100000 : 120000",
  "const MAX_CHARS = Infinity"
)

// 2. Remove per-role limits entirely (empty object = no truncation)
content = content.replace(
  "const ROLE_LIMITS = hasToolsActive ? {\n  assistant: 500,\n  user: 1600,\n  tool: 6000,\n  system: 2000,\n} : {}",
  "const ROLE_LIMITS = {} // No limits — send full context"
)

// 3. Remove message count cap
content = content.replace(
  "const MAX_HISTORY_MSGS = hasToolsActive ? 60 : 200",
  "const MAX_HISTORY_MSGS = 9999 // No cap — send full history"
)

// 4. Remove tool result body truncation
content = content.replace(
  "const TOOL_RESULT_BODY_LIMIT = 16000",
  "const TOOL_RESULT_BODY_LIMIT = Infinity"
)

// 5. Remove system text cap
content = content.replace(
  "if (hasToolsActive && sysContent.length > 2000) {",
  "if (false && sysContent.length > 2000) { // Disabled: no system truncation"
)

// 6. Remove original task anchor cap
content = content.replace(
  "const cap = 2000\n  const truncated = firstText.length > cap ? firstText.slice(0, cap) + '...[original task truncated]' : firstText",
  "const cap = Infinity\n  const truncated = firstText // No truncation"
)

// 7. Remove current task anchor cap
content = content.replace(
  "const capLatest = 2000\n  const latestTruncated = latestText.length > capLatest ? latestText.slice(0, capLatest) + '...[latest task truncated]' : latestText",
  "const capLatest = Infinity\n  const latestTruncated = latestText // No truncation"
)

fs.writeFileSync(path, content, 'utf-8')
console.log('PATCHED: ALL truncation removed — full context sent upstream')
