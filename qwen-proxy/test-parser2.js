const { parseToolCallsFromText } = require('./src/utils/toolcall.js')

// Exact model output from debug log
const text = `I'll execute all three tasks in parallel since they are independent of each other.

{"name":"search_text","arguments":{"pattern": "deleteChat", "path": "D:\\\\Qwen-Proxy\\\\src\\\\utils\\\\request.js", "output_mode": "content"}}
{"name":"shell_exec","arguments": {"command": "echo \\"streaming test ok\\""}}
{"name":"file_read","arguments":{"file_path": "D:\\\\Qwen-Proxy\\\\package.json", "limit": 3}}`

console.log('Input length:', text.length)
console.log('Contains <tool_call>:', text.includes('<tool_call>'))
console.log('Contains (tool_call):', text.includes('(tool_call)'))

const result = parseToolCallsFromText(text)
console.log('toolCalls:', result.toolCalls.length)
console.log('content:', JSON.stringify(result.content).substring(0, 200))

// Now test with just the tag portion
const justTag = `
{"name":"search_text","arguments":{"pattern": "deleteChat"}}
`
console.log('\nJust tag test:')
const r2 = parseToolCallsFromText(justTag)
console.log('toolCalls:', r2.toolCalls.length)
if (r2.toolCalls.length) console.log('calls:', JSON.stringify(r2.toolCalls))

// Test: what if there's newline between open tag and JSON?
const withNewline = '\n{"name":"test","arguments":{}}\n'
console.log('\nWith newline test:')
const r3 = parseToolCallsFromText(withNewline)
console.log('toolCalls:', r3.toolCalls.length)

// Test: what about space between tag and brace?
const withSpace = ' {"name":"test","arguments":{}} '
console.log('\nWith space test:')
const r4 = parseToolCallsFromText(withSpace)
console.log('toolCalls:', r4.toolCalls.length)
