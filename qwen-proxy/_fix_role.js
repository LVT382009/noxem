#!/usr/bin/env node
const fs = require('fs')
const path = 'D:/Qwen-Proxy/src/routes/anthropic.js'
const lines = fs.readFileSync(path, 'utf-8').split('\n')

// Replace lines 148-153 with empty ROLE_LIMITS
// Line 148 (0-indexed 147): const ROLE_LIMITS = hasToolsActive ? {
const startIdx = lines.findIndex(l => l.includes('const ROLE_LIMITS = hasToolsActive'))
if (startIdx === -1) { console.log('ROLE_LIMITS NOT FOUND'); process.exit(1) }

// Count lines to remove (until we find the closing } : {})
let endIdx = startIdx
for (let i = startIdx; i < lines.length; i++) {
  if (lines[i].includes('} : {}') || lines[i].includes('} : {}')) { endIdx = i; break }
}

console.log(`Replacing lines ${startIdx+1}-${endIdx+1}`)
lines.splice(startIdx, endIdx - startIdx + 1, "const ROLE_LIMITS = {} // No limits — send full context")

fs.writeFileSync(path, lines.join('\n'), 'utf-8')
console.log('PATCHED: ROLE_LIMITS removed')
