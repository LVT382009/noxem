const { generateUUID } = require('../utils/tools.js')
const { isChatType, isThinkingEnabled, parserModel, parserMessages } = require('../utils/chat-helpers.js')
const accountManager = require('../utils/account.js')
const { logger } = require('../utils/logger')
const {
  hasTools,
  buildToolPromptBlock,
  serializeAssistantToolCalls,
  serializeToolResult,
} = require('../utils/toolcall.js')
const { getUploadedFiles } = require('../routes/files.js')

/**
 * Rewrite OpenAI-style messages so the upstream model (which has no native
 * tool calling) sees a textual conversation. Only invoked when the request
 * carries a non-empty `tools` array.
 *
 * - assistant.tool_calls -> tool_call JSON format appended to content
 * - role:tool -> role:user with a tool_response block
 * - tool prompt is returned separately for the caller to embed
 */
function injectToolCallContext(messages, tools, toolChoice) {
  // Build tool_call_id -> name lookup from assistant messages
  // so tool result messages can include the tool name in the XML attributes
  const idToName = {}
  for (const m of (messages || [])) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function && tc.function.name) {
          idToName[tc.id] = tc.function.name
        }
      }
    }
  }

  const rewritten = (messages || []).map((m) => {
    if (!m || typeof m !== 'object') return m
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const dsml = serializeAssistantToolCalls(m.tool_calls)
      const baseText = typeof m.content === 'string' ? m.content : ''
      const merged = baseText ? baseText + '\n' + dsml : dsml
      const out = { ...m, content: merged }
      delete out.tool_calls
      return out
    }
    if (m.role === 'tool') {
      // Enrich with tool name from the preceding assistant tool_calls
      const name = m.name || idToName[m.tool_call_id] || ''
      return { role: 'user', content: serializeToolResult({ ...m, name }) }
    }
    return m
  })
  const promptBlock = buildToolPromptBlock(tools, toolChoice)
  // Return rewritten messages WITHOUT the tool system message.
  // The caller prepends the tool prompt to the last user message instead.
  return { messages: rewritten, toolPrompt: promptBlock }
}

/**
 * Process chat request body middleware
 * Parse and transform request parameters to internal format
 */
const processRequestBody = async (req, res, next) => {
  try {
    // Wait for the account manager's first signin to land before doing
    // anything else. parserMessages -> normalizeMediaContentItem ->
    // uploadFileToQwenOss needs a token; without this guard the very
    // first concurrent requests on a Vercel cold start fail with
    // "Missing required upload parameters" and the user sees the model
    // get a [image] text placeholder instead of the real image.
    if (typeof accountManager.ensureInitialized === 'function') {
      try { await accountManager.ensureInitialized() } catch { /* fall through */ }
    }

    const body = {
      "stream": true,
      "incremental_output": true,
      "chat_type": "t2t",
      "model": "qwen3-235b-a22b",
      "messages": [],
      "session_id": generateUUID(),
      "id": generateUUID(),
      "sub_chat_type": "t2t",
      "chat_mode": "normal"
    }

    let {
      messages,
      model,
      stream,
      enable_thinking,
      thinking_budget,
      reasoning_effort,
      size
    } = req.body

    // Process stream parameter
    if (stream === true || stream === 'true') {
      body.stream = true
    } else {
      body.stream = false
    }

    // Process chat_type
    body.chat_type = isChatType(model)
    req.enable_web_search = body.chat_type === 'search' ? true : false

    // Process model
    body.model = await parserModel(model)

    // Tool-call gate: only activate when the client actually sent `tools`.
    // When inactive, behavior is byte-identical to before this feature existed.
    req.toolcall_enabled = false
    let toolPrompt = ''
    if (hasTools(req.body)) {
      req.toolcall_enabled = true
      req.toolcall_tools = req.body.tools
      req.toolcall_choice = req.body.tool_choice
      const result = injectToolCallContext(messages, req.body.tools, req.body.tool_choice)
      messages = result.messages
      toolPrompt = result.toolPrompt

      // Do NOT pass tools or feature_config in the request body.
      // The Qwen web API does NOT support these fields at the body level —
      // they cause silent stream rejection (~8s close).
      // Tool calling is handled entirely via prompt injection (buildToolPromptBlock).
      logger.info("Tool-calling active — using prompt injection only", "TOOLS")
    }

    // Process messages
    body.messages = await parserMessages(messages, isThinkingEnabled(model, enable_thinking, thinking_budget, reasoning_effort), body.chat_type)

    // Resolve file_ids to QwenFile objects and inject into first user message
    if (Array.isArray(req.body.file_ids) && req.body.file_ids.length > 0) {
      const resolvedFiles = getUploadedFiles(req.body.file_ids)
      if (resolvedFiles.length > 0 && body.messages.length > 0) {
        const target = body.messages.find(m => m.role === 'user') || body.messages[0]
        target.files = [...(target.files || []), ...resolvedFiles]
        logger.info(`Attached ${resolvedFiles.length} file(s) to message (file_ids: ${req.body.file_ids.join(',')})`, 'FILES')
      }
    }

    // Qwen2API approach: prepend tool prompt to the LAST user message content.
    // This keeps the prompt close to where the model generates its response,
    // avoids the "system:<37K-chars>" inflation that chat-helpers creates,
    // and matches the pattern that Qwen models are most responsive to.
    if (toolPrompt && Array.isArray(body.messages) && body.messages.length > 0) {
      const last = body.messages[body.messages.length - 1]
      if (typeof last.content === 'string') {
        last.content = toolPrompt + '\n\n' + last.content
      } else if (Array.isArray(last.content)) {
        const textIdx = last.content.findIndex(c => c && c.type === 'text')
        if (textIdx >= 0) {
          last.content[textIdx].text = toolPrompt + '\n\n' + (last.content[textIdx].text || '')
        } else {
          last.content.unshift({
            type: 'text',
            text: toolPrompt,
            chat_type: 't2t',
            feature_config: { output_schema: 'phase', thinking_enabled: false }
          })
        }
      }
      logger.info('Tool prompt prepended to last message (' + toolPrompt.length + ' chars)', 'TOOLS')
    }

    // Process enable_thinking
    req.enable_thinking = isThinkingEnabled(model, enable_thinking, thinking_budget, reasoning_effort).thinking_enabled

    // Process sub_chat_type
    body.sub_chat_type = body.chat_type

    // Process image size
    if (size) {
      body.size = size
    }

    req.body = body
    next()
  } catch (e) {
    logger.error('Error processing request body', 'MIDDLEWARE', '', e)
    res.status(500).json({
      status: 500,
      message: "Error processing request body"
    })
  }
}

module.exports = {
  processRequestBody,
  injectToolCallContext
}
