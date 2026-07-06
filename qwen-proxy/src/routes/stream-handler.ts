import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta, parseQwenErrorPayload } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { removeStream } from '../core/stream-registry.js';
import { updateSessionParent } from '../services/qwen.js';
import { createContinuationStream } from '../services/stream-creator.js';

export interface StreamHandlerContext {
  stream: ReadableStream;
  completionId: string;
  model: string;
  uiSessionId: string;
  accountId?: string;
  chatHeaders?: Record<string, string>;
  enableThinking?: boolean;
  hasTools: boolean;
  tools: any[];
  finalPrompt: string;
  streamOptions?: { include_usage?: boolean };
}

export function handleStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval);
        }
      }, 15000);

      const writeEvent = (data: any) => {
        streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      const emittedStreamingToolIds = new Set<string>();

      const emitStreamingToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }, index: number) => {
        if (emittedStreamingToolIds.has(tc.id)) return;
        emittedStreamingToolIds.add(tc.id);
        streamWriter.write(`data: ${JSON.stringify({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({
            tool_calls: [{
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }]
          })]
        })}\n\n`);
      };

      const createdTimestamp = Math.floor(Date.now() / 1000);

      const fastWriteContent = (content: string) => {
        const escaped = JSON.stringify(content).slice(1, -1);
        streamWriter.write(`data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${ctx.model}","choices":[{"index":0,"delta":{"content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };

      const fastWriteReasoning = (content: string) => {
        const escaped = JSON.stringify(content).slice(1, -1);
        streamWriter.write(`data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${ctx.model}","choices":[{"index":0,"delta":{"reasoning_content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      let _reasoningBuffer = '';
      let lastFullContent = '';
      let contentLength = 0;
      let contentSuffix = '';
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      let currentThoughtIndex = 0;
      const toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
      const bufferChunks: string[] = [];
      let bufferLen = 0;
      let lineStart = 0;
      let completionTokens = 0;
      let promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5);

      const processLines = (fullBuffer: string) => {
        let pos = lineStart;
        while (pos < fullBuffer.length) {
          const newlineIdx = fullBuffer.indexOf('\n', pos);
          if (newlineIdx === -1) {
            lineStart = pos;
            return;
          }
          const line = fullBuffer.substring(pos, newlineIdx);
          pos = newlineIdx + 1;
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            streamWriter.write('data: [DONE]\n');
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
                targetResponseIdSet = true;
              }
              updateSessionParent(ctx.uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id && !targetResponseIdSet) {
              targetResponseId = chunk.response_id;
              targetResponseIdSet = true;
              updateSessionParent(ctx.uiSessionId, chunk.response_id);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              // Only accept input_tokens from round 0 (the user's actual prompt).
              // Continuation rounds report the full chat context as input_tokens
              // (huge, misleading) — never overwrite the round-0 figure.
              if (chunk.usage.input_tokens && roundIndex === 0) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra?.summary_thought?.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent, contentLength, contentSuffix);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    contentLength = result.contentLength;
                    contentSuffix = result.contentSuffix;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                _reasoningBuffer += vStr;
                fastWriteReasoning(vStr);
              } else {
                if (ctx.hasTools && toolParser) {
                  const { text, toolCalls } = toolParser.feed(vStr);
                  if (text) {
                    if (looksLikeUnwrappedToolCall(text)) {
                      const unwrappedToolCalls = parseUnwrappedToolCalls(text);
                      const baseIndex = toolParser.getEmittedToolCallCount();
                      for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
                        const tc = unwrappedToolCalls[idx];
                        emitStreamingToolCall(tc, baseIndex + idx);
                      }
                    } else {
                      fastWriteContent(text);
                    }
                  }
                  for (const tc of toolCalls) {
                    emitStreamingToolCall(tc, toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc));
                  }
                } else {
                  if (vStr) fastWriteContent(vStr);
                }
              }
            }
          } catch (e) {
            if (dataStr.length > 10) {
              console.warn(`[Chat] SSE parse error for chunk (${dataStr.length} chars):`, (e as Error).message);
            }
          }
        }
        lineStart = pos;
      };

      // ── AutoContinue config (env-driven; default OFF keeps the working path unchanged) ──
      const AC_ENABLED = process.env.QWEN_AUTO_CONTINUE === 'true' && !!ctx.accountId && ctx.accountId !== 'guest' && !ctx.hasTools;
      const AC_OUTPUT_CAP = parseInt(process.env.QWEN_OUTPUT_TOKEN_CAP || '0') || 0;
      const AC_SAFETY = parseInt(process.env.QWEN_CONTINUE_SAFETY_MARGIN || '4096') || 0;
      const AC_MIN_TOKENS = parseInt(process.env.QWEN_CONTINUE_MIN_TOKENS || '8192') || 0;
      const AC_MAX_ITERS = parseInt(process.env.QWEN_CONTINUE_MAX_ITERS || '8') || 0;
      const AC_INCOMPLETE = process.env.QWEN_CONTINUE_INCOMPLETE_CHECK !== 'false';
      let totalCompletionTokens = 0;
      let accumulatedFullContent = '';
      let roundIndex = 0;

      // isTruncated — per-round tokens (did THIS round hit the cap?) + content
      // incompleteness on the full answer so far. MIN_CONTINUE_TOKENS gate keeps
      // short natural answers from ever triggering.
      const isTruncated = (perRoundTokens: number, fullContent: string): boolean => {
        if (perRoundTokens < AC_MIN_TOKENS) return false;
        if (AC_OUTPUT_CAP > 0 && perRoundTokens >= (AC_OUTPUT_CAP - AC_SAFETY)) return true;
        if (AC_INCOMPLETE) {
          const trimmed = fullContent.replace(/\s+$/, '');
          if (!trimmed) return false;
          const codeFences = (trimmed.match(/```/g) || []).length + (trimmed.match(/~~~/g) || []).length;
          if (codeFences % 2 !== 0) return true;
          const lastChar = trimmed.slice(-1);
          if ('{([<,:|&=+-'.includes(lastChar)) return true;
        }
        return false;
      };

      // drainStream — consume one Qwen SSE stream through processLines (which
      // writes OpenAI chunks to the client). Resets per-round incremental-delta
      // state; the targetResponseId reset is CRITICAL: round-N has a NEW
      // response_id, and without reset its chunks filter to round-(N-1)'s id and
      // get dropped. Accumulates round content + tokens for the heuristic/usage.
      const drainStream = async (stream: ReadableStream): Promise<string> => {
        const r = stream.getReader();
        const dec = new TextDecoder();
        if (roundIndex > 0) {
          lastFullContent = '';
          contentLength = 0;
          contentSuffix = '';
          targetResponseId = null;
          targetResponseIdSet = false;
          currentThoughtIndex = 0;
          completionTokens = 0;
          _reasoningBuffer = '';
          bufferChunks.length = 0;
          bufferLen = 0;
          lineStart = 0;
        }
        while (true) {
          const { done, value } = await r.read();
          if (done) break;
          const decoded = dec.decode(value, { stream: true });
          bufferChunks.push(decoded);
          bufferLen += decoded.length;

          if (decoded.includes('\n')) {
            const fullBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
            processLines(fullBuffer);

            const remaining = fullBuffer.substring(lineStart);
            bufferChunks.length = 0;
            if (remaining) {
              bufferChunks.push(remaining);
              bufferLen = remaining.length;
            } else {
              bufferLen = 0;
            }
            lineStart = 0;
          }
        }

        if (bufferLen > 0) {
          const finalBuffer = bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('');
          processLines(finalBuffer);
        }

        accumulatedFullContent += lastFullContent;
        totalCompletionTokens += completionTokens;
        return bufferChunks.length > 0
          ? (bufferChunks.length === 1 ? bufferChunks[0] : bufferChunks.join('')).substring(lineStart)
          : '';
      };

      // ── Round 1, then AutoContinue rounds 2..N if the round hit the cap ──
      let tailBuffer = await drainStream(ctx.stream);
      let upstreamError = parseQwenErrorPayload(tailBuffer);

      let acIters = 0;
      while (AC_ENABLED && !upstreamError && acIters < AC_MAX_ITERS &&
             isTruncated(completionTokens, accumulatedFullContent)) {
        const contParentId = targetResponseId;
        if (!contParentId) {
          console.warn('[AutoContinue] no target response_id from round — cannot thread continuation, stopping.');
          break;
        }
        acIters++;
        console.log(`[AutoContinue] iter ${acIters}: continuing chat ${ctx.uiSessionId}, parentId=${contParentId}, roundTokens=${completionTokens}`);
        try {
          const { stream: contStream } = await createContinuationStream({
            chatId: ctx.uiSessionId,
            chatHeaders: ctx.chatHeaders || {},
            accountId: ctx.accountId!,
            prompt: 'Continue from exactly where your previous response was cut off. Resume mid-sentence/mid-block if needed. Do not repeat, apologize, or summarize — output ONLY the continuation.',
            modelId: ctx.model,
            parentId: contParentId,
            enableThinking: ctx.enableThinking ?? false,
          });
          roundIndex = acIters;
          tailBuffer = await drainStream(contStream);
        } catch (contErr: any) {
          console.warn(`[AutoContinue] continuation aborted (iter ${acIters}): ${(contErr as Error).message}. Keeping content generated so far.`);
          tailBuffer = '';
          break;
        }
        upstreamError = parseQwenErrorPayload(tailBuffer);
      }
      if (acIters > 0) console.log(`[AutoContinue] done: ${acIters} continuation round(s), totalTokens=${totalCompletionTokens}`);
      if (upstreamError) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({}, 'stop')]
        });
        streamWriter.write('data: [DONE]\n\n');
        return;
      }

      if (toolParser) {
        const flushResult = toolParser.flush();
        if (flushResult.text) {
          if (ctx.hasTools && looksLikeUnwrappedToolCall(flushResult.text)) {
            const unwrappedToolCalls = parseUnwrappedToolCalls(flushResult.text);
            const baseIndex = toolParser.getEmittedToolCallCount();
            for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
              const tc = unwrappedToolCalls[idx];
              emitStreamingToolCall(tc, baseIndex + idx);
            }
          } else {
            writeEvent({
              id: ctx.completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: ctx.model,
              choices: [makeChoice({ content: flushResult.text })]
            });
          }
        }
        for (const tc of flushResult.toolCalls) {
          const idx = toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc);
          emitStreamingToolCall(tc, idx);
        }
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: totalCompletionTokens,
        total_tokens: promptTokens + totalCompletionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(ctx.streamOptions?.include_usage ? {} : { usage })
      });

      if (ctx.streamOptions?.include_usage) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [],
          usage
        });
      }
      streamWriter.write('data: [DONE]\n\n');
    } finally {
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
    }
  });
}

export function handleNonStreamingResponse(
  c: Context,
  stream: ReadableStream,
  completionId: string,
  model: string,
  uiSessionId: string,
  hasTools: boolean,
  tools: any[],
): any {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const toolCallsOut: any[] = [];
    const seenToolCallIds = new Set<string>();
    let buffer = '';

    const pushToolCall = (tc: { id: string; name: string; arguments: Record<string, unknown> }) => {
      if (seenToolCallIds.has(tc.id)) return;
      seenToolCallIds.add(tc.id);
      toolCallsOut.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      });
    };

    const qwenParser = new QwenStreamParser(uiSessionId, {
      tools: hasTools ? tools : [],
      onThinking: () => {},
      onToolCall: (tc) => {
        pushToolCall(tc);
      },
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        qwenParser.parseLine(dataStr);
      }
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      removeStream(completionId);
      return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
    }

    const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
    const parserState = qwenParser.state;
    let finalContent = parserState.lastFullContent;
    if (remainingText) finalContent += remainingText;
    for (const tc of remainingToolCalls) {
      pushToolCall(tc);
    }

    if (hasTools && toolCallsOut.length === 0) {
      for (const tc of parseUnwrappedToolCalls(finalContent)) {
        pushToolCall(tc);
      }
      if (toolCallsOut.length > 0) finalContent = '';
    }

    const usage = {
      prompt_tokens: parserState.promptTokens,
      completion_tokens: parserState.completionTokens,
      total_tokens: parserState.promptTokens + parserState.completionTokens,
      prompt_tokens_details: { cached_tokens: 0 }
    };
    const message: any = { role: 'assistant', content: toolCallsOut.length ? null : finalContent };
    if (parserState.reasoningBuffer) message.reasoning_content = parserState.reasoningBuffer;
    if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
    if (toolCallsOut.length) message.tool_calls = toolCallsOut;

    removeStream(completionId);
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
      }],
      usage
    });
  })();
}
