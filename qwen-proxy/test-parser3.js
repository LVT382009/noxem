const fs = require('fs')
const src = fs.readFileSync('./src/utils/toolcall.js', 'utf8')

// Extract TOOL_TAG_OPEN value directly from source
const openMatch = src.match(/const TOOL_TAG_OPEN = "(.*?)"/)
const closeMatch = src.match(/const TOOL_TAG_CLOSE = "(.*?)"/)
const OPEN = openMatch ? openMatch[1] : 'NOT_FOUND'
const CLOSE = closeMatch ? closeMatch[1] : 'NOT_FOUND'

console.log('OPEN tag:', JSON.stringify(OPEN), 'length:', OPEN.length)
console.log('CLOSE tag:', JSON.stringify(CLOSE), 'length:', CLOSE.length)

// Now construct the exact model output with these tags
const modelOutput = `I'll execute all three tasks.

${OPEN}{"name":"search_text","arguments":{"pattern": "deleteChat"}}${CLOSE}
${OPEN}{"name":"shell_exec","arguments": {"command": "echo test"}}${CLOSE}
${OPEN}{"name":"file_read","arguments":{"file_path": "test.json", "limit": 3}}${CLOSE}`

console.log('\nModel output length:', modelOutput.length)
console.log('Contains OPEN tag:', modelOutput.includes(OPEN))
console.log('Contains CLOSE tag:', modelOutput.includes(CLOSE))

// Test the regex directly
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
const tagRegex = new RegExp(escRegex(OPEN) + '\\s*([\\s\\S]*?)\\s*' + escRegex(CLOSE), 'g')
let match
let matchCount = 0
while ((match = tagRegex.exec(modelOutput)) !== null) {
  matchCount++
  console.log('\nMatch', matchCount + ':', match[1].trim().substring(0, 100))
}
console.log('\nTotal regex matches:', matchCount)

// Now test with the parseToolCallsFromText function
const { parseToolCallsFromText } = require('./src/utils/toolcall.js')
const result = parseToolCallsFromText(modelOutput)
console.log('\nparseToolCallsFromText result:')
console.log('toolCalls:', result.toolCalls.length)
console.log('content:', JSON.stringify(result.content).substring(0, 200))
if (result.toolCalls.length) {
  for (const tc of result.toolCalls) {
    console.log('  Tool:', tc.function?.name, tc.function?.arguments?.substring(0, 80))
  }
}
