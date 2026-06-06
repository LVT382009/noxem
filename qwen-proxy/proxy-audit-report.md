# Qwen-Proxy SSE Streaming & Tool Call Audit Report

## 1. How the Proxy Handles SSE Streaming

The proxy operates as a **buffer-then-reemit** architecture rather than a true pass-through stream:

### Anthropic Route (`src/routes/anthropic.js`)
- The `accumulateResponse()` function (line 484) consumes the entire upstream Qwen SSE stream into memory, parsing each `data:` chunk and concatenating `delta.content` by phase (`think` vs `answer`).
- Only after the upstream `end` event fires does it construct a complete OpenAI-format response object.
- The accumulated response is then re-emitted as Anthropic-format SSE events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`) in a single burst (lines 427-447).
- Retry logic: if accumulation produces empty content, the proxy retries up to 3 times with exponential backoff, deleting the stale chat session between attempts.

### OpenAI Chat Route (`src/controllers/chat.js`)
- True streaming pass-through via `handleStreamResponse()` (line 65).
- Sets proper SSE headers including `X-Accel-Buffering: no` (line 37) to prevent Nginx buffering.
- Implements a **keep-alive interval** sending SSE comment lines (`: keep-alive\n\n`) every 15 seconds (line 95).
- Implements a **stream timeout** that destroys the upstream connection after 110 seconds of inactivity (line 86), racing against WAF idle timeouts at ~120s.
- Detects client disconnect via `res.on('close')` and destroys the upstream socket (line 106).
- On upstream premature close (`response.on('close')`), sends `[Connection lost]` sentinel and graceful `[DONE]` termination (line 153).

### Key Difference
The Anthropic route does NOT stream incrementally — it buffers everything first. This means:
- Time-to-first-token (TTFT) equals total generation time.
- No keep-alive pings during accumulation (the upstream may time out for long generations).
- No client disconnect detection during accumulation.

## 2. How Tool Calls Are Parsed from Qwen's Output

Tool calling uses a **prompt injection + post-hoc extraction** pattern (no native Qwen function calling):

### Prompt Construction (`src/utils/toolcall.js`)
- Tools are serialized into a `<tool_call>` XML format matching Qwen3's training tokens (151657/151658).
- JSON Schema parameters are compressed to TypeScript-style signatures via `compressSchemaType()` for ~90% token reduction.
- Tool names are obfuscated (e.g., `Read` -> `file_read`, `Bash` -> `shell_exec`) to bypass Qwen's server-side plugin validator that rejects reserved names.
- Few-shot examples are included in the prompt to demonstrate the expected format.

### Extraction (Non-streaming: `parseToolCallsFromText()`)
- Regex-based extraction of `<tool_call>...</tool_call>` blocks from accumulated text.
- Three-tier fallback: (1) answer phase text, (2) reasoning/thinking phase text, (3) combined think+answer text.
- Handles bare JSON objects without wrapping tags.
- `splitMultiJson()` handles multiple JSON objects inside one tag pair with string-aware brace depth tracking.
- `escapeControlCharsInStrings()` fixes raw newlines/tabs inside JSON string values before parsing.
- `tryJsonRepair()` attempts recovery: Python literals, trailing commas, single quotes, bracket balancing.

### Extraction (Streaming: `createSieve()`)
- Stateful scanner that processes content deltas incrementally.
- Holds back partial `<tool_call>` tag prefixes at buffer boundaries.
- Emits parsed tool calls as OpenAI-format `tool_calls` deltas.
- Normalizes variant forms: `<tool_call>` special tokens, `<tool_call>` XML tags.
- After first successful tool block parse, sets `finished=true` and stops scanning.

### Refusal Handling
- `cleanToolRefusal()` strips "" messages from Qwen's server-side validator.
- `buildRefusalCorrection()` generates correction prompts for retry scenarios.

## 3. Known Weak Points and Failure Modes

### Critical Issues

1. **No keep-alive during Anthropic accumulation**: The `accumulateResponse()` function in `anthropic.js` has no heartbeat mechanism. For long-running Qwen generations (>110s), the upstream connection or intermediate proxies may kill the stream silently. The `chat.js` controller has this but the Anthropic route does not.

2. **No client disconnect detection during Anthropic accumulation**: If the Anthropic client disconnects while `accumulateResponse()` is running, the proxy continues consuming upstream resources until completion. The `chat.js` controller handles this via `res.on('close')` but the Anthropic route does not.

3. **Empty catch block swallows parse errors silently** (line 546 of `anthropic.js`): When SSE chunk JSON parsing fails inside `accumulateResponse()`, the error is silently discarded with `catch { // skip }`. Malformed upstream responses go undetected.

4. **Stream duration log calculation is wrong** (line 308 of `chat.js`): `lastDataTime` is reset on every data chunk, so `Date.now() - lastDataTime` at end-time measures only the gap since the last chunk, not total stream duration. The formula on line 309 compounds this with nonsensical arithmetic.

5. **`accumulateResponse` missing `X-Accel-Buffering: no` header**: The Anthropic route sets SSE headers (line 405-409) but omits `X-Accel-Buffering: no`, which means Nginx reverse proxies may buffer the entire re-emitted stream.

### Moderate Issues

6. **Tool call sieve stops after first block** (`finished = true` at line 713 of `toolcall.js`): After successfully parsing one tool call, the sieve ignores all subsequent content. Multi-tool-call responses where the model emits text between tool calls will lose content after the first tool block.

7. **Duplicate `accumulateResponse` implementations**: Both `anthropic.js` (line 484) and `gemini.js` (line 135) have their own copies with slight variations. Bug fixes must be applied in multiple places.

8. **No `res.flushHeaders()` call**: Per SSE best practices, headers should be flushed immediately after setting them to establish the stream connection before any data is written. Neither route calls `res.flushHeaders()`.

9. **Memory pressure on large responses**: `accumulateResponse()` stores the entire response in string variables (`fullContent`, `reasoningContent`). For very long Qwen outputs (1M token context), this could consume significant memory.

## 4. Recommendations for Improving Reliability

1. **Add keep-alive and client disconnect handling to `accumulateResponse()`**: Pass the `res` object and set up the same 15s keep-alive interval and `res.on('close')` handler that `chat.js` uses. This prevents upstream timeout during long accumulations.

2. **Add `X-Accel-Buffering: no` to Anthropic SSE headers**: Ensures Nginx proxies forward events immediately rather than buffering.

3. **Call `res.flushHeaders()` after setting SSE headers**: Establishes the HTTP stream connection immediately per SSE specification.

4. **Log parse failures instead of silently swallowing**: Replace empty `catch {}` with `logger.warn()` to enable monitoring of upstream format drift.

5. **Fix stream duration logging**: Capture `streamStartTime` at the beginning of the stream handler and compute duration from that fixed point.

6. **Extract shared accumulation logic**: Create a single `accumulateResponse()` in `src/utils/` used by both Anthropic and Gemini routes to eliminate duplication.

7. **Allow multi-tool-call in sieve**: Remove the `finished = true` early-exit or make it configurable, so models that interleave text and multiple tool calls are fully supported.

8. **Add `retry:` field to SSE streams**: Per SSE specification, emit `retry: 10000\n\n` to instruct clients to auto-reconnect on disconnect.

## 5. Web Research References

Best practices referenced from:
- [Server-Sent Events with Express - Mastering JS](https://masteringjs.io/tutorials/express/server-sent-events): Required headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), use of `res.write()` vs `res.send()`, `retry:` field for auto-reconnection, `res.flushHeaders()`.
- [Express.js timeout middleware](https://expressjs.com/en/resources/middleware/timeout/): Server-side timeout patterns for long-lived connections.
- [How to Set Response Timeouts in Express.js - Sling Academy](https://www.slingacademy.com/article/how-to-set-response-timeouts-in-express-js/): Socket-level timeout configuration.
- [NodeJS: Server-Sent Events using ExpressJS - BigBoxCode](https://bigboxcode.com/nodejs-server-sent-events-sse): Heartbeat/keepalive patterns and client disconnect detection.
- [AI API Streaming Guide 2026 - TokenMix](https://tokenmix.ai/blog/ai-api-streaming-guide): TTFT optimization through true streaming vs buffering.
