const { logger } = require('./logger')
const { cleanToolRefusal, parseToolCallsFromText, stripToolResultBlocks } = require('./toolcall')

/**
 * Accumulate upstream Qwen SSE response into a single OpenAI-format response object.
 * Handles Qwen's raw delta.phase format (think/answer) and <tool> format tool-call extraction.
 * Supports keep-alive pings and client disconnect detection when res is provided.
 *
 * @param {Stream} response - Upstream Qwen SSE response stream
 * @param {boolean} enable_thinking - Whether thinking/reasoning phase is enabled
 * @param {boolean} toolcallEnabled - Whether tool-call extraction should run
 * @param {http.ServerResponse|null} res - Optional client response for keep-alive + disconnect detection
 * @returns {Promise<Object>} OpenAI-format response object
 */
function accumulateResponse(response, enable_thinking, toolcallEnabled = false, res = null) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullContent = ''
    let reasoningContent = ''
    let currentPhase = null
    let totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    let clientDisconnected = false

    // Keep-alive pings during accumulation: send SSE comments every 15s.
    // Without these, intermediate proxies kill idle connections during long Qwen generations.
    // Only active when res has already had its headers sent (SSE stream already established).
    let keepAliveInterval = null
    if (res && !res.writableEnded && res.headersSent) {
      keepAliveInterval = setInterval(() => {
        if (res.writableEnded || clientDisconnected) {
          clearInterval(keepAliveInterval)
          return
        }
        try { res.write(': keep-alive\n\n') } catch {}
      }, 15000)
    }

    // Detect client disconnect — stop upstream if client is gone.
    if (res) {
      res.on('close', () => {
        if (!res.writableFinished && !clientDisconnected) {
          clientDisconnected = true
          logger.warn('Client disconnected during accumulation, destroying upstream', 'ACCUMULATE')
          if (keepAliveInterval) clearInterval(keepAliveInterval)
          try { response.destroy() } catch {}
        }
      })
    }

    const cleanup = () => {
      if (keepAliveInterval) clearInterval(keepAliveInterval)
    }

    response.on('data', (chunk) => {
      const decodeText = decoder.decode(chunk, { stream: true })
      buffer += decodeText

      // Parse Qwen SSE format
      const chunks = []
      let startIndex = 0
      while (true) {
        const dataStart = buffer.indexOf('data: ', startIndex)
        if (dataStart === -1) break
        const dataEnd = buffer.indexOf('\n\n', dataStart)
        if (dataEnd === -1) break
        chunks.push(buffer.substring(dataStart, dataEnd).trim())
        startIndex = dataEnd + 2
      }
      if (startIndex > 0) buffer = buffer.substring(startIndex)

      for (const item of chunks) {
        try {
          let dataContent = item.replace('data: ', '')
          let parsed = null
          try { parsed = JSON.parse(dataContent) } catch { continue }
          if (!parsed || !parsed.choices || parsed.choices.length === 0) continue

          if (parsed.usage) {
            totalTokens = {
              prompt_tokens: parsed.usage.prompt_tokens || totalTokens.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens || totalTokens.completion_tokens,
              total_tokens: parsed.usage.total_tokens || totalTokens.total_tokens,
            }
          }

          const delta = parsed.choices[0].delta
          if (!delta) continue
            // Capture web_search_info: skip web_search deltas to prevent metadata leaks
            if (delta && delta.name === 'web_search') continue

          // Handle inline images
          if (delta.extra && delta.extra.image_list) {
            for (const img of delta.extra.image_list) {
              if (img && img.image) fullContent += `![](${img.image})\n\n`
            }
          }

          if (delta.content && delta.phase === 'think') {
            currentPhase = 'think'
            reasoningContent += delta.content
          } else if (delta.content && delta.phase === 'answer') {
            currentPhase = 'answer'
            fullContent += delta.content
          } else if (delta.content && !delta.phase) {
            // Phaseless deltas often contain echoed format markers when toolcallEnabled
                if (!toolcallEnabled) fullContent += delta.content
          }
        } catch (parseErr) {
          logger.warn('SSE chunk parse failed in accumulateResponse: ' + (parseErr && parseErr.message || parseErr), 'ACCUMULATE')
        }
      }
    })

    response.on('end', () => {
      cleanup()
      const message = { role: 'assistant', content: fullContent }
      if (reasoningContent) {
        message.reasoning_content = reasoningContent
      }

      let finish_reason = 'stop'

      // Parse <tool> blocks from accumulated text.
      // Also check reasoningContent (thinking phase) because Qwen models
      // sometimes emit tool_call tags across the think/answer boundary.
      if (toolcallEnabled) {
        const cleaned = cleanToolRefusal(fullContent)
        if (cleaned !== null) fullContent = cleaned
        let parsed = parseToolCallsFromText(fullContent)

        // Fallback 1: try reasoningContent if answer phase had no tool calls
        if (parsed.toolCalls.length === 0 && reasoningContent) {
          const thinkParsed = parseToolCallsFromText(reasoningContent)
          if (thinkParsed.toolCalls.length > 0) {
            logger.info('Tool calls recovered from thinking phase: ' + thinkParsed.toolCalls.length, 'ACCUMULATE')
            parsed = thinkParsed
          }
        }

        // Fallback 2: try combined text (tag may span the boundary)
        if (parsed.toolCalls.length === 0 && reasoningContent) {
          const combinedParsed = parseToolCallsFromText(reasoningContent + '\n' + fullContent)
          if (combinedParsed.toolCalls.length > 0) {
            logger.info('Tool calls recovered from combined think+answer: ' + combinedParsed.toolCalls.length, 'ACCUMULATE')
            parsed = combinedParsed
          }
        }

        if (parsed.toolCalls.length > 0) {
          message.content = stripToolResultBlocks(parsed.content)
          message.tool_calls = parsed.toolCalls
          finish_reason = 'tool_calls'
        } else if (fullContent) {
                fullContent = stripToolResultBlocks(fullContent)
                message.content = fullContent
          logger.info('Tool call parse failed after all fallbacks. fullContent len=' + fullContent.length + ' reasoning len=' + (reasoningContent || '').length, 'ACCUMULATE')
        }
      }

      resolve({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.round(Date.now() / 1000),
        choices: [{ index: 0, message, finish_reason }],
        usage: totalTokens,
      })
    })

    response.on('error', (err) => {
      cleanup()
      reject(err)
    })
  })
}

module.exports = { accumulateResponse }
