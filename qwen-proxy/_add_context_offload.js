#!/usr/bin/env node
// Add context offloading: when prompt > 120KB, upload conversation history
// as a .txt document to Qwen OSS and attach it to the message via files[].
// System prompt + tool prompt stay inline (model needs these directly).
// Only the conversation history gets offloaded to the attachment.

const fs = require('fs')
const path = 'src/routes/anthropic.js'
let content = fs.readFileSync(path, 'utf-8')

// ============================================================
// STEP 1: Modify flattenMessagesToPrompt to return structured data
// Changed: return { prompt, sysPart, toolsPart, historyParts, used }
// instead of just the string
// ============================================================

const OLD_ASSEMBLY = `// Assembly order (Qwen2API pattern):
// [sys_part] [tools_part] [history] Assistant:
const parts = []
if (sysPart) parts.push(sysPart)
if (toolsPart) parts.push(toolsPart)
parts.push(...historyParts)
parts.push('Assistant:')

const result = parts.join('\\n\\n')
logger.info('Prompt assembled: ' + result.length + ' chars (system=' + sysPart.length + ', tools=' + toolsPart.length + ', history=' + used + ')', 'ANTHROPIC')
return result`

const NEW_ASSEMBLY = `// Assembly order (Qwen2API pattern):
// [sys_part] [tools_part] [history] Assistant:
const parts = []
if (sysPart) parts.push(sysPart)
if (toolsPart) parts.push(toolsPart)
parts.push(...historyParts)
parts.push('Assistant:')

const result = parts.join('\\n\\n')
logger.info('Prompt assembled: ' + result.length + ' chars (system=' + sysPart.length + ', tools=' + toolsPart.length + ', history=' + used + ')', 'ANTHROPIC')
return { prompt: result, sysPart, toolsPart, historyParts, historyChars: used }`

if (!content.includes('// Assembly order (Qwen2API pattern):')) {
  console.log('ERROR: Assembly comment not found')
  process.exit(1)
}
content = content.replace(OLD_ASSEMBLY, NEW_ASSEMBLY)

// ============================================================
// STEP 2: Update the caller to handle new return type
// OLD: const finalPrompt = flattenMessagesToPrompt(...)
// NEW: destructure + context offload logic
// ============================================================

const OLD_CALLER = `const finalPrompt = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)

// Determine thinking config`

const NEW_CALLER = `const { prompt: finalPrompt, sysPart: _sysPart, toolsPart: _toolsPart, historyParts: _historyParts, historyChars: _historyChars } = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)

// --- Context Offloading ---
// When total prompt exceeds 120KB, the Qwen web gateway kills the connection.
// Strategy: upload conversation history as a .txt document attachment.
// System prompt + tool prompt stay inline (model needs these directly).
// The history goes into the uploaded file — model reads it server-side.
const OFFLOAD_THRESHOLD = 120 * 1024 // 120KB
let offloadedFiles = []
let effectivePrompt = finalPrompt

if (finalPrompt.length > OFFLOAD_THRESHOLD && _historyParts.length > 0) {
  try {
    const { uploadFileToQwenOss } = require('../utils/upload.js')
    const accountManager = require('../utils/account.js')
    const authToken = accountManager.getAccountToken()

    if (authToken) {
      // Build the history document content
      const historyDocContent = _historyParts.join('\\n\\n')
      // Build the inline prompt: system + tools + reference to attachment + Assistant:
      const inlineParts = []
      if (_sysPart) inlineParts.push(_sysPart)
      if (_toolsPart) inlineParts.push(_toolsPart)
      inlineParts.push('[CONVERSATION HISTORY: See attached file "conversation-history.txt" for the full prior conversation. Continue from where it left off.]')
      inlineParts.push('Assistant:')
      effectivePrompt = inlineParts.join('\\n\\n')

      // Upload the history as a text document
      const historyBuffer = Buffer.from(historyDocContent, 'utf-8')
      logger.info('Context offloading: uploading ' + historyBuffer.length + ' chars of history as document attachment', 'OFFLOAD')
      const uploadResult = await uploadFileToQwenOss(historyBuffer, 'conversation-history.txt', authToken)

      if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {
        const fileId = uploadResult.file_id || ''
        const fileUrl = uploadResult.file_url
        const fileSize = historyBuffer.length
        const itemId = generateUUID()
        const taskId = generateUUID()

        offloadedFiles = [{
          type: 'file',
          file_class: 'document',
          file_type: 'text/plain',
          showType: 'file',
          id: fileId,
          url: fileUrl,
          name: 'conversation-history.txt',
          size: fileSize,
          status: 'uploaded',
          greenNet: 'success',
          progress: 0,
          error: '',
          itemId: itemId,
          uploadTaskId: taskId,
          collection_name: '',
          file: {
            id: fileId,
            filename: 'conversation-history.txt',
            user_id: '',
            created_at: Date.now(),
            update_at: Date.now(),
            data: {},
            hash: null,
            meta: {
              name: 'conversation-history.txt',
              size: fileSize,
              content_type: 'text/plain'
            }
          }
        }]
        logger.success('Context offloaded: ' + (historyBuffer.length / 1024).toFixed(1) + 'KB history uploaded as document (inline prompt: ' + (effectivePrompt.length / 1024).toFixed(1) + 'KB)', 'OFFLOAD')
      } else {
        logger.warn('Context offload upload failed — falling back to inline prompt (' + (finalPrompt.length / 1024).toFixed(1) + 'KB)', 'OFFLOAD')
      }
    } else {
      logger.warn('No auth token for context offload — falling back to inline prompt', 'OFFLOAD')
    }
  } catch (offloadErr) {
    logger.error('Context offload error: ' + offloadErr.message + ' — falling back to inline prompt', 'OFFLOAD')
  }
}

// Determine thinking config`

if (!content.includes('const finalPrompt = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)')) {
  console.log('ERROR: Caller line not found')
  process.exit(1)
}
content = content.replace(OLD_CALLER, NEW_CALLER)

// ============================================================
// STEP 3: Update requestBody to use effectivePrompt and offloadedFiles
// OLD: content: finalPrompt, ... files: []
// NEW: content: effectivePrompt, ... files: offloadedFiles
// ============================================================

// Replace content field
content = content.replace(
  'content: finalPrompt,',
  'content: effectivePrompt,'
)

// Replace files field
content = content.replace(
  'files: [],',
  'files: offloadedFiles,'
)

// ============================================================
// STEP 4: Also update the retry body builder to use effectivePrompt
// ============================================================
content = content.replace(
  "const hintPrompt = finalPrompt + '\\n\\n[IMPORTANT:",
  "const hintPrompt = effectivePrompt + '\\n\\n[IMPORTANT:"
)

fs.writeFileSync(path, content, 'utf-8')
console.log('PATCHED: Context offloading added')
