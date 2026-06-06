const { parseToolCallsFromText } = require('./src/utils/toolcall.js')

// Test 1: tag format
const text1 = '\n{"name":"test","arguments":{"a":1}}\n'
console.log('test1 (tag):', parseToolCallsFromText(text1).toolCalls.length)

// Test 2: (tool_call) format - this is what the normalizer should handle
const text2 = '(tool_call)\n{"name":"test","arguments":{"a":1}}\n(/tool_call)'
console.log('test2 (parens):', parseToolCallsFromText(text2).toolCalls.length)

// Test 3: Actual model output from log
const text3 = ' {"name":"file_read","arguments":{"file_path": "D:\\Qwen-Proxy\\package.json", "limit": 5}} \n {"name":"shell_exec","arguments": {"command": "echo test"}} '
console.log('test3 (model output):', parseToolCallsFromText(text3).toolCalls.length)

// Test 4: With leading text
const text4 = 'I will use the tools.\n {"name":"file_read","arguments":{"file_path": "test.json"}} '
const r4 = parseToolCallsFromText(text4)
console.log('test4 (with leading text):', r4.toolCalls.length, 'content:', JSON.stringify(r4.content).substring(0, 100))

// Test 5: What the model ACTUALLY outputs (from debug log - raw bytes)
// Use the literal text from logs
const text5 = ` {"name":"file_read","arguments":{"file_path": "D:\\Qwen-Proxy\\package.json", "limit": 5}}  {"name":"shell_exec","arguments": {"command": "echo \\"Tool calling works from opus via Qwen proxy\\""}} `
const r5 = parseToolCallsFromText(text5)
console.log('test5 (exact model output):', r5.toolCalls.length, 'content:', JSON.stringify(r5.content).substring(0, 100))
if (r5.toolCalls.length > 0) {
  console.log('test5 tool calls:', JSON.stringify(r5.toolCalls, null, 2))
}

// Test 6: Check what TOOL_TAG_OPEN looks like char-by-char
const fs = require('fs')
const src = fs.readFileSync('./src/utils/toolcall.js', 'utf8')
const idx = src.indexOf('const TOOL_TAG_OPEN = ')
const line = src.substring(idx, idx + 80)
console.log('\nTOOL_TAG_OPEN line:', JSON.stringify(line))
// Extract the actual value
const match = src.match(/const TOOL_TAG_OPEN = "(.*?)"/)
if (match) {
  const tag = match[1]
  console.log('Tag value:', JSON.stringify(tag))
  console.log('Tag chars:')
  for (let i = 0; i < tag.length; i++) {
    console.log(`  [${i}] U+${tag.charCodeAt(i).toString(16).padStart(4, '0')} ${JSON.stringify(tag[i])}`)
  }
}
