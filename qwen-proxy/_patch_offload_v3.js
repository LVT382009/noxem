#!/usr/bin/env node
// Patch v3: Improve offloaded archive quality
// 1. Document grounding instructions (tell model to read the attachment)
// 2. Markdown-formatted archive with Table of Contents + section headers
// 3. Observation masking (compress old tool results in archive)
// 4. Better structured summary with session state

const fs = require('fs')
const path = 'src/routes/anthropic.js'
let c = fs.readFileSync(path, 'utf-8')

// ============================================================
// PATCH 1: Replace the summary builder section
// Old: simple count-based summary
// New: session state summary + document grounding instructions
// ============================================================

const OLD_SUMMARY = `      // Build structured summary of the archived (offloaded) portion
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
      summaryLines.push('Continue seamlessly from the recent context below. Refer to the attached archive file for details of earlier steps.')`

const NEW_SUMMARY = `      // Build structured summary of the archived (offloaded) portion
      // Extract key info for session state summary
      let userReqCount = 0
      let toolCallCount = 0
      let lastUserReq = ''
      const sectionNames = []
      let currentSection = null

      for (const part of archiveParts) {
        if (part.startsWith('Human:') || part.startsWith('Human (')) {
          userReqCount++
          const reqText = part.replace(/^Human(?:\\s*\\([^)]*\\))?\\s*/, '').slice(0, 200).trim()
          if (reqText) lastUserReq = reqText
          // Detect topic shifts for sectioning
          if (reqText.length > 20) {
            const label = reqText.slice(0, 60).replace(/[\\n\\r]/g, ' ').trim()
            if (label && (!currentSection || currentSection !== label)) {
              currentSection = label
              sectionNames.push({ label, msgIndex: archiveParts.indexOf(part) })
            }
          }
        }
        if (part.includes('##TOOL_CALL##')) toolCallCount++
      }

      // Build session state summary with document grounding instructions
      const archiveSizeKB = (archiveParts.join('\\n').length / 1024).toFixed(1)
      const summaryLines = [
        '## Session State (archived context summary)',
        '',
        '- **Archive size**: ' + archiveSizeKB + 'KB in attached "conversation-archive.md"',
        '- **Previous user requests**: ' + userReqCount + (lastUserReq ? ' (last: "' + (lastUserReq.length > 150 ? lastUserReq.slice(0, 150) + '...' : lastUserReq) + '")' : ''),
        '- **Tool calls**: ' + toolCallCount + ' calls in archive',
        '- **Sections**: ' + sectionNames.length + ' topics detected (see ToC in attachment)',
        '',
        'CRITICAL: Before responding, review the attached conversation-archive.md. Your current task continues from prior steps. Key findings and decisions are in the document. Read the Table of Contents first, then focus on sections relevant to the current step. The most recent exchanges are shown inline below.',
      ]`

if (!c.includes('// Build structured summary of the archived (offloaded) portion')) {
  console.log('ERROR: Summary builder not found')
  process.exit(1)
}
c = c.replace(OLD_SUMMARY, NEW_SUMMARY)
console.log('Patched: Session state summary + document grounding')

// ============================================================
// PATCH 2: Replace archive content builder
// Old: plain .txt with raw content
// New: markdown with ToC, section headers, and observation masking
// ============================================================

const OLD_ARCHIVE = `      // Upload ONLY the older archive as document
      const archiveContent = archiveParts.join('\\n\\n')
      const archiveBuffer = Buffer.from(archiveContent, 'utf-8')
      logger.info('Context offloading: uploading ' + archiveBuffer.length + ' chars of archive (' + archiveParts.length + ' msgs), keeping ' + recentParts.length + ' recent msgs inline', 'OFFLOAD')
      const uploadResult = await uploadFileToQwenOss(archiveBuffer, 'conversation-archive.txt', authToken)`

const NEW_ARCHIVE = `      // Build markdown-formatted archive with ToC + section headers + observation masking
      const mdLines = ['# Conversation Archive', '']
      mdLines.push('> Generated: ' + new Date().toISOString())
      mdLines.push('> Total messages: ' + archiveParts.length)
      mdLines.push('')

      // Table of Contents
      mdLines.push('## Table of Contents')
      mdLines.push('')
      let secIdx = 1
      const tocEntries = []
      for (const sec of sectionNames) {
        const title = sec.label.length > 55 ? sec.label.slice(0, 55) + '...' : sec.label
        tocEntries.push('  ' + secIdx + '. ' + title + ' (msgs ~' + (sec.msgIndex + 1) + ')')
        secIdx++
      }
      if (tocEntries.length === 0) tocEntries.push('  1. Full conversation sequence')
      mdLines.push(...tocEntries)
      mdLines.push('')

      // Observation masking: compress tool results older than 2 turns
      const maskedParts = archiveParts.map((part, idx) => {
        // Compress large tool results: keep tool name + first 200 chars + status
        if (part.startsWith('[Tool Result')) {
          const toolMatch = part.match(/^\\[Tool Result \\(([^)]+)\\)\\]/)
          const toolName = toolMatch ? toolMatch[1] : 'tool'
          // Keep first ~300 chars of result, mask the rest
          const body = part.replace(/^\\[Tool Result[^\\]]*\\]\\n?/, '').replace(/\\n\\[\\/Tool Result\\]$/, '')
          if (body.length > 500) {
            return '[Tool Result (' + toolName + ')]\\n' + body.slice(0, 300) + '\\n...[' + (body.length - 300) + ' chars masked. Full content available on request.]\\n[/Tool Result]'
          }
          return part
        }
        return part
      })

      // Content sections with headers
      let lastSecIdx = -1
      for (let i = 0; i < maskedParts.length; i++) {
        // Add section header if this message starts a new section
        for (let s = 0; s < sectionNames.length; s++) {
          if (sectionNames[s].msgIndex === i) {
            mdLines.push('')
            mdLines.push('---')
            mdLines.push('')
            mdLines.push('## Section ' + (s + 1) + ': ' + sectionNames[s].label)
            mdLines.push('')
            lastSecIdx = s
            break
          }
        }
        mdLines.push(maskedParts[i])
      }

      const archiveContent = mdLines.join('\\n')
      const archiveBuffer = Buffer.from(archiveContent, 'utf-8')
      logger.info('Context offloading: uploading ' + archiveBuffer.length + ' chars of archive (' + archiveParts.length + ' msgs, ' + sectionNames.length + ' sections, ' + tocEntries.length + ' ToC entries), keeping ' + recentParts.length + ' recent msgs inline', 'OFFLOAD')
      const uploadResult = await uploadFileToQwenOss(archiveBuffer, 'conversation-archive.md', authToken)`

if (!c.includes('// Upload ONLY the older archive as document')) {
  console.log('ERROR: Archive builder not found')
  process.exit(1)
}
c = c.replace(OLD_ARCHIVE, NEW_ARCHIVE)
console.log('Patched: Markdown archive with ToC + section headers + observation masking')

// ============================================================
// PATCH 3: Update the file metadata to .md
// ============================================================
c = c.replace("name: 'conversation-archive.txt'", "name: 'conversation-archive.md'")
c = c.replace("filename: 'conversation-archive.txt'", "filename: 'conversation-archive.md'")
c = c.replace("content_type: 'text/plain'", "content_type: 'text/markdown'")
console.log('Patched: File metadata updated to .md')

// ============================================================
// PATCH 4: Update log messages to reference .md
// ============================================================
c = c.replace('conversation-archive.txt', 'conversation-archive.md')
console.log('Patched: Log messages updated to .md')

fs.writeFileSync(path, c, 'utf-8')
console.log('ALL PATCHES APPLIED: Context offloading v3')
