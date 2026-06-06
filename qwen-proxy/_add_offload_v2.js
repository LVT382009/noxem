#!/usr/bin/env node
// Patch 2: Replace the flattenMessagesToPrompt caller with context offload logic
const fs = require('fs')
const path = 'src/routes/anthropic.js'
let c = fs.readFileSync(path, 'utf-8')
const lines = c.split(/\r?\n/)

// Find the line with flattenMessagesToPrompt caller
const callerIdx = lines.findIndex(l => l.includes('const finalPrompt = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)'))
if (callerIdx === -1) { console.log('ERROR: caller not found'); process.exit(1) }
console.log('Found caller at line', callerIdx + 1)

// Find the "// Determine thinking config" line after the caller
let thinkIdx = -1
for (let i = callerIdx + 1; i < Math.min(callerIdx + 5, lines.length); i++) {
  if (lines[i].includes('// Determine thinking config')) { thinkIdx = i; break }
}
if (thinkIdx === -1) { console.log('ERROR: thinking config comment not found'); process.exit(1) }
console.log('Found thinking config at line', thinkIdx + 1)

// Replace the caller line
lines[callerIdx] = 'const { prompt: finalPrompt, sysPart: _sysPart, toolsPart: _toolsPart, historyParts: _historyParts, historyChars: _historyChars } = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)'

// Insert the offload block before the "// Determine thinking config" line
const offloadBlock = [
  '',
  '// --- Context Offloading ---',
  '// When total prompt exceeds 120KB, upload conversation history as a .txt document.',
  '// System prompt + tool prompt stay inline (model needs these directly).',
  '// The history goes into an uploaded attachment — model reads it server-side.',
  'const OFFLOAD_THRESHOLD = 120 * 1024 // 120KB',
  'let offloadedFiles = []',
  'let effectivePrompt = finalPrompt',
  '',
  'if (finalPrompt.length > OFFLOAD_THRESHOLD && _historyParts.length > 0) {',
  '  try {',
  '    const { uploadFileToQwenOss } = require(\'../utils/upload.js\')',
  '    const accountManager = require(\'../utils/account.js\')',
  '    const authToken = accountManager.getAccountToken()',
  '',
  '    if (authToken) {',
  '      const historyDocContent = _historyParts.join(\'\\n\\n\')',
  '      const inlineParts = []',
  '      if (_sysPart) inlineParts.push(_sysPart)',
  '      if (_toolsPart) inlineParts.push(_toolsPart)',
  '      inlineParts.push(\'[CONVERSATION HISTORY: See attached file "conversation-history.txt" for the full prior conversation. Continue from where it left off.]\')',
  '      inlineParts.push(\'Assistant:\')',
  '      effectivePrompt = inlineParts.join(\'\\n\\n\')',
  '',
  '      const historyBuffer = Buffer.from(historyDocContent, \'utf-8\')',
  '      logger.info(\'Context offloading: uploading \' + historyBuffer.length + \' chars of history as document attachment\', \'OFFLOAD\')',
  '      const uploadResult = await uploadFileToQwenOss(historyBuffer, \'conversation-history.txt\', authToken)',
  '',
  '      if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {',
  '        const fileId = uploadResult.file_id || \'\'',
  '        const fileUrl = uploadResult.file_url',
  '        const fileSize = historyBuffer.length',
  '        const itemId = generateUUID()',
  '        const taskId = generateUUID()',
  '',
  '        offloadedFiles = [{',
  '          type: \'file\',',
  '          file_class: \'document\',',
  '          file_type: \'text/plain\',',
  '          showType: \'file\',',
  '          id: fileId,',
  '          url: fileUrl,',
  '          name: \'conversation-history.txt\',',
  '          size: fileSize,',
  '          status: \'uploaded\',',
  '          greenNet: \'success\',',
  '          progress: 0,',
  '          error: \'\',',
  '          itemId: itemId,',
  '          uploadTaskId: taskId,',
  '          collection_name: \'\',',
  '          file: {',
  '            id: fileId,',
  '            filename: \'conversation-history.txt\',',
  '            user_id: \'\',',
  '            created_at: Date.now(),',
  '            update_at: Date.now(),',
  '            data: {},',
  '            hash: null,',
  '            meta: {',
  '              name: \'conversation-history.txt\',',
  '              size: fileSize,',
  '              content_type: \'text/plain\'',
  '            }',
  '          }',
  '        }]',
  '        logger.success(\'Context offloaded: \' + (historyBuffer.length / 1024).toFixed(1) + \'KB history uploaded as document (inline prompt: \' + (effectivePrompt.length / 1024).toFixed(1) + \'KB)\', \'OFFLOAD\')',
  '      } else {',
  '        logger.warn(\'Context offload upload failed — falling back to inline prompt (\' + (finalPrompt.length / 1024).toFixed(1) + \'KB)\', \'OFFLOAD\')',
  '      }',
  '    } else {',
  '      logger.warn(\'No auth token for context offload — falling back to inline prompt\', \'OFFLOAD\')',
  '    }',
  '  } catch (offloadErr) {',
  '    logger.error(\'Context offload error: \' + offloadErr.message + \' — falling back to inline prompt\', \'OFFLOAD\')',
  '  }',
  '}',
]

lines.splice(thinkIdx, 0, ...offloadBlock)

// Now fix: replace content: finalPrompt -> content: effectivePrompt
// and files: [] -> files: offloadedFiles
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('content: finalPrompt,')) {
    lines[i] = lines[i].replace('content: finalPrompt,', 'content: effectivePrompt,')
    console.log('Patched content field at line', i + 1)
  }
  if (lines[i].includes('files: [],') && i > callerIdx) {
    lines[i] = lines[i].replace('files: [],', 'files: offloadedFiles,')
    console.log('Patched files field at line', i + 1)
    break // only patch the first one after the caller
  }
}

// Also fix the retry hint prompt
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("const hintPrompt = finalPrompt + '\\n\\n[IMPORTANT:")) {
    lines[i] = lines[i].replace('finalPrompt + ', 'effectivePrompt + ')
    console.log('Patched retry hint at line', i + 1)
  }
}

fs.writeFileSync(path, lines.join('\n'), 'utf-8')
console.log('PATCHED: Context offloading added')
