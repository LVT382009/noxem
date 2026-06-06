#!/usr/bin/env node
const fs = require('fs')
const path = 'src/utils/upload.js'
let c = fs.readFileSync(path, 'utf-8')

// Exact content with 4-space indent (verified by char analysis)
const OLD = 'const getSimpleFileType = (mimeType) => {\r\n    if (!mimeType) return \'file\'\r\n    const mainType = mimeType.split(\'/\')[0].toLowerCase()\r\n    if (Object.keys(SUPPORTED_TYPES).includes(mainType)) {\r\n      return mainType\r\n    }\r\n    return \'file\'\r\n  }'

const NEW = 'const getSimpleFileType = (mimeType) => {\r\n    if (!mimeType) return \'file\'\r\n    // Check specific MIME type against all categories first\r\n    for (const [category, types] of Object.entries(SUPPORTED_TYPES)) {\r\n      if (types.includes(mimeType)) return category\r\n    }\r\n    // Fallback: check main type\r\n    const mainType = mimeType.split(\'/\')[0].toLowerCase()\r\n    if (Object.keys(SUPPORTED_TYPES).includes(mainType)) {\r\n      return mainType\r\n    }\r\n    return \'file\'\r\n  }'

if (c.includes(OLD)) {
  c = c.replace(OLD, NEW)
  fs.writeFileSync(path, c, 'utf-8')
  console.log('PATCHED: getSimpleFileType now resolves text/markdown -> document')
} else {
  console.log('ERROR: exact text not found, trying line-based approach')
  // Use line-based replacement
  const lines = c.split(/\r?\n/)
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('getSimpleFileType = (mimeType)')) {
      startLine = i
      break
    }
  }
  if (startLine === -1) { console.log('FUNCTION NOT FOUND'); process.exit(1) }
  console.log('Found function at line', startLine + 1)
  // Find closing brace
  let endLine = -1
  let depth = 0
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      if (ch === '}') depth--
    }
    if (depth === 0 && i > startLine) { endLine = i; break }
  }
  if (endLine === -1) { console.log('CLOSING BRACE NOT FOUND'); process.exit(1) }
  console.log('Function ends at line', endLine + 1)

  // Replace lines startLine..endLine with new function
  const newFuncLines = [
    'const getSimpleFileType = (mimeType) => {',
    '    if (!mimeType) return \'file\'',
    '    // Check specific MIME type against all categories first',
    '    for (const [category, types] of Object.entries(SUPPORTED_TYPES)) {',
    '      if (types.includes(mimeType)) return category',
    '    }',
    '    // Fallback: check main type',
    '    const mainType = mimeType.split(\'/\')[0].toLowerCase()',
    '    if (Object.keys(SUPPORTED_TYPES).includes(mainType)) {',
    '      return mainType',
    '    }',
    '    return \'file\'',
    '  }'
  ]
  lines.splice(startLine, endLine - startLine + 1, ...newFuncLines)
  c = lines.join('\r\n')
  fs.writeFileSync(path, c, 'utf-8')
  console.log('PATCHED (line-based): getSimpleFileType now resolves text/markdown -> document')
}
