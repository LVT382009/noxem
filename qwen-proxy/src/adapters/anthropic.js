/**
 * Anthropic Messages API adapter
 * Converts between Anthropic format and internal OpenAI format
 * and streams Qwen raw SSE directly to Anthropic SSE (no fakeRes interception)
 */

const { createSieve, deobfuscateToolName, cryptoRandom, parseToolCallsFromText, cleanToolRefusal } = require('../utils/toolcall.js')
const { logger } = require('../utils/logger')

/**
 * Convert Anthropic Messages API request to OpenAI chat completions format
 */
function anthropicToOpenAI(anthropicBody) {
  const messages = []

  // system is extracted by the Anthropic route handler and prepended
  // to the last user message AFTER parserMessages (Qwen2API pattern).
  // When the caller sets system: undefined, skip adding it as a message.
  if (anthropicBody.system) {
    const systemText = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : anthropicBody.system.map(b => b.text).join('\n')
    messages.push({ role: 'system', content: systemText })
  }

  // Convert messages
  for (const msg of anthropicBody.messages || []) {
    const role = msg.role // "user" or "assistant"

    if (typeof msg.content === 'string') {
      messages.push({ role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (role === 'assistant') {
      const openaiContent = []
      const toolCalls = []
      for (const block of msg.content) {
        if (block.type === 'text') {
          openaiContent.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`
          openaiContent.push({ type: 'image_url', image_url: { url: dataUrl } })
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
          })
        } else if (block.type === 'thinking') {
          continue
        }
      }
      const m = { role: 'assistant' }
      if (openaiContent.length === 1 && openaiContent[0].type === 'text') {
        m.content = openaiContent[0].text
      } else if (openaiContent.length > 0) {
        m.content = openaiContent
      } else {
        m.content = ''
      }
      if (toolCalls.length > 0) m.tool_calls = toolCalls
      messages.push(m)
      continue
    }

    // role === 'user': split tool_result blocks into separate role:'tool' msgs
    const userText = []
    const toolResults = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        userText.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`
        userText.push({ type: 'image_url', image_url: { url: dataUrl } })
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string' ? block.content :
          (Array.isArray(block.content) ? block.content.map(c => c.text || JSON.stringify(c)).join('') : JSON.stringify(block.content))
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, name: block.name || '', content: resultText })
      }
    }
    if (userText.length === 1 && userText[0].type === 'text') {
      messages.push({ role: 'user', content: userText[0].text })
    } else if (userText.length > 0) {
      messages.push({ role: 'user', content: userText })
    }
    for (const t of toolResults) messages.push(t)
  }

  // thinking config conversion
  let enable_thinking = false
  let thinking_budget = undefined
  let reasoning_effort = undefined

  if (anthropicBody.thinking) {
    if (anthropicBody.thinking.type === 'enabled') {
      enable_thinking = true
      thinking_budget = anthropicBody.thinking.budget_tokens
    } else if (anthropicBody.thinking.type === 'adaptive') {
      enable_thinking = true
      reasoning_effort = 'high'
    }
  }

  // tools and tool_choice
  let tools = undefined
  if (Array.isArray(anthropicBody.tools) && anthropicBody.tools.length > 0) {
    tools = anthropicBody.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }))
  }
  let tool_choice = undefined
  const tc = anthropicBody.tool_choice
  if (tc && typeof tc === 'object') {
    if (tc.type === 'auto') tool_choice = 'auto'
    else if (tc.type === 'any') tool_choice = 'required'
    else if (tc.type === 'tool' && tc.name) tool_choice = { type: 'function', function: { name: tc.name } }
    else if (tc.type === 'none') tool_choice = 'none'
  }

  const out = {
    model: anthropicBody.model || '',
    messages,
    max_tokens: anthropicBody.max_tokens,
    stream: anthropicBody.stream || false,
    temperature: anthropicBody.temperature,
    top_p: anthropicBody.top_p,
    enable_thinking,
    thinking_budget,
    reasoning_effort,
    stop: anthropicBody.stop_sequences,
  }
  if (tools) out.tools = tools
  if (tool_choice !== undefined) out.tool_choice = tool_choice
  return out
}

/**
 * Convert OpenAI non-streaming response to Anthropic Messages format
 */
function openaiToAnthropicResponse(openaiResponse, model) {
  const choice = openaiResponse.choices && openaiResponse.choices[0]
  const content = []

  // reasoning_content -> thinking block
  if (choice && choice.message && choice.message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
      signature: 'ErUB3v3gG0'
    })
  }

  // content -> text block
  if (choice && choice.message && choice.message.content) {
    content.push({
      type: 'text',
      text: choice.message.content
    })
  }

  // tool_calls -> tool_use blocks
  let hasToolUse = false
  if (choice && choice.message && Array.isArray(choice.message.tool_calls)) {
    for (const tc of choice.message.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* keep empty */ }
      const id = (tc.id && tc.id.startsWith('toolu_') ? tc.id : `toolu_${(tc.id || '').replace(/^call_/, '') || Date.now()}`)
      content.push({
        type: 'tool_use',
        id,
        name: deobfuscateToolName(tc.function.name),
        input
      })
      hasToolUse = true
    }
  }

  // stop_reason mapping
  let stop_reason = 'end_turn'
  if (hasToolUse || (choice && choice.finish_reason === 'tool_calls')) {
    stop_reason = 'tool_use'
  } else if (choice && choice.finish_reason === 'length') {
    stop_reason = 'max_tokens'
  } else if (choice && choice.finish_reason === 'stop') {
    stop_reason = 'end_turn'
  } else if (choice && choice.finish_reason) {
    stop_reason = choice.finish_reason
  }

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: (openaiResponse.usage && openaiResponse.usage.prompt_tokens) || 0,
      output_tokens: (openaiResponse.usage && openaiResponse.usage.completion_tokens) || 0,
    }
  }
}

/**
 * Stream Qwen raw SSE upstream directly to Anthropic SSE format.
 * Reads Qwen's delta.phase (think/answer) natively — no fakeRes, no handleStreamResponse.
 *
 * @param {http.ServerResponse} clientRes - The Express response to the Anthropic client
 * @param {http.IncomingMessage} upstreamResponse - The raw Qwen SSE stream
 * @param {string} model - The model name to report back to the client
 * @param {boolean} toolcallEnabled - Whether tool_call format sieve extraction is active
 */
function streamQwenToAnthropic(clientRes, upstreamResponse, model, toolcallEnabled = false, onComplete = null) {
let streamCompleted = false
const safeOnComplete = () => { if (!streamCompleted) { streamCompleted = true; if (onComplete) { try { onComplete() } catch {} } } }
const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let blockIndex = 0
  let inThinking = false
  let inText = false
  let hasToolUse = false
  let lastFinishReason = null
  let inputTokens = 0
  let outputTokens = 0
  let currentPhase = null
  let emittedImageSet = new Set()
  let pendingImageList = []

  // Tool-call sieve: buffers content until tool_call close tag,
  // then parses the complete block and emits tool_calls deltas in one shot
  const sieve = toolcallEnabled ? createSieve() : null

  // Stream timeout: WAF kills idle connections at ~120s. We destroy at 110s to win the race.
  let streamTimeout = null
  const resetStreamTimeout = () => {
    if (streamTimeout) clearTimeout(streamTimeout)
    streamTimeout = setTimeout(() => {
      logger.error('Anthropic stream timeout - no data for 300s, destroying upstream', 'ANTHROPIC')
      try { upstreamResponse.destroy() } catch {}
    }, 110000)
  }
  resetStreamTimeout()

  // Keep-alive pings: send SSE comments every 15s during thinking silence.
// Without these, intermediate proxies/nginx/Cloudflare will kill idle
// connections after 60-120s of no data, causing mid-task disconnections.
let keepAliveInterval = setInterval(() => {
    if (clientRes.writableEnded) {
      clearInterval(keepAliveInterval)
      return
    }
    clientRes.write(`: keep-alive

`)
  }, 15000)

// Detect client disconnect — stop upstream if client is gone
  clientRes.on("close", () => {
    if (!clientRes.writableFinished) {
      logger.warn("Anthropic client disconnected mid-stream, destroying upstream", "ANTHROPIC")
      clearInterval(keepAliveInterval)
      if (streamTimeout) clearTimeout(streamTimeout)
      try { upstreamResponse.destroy() } catch {}
    }
  })

  const writeEvent = (eventType, data) => {
    if (clientRes.writableEnded) return
    clientRes.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const closeThinkingBlock = () => {
    if (inThinking) {
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: 'ErUB3v3gG0' }
      })
      writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
      blockIndex++
      inThinking = false
    }
  }

  const closeTextBlock = () => {
    if (inText) {
      writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
      blockIndex++
      inText = false
    }
  }

  const closeOpenBlocks = () => {
    closeThinkingBlock()
    closeTextBlock()
  }

  // --- message_start ---
  writeEvent('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })

  // --- ping ---
  writeEvent('ping', { type: 'ping' })

  // --- Process Qwen upstream data ---
  upstreamResponse.on('data', (chunk) => {
    resetStreamTimeout()
    const decodeText = decoder.decode(chunk, { stream: true })
    buffer += decodeText

    // Parse Qwen SSE: split on 'data: ...' followed by '\n\n'
    const sseChunks = []
    let startIndex = 0
    while (true) {
      const dataStart = buffer.indexOf('data: ', startIndex)
      if (dataStart === -1) break
      const dataEnd = buffer.indexOf('\n\n', dataStart)
      if (dataEnd === -1) break
      sseChunks.push(buffer.substring(dataStart, dataEnd).trim())
      startIndex = dataEnd + 2
    }
    if (startIndex > 0) buffer = buffer.substring(startIndex)

    for (const item of sseChunks) {
      try {
        let dataContent = item.replace('data: ', '')
        let parsed = null
        try { parsed = JSON.parse(dataContent) } catch { continue }
        if (!parsed || !parsed.choices || parsed.choices.length === 0) continue

        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || inputTokens
          outputTokens = parsed.usage.completion_tokens || outputTokens
        }

        const delta = parsed.choices[0].delta
        if (!delta) continue

        // Handle inline images from Qwen
        if (delta.extra && delta.extra.image_list) {
          for (const img of delta.extra.image_list) {
            if (img && img.image && !emittedImageSet.has(img.image)) {
              emittedImageSet.add(img.image)
              if (currentPhase === 'think') {
                pendingImageList.push(`![](${img.image})\n\n`)
              } else {
                if (!inText) {
                  writeEvent('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' }
                  })
                  inText = true
                }
                writeEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: `![](${img.image})\n\n` }
                })
              }
            }
          }
        }

        // We only process deltas with phase === 'think' or 'answer'
        if (!delta.content || (delta.phase !== 'think' && delta.phase !== 'answer')) continue

        const content = delta.content

        if (delta.phase === 'think') {
          // --- Thinking phase -> Anthropic thinking block ---
          if (currentPhase !== 'think') {
            closeTextBlock()
            currentPhase = 'think'
          }
          if (!inThinking) {
            writeEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'thinking', thinking: '', signature: '' }
            })
            inThinking = true
          }
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'thinking_delta', thinking: content }
          })
        } else if (delta.phase === 'answer') {
          // --- Answer phase -> Anthropic text block ---
          if (currentPhase === 'think') {
            // Transition from think to answer: close thinking block
            closeThinkingBlock()
            currentPhase = 'answer'

            // Flush any pending images that arrived during thinking
            if (pendingImageList.length > 0) {
              if (!inText) {
                writeEvent('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' }
                })
                inText = true
              }
              const pendingImg = pendingImageList.join('')
              writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: pendingImg }
              })
              pendingImageList = []
            }
          } else {
            currentPhase = 'answer'
          }

          // Run content through tool-call sieve if enabled
          if (sieve) {
            const out = sieve.push(content)
            // Strip tool-refusal text from sieve output
            if (out.textDelta) {
              const cleaned = cleanToolRefusal(out.textDelta)
              if (cleaned !== null) out.textDelta = cleaned
              if (!inText) {
                writeEvent('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' }
                })
                inText = true
              }
              writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: out.textDelta }
              })
            }
            if (out.toolCallsDelta && out.toolCallsDelta.length > 0) {
              closeOpenBlocks()
              for (const tc of out.toolCallsDelta) {
                let id = (tc && tc.id) || ''
                if (id && !id.startsWith('toolu_')) id = `toolu_${id.replace(/^call_/, '')}`
                if (!id) id = `toolu_${cryptoRandom()}`
                const name = deobfuscateToolName((tc && tc.function && tc.function.name) || '')
                const args = (tc && tc.function && tc.function.arguments) || '{}'
                writeEvent('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'tool_use', id, name, input: {} }
                })
                writeEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: '' }
                })
                writeEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: args }
                })
                writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                blockIndex++
                hasToolUse = true
              }
            }
          } else {
            // No sieve: direct text output
            if (!inText) {
              writeEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' }
              })
              inText = true
            }
            writeEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: content }
            })
          }
        }
      } catch (error) {
        logger.error('Anthropic stream data processing error', 'ANTHROPIC', '', error)
      }
    }
  })

  upstreamResponse.on('close', () => {
  safeOnComplete()
    if (streamTimeout) clearTimeout(streamTimeout)
    clearInterval(keepAliveInterval)
    logger.warn('Anthropic upstream CLOSE event (socket closed)', 'ANTHROPIC')
    // If the stream was already ended normally, do nothing.
    // If not, close gracefully so the client doesn't hang.
    if (!clientRes.writableEnded) {
      closeOpenBlocks()
      writeEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens }
      })
      writeEvent('message_stop', { type: 'message_stop' })
      clientRes.end()
    }
  })

  upstreamResponse.on('error', (err) => {
    if (streamTimeout) clearTimeout(streamTimeout)
    logger.error('Anthropic upstream stream error', 'ANTHROPIC', '', err)
    closeOpenBlocks()
    writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens }
    })
    writeEvent('message_stop', { type: 'message_stop' })
    if (!clientRes.writableEnded) clientRes.end()
  })

  upstreamResponse.on('end', () => {
    if (streamTimeout) clearTimeout(streamTimeout)

    // Flush any remaining content in the tool-call sieve
    if (sieve) {
      const out = sieve.flush()
      // Strip tool-refusal text from flush
      if (out.textDelta) {
        const cleaned = cleanToolRefusal(out.textDelta)
        if (cleaned !== null) out.textDelta = cleaned
        if (!inText) {
          writeEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
          })
          inText = true
        }
        writeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: out.textDelta }
        })
      }
      if (out.toolCallsDelta && out.toolCallsDelta.length > 0) {
        closeOpenBlocks()
        for (const tc of out.toolCallsDelta) {
          let id = (tc && tc.id) || ''
          if (id && !id.startsWith('toolu_')) id = `toolu_${id.replace(/^call_/, '')}`
          if (!id) id = `toolu_${cryptoRandom()}`
          const name = deobfuscateToolName((tc && tc.function && tc.function.name) || '')
          const args = (tc && tc.function && tc.function.arguments) || '{}'
          writeEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} }
          })
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: '' }
          })
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: args }
          })
          writeEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
          blockIndex++
          hasToolUse = true
        }
      }
    }

    closeOpenBlocks()

    const stopReason = hasToolUse ? 'tool_use' : 'end_turn'

    writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    })

    writeEvent('message_stop', { type: 'message_stop' })
    if (!clientRes.writableEnded) clientRes.end()
  safeOnComplete()
})

}

module.exports = {
  anthropicToOpenAI,
  openaiToAnthropicResponse,
  streamQwenToAnthropic
}
