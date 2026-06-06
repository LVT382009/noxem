'use strict'
var m = require('./src/utils/toolcall.js');
var O = String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62);
var C = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);

// Test A: literal angle bracket tags
var ta = O + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + C;
var ra = m.parseToolCallsFromText(ta);
console.log('Test A (angle):', ra.toolCalls.length, 'calls');

// Test B: (tool_call) text form
var tb = '(tool_call)' + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + '(/tool_call)';
var rb = m.parseToolCallsFromText(tb);
console.log('Test B (paren):', rb.toolCalls.length, 'calls');

// Test C3: HTML entities
var tc3 = '&lt;tool_call&gt;' + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + '&lt;/tool_call&gt;';
var rc3 = m.parseToolCallsFromText(tc3);
console.log('Test C3 (HTML entities):', rc3.toolCalls.length, 'calls');

// Test C4: Square brackets
var tc4 = '[tool_call]' + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + '[/tool_call]';
var rc4 = m.parseToolCallsFromText(tc4);
console.log('Test C4 (square brackets):', rc4.toolCalls.length, 'calls');

// Test C5: bare JSON (no wrapping tags)
var tc5 = JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}});
var rc5 = m.parseToolCallsFromText(tc5);
console.log('Test C5 (bare JSON):', rc5.toolCalls.length, 'calls');

// Test C6: newlines inside tags
var tc6 = O + '\n' + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + '\n' + C;
var rc6 = m.parseToolCallsFromText(tc6);
console.log('Test C6 (newlines):', rc6.toolCalls.length, 'calls');

// Test C7: streaming - what if opening and closing tags arrive in separate chunks?
var sv = m.createSieve();
var s1 = sv.push('I will read it.\n');
console.log('Test C7a:', JSON.stringify(s1));
var s2 = sv.push(O);
console.log('Test C7b (open tag chunk):', JSON.stringify(s2));
var s3 = sv.push(JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}));
console.log('Test C7c (JSON chunk):', JSON.stringify(s3));
var s4 = sv.push(C);
console.log('Test C7d (close tag chunk):', JSON.stringify(s4));

// Test D: simulate what Qwen WEB API delivers when native tools are disabled
// When native tools are disabled, the model might output the tags as plain text
// The Qwen web chat backend should pass them through as-is in the SSE delta.content
// BUT: some web APIs strip or replace special tokens
// Let us test streaming sieve with (tool_call) form split across chunks
var sv2 = m.createSieve();
var t1 = sv2.push('(tool_call){"na');
var t2 = sv2.push('me":"file_read","arguments":{"path":"/tmp/x"}}(/tool_call)');
console.log('Test D1 (paren streaming):', JSON.stringify(t1), JSON.stringify(t2));

// Test E: what if the model outputs with \u escaped form?
var te1 = '\\u003ctool_call\\u003e' + JSON.stringify({name:"file_read",arguments:{path:"/tmp/x"}}) + '\\u003c/tool_call\\u003e';
var re1 = m.parseToolCallsFromText(te1);
console.log('Test E (unicode escape):', re1.toolCalls.length, 'calls');
