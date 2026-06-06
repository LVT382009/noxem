const { isJson, generateUUID } = require('../utils/tools.js')
const { createUsageObject } = require('../utils/precise-tokenizer.js')
const { sendChatRequest } = require('../utils/request.js')
const accountManager = require('../utils/account.js')
const config = require('../config/index.js')
const { logger } = require('../utils/logger')
const { createSieve, parseToolCallsFromText, cleanToolRefusal, buildRefusalCorrection, obfuscateToolName } = require('../utils/toolcall.js')

/** Whether tool_choice requires at least one tool call */
const requiresToolCall = (toolChoice) => {
  if (toolChoice === 'required') return true
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function && toolChoice.function.name) return true
  return false
}

/** Build a strong retry hint when model failed to call tools */
const buildRequiredRetryHint = (toolChoice) => {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    const name = obfuscateToolName(toolChoice.function.name)
    return `You did not call any tool in your previous reply. You MUST now call the tool \`${name}\` using the <tool_call> format and nothing else.`
  }
  return 'You did not call any tool in your previous reply. You MUST now call exactly one tool using the <tool_call></tool_call> format and nothing else.'
}

/**
 * Set response headers
 * @param {object} res - Express response object
 * @param {boolean} stream - Whether streaming response
 */
const setResponseHeaders = (res, stream) => {
    try {
        if (stream) {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
            })
        } else {
            res.set({
                'Content-Type': 'application/json',
            })
        }
    } catch (e) {
        logger.error('Error setting response headers', 'CHAT', '', e)
    }
}

const getImageMarkdownListFromDelta = (delta) => {
    const imageList = []
    const displayImages = delta?.extra?.image_list || []

    for (const item of displayImages) {
        if (item?.image) {
            imageList.push(`![image](${item.image})`)
        }
    }

    return imageList
}

/**
 * Handle streaming response
 */
const handleStreamResponse = async (res, response, enable_thinking, enable_web_search, requestBody = null, toolcallEnabled = false, toolChoice = null) => {
    try {
        const message_id = generateUUID()
        const decoder = new TextDecoder('utf-8')
        let web_search_info = null
        let currentPhase = null // 'think' or 'answer'
        let buffer = ''
        let emittedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        // Tool-call sieve. Only created when the request was gated as
        // tool-call enabled by the middleware.
        const sieve = toolcallEnabled ? createSieve() : null
        let toolCallsEmitted = false

  const streamStartTime = Date.now()

  /// Stream timeout: WAF kills idle connections at ~120s. We destroy at 110s to win the race.
  let streamTimeout = null
  let lastDataTime = Date.now()
  const resetStreamTimeout = () => {
    lastDataTime = Date.now()
    if (streamTimeout) clearTimeout(streamTimeout)
    streamTimeout = setTimeout(() => {
      logger.error("Stream timeout - no data from upstream for 300s, destroying upstream", "STREAM", "", "")
      try { response.destroy() } catch {}
    }, 180000)
  }
  resetStreamTimeout()

  // Keep-alive pings: send SSE comments every 15s during thinking silence.
  // Without these, intermediate proxies kill idle connections.
  let keepAliveInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAliveInterval)
      return
    }
    res.write(`: keep-alive

`)
  }, 15000)

  // SSE retry directive — tells clients to auto-reconnect after 10s on disconnect
  res.write('retry: 10000\n\n')

  // Detect client disconnect — stop upstream if client is gone
  res.on('close', () => {
    if (!res.writableFinished) {
      logger.warn('Client disconnected mid-stream, destroying upstream', 'STREAM')
      clearInterval(keepAliveInterval)
      if (streamTimeout) clearTimeout(streamTimeout)
      try { response.destroy() } catch {}
    }
  })


        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
        let completionContent = ''
  let streamClosed = false

        let promptText = ''
        if (requestBody && requestBody.messages) {
            promptText = requestBody.messages.map(msg => {
                if (typeof msg.content === 'string') return msg.content
                if (Array.isArray(msg.content)) return msg.content.map(item => item.text || '').join('')
                return ''
            }).join('\n')
        }

        const writeChunk = (delta) => {
            const chunk = {
                "id": `chatcmpl-${message_id}`,
                "object": "chat.completion.chunk",
                "created": Math.round(new Date().getTime() / 1000),
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": null
                }]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }

        const writeToolCallDeltas = (deltas) => {
            if (!Array.isArray(deltas) || deltas.length === 0) return
            toolCallsEmitted = true
            writeChunk({ tool_calls: deltas })
        }

        response.on('close', () => {
    if (streamTimeout) clearTimeout(streamTimeout)
    clearInterval(keepAliveInterval)
    logger.warn('Upstream response CLOSE event (socket closed)', 'STREAM', '', '')
    if (!res.writableEnded) {
      try {
        writeChunk({ content: String.fromCharCode(10)+String.fromCharCode(10)+'[Connection lost]' })
        const doneChunk = JSON.stringify({
          id: 'chatcmpl-' + message_id,
          object: 'chat.completion.chunk',
          created: Math.round(Date.now() / 1000),
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })
        res.write('data: ' + doneChunk + String.fromCharCode(10)+String.fromCharCode(10))
        res.write('data: [DONE]' + String.fromCharCode(10)+String.fromCharCode(10))
        res.end()
      } catch {}
    }
  })

  response.on('data', async (chunk) => {
    resetStreamTimeout()
            const decodeText = decoder.decode(chunk, { stream: true })
            buffer += decodeText

            const chunks = []
            let startIndex = 0

            while (true) {
                const dataStart = buffer.indexOf('data: ', startIndex)
                if (dataStart === -1) break

                const dataEnd = buffer.indexOf('\n\n', dataStart)
                if (dataEnd === -1) break

                const dataChunk = buffer.substring(dataStart, dataEnd).trim()
                chunks.push(dataChunk)
                startIndex = dataEnd + 2
            }

            if (startIndex > 0) {
                buffer = buffer.substring(startIndex)
            }

            for (const item of chunks) {
                try {
                    let dataContent = item.replace("data: ", '')
                    let decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
                    if (decodeJson === null || !decodeJson.choices || decodeJson.choices.length === 0) {
                        continue
                    }

                    if (decodeJson.usage) {
                        totalTokens = {
                            prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                            completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                            total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                        }
                    }

                    const delta = decodeJson.choices[0].delta

                    // Handle web search info
                    if (delta && delta.name === 'web_search') {
                        web_search_info = delta.extra.web_search_info
                    }

                    // Handle inline images
                    const imageMarkdownList = getImageMarkdownListFromDelta(delta)
                    if (imageMarkdownList.length > 0) {
                        const newImageMarkdownList = imageMarkdownList.filter(item => !emittedImageMarkdownSet.has(item))

                        if (currentPhase === 'think') {
                            // Buffer images during thinking phase
                            for (const imageMarkdown of newImageMarkdownList) {
                                if (!pendingImageMarkdownList.includes(imageMarkdown)) {
                                    pendingImageMarkdownList.push(imageMarkdown)
                                }
                            }
                        } else if (newImageMarkdownList.length > 0) {
                            const imageContent = `${newImageMarkdownList.join('\n\n')}\n\n`
                            completionContent += imageContent
                            newImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                            writeChunk({ "content": imageContent })
                        }
                    }

                    if (!delta || !delta.content ||
                        (delta.phase !== 'think' && delta.phase !== 'answer')) {
                        continue
                    }

                    let content = delta.content
                    completionContent += content

                    if (delta.phase === 'think') {
                        // Thinking phase: send as reasoning_content (OpenAI standard)
                        if (currentPhase !== 'think') {
                            currentPhase = 'think'
                            // Prepend search info to first thinking chunk if available
                            if (web_search_info) {
                                const searchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                                content = searchTable + '\n\n' + content
                            }
                        }
                        writeChunk({ "reasoning_content": content })
                    } else if (delta.phase === 'answer') {
                        // Answer phase: send as content
                        if (currentPhase === 'think') {
                            // Flush pending images when transitioning from think to answer
                            if (pendingImageMarkdownList.length > 0) {
                                const pendingImageContent = `${pendingImageMarkdownList.join('\n\n')}\n\n`
                                completionContent += pendingImageContent
                                pendingImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                                pendingImageMarkdownList = []
                                writeChunk({ "content": pendingImageContent })
                            }
                        }
                        currentPhase = 'answer'
                        if (sieve) {
          const out = sieve.push(content)
          // Strip tool-refusal text from sieve output
          if (out.textDelta) {
            const cleaned = cleanToolRefusal(out.textDelta)
            if (cleaned !== null) out.textDelta = cleaned
          }
          if (out.textDelta) writeChunk({ "content": out.textDelta })
                            if (out.toolCallsDelta) writeToolCallDeltas(out.toolCallsDelta)
                        } else {
                            writeChunk({ "content": content })
                        }
                    }
                } catch (error) {
                    logger.error('Stream data processing error', 'CHAT', '', error)
                }
            }
        })

        response.on('error', (err) => {
    if (streamTimeout) clearTimeout(streamTimeout)
    clearInterval(keepAliveInterval)
    logger.error('Upstream stream error', 'CHAT', '', err)
    if (!res.writableEnded) {
      try {
        writeChunk({ "content": "\n\n[Error: upstream connection reset]" })
        res.write("data: " + JSON.stringify({ "id": "chatcmpl-" + message_id, "object": "chat.completion.chunk", "created": Math.round(Date.now() / 1000), "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }) + "\n\n")
        res.write("data: [DONE]\n\n")
        res.end()
      } catch {}
    }
  })



response.on('end', async () => {
    const streamDuration = ((Date.now() - streamStartTime) / 1000).toFixed(1)
    logger.info(`Upstream stream END — duration: ${streamDuration}s, totalTokens: ${JSON.stringify(totalTokens)}`, 'STREAM')
    if (streamTimeout) clearTimeout(streamTimeout)
            try {
                // Flush any pending content held by the tool-call sieve
                if (sieve) {const out = sieve.flush()
                    if (out.textDelta) {
                      const cleaned = cleanToolRefusal(out.textDelta)
                      if (cleaned !== null) out.textDelta = cleaned
                    }
                    if (out.textDelta) writeChunk({ "content": out.textDelta })
                    if (out.toolCallsDelta) writeToolCallDeltas(out.toolCallsDelta)
                }

                // Append search info for non-thinking mode
                if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
                    const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
                    writeChunk({ "content": `\n\n---\n${webSearchTable}` })
                }

                if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
                    totalTokens = createUsageObject(requestBody?.messages || promptText, completionContent, null)
                }

                totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
                totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
                totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

                const finishReason = toolCallsEmitted ? 'tool_calls' : 'stop'

                // Finish chunk
                res.write(`data: ${JSON.stringify({
                    "id": `chatcmpl-${message_id}`,
                    "object": "chat.completion.chunk",
                    "created": Math.round(new Date().getTime() / 1000),
                    "choices": [{ "index": 0, "delta": {}, "finish_reason": finishReason }]
                })}\n\n`)

                // Usage chunk
                res.write(`data: ${JSON.stringify({
                    "id": `chatcmpl-${message_id}`,
                    "object": "chat.completion.chunk",
                    "created": Math.round(new Date().getTime() / 1000),
                    "choices": [],
                    "usage": totalTokens
                })}\n\n`)

                res.write(`data: [DONE]\n\n`)
                res.end()
            } catch (e) {
                logger.error('Stream response end error', 'CHAT', '', e)
                if (!res.headersSent) {
                    res.status(500).json({ error: "Internal server error" })
                }
            }
        })
    } catch (error) {
        logger.error('Chat processing error', 'CHAT', '', error)
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" })
        }
    }
}

/**
 * Handle non-streaming response (accumulate from stream)
 */
const handleNonStreamResponse = async (res, response, enable_thinking, enable_web_search, model, requestBody = null, toolcallEnabled = false, toolChoice = null) => {
    try {
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let fullContent = ''
        let reasoningContent = ''
        let web_search_info = null
        let currentPhase = null
        let appendedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        let totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

        await new Promise((resolve, reject) => {
            response.on('data', async (chunk) => {
                const decodeText = decoder.decode(chunk, { stream: true })
                buffer += decodeText

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
                        let dataContent = item.replace("data: ", '')
                        let decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
                        if (!decodeJson || !decodeJson.choices || decodeJson.choices.length === 0) continue

                        if (decodeJson.usage) {
                            totalTokens = {
                                prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                                completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                                total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                            }
                        }

                        const delta = decodeJson.choices[0].delta

                        if (delta && delta.name === 'web_search') {
                            web_search_info = delta.extra.web_search_info
                        }

                        const imageMarkdownList = getImageMarkdownListFromDelta(delta)
                        if (imageMarkdownList.length > 0) {
                            const newList = imageMarkdownList.filter(item => !appendedImageMarkdownSet.has(item))
                            if (currentPhase === 'think') {
                                for (const md of newList) {
                                    if (!pendingImageMarkdownList.includes(md)) pendingImageMarkdownList.push(md)
                                }
                            } else if (newList.length > 0) {
                                fullContent += `${newList.join('\n\n')}\n\n`
                                newList.forEach(item => appendedImageMarkdownSet.add(item))
                            }
                        }

                        if (!delta || !delta.content || (delta.phase !== 'think' && delta.phase !== 'answer')) continue

                        let content = delta.content

                        if (delta.phase === 'think') {
                            if (currentPhase !== 'think' && web_search_info) {
                                const searchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                                reasoningContent += searchTable + '\n\n'
                            }
                            currentPhase = 'think'
                            reasoningContent += content
                        } else if (delta.phase === 'answer') {
                            if (currentPhase === 'think' && pendingImageMarkdownList.length > 0) {
                                fullContent += `${pendingImageMarkdownList.join('\n\n')}\n\n`
                                pendingImageMarkdownList.forEach(item => appendedImageMarkdownSet.add(item))
                                pendingImageMarkdownList = []
                            }
                            currentPhase = 'answer'
                            fullContent += content
                        }
                    } catch (error) {
                        logger.error('Non-stream data processing error', 'CHAT', '', error)
                    }
                }
            })

            response.on('end', () => resolve())
            response.on('error', (error) => reject(error))
        })

        if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            fullContent += `\n\n---\n${webSearchTable}`
        }

        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || '', fullContent + reasoningContent, null)
        }

        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
        totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
        totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

        const message = { "role": "assistant", "content": fullContent }
        if (reasoningContent) {
            message.reasoning_content = reasoningContent
        }

        // Tool-call extraction. Only when the gate said the request has tools.
        let finishReason = "stop"
        // Strip tool-refusal text from non-streaming response
  if (toolcallEnabled && fullContent) {
    const cleaned = cleanToolRefusal(fullContent)
    if (cleaned !== null) fullContent = cleaned
  }
  if (toolcallEnabled && fullContent) {
            let parsed = parseToolCallsFromText(fullContent)
 // Fallback: check reasoningContent (thinking phase)
 if (parsed.toolCalls.length === 0 && reasoningContent) {
 const thinkParsed = parseToolCallsFromText(reasoningContent)
 if (thinkParsed.toolCalls.length > 0) parsed = thinkParsed
 }
 // Fallback: try combined text (tag may span boundary)
 if (parsed.toolCalls.length === 0 && reasoningContent) {
 const combinedParsed = parseToolCallsFromText(reasoningContent + '\n' + fullContent)
 if (combinedParsed.toolCalls.length > 0) parsed = combinedParsed
 }
 if (parsed.toolCalls.length > 0) {
 message.content = parsed.content
 message.tool_calls = parsed.toolCalls
 finishReason = "tool_calls"
 }
 }

        
  // Auto-retry: when tool_choice requires a call but model produced none,
  // retry once with a stronger constraint message (Qwen2API pattern)
  if (toolcallEnabled && finishReason !== 'tool_calls' && requiresToolCall(toolChoice)) {
    logger.warn('tool_choice=required but no tool call produced - retrying with stronger constraint', 'CHAT')
    const retryHint = buildRequiredRetryHint(toolChoice)
    const retryBody = {
      ...requestBody,
      messages: [
        ...(Array.isArray(requestBody && requestBody.messages) ? requestBody.messages : []),
        { role: 'system', content: retryHint }
      ]
    }
    try {
      const retryData = await sendChatRequest(retryBody)
      if (retryData && retryData.status && retryData.response) {
        let retryContent = ''
        const retryDecoder = new TextDecoder('utf-8')
        let retryBuf = ''
        await new Promise((resolve, reject) => {
          retryData.response.on('data', (chunk) => {
            const text = retryDecoder.decode(chunk, { stream: true })
            retryBuf += text
            const items = []
            let si = 0
            while (true) {
              const ds = retryBuf.indexOf('data: ', si)
              if (ds === -1) break
              const de = retryBuf.indexOf('\n\n', ds)
              if (de === -1) break
              items.push(retryBuf.substring(ds, de).trim())
              si = de + 2
            }
            if (si > 0) retryBuf = retryBuf.substring(si)
            for (const item of items) {
              try {
                let dc = item.replace('data: ', '')
                let p = isJson(dc) ? JSON.parse(dc) : null
                if (!p || !p.choices || p.choices.length === 0) continue
                const d = p.choices[0].delta
                if (!d || !d.content || (d.phase !== 'think' && d.phase !== 'answer')) continue
                if (d.phase === 'answer') retryContent += d.content
              } catch {}
            }
          })
          retryData.response.on('end', () => resolve())
          retryData.response.on('error', (e) => reject(e))
        })
        const retryCleaned = cleanToolRefusal(retryContent)
        if (retryCleaned !== null) retryContent = retryCleaned
        if (retryContent) {
          const retryParsed = parseToolCallsFromText(retryContent)
          if (retryParsed.toolCalls.length > 0) {
            message.content = retryParsed.content
            message.tool_calls = retryParsed.toolCalls
            finishReason = 'tool_calls'
          }
        }
      }
    } catch (retryErr) {
      logger.error('tool_choice required retry failed', 'CHAT', '', retryErr)
    }
  }

res.json({
            "id": `chatcmpl-${generateUUID()}`,
            "object": "chat.completion",
            "created": Math.round(new Date().getTime() / 1000),
            "model": model,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finishReason
            }],
            "usage": totalTokens
        })
    } catch (error) {
        logger.error('Non-stream chat processing error', 'CHAT', '', error)
        res.status(500).json({ error: "Internal server error" })
    }
}

/**
 * Main chat completion handler
 */
const handleChatCompletion = async (req, res) => {
    const { stream, model } = req.body
    const enable_thinking = req.enable_thinking
    const enable_web_search = req.enable_web_search

    try {
    // Retry up to 2 times on connection errors
    let response_data = null
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response_data = await sendChatRequest(req.body)
        if (response_data && response_data.status && response_data.response) break
        lastErr = new Error('Empty response from upstream')
      } catch (err) {
        lastErr = err
        if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
          logger.warn('Upstream connection error (attempt ' + (attempt + 1) + '/3), retrying...', 'CHAT', '', err.code)
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        throw err
      }
    }

    if (!response_data || !response_data.status || !response_data.response) {
      res.status(502).json({ error: "Failed to send request after retries: " + (lastErr ? lastErr.message : "empty response") })
      return
    }

if (stream) {
            setResponseHeaders(res, true)
            await handleStreamResponse(res, response_data.response, enable_thinking, enable_web_search, req.body, req.toolcall_enabled, req.toolcall_choice)
        } else {
            setResponseHeaders(res, false)
            await handleNonStreamResponse(res, response_data.response, enable_thinking, enable_web_search, model, req.body, req.toolcall_enabled, req.toolcall_choice)
        }

    } catch (error) {
        logger.error('Chat processing error', 'CHAT', '', error)
        res.status(500).json({ error: "Invalid token, request failed" })
    }
}

module.exports = {
    handleChatCompletion,
    handleStreamResponse,
    handleNonStreamResponse,
    setResponseHeaders
}
