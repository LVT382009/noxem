// Phase C-3: Brain 2 tool-call loop (+ the augment orchestrator). Backend-agnostic over the
// qwenproxy-adapter (:8000 OpenAI-compatible). Tool-calling is PROMPT-DRIVEN, not a native API:
// the system prompt lists tools as a JSON array under `# TOOLS AVAILABLE` + a `# TOOL CALLING FORMAT`
// section requiring the model to wrap each call in <antml:tool_call>{json}</antml:tool_call>
// (the format proven by hermesprompt.md running against qwenproxy models). This module parses those
// tags, dispatches each call through brain2-tools.dispatchTool, feeds the result back as a user
// turn (`Tool Response (<name>): {json}`), and iterates until the model emits a no-tool-call turn
// (the final answer) or maxTurns is exhausted.
//
// The adapter itself does NOT translate tool calls — it just shuttles chat completions (collectSSE for
// qwenproxy mode). Native OpenAI tool/function API is unused on purpose: qwenproxy models reliably
// emit antml-tagged tool calls when prompted this way, and it keeps us provider-agnostic.
//
// Recoverability: this loop can only call brain2-tools handlers, all of which are soft-mutate (no
// prune/delete/status-flip). So even a runaway loop cannot remove a fact from retrieval.

import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
import { BRAIN2_TOOLS_SPEC, dispatchTool } from './brain2-tools.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const B2_MAX_TURNS = parseInt(process.env.BRAIN2_MAX_TURNS || '8');
const B2_MAX_TOKENS = parseInt(process.env.BRAIN2_MAX_TOKENS || '1024');
const B2_TIMEOUT_MS = parseInt(process.env.BRAIN2_TIMEOUT_MS || '120000');

export const TOOLS_SPEC_JSON = JSON.stringify(BRAIN2_TOOLS_SPEC);

// The system prompt header Brain 2 receives every augment run. Stated role + recoverability rule +
// the 7-step workflow + the `# TOOLS AVAILABLE` menu + the antml `# TOOL CALLING FORMAT` contract +
// the 6 critical rules. extraRole lets a caller append a run-specific directive.
const SYSTEM_PROMPT_HEADER = `You are the noxem Brain 2 memory curator. You have READ, WRITE, REFINE, ANNOTATE, RANK, and FLAG tools over the memory corpus. Brain 1 (the semantic engine) just chunked the conversation at a small embedding context and stored facts — possibly splitting a single fact across chunks, rephrasing it, or missing a fact that spanned a chunk boundary. Your job is to verify and supplement what Brain 1 stored by looking at the FULL conversation (which you see at full context).

RECOVERABILITY RULE (NON-NEGOTIABLE): you may NEVER remove a fact from retrieval. There is no delete tool on purpose. memory_edit rewrites text in place (the previous text is audited in metadata). memory_flag_superseded ONLY downranks + footnotes a stale fact — the row STAYS active and retrievable, so a judgment you get wrong can be reversed later. Prefer editing/annotating over storing a near-duplicate; prefer flag_superseded over discarding nuance.

WORKFLOW:
1. Use memory_list_session to see the facts Brain 1 just stored from this conversation.
2. Use memory_search / memory_get to cross-check each chunked fact against older stored memories and against the full conversation below.
3. For a chunked fact that is INCOMPLETE or WRONG, use memory_edit to fix it in place (cite why in the reason field).
4. For a nuance / uncertainty / source caveat, use memory_annotate.
5. For a fact Brain 1 MISSED entirely (present in the conversation, absent from storage), use memory_store.
6. For a stored fact that a NEWER fact supersedes, use memory_flag_superseded (soft — both stay retrievable).
7. When done, output a one-line summary of what you changed/stored and STOP (no further tool calls).

Be surgical: small in-place edits beat wholesale rewrites. When in doubt, annotate rather than flag.

# TOOLS AVAILABLE
You have access to the following tools:
${TOOLS_SPEC_JSON}

# TOOL CALLING FORMAT (MANDATORY)
To use a tool, you MUST output a JSON object wrapped EXACTLY in <antml:tool_call> tags:

<antml:tool_call>
{"name": "tool_name", "arguments": {"param_name": "value"}}
</antml:tool_call>

EXAMPLE OF MULTIPLE TOOL CALLS:
<antml:tool_call>
{"name": "memory_search", "arguments": {"query": "user prefers dark mode"}}
</antml:tool_call>
<antml:tool_call>
{"name": "memory_search", "arguments": {"query": "user uses react"}}
</antml:tool_call>

CRITICAL RULES:
1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.
2. You can call multiple tools by outputting multiple <antml:tool_call> blocks consecutively.
3. Do NOT output any other text (explanations, chat, etc.) after your <antml:tool_call> blocks. Wait for the tool response.
4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.
5. If you need to use a tool, do it IMMEDIATELY without preamble.
6. NEVER invent tool names. ONLY use the exact tool names provided in the TOOLS AVAILABLE list above. Calling an unlisted tool is a hard error.`;

export function buildSystemPrompt(extraRole = '') {
  return extraRole ? `${SYSTEM_PROMPT_HEADER}\n\n${extraRole}` : SYSTEM_PROMPT_HEADER;
}

// ── LLM call (OpenAI-compatible, non-streaming) ──────────────
async function callLLM(messages, { maxTokens = B2_MAX_TOKENS, temperature = 0.2, timeoutMs = B2_TIMEOUT_MS } = {}) {
  const res = await llmFetch(LLM_URL, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: maxTokens, temperature, stream: false }),
  }, { timeoutMs, enforceSizeLimit: true });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).substring(0, 200)}`);
  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content || '';
  return content;
}

// ── antml:tool_call parser ──────────────────────────────────
// Extracts every <antml:tool_call>{json}</antml:tool_call> block. Malformed JSON produces a
// __malformed entry so the loop can feed an error result back and let the model self-correct on the
// next turn (instead of dropping the call silently). Accepts both "arguments" (spec) and "params".
const TOOL_CALL_RE = /<antml:tool_call>\s*([\s\S]*?)\s*<\/antml:tool_call>/g;
function parseToolCalls(content) {
  if (!content) return [];
  const calls = [];
  let m;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(content)) !== null) {
    const raw = m[1].trim();
    let parsed = null;
    let err = null;
    try { parsed = JSON.parse(raw); } catch (e) { err = e.message; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      calls.push({ name: String(parsed.name || ''), arguments: parsed.arguments || parsed.params || {} });
    } else {
      calls.push({ __malformed: true, raw, error: err || 'invalid JSON (expected {name,arguments})' });
    }
  }
  return calls;
}

/**
 * runBrain2Agent — turns-based tool-call loop over the qwenproxy adapter.
 * @param {string} systemPrompt - from buildSystemPrompt()
 * @param {Array<{role,content}>} messages - the initial user turns (Brain 2's task + context)
 * @param {number} maxTurns - hard cap on LLM round-trips (default BRAIN2_MAX_TURNS)
 * @returns {Promise<{ok, text, turns, toolCalls}>} ok=true with a final text answer, or
 *   {ok:false, reason} (llm-failed / max-turns / bad-args). Never throws to the caller.
 */
export async function runBrain2Agent({ systemPrompt, messages, maxTurns = B2_MAX_TURNS, maxTokens = B2_MAX_TOKENS, temperature = 0.2 } = {}) {
  if (!systemPrompt || !Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'bad-args', turns: 0, toolCalls: 0 };
  }
  const convo = [{ role: 'system', content: systemPrompt }, ...messages];
  let totalToolCalls = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    let content;
    try {
      content = await callLLM(convo, { maxTokens, temperature });
    } catch (e) {
      LOG_DEBUG && console.error('[Brain2] LLM call failed (turn', turn, '):', e.message);
      return { ok: false, reason: 'llm-failed', error: e.message, turns: turn, toolCalls: totalToolCalls };
    }
    const calls = parseToolCalls(content);
    if (calls.length === 0) {
      // No tool call this turn -> final answer.
      return { ok: true, text: (content || '').trim(), turns: turn + 1, toolCalls: totalToolCalls };
    }
    // Keep the assistant's raw emission (the antml blocks) for conversation continuity.
    convo.push({ role: 'assistant', content });
    for (const c of calls) {
      totalToolCalls++;
      if (c.__malformed) {
        convo.push({ role: 'user', content: `Tool Response (malformed): ${JSON.stringify({ ok: false, error: 'malformed antml tool_call block: ' + c.error, raw_preview: String(c.raw).slice(0, 160) })}` });
        continue;
      }
      const result = await dispatchTool(c.name, c.arguments);
      let body;
      try { body = JSON.stringify(result); } catch { body = JSON.stringify({ ok: false, error: 'result-not-serializable' }); }
      convo.push({ role: 'user', content: `Tool Response (${c.name || 'unknown'}): ${body}` });
    }
  }
  // Exhausted turns without a clean no-tool final turn. Return the last assistant emission as best text.
  const last = convo.length ? convo[convo.length - 1] : null;
  return { ok: false, reason: 'max-turns', turns: maxTurns, toolCalls: totalToolCalls, text: (last?.content || '').slice(0, 500) };
}

// ── Augment orchestrator + status (Phase C-4 wires this into /memory/sync) ──
// Brain 1 stored chunked facts; Brain 2 re-reads the FULL conversation at 1M context and refines.
// Fire-and-forget — the sync endpoint responds before this runs. Single-flight: if a run is in
// progress, a second trigger is refused (don't pile augment calls on rapid sync bursts).
let _augmentState = {
  running: false, runs: 0,
  lastStartedAt: null, lastFinishedAt: null,
  lastTurns: 0, lastToolCalls: 0, lastOk: null, lastError: null, lastSummary: null,
};
export function getAugmentStatus() {
  return { ..._augmentState, running: _augmentState.running };
}

/**
 * runAugment — given the session context + the list of facts Brain 1 just stored, drive Brain 2 to
 * verify + supplement them via tool calls. Returns whatever runBrain2Agent returns. Updates the
 * module status tracker. Never throws (the caller is a fire-and-forget .catch on the sync path).
 * @param {object} ctx
 * @param {string} ctx.sessionId
 * @param {string} ctx.userMessage   - the user side of the synced exchange
 * @param {string} ctx.assistantResponse - the assistant side
 * @param {Array<{id,text,type,entity,attribute,importance}>} ctx.storedMemories - Brain 1's chunked facts
 */
export async function runAugment({ sessionId, userMessage, assistantResponse, storedMemories }) {
  if (_augmentState.running) return { ok: false, reason: 'already-running' };
  _augmentState.running = true;
  _augmentState.lastStartedAt = new Date().toISOString();
  _augmentState.runs++;
  try {
    const systemPrompt = buildSystemPrompt();
    const storedBlock = (storedMemories && storedMemories.length)
      ? storedMemories.map((m, i) =>
          `${i + 1}. [id=${m.id}] (${m.type || 'fact'}${m.entity ? `, entity=${m.entity}` : ''}${m.attribute ? `, attribute=${m.attribute}` : ''}, importance=${Number(m.importance || 0).toFixed(2)}): ${m.text}`
        ).join('\n')
      : '(Brain 1 stored no facts from this exchange.)';
    const userMsg = `SESSION: ${sessionId || '(none)'}\n\n=== FULL CONVERSATION (you see this at full context; Brain 1 had to chunk it) ===\nUSER:\n${userMessage || ''}\n\nASSISTANT:\n${assistantResponse || ''}\n\n=== FACTS BRAIN 1 ALREADY STORED FROM THIS EXCHANGE ===\n${storedBlock}\n\nYour task: verify each stored fact against the full conversation, EDIT incomplete/wrong ones in place, STORE any fact Brain 1 missed, ANNOTATE nuance, and (softly) FLAG any a newer fact supersedes. Respect the recoverability rule — never delete. Begin by listing the session's stored memories, then act. End with a one-line summary.`;
    const result = await runBrain2Agent({ systemPrompt, messages: [{ role: 'user', content: userMsg }] });
    _augmentState.lastFinishedAt = new Date().toISOString();
    _augmentState.lastTurns = result.turns || 0;
    _augmentState.lastToolCalls = result.toolCalls || 0;
    _augmentState.lastOk = !!result.ok;
    _augmentState.lastError = result.ok ? null : (result.reason || result.error || null);
    _augmentState.lastSummary = result.ok ? (result.text || '').slice(0, 1000) : null;
    if (LOG_DEBUG) console.log(`[Brain2] augment done: ok=${result.ok} turns=${result.turns} toolCalls=${result.toolCalls}${result.ok ? '' : ' reason=' + (result.reason || '')}`);
    return result;
  } catch (e) {
    _augmentState.lastFinishedAt = new Date().toISOString();
    _augmentState.lastOk = false;
    _augmentState.lastError = e.message;
    LOG_DEBUG && console.error('[Brain2] runAugment error:', e.message);
    return { ok: false, reason: 'throw', error: e.message };
  } finally {
    _augmentState.running = false;
  }
}
