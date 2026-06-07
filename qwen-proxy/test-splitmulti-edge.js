const { parseToolCallsFromText } = require('./src/utils/toolcall')

const OPEN = String.fromCharCode(60,116,111,111,108,95,99,97,108,108,62)
const CLOSE = String.fromCharCode(60,47,116,111,111,108,95,99,97,108,108,62)

// Most dangerous case: string has unmatched braces across a raw newline
// e.g. "old_string": "if x {\n  y = 1}"
// The { is on one line, the } is on the next — splitMultiJson might split mid-object
const json1 = '{"name":"file_edit","arguments":{"file_path":"D:\\\\test.py","old_string":"if x {\n  y = 1}","new_string":"if x {\n  y = 2}"}}\n{"name":"file_read","arguments":{"file_path":"D:\\\\other.py"}}'
const r1 = parseToolCallsFromText(OPEN + json1 + CLOSE)
console.log('Dangerous case (unmatched braces in string): toolCalls=' + r1.toolCalls.length)
if (r1.toolCalls.length) {
  r1.toolCalls.forEach((tc,i) => console.log('  '+i+':', tc.function.name))
} else {
  console.log('BUG: splitMultiJson broke due to braces in strings')
}
