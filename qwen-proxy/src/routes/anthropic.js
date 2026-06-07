const express = require('express')
const router = express.Router()
const { validateApiKey } = require('../middlewares/authorization.js')
const { anthropicToOpenAI, openaiToAnthropicResponse, streamQwenToAnthropic } = require('../adapters/anthropic.js')
const { sendChatRequest, disableNativeTools, deleteChat } = require('../utils/request.js')
const { hasTools } = require('../utils/toolcall.js')
const { injectToolCallContext } = require('../middlewares/chat-middleware.js')
const { isThinkingEnabled } = require('../utils/chat-helpers.js')
const { generateUUID } = require('../utils/tools.js')
const { logger } = require('../utils/logger')
const { accumulateResponse } = require('../utils/accumulate.js')
const config = require('../config/index.js')
const { countTokens } = require('../utils/precise-tokenizer.js')

/**
 * Anthropic API key verification middleware
 * Accepts x-api-key header or Authorization: Bearer header
 */
const anthropicKeyVerify = (req, res, next) => {
  if (config.apiKeys.length === 0) {
    req.isAdmin = true
    req.apiKey = ''
    return next()
  }

  const apiKey = req.headers['x-api-key'] || req.headers['authorization'] || req.headers['Authorization']
  const { isValid, isAdmin } = validateApiKey(apiKey)

  if (!isValid) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' }
    })
  }

  req.isAdmin = isAdmin
  req.apiKey = apiKey
  next()
}

// Suffixes that are invalid with chat_type=t2t — strip them from any model.
// The Python proxy on 8082 routes opus→qwen3.7-max-search etc.
// We strip the suffix so the actual Qwen model name is used: qwen3.7-max
const MODEL_SUFFIXES = ['-search', '-thinking', '-image', '-video', '-deep-research', '-image-edit']

function stripModelSuffix(model) {
  for (const suffix of MODEL_SUFFIXES) {
    if (model.endsWith(suffix)) return model.slice(0, -suffix.length)
  }
  return model
}

function getModelSuffix(model) {
  for (const suffix of MODEL_SUFFIXES) {
    if (model.endsWith(suffix)) return suffix
  }
  return ''
}

// Model mapping: only maps Anthropic/Claude model names to Qwen models.
// Qwen model names pass through directly (with suffix stripped).
const MODEL_MAPPING = {
  'claude-opus-4-7': '',
  'claude-opus-4-5': '',
  'claude-sonnet-4-6': '',
  'claude-sonnet-4-5': '',
  'claude-haiku-4-5': '',
  'claude-3-5-sonnet': '',
  'claude-3-5-haiku': '',
  'claude-3-opus': '',
  'claude-3-sonnet': '',
  'claude-3-haiku': '',
}

/**
 * Normalize Anthropic system field to a string
 */
const normalizeAnthropicSystem = (system) => {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n')
  }
  return ''
}

/**
 * Compress <system-reminder> blocks to a one-line summary.
 * Prevents MCP instruction blocks from consuming the prompt budget.
 */
function compactSystemReminders(text) {
  if (!text || !text.includes('<system-reminder>')) return text
  return text.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/gi, (match, body) => {
    const first = body.trim().split('\n')[0].slice(0, 80)
    return first ? `[system-reminder: ${first}...]` : '[system-reminder]'
  })
}

// Clean refusal messages from assistant history.
// Qwen sometimes says "I cannot help" / "Tool X does not exists" in its responses.
// If these refusal messages appear in conversation history, Qwen sees its own
// prior refusal and cascades into more refusals. Replace with a neutral placeholder.
const REFUSAL_PATTERNS = [
  /\bI['"']?m sorry,?\s+I\s+cannot\b/gi,
  /\bI\s+cannot\s+(?:help|assist|execute|perform|use|invoke|call)\b/gi,
  /\bI\s+(?:only|can only)\s+answer\b/gi,
  /\boutside\s+(?:my|the)\s+(?:capabilities|scope|abilities)\b/gi,
  /\bTool\s+\S+\s+does\s+not\s+exists?\b/gi,
  /\bI\s+cannot\s+execute\s+this\s+tool\b/gi,
  /\btool\s+\S+\s+is\s+not\s+available\b/gi,
  /\bI\s+am\s+unable\s+to\s+(?:execute|perform|use|invoke|call)\b/gi,
  /\bI\s+don'?t\s+have\s+(?:access\s+to|the\s+ability)\b/gi,
]
function cleanAssistantRefusals(text) {
  if (!text || typeof text !== 'string') return text
  let cleaned = text
  for (const pattern of REFUSAL_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    if (pattern.test(cleaned)) {
      pattern.lastIndex = 0
      cleaned = cleaned.replace(pattern, '[refusal removed]')
    }
  }
  return cleaned
}


/**
 * Flatten OpenAI-style messages into a single prompt string with budget control.
 * Calibrated to Qwen2API's prompt_builder.py budgets:
 * - With tools: 40K total (system capped at 2K, per-role limits applied)
 * - Without tools: 120K total (more relaxed)
 *
 * Per-role caps (tool mode, Claude Code profile):
 *   assistant: 500, user: 1600, tool result: 6000
 * These prevent individual messages from dominating the budget.
 * Original task and latest user message preserved (capped at 900 chars each).
 * Tool result bodies get head+tail truncation at 8K (3K head + 1K tail).
 */
function flattenMessagesToPrompt(messages, systemText, toolPrompt) {
  const hasToolsActive = !!toolPrompt
  const MAX_CHARS = Infinity

  // Per-role message caps when tools are active (matches Qwen2API prompt_builder.py)
const ROLE_LIMITS = {} // No limits — send full context

  const TOOL_RESULT_BODY_LIMIT = Infinity
  const TOOL_RESULT_HEAD = 6000
  const TOOL_RESULT_TAIL = 2000

  // System text: cap at 2000 chars when tools active (Qwen2API pattern)
  let sysPart = ''
  if (systemText) {
    const sysContent = compactSystemReminders(systemText)
    if (false && sysContent.length > 2000) { // Disabled: no system truncation
      sysPart = '<system>\n' + sysContent.slice(0, 2000) + '\n...[system prompt truncated]\n</system>'
    } else {
      sysPart = '<system>\n' + sysContent + '\n</system>'
    }
  }

  const toolsPart = toolPrompt || ''
  const overhead = sysPart.length + toolsPart.length + 50
  let budget = MAX_CHARS - overhead
  if (budget < 2000) budget = 2000

  // Head+tail truncation for large tool result bodies
  function compactToolResultBody(body) {
    if (body.length <= TOOL_RESULT_BODY_LIMIT) return body
    const head = body.slice(0, TOOL_RESULT_HEAD)
    const tail = body.slice(-TOOL_RESULT_TAIL)
    const dropped = body.length - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL
    return head + '\n...[truncated ' + dropped + ' chars from middle]...\n' + tail
  }

  // Per-role truncation
  function truncateByRole(content, _role) {
  return content // No truncation
}

  // Build history from messages, respecting budget.
// Strategy (from Qwen2API Python reference): cap at last 30 messages in tool mode,
// always preserve first user message (original task). When budget overflows,
// the backward scan naturally keeps newest messages.
const MAX_HISTORY_MSGS = 9999 // No cap — send full history
const historyParts = []
let used = 0

// Phase 1: Select messages (cap count, preserve first user)
const selectedMsgs = []
let firstUserMsg = null
for (let i = 0; i < messages.length; i++) {
  const msg = messages[i]
  if (!msg || !msg.content) continue
  if (msg.role === 'system' && systemText && typeof msg.content === 'string' && msg.content.trim() === systemText.trim()) continue
  // Track first user message for ORIGINAL TASK anchor
  if (!firstUserMsg && msg.role === 'user') {
    const txt = typeof msg.content === 'string' ? msg.content.trim() : ''
    if (txt) firstUserMsg = msg
  }
  selectedMsgs.push(msg)
}

// Cap to most recent messages, but keep firstUserMsg if cut
let workingMsgs = selectedMsgs
if (hasToolsActive && selectedMsgs.length > MAX_HISTORY_MSGS) {
  const recent = selectedMsgs.slice(-MAX_HISTORY_MSGS)
  if (firstUserMsg && !recent.includes(firstUserMsg)) {
    workingMsgs = [firstUserMsg, ...recent]
  } else {
    workingMsgs = recent
  }
}

// Phase 2: Convert to text lines, newest-first, respecting budget
for (let i = workingMsgs.length - 1; i >= 0; i--) {
  const msg = workingMsgs[i]
  if (!msg || !msg.content) continue

  let contentStr = ''
  if (typeof msg.content === 'string') {
    contentStr = msg.content
  } else if (Array.isArray(msg.content)) {
    contentStr = msg.content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
  }
  if (!contentStr.trim()) continue

  contentStr = compactSystemReminders(contentStr)
  if (msg.role === 'tool') contentStr = compactToolResultBody(contentStr)
  contentStr = truncateByRole(contentStr, msg.role)

  let line
  if (msg.role === 'user') line = 'Human: ' + contentStr
  else if (msg.role === 'assistant') line = 'Assistant: ' + contentStr.trim()
  else if (msg.role === 'system') line = 'System: ' + contentStr
  else if (msg.role === 'tool') line = '[Tool Result (' + (msg.name || 'tool') + ')]\n' + contentStr + '\n[/Tool Result]'
  else line = contentStr

  if (used + line.length + 2 > budget && historyParts.length > 0) break
  historyParts.unshift(line)
  used += line.length + 2
}

// Preserve original task (capped at 800 chars) — make room if needed
if (hasToolsActive && firstUserMsg) {
  let firstText = typeof firstUserMsg.content === 'string' ? firstUserMsg.content : ''
  firstText = compactSystemReminders(firstText)
  const cap = Infinity
  const truncated = firstText // No truncation
  const firstLine = 'Human (ORIGINAL TASK): ' + truncated
  const firstHistoryPart = historyParts[0] || ''
  if (!firstHistoryPart.includes(firstText.slice(0, 60))) {
    const cost = firstLine.length + 2
    // Make room by removing oldest included messages
    while (used + cost > budget && historyParts.length > 2) {
      const removed = historyParts.shift()
      used -= removed.length + 2
    }
    if (used + cost <= budget) {
      historyParts.unshift(firstLine)
      used += cost
    }
  }
}
  // Inject CURRENT TASK anchor — the most recent user message with priority.
  // This prevents Qwen from losing track of the active task after tool rounds.
  if (hasToolsActive && messages.length > 0) {
    const latestUser = [...messages].reverse().find(m => m.role === 'user' && (typeof m.content === 'string' ? m.content.trim() : ''))
    if (latestUser) {
      let latestText = typeof latestUser.content === 'string' ? latestUser.content : ''
      latestText = compactSystemReminders(latestText)
      const capLatest = 900
      const latestTruncated = latestText.length > capLatest ? latestText.slice(0, capLatest) + '...[latest task truncated]' : latestText
      const latestLine = 'Human (CURRENT TASK - TOP PRIORITY): ' + latestTruncated
      const lastPart = historyParts[historyParts.length - 1] || ''
      if (!lastPart.includes(latestText.slice(0, 60))) {
        if (used + latestLine.length + 2 <= budget) {
          historyParts.push(latestLine)
          used += latestLine.length + 2
        }
      }
    }
  }

  // Assembly order (Qwen2API pattern):
  // [sys_part] [tools_part] [history] Assistant:
  const parts = []
  if (sysPart) parts.push(sysPart)
  if (toolsPart) parts.push(toolsPart)
  parts.push(...historyParts)
  parts.push('Assistant:')

  const result = parts.join('\n\n')
  logger.info('Prompt assembled: ' + result.length + ' chars (system=' + sysPart.length + ', tools=' + toolsPart.length + ', history=' + used + ')', 'ANTHROPIC')
return { prompt: result, sysPart, toolsPart, historyParts, historyChars: used }
}

/**
 * Handle Anthropic Messages API request
 *
 * Uses the noxem single-message flattening pattern + Qwen2API truncation:
 * 1. Convert Anthropic request to OpenAI format (extract system text separately)
 * 2. Process tool calls (fold tool messages, build tool prompt)
 * 3. Flatten ALL messages + system + tool prompt into ONE budget-controlled prompt
 * 4. Send as a single user message with full Qwen v2 API metadata
 * 5. Disable native Qwen tools before every tool-enabled request
 */
const handleAnthropicMessages = async (req, res) => {
  try {
    const anthropicBody = req.body
    const requestedModel = anthropicBody.model || ''
    const isStream = anthropicBody.stream || false

    // Extract system text BEFORE conversion (will be folded into flat prompt)
    let systemText = normalizeAnthropicSystem(anthropicBody.system)

    // Convert Anthropic request to OpenAI format (system is excluded from messages)
    const openaiBody = anthropicToOpenAI({ ...anthropicBody, system: undefined })

    // Map Anthropic model names to Qwen models
    const rawModel = (openaiBody.model || '').toLowerCase().replace(/^anthropic\//, '')
    const mapped = MODEL_MAPPING[rawModel] || MODEL_MAPPING[stripModelSuffix(rawModel)]
  const qwenModel = stripModelSuffix(mapped || rawModel)
// Preserve model suffix for chat_type routing: -search -> chat_type=search
// Only when no custom tools are active (search + custom tools are incompatible)
const originalSuffix = getModelSuffix(rawModel)
  logger.info('Model mapping: requested="' + (anthropicBody.model || '') + '" raw="' + rawModel + '" qwen="' + qwenModel + '"', 'ANTHROPIC')

    // Process tool calls before flattening
    let toolPrompt = ''
    let toolcallEnabled = false
    let rewrittenMessages = openaiBody.messages || []

    if (hasTools(openaiBody)) {
      toolcallEnabled = true

      // Rewrite tool messages just like the middleware does
      const result = injectToolCallContext(rewrittenMessages, openaiBody.tools, openaiBody.tool_choice)
      rewrittenMessages = result.messages
      toolPrompt = result.toolPrompt

      logger.info('Tool-calling active — using prompt injection only', 'TOOLS')

      // Disable native Qwen tools before every tool-enabled request.
      // Settings don't persist — Qwen server resets them, so we must
      // call this before every request that uses tool calling.
      try {
        await disableNativeTools()
        logger.info('Native tools disabled before request', 'TOOLS')
      } catch (e) {
        logger.warn('disableNativeTools failed: ' + e.message, 'TOOLS')
      }
    }

    // Flatten everything into a single budget-controlled prompt string.
    // System text is truncated to 2K chars (Qwen2API pattern) to prevent
    // 30K-char system prompts from causing Qwen to CLOSE the connection.
    // Strip reasoning_content from messages — Alibaba Cloud recommends excluding
// thinking content from conversation history to save ~50% context budget.
// Also clean refusal messages from assistant history — prevents cascading refusals.
for (const msg of rewrittenMessages) {
  if (msg.reasoning_content) delete msg.reasoning_content
  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    msg.content = cleanAssistantRefusals(msg.content)
  }
}
// For tool-call mode, prefix with /no_think to skip reasoning and speed up response.
// This produces faster, more focused tool calls without extended thinking overhead.
if (toolcallEnabled) {
  const noThinkPrefix = '/no_think\n'
  // Insert into the system text if present, or prepend to prompt
  if (systemText) {
    systemText = noThinkPrefix + systemText
  }
}
const { prompt: finalPrompt, sysPart: _sysPart, toolsPart: _toolsPart, historyParts: _historyParts, historyChars: _historyChars } = flattenMessagesToPrompt(rewrittenMessages, systemText, toolPrompt)


// --- Context Offloading (v2: Sliding Window + Structured Summary) ---
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
      // Extract key info for session state summary
      let userReqCount = 0
      let toolCallCount = 0
      let lastUserReq = ''
      const sectionNames = []
      let currentSection = null

      for (const part of archiveParts) {
        if (part.startsWith('Human:') || part.startsWith('Human (')) {
          userReqCount++
          const reqText = part.replace(/^Human(?:\s*\([^)]*\))?\s*/, '').slice(0, 200).trim()
          if (reqText) lastUserReq = reqText
          // Detect topic shifts for sectioning
          if (reqText.length > 20) {
            const label = reqText.slice(0, 60).replace(/[\n\r]/g, ' ').trim()
            if (label && (!currentSection || currentSection !== label)) {
              currentSection = label
              sectionNames.push({ label, msgIndex: archiveParts.indexOf(part) })
            }
          }
        }
        if (part.includes('##TOOL_CALL##')) toolCallCount++
      }

      // Build session state summary with document grounding instructions
      const archiveSizeKB = (archiveParts.join('\n').length / 1024).toFixed(1)
      const summaryLines = [
        '## Session State (archived context summary)',
        '',
        '- **Archive size**: ' + archiveSizeKB + 'KB in attached "conversation-archive.md"',
        '- **Previous user requests**: ' + userReqCount + (lastUserReq ? ' (last: "' + (lastUserReq.length > 150 ? lastUserReq.slice(0, 150) + '...' : lastUserReq) + '")' : ''),
        '- **Tool calls**: ' + toolCallCount + ' calls in archive',
        '- **Sections**: ' + sectionNames.length + ' topics detected (see ToC in attachment)',
        '',
        'CRITICAL: Before responding, review the attached conversation-archive.md. Your current task continues from prior steps. Key findings and decisions are in the document. Read the Table of Contents first, then focus on sections relevant to the current step. The most recent exchanges are shown inline below.',
      ]

      // Build inline prompt: system + tools + archive summary + recent context + Assistant:
      const inlineParts = []
      if (_sysPart) inlineParts.push(_sysPart)
      if (_toolsPart) inlineParts.push(_toolsPart)
      inlineParts.push(summaryLines.join('\n'))
      inlineParts.push(...recentParts)
      inlineParts.push('Assistant:')
      effectivePrompt = inlineParts.join('\n\n')

      // Build markdown-formatted archive with ToC + section headers + observation masking
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
          const toolMatch = part.match(/^\[Tool Result \(([^)]+)\)\]/)
          const toolName = toolMatch ? toolMatch[1] : 'tool'
          // Keep first ~300 chars of result, mask the rest
          const body = part.replace(/^\[Tool Result[^\]]*\]\n?/, '').replace(/\n\[\/Tool Result\]$/, '')
          if (body.length > 500) {
            return '[Tool Result (' + toolName + ')]\n' + body.slice(0, 300) + '\n...[' + (body.length - 300) + ' chars masked. Full content available on request.]\n[/Tool Result]'
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

      const archiveContent = mdLines.join('\n')
      const archiveBuffer = Buffer.from(archiveContent, 'utf-8')
      logger.info('Context offloading: uploading ' + archiveBuffer.length + ' chars of archive (' + archiveParts.length + ' msgs, ' + sectionNames.length + ' sections, ' + tocEntries.length + ' ToC entries), keeping ' + recentParts.length + ' recent msgs inline', 'OFFLOAD')
      const uploadResult = await uploadFileToQwenOss(archiveBuffer, 'conversation-archive.md', authToken)

      if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {
        const fileId = uploadResult.file_id || ''
        const fileUrl = uploadResult.file_url
        const fileSize = archiveBuffer.length
        const itemId = generateUUID()
        const taskId = generateUUID()

        offloadedFiles = [{
          type: 'file',
          file_class: 'document',
          file_type: 'text/markdown',
          showType: 'file',
          id: fileId,
          url: fileUrl,
          name: 'conversation-archive.md',
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
            filename: 'conversation-archive.md',
            user_id: '',
            created_at: Date.now(),
            update_at: Date.now(),
            data: {},
            hash: null,
            meta: {
              name: 'conversation-archive.md',
              size: fileSize,
              content_type: 'text/markdown'
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

// Determine thinking config
    let thinkingConfig = { output_schema: 'phase', thinking_enabled: false }
    if (openaiBody.enable_thinking) {
      thinkingConfig = isThinkingEnabled(
        qwenModel,
        openaiBody.enable_thinking,
        openaiBody.thinking_budget,
        openaiBody.reasoning_effort
      )
    }

    // Build the Qwen request body matching Qwen2API's payload structure exactly.
    // Qwen's v2 API expects: version, parent_id, timestamp at top level,
    // and each message needs: fid, parentId, childrenIds, user_action,
    // files, timestamp, models, parent_id — in addition to role/content.
    // feature_config MUST include function_calling: false, enable_tools: false,
    // enable_function_call: false, tool_choice: "none" to prevent Qwen's
    // server-side tool validator from intercepting custom tool names.
    const msgFid = generateUUID()
    const msgTimestamp = Math.floor(Date.now() / 1000)
    const parentId = null

    // Determine chat_type based on model suffix and tool state
// -search suffix + no tools -> chat_type=search (enables web search in thinking)
// tools active or no -search -> chat_type=t2t
const effectiveChatType = (!toolcallEnabled && originalSuffix === '-search') ? 'search' : 't2t'

const requestBody = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: null,
      chat_mode: 'normal',
      model: qwenModel,
  chat_type: effectiveChatType,
      parent_id: parentId,
      messages: [
        {
          fid: msgFid,
          parentId: parentId,
          childrenIds: [],
          role: 'user',
          content: effectivePrompt,
          user_action: 'chat',
          files: offloadedFiles,
          timestamp: msgTimestamp,
          models: [qwenModel],
          chat_type: effectiveChatType,
          feature_config: {
            thinking_enabled: toolcallEnabled ? false : (thinkingConfig.thinking_enabled || false),
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: toolcallEnabled ? false : true,
            thinking_mode: thinkingConfig.thinking_enabled ? 'Thinking' : 'Auto',
            thinking_format: 'summary',
            auto_search: effectiveChatType === "search" || !toolcallEnabled,
            code_interpreter: false,
            plugins_enabled: false,
            function_calling: false,
            enable_tools: false,
            enable_function_call: false,
            tool_choice: toolcallEnabled ? 'none' : undefined,
          },
          extra: {
            meta: {
              subChatType: effectiveChatType,
            },
          },
          sub_chat_type: effectiveChatType,
          parent_id: parentId,
        },
      ],
      sub_chat_type: effectiveChatType,
      timestamp: msgTimestamp + 1,
    }

    logger.info(`DEBUG payload: model=${qwenModel} chat_type=${effectiveChatType} toolcall=${toolcallEnabled} content_len=${finalPrompt.length}`, 'ANTHROPIC')

// Store tool state for stream/accumulate processing
    req.toolcall_enabled = toolcallEnabled
    req.enable_thinking = thinkingConfig.thinking_enabled
    req.body = requestBody

    // Send request to upstream - retry up to 2 times on connection errors
    let response_data = null
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response_data = await sendChatRequest(requestBody)
        if (response_data && response_data.status && response_data.response) break
        lastErr = new Error('Empty response from upstream')
      } catch (err) {
        lastErr = err
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
          logger.warn('Anthropic upstream connection error (attempt ' + (attempt + 1) + '/3)', 'ANTHROPIC')
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        throw err
      }
    }

    if (!response_data || !response_data.status || !response_data.response) {
  if (response_data && response_data.chatId) deleteChat(response_data.chatId, response_data.currentToken)
  return res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed after retries: ' + (lastErr ? lastErr.message : 'empty response') }
      })
    }

    if (isStream) {
    // Buffer-then-stream: accumulate first (with retry on empty), then emit as SSE
    let openaiResponse = null
    let retriedForToolChoice = false
    let finalData = response_data
    for (let attempt = 0; attempt < 3; attempt++) {
      openaiResponse = await accumulateResponse(finalData.response, req.enable_thinking, toolcallEnabled)
      const hasContent = openaiResponse.choices && openaiResponse.choices[0] && (openaiResponse.choices[0].message?.content || openaiResponse.choices[0].message?.tool_calls?.length > 0)
      if (hasContent) break
      logger.warn("Empty stream response (attempt " + (attempt + 1) + "/3), retrying...", "ANTHROPIC")
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        if (finalData.chatId) deleteChat(finalData.chatId, finalData.currentToken)
        const rData = await sendChatRequest(requestBody)
        if (rData && rData.status && rData.response) {
          finalData = rData
        }
      }
    }
    if (finalData.chatId) deleteChat(finalData.chatId, finalData.currentToken)

    // tool_choice=required retry: if tools were active but model returned text
    // instead of tool calls, retry once with a stronger hint appended to prompt.
    if (toolcallEnabled && !retriedForToolChoice && (openaiBody.tool_choice === 'required' || openaiBody.tool_choice === 'any')) {
      const tc0 = openaiResponse.choices?.[0]?.message?.tool_calls?.length || 0
      const cl0 = openaiResponse.choices?.[0]?.message?.content?.length || 0
      if (tc0 === 0 && cl0 > 0) {
        logger.info("Tool-choice required but got text — retrying with stronger hint", "ANTHROPIC")
        retriedForToolChoice = true
        const hintPrompt = effectivePrompt + '\n\n[IMPORTANT: You MUST use a tool call (##TOOL_CALL##...##END_CALL##) to answer this. Do NOT respond with plain text.]'
        const retryBody = { ...requestBody, messages: [{ ...requestBody.messages[0], content: hintPrompt }] }
        try {
          const retryData = await sendChatRequest(retryBody)
          if (retryData && retryData.status && retryData.response) {
            const retryResponse = await accumulateResponse(retryData.response, req.enable_thinking, toolcallEnabled)
            const retryTc = retryResponse.choices?.[0]?.message?.tool_calls?.length || 0
            if (retryTc > 0) {
              logger.info("tool_choice retry succeeded: got " + retryTc + " tool calls", "ANTHROPIC")
              openaiResponse = retryResponse
              if (retryData.chatId) deleteChat(retryData.chatId, retryData.currentToken)
            } else {
              if (retryData.chatId) deleteChat(retryData.chatId, retryData.currentToken)
            }
          }
        } catch (retryErr) {
          logger.warn("tool_choice retry failed: " + retryErr.message, "ANTHROPIC")
        }
      }
    }

    // Set Anthropic SSE headers
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    const anthropicResp = openaiToAnthropicResponse(openaiResponse, requestedModel)
    const tc = openaiResponse.choices?.[0]?.message?.tool_calls?.length || 0
    const cl = openaiResponse.choices?.[0]?.message?.content?.length || 0
    logger.info("Stream-accumulated response: stop_reason=" + (openaiResponse.choices?.[0]?.finish_reason) + " tool_calls=" + tc + " content_len=" + cl + " anthropic_blocks=" + anthropicResp.content.length, "ANTHROPIC")
    if (tc === 0 && cl > 0) {
      const rawContent = openaiResponse.choices?.[0]?.message?.content || ''
      logger.info("Raw model output (FULL): " + rawContent, "ANTHROPIC")
      const hexDump = []
      for (let i = 0; i < Math.min(rawContent.length, 200); i++) {
        const code = rawContent.charCodeAt(i)
        if (code > 127 || code === 60 || code === 40) hexDump.push({i, char: rawContent[i], hex: 'U+' + code.toString(16).padStart(4, '0'), dec: code, context: rawContent.substring(Math.max(0,i-3), Math.min(rawContent.length,i+4))})
      }
      if (hexDump.length) logger.info("Special chars in output: " + JSON.stringify(hexDump.slice(0, 20)), "ANTHROPIC")
    }
    res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: anthropicResp.id, type: 'message', role: 'assistant', model: anthropicResp.model, content: [], stop_reason: null, stop_sequence: null, usage: anthropicResp.usage } }) + '\n\n')
    res.write('event: ping\ndata: ' + JSON.stringify({ type: 'ping' }) + '\n\n')
    for (let i = 0; i < anthropicResp.content.length; i++) {
      const block = anthropicResp.content[i]
      if (block.type === 'thinking') {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } }) + '\n\n')
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: block.thinking } }) + '\n\n')
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: i }) + '\n\n')
      } else if (block.type === 'text') {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }) + '\n\n')
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }) + '\n\n')
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: i }) + '\n\n')
      } else if (block.type === 'tool_use') {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }) + '\n\n')
        // Chunk input_json_delta into 32-char pieces (Rfym21/Qwen2API pattern)
        const inputJson = JSON.stringify(block.input)
        const CHUNK_SIZE = 32
        for (let offset = 0; offset < inputJson.length; offset += CHUNK_SIZE) {
          const chunk = inputJson.slice(offset, offset + CHUNK_SIZE)
          res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: chunk } }) + '\n\n')
        }
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: i }) + '\n\n')
      }
    }
    res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: anthropicResp.stop_reason, stop_sequence: null }, usage: { output_tokens: anthropicResp.usage.output_tokens } }) + '\n\n')
    res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n')
    res.end()
  }
    else {
    // Non-streaming: accumulate, retry on empty response (upstream CLOSE)
    let openaiResponse = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        openaiResponse = await accumulateResponse(response_data.response, req.enable_thinking, toolcallEnabled, res)
      } catch (accErr) {
        logger.warn('accumulateResponse error in non-stream (attempt ' + (attempt + 1) + '/3): ' + (accErr.code || accErr.message), 'ANTHROPIC')
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          const retryData = await sendChatRequest(requestBody)
          if (retryData && retryData.status && retryData.response) {
            deleteChat(response_data.chatId, response_data.currentToken)
            response_data = retryData
          }
        }
        continue
      }
      const hasContent = openaiResponse.choices &&
        openaiResponse.choices[0] &&
        (openaiResponse.choices[0].message?.content || openaiResponse.choices[0].message?.tool_calls?.length > 0)
      if (hasContent) break
      logger.warn("Empty non-stream response (attempt " + (attempt + 1) + "/3), retrying...", "ANTHROPIC")
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        const retryData = await sendChatRequest(requestBody)
          if (retryData && retryData.status && retryData.response) {
            deleteChat(response_data.chatId, response_data.currentToken)
            response_data = retryData
        }
      }
    }
    const anthropicResponse = openaiToAnthropicResponse(openaiResponse, requestedModel)
  res.json(anthropicResponse)
  deleteChat(response_data.chatId, response_data.currentToken)
 }
  } catch (error) {
    logger.error('Anthropic Messages API error', 'ANTHROPIC', '', error)
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: error.message || 'Internal server error' }
    })
  }
}

// Routes
router.post('/v1/messages', anthropicKeyVerify, handleAnthropicMessages)
router.post('/anthropic/v1/messages', anthropicKeyVerify, handleAnthropicMessages)

module.exports = router
