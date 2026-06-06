// Read the latest log and find the raw model output line, then hex-dump it
const fs = require('fs')
const log = fs.readFileSync('./logs/app.log', 'utf8')
const lines = log.split('\n')

// Find the last "Raw model output" line
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('Raw model output')) {
    console.log('Found line:', i)
    const marker = 'Raw model output (first 500): '
    const idx = lines[i].indexOf(marker)
    if (idx === -1) { console.log('Marker not found'); break }
    const rawOutput = lines[i].substring(idx + marker.length)

    console.log('\n--- Raw output length ---')
    console.log(rawOutput.length)
    console.log('\n--- Hex dump of ALL non-ASCII chars ---')
    for (let j = 0; j < rawOutput.length; j++) {
      const code = rawOutput.charCodeAt(j)
      if (code > 127 || code === 60 || code === 40) {
        console.log(`  [${j}] U+${code.toString(16).padStart(4,'0')} = ${JSON.stringify(rawOutput[j])} context: "${rawOutput.substring(Math.max(0,j-3), Math.min(rawOutput.length,j+4))}"`)
      }
    }

    // Check for tag patterns using code points
    const OPEN_EXPECTED = [0x3c, 0x74, 0x6f, 0x6f, 0x6c, 0x5f, 0x63, 0x61, 0x6c, 0x6c, 0x3e] // <tool_call>
    console.log('\n--- Searching for <tool_call> pattern by code points ---')
    for (let j = 0; j < rawOutput.length - 10; j++) {
      let match = true
      for (let k = 0; k < OPEN_EXPECTED.length; k++) {
        if (rawOutput.charCodeAt(j + k) !== OPEN_EXPECTED[k]) { match = false; break }
      }
      if (match) {
        console.log('  FOUND at position', j, ':', JSON.stringify(rawOutput.substring(j, j + 50)))
      }
    }

    // Also search for (tool_call) pattern
    console.log('\n--- Searching for (tool_call) pattern ---')
    const PAREN_OPEN = [0x28, 0x74, 0x6f, 0x6f, 0x6c, 0x5f, 0x63, 0x61, 0x6c, 0x6c, 0x29] // (tool_call)
    for (let j = 0; j < rawOutput.length - 10; j++) {
      let match = true
      for (let k = 0; k < PAREN_OPEN.length; k++) {
        if (rawOutput.charCodeAt(j + k) !== PAREN_OPEN[k]) { match = false; break }
      }
      if (match) {
        console.log('  FOUND at position', j, ':', JSON.stringify(rawOutput.substring(j, j + 50)))
      }
    }

    // Search for any < character
    console.log('\n--- All < positions ---')
    for (let j = 0; j < rawOutput.length; j++) {
      if (rawOutput[j] === '<') {
        console.log(`  [${j}] context: "${rawOutput.substring(j, Math.min(rawOutput.length, j + 20))}"`)
      }
    }
    break
  }
}
