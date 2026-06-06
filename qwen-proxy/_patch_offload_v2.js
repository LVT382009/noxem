#!/usr/bin/env node
// Patch v2: Replace simple context offloading with sliding window + structured summary
// Key improvements:
//   1. Keep last ~25KB of recent messages INLINE (not offloaded)
//   2. Build structured summary of archived (offloaded) portion
//   3. Only upload older history as archive file, not entire conversation
//   4. Lower threshold from 120KB to 100KB
//   5. Fix bug: estimatedInputTokens was inside if-block, now outside

const fs = require('fs')
const path = 'src/routes/anthropic.js'
let c = fs.readFileSync(path, 'utf-8')

// Find the offload block start and end
const START_MARKER = '// --- Context Offloading ---'
const END_MARKER = '// Determine thinking config'

const startIdx = c.indexOf(START_MARKER)
const endIdx = c.indexOf(END_MARKER)

if (startIdx === -1) { console.log('ERROR: Start marker not found'); process.exit(1) }
if (endIdx === -1) { console.log('ERROR: End marker not found'); process.exit(1) }

console.log('Found offload block from char', startIdx, 'to', endIdx)

const newOffloadBlock = `// --- Context Offloading (v2: Sliding Window + Structured Summary) ---
// When prompt > 100KB, split history into:
//   1. RECENT context (last ~25KB) — stays INLINE for immediate coherence
//   2. OLDER history — uploaded as document attachment + structured summary inline
// System prompt + tool prompt always stay inline.
// The model gets: system + tools + summary + recent context + "see archive" + Assistant:
const OFFLOAD_THRESHOLD = 100 * 1024 // 100KB
const RECENT_CONTEXT_BUDGET = 25 * 1024 // 25KB of recent messages stay inline
let offloadedFiles = []
let effectivePrompt = finalPrompt

if (finalPrompt.length > OFFLOAD_THRESHOLD && _historyParts.length > 0) {
  try {
    const { uploadFileToQwenOss } = require('../utils/upload.js')
    const accountManager = require('../utils/account.js')
    const authToken = accountManager.getAccountToken()

    if (authToken) {
      // Split history: keep recent messages inline, offload older ones
      const archiveParts = []
      const recentParts = []
      let recentBudget = RECENT_CONTEXT_BUDGET

      // Walk from newest to oldest, keeping recent within budget
      for (let i = _historyParts.length - 1; i >= 0; i--) {
        const part = _historyParts[i]
        if (recentBudget > 0 && (recentParts.length === 0 || recentBudget >= part.length)) {
          recentParts.unshift(part)
          recentBudget -= part.length
        } else {
          archiveParts.unshift(part)
        }
      }

      // Build structured summary of the archived (offloaded) portion
      const summaryLines = []
      let userReqCount = 0
      let toolCallCount = 0
      let lastUserReq = ''
      for (const part of archiveParts) {
        if (part.startsWith('Human:') || part.startsWith('Human (')) {
          userReqCount++
          const reqText = part.replace(/^Human(?:\\s*\\([^)]*\\))?\\s*/, '').slice(0, 200).trim()
          if (reqText) lastUserReq = reqText
        }
        if (part.includes('##TOOL_CALL##')) toolCallCount++
      }
      summaryLines.push('[ARCHIVE SUMMARY — ' + (archiveParts.join('\\n').length / 1024 > 1 ? (archiveParts.join('\\n').length / 1024).toFixed(1) + 'KB' : archiveParts.join('\\n').length + ' chars') + ' of older conversation is attached as "conversation-archive.txt"]')
      if (userReqCount > 0) summaryLines.push('Previous user requests: ' + userReqCount + ' (last: "' + (lastUserReq.length > 150 ? lastUserReq.slice(0, 150) + '...' : lastUserReq) + '")')
      if (toolCallCount > 0) summaryLines.push('Tool calls made: ' + toolCallCount)
      const toolResultLines = archiveParts.filter(p => p.startsWith('[Tool Result'))
      if (toolResultLines.length > 0) {
        summaryLines.push('Tool results in archive: ' + toolResultLines.length)
      }
      summaryLines.push('Continue seamlessly from the recent context below. Refer to the attached archive file for details of earlier steps.')

      // Build inline prompt: system + tools + archive summary + recent context + Assistant:
      const inlineParts = []
      if (_sysPart) inlineParts.push(_sysPart)
      if (_toolsPart) inlineParts.push(_toolsPart)
      inlineParts.push(summaryLines.join('\\n'))
      inlineParts.push(...recentParts)
      inlineParts.push('Assistant:')
      effectivePrompt = inlineParts.join('\\n\\n')

      // Upload ONLY the older archive as document
      const archiveContent = archiveParts.join('\\n\\n')
      const archiveBuffer = Buffer.from(archiveContent, 'utf-8')
      logger.info('Context offloading: uploading ' + archiveBuffer.length + ' chars of archive (' + archiveParts.length + ' msgs), keeping ' + recentParts.length + ' recent msgs inline', 'OFFLOAD')
      const uploadResult = await uploadFileToQwenOss(archiveBuffer, 'conversation-archive.txt', authToken)

      if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {
        const fileId = uploadResult.file_id || ''
        const fileUrl = uploadResult.file_url
        const fileSize = archiveBuffer.length
        const itemId = generateUUID()
        const taskId = generateUUID()

        offloadedFiles = [{
          type: 'file',
          file_class: 'document',
          file_type: 'text/plain',
          showType: 'file',
          id: fileId,
          url: fileUrl,
          name: 'conversation-archive.txt',
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
            filename: 'conversation-archive.txt',
            user_id: '',
            created_at: Date.now(),
            update_at: Date.now(),
            data: {},
            hash: null,
            meta: {
              name: 'conversation-archive.txt',
              size: fileSize,
              content_type: 'text/plain'
            }
          }
        }]
        logger.success('Context offloaded: ' + (archiveBuffer.length / 1024).toFixed(1) + 'KB archive uploaded (' + archiveParts.length + ' older msgs), ' + recentParts.length + ' recent msgs inline (prompt: ' + (effectivePrompt.length / 1024).toFixed(1) + 'KB)', 'OFFLOAD')
      } else {
        logger.warn('Context offload upload failed — falling back to full inline prompt (' + (finalPrompt.length / 1024).toFixed(1) + 'KB)', 'OFFLOAD')
        effectivePrompt = finalPrompt
      }
    } else {
      logger.warn('No auth token for context offload — falling back to inline prompt', 'OFFLOAD')
    }
  } catch (offloadErr) {
    logger.error('Context offload error: ' + offloadErr.message + ' — falling back to inline prompt', 'OFFLOAD')
  }
}
const estimatedInputTokens = countTokens(effectivePrompt)

`

c = c.substring(0, startIdx) + newOffloadBlock + c.substring(endIdx)

fs.writeFileSync(path, c, 'utf-8')
console.log('PATCHED: Context offloading v2 (sliding window + structured summary)')
