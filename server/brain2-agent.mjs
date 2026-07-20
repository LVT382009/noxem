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
// Recoverability: this loop can only call brain2-tools handlers. Most are soft-mutate (edit text /
// rank / annotate / link — never prune/delete/status-flip). TWO narrow carve-outs (user Option-2,
// 2026-06-24): memory_merge absorbs REDUNDANT originals into a Brain2-authored merge row + hard-deletes
// the originals ONLY as that post-merge step (content preserved inside the merge text + citation_log);
// memory_compact REVERSIBLY archives a true orphan (status-flip + vec-prune — reactivate restores it,
// NOT a delete). L0/L3 cardinal rows survive both forever. No standalone delete exists — a wrong
// judgment self-heals on the next augment pass / a reconcile CRON / reactivate-on-reference (E7).

import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
import { BRAIN2_TOOLS_SPEC, dispatchTool } from './brain2-tools.mjs';
import { getAuditReport, db } from './memory-store.mjs'; // E23: audit-driven reconcile prompt + durable queue

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const B2_MAX_TURNS = parseInt(process.env.BRAIN2_MAX_TURNS || '8');
const B2_MAX_TOKENS = parseInt(process.env.BRAIN2_MAX_TOKENS || '1024');
const B2_TIMEOUT_MS = parseInt(process.env.BRAIN2_TIMEOUT_MS || '120000');

// E23 verdict-QUEUE constants (SQLite-backed, durable). The old single-flight DROP ("if running return
// 'already-running'") is gone — an augment or cron-reconcile ENQUEUES a job + kicks a sequential drain.
const BRAIN2_MAX_QUEUE_DEPTH = parseInt(process.env.BRAIN2_MAX_QUEUE_DEPTH || '2'); // bound: augment + 1 reconcile coexist, else reject (cron re-scans next tick)
const BRAIN2_STALE_JOB_MS = parseInt(process.env.BRAIN2_STALE_JOB_MS || '600000'); // resurrect a 'processing' job whose started_at is older than this (crashed drain)
const E23_MAX_ATTEMPTS = parseInt(process.env.E23_MAX_ATTEMPTS || '3'); // transient-retry ceiling before a job moves to the DLQ
let _b2Busy = false; // global single-flight across augment + reconcile (the queue table holds the real depth)

export const TOOLS_SPEC_JSON = JSON.stringify(BRAIN2_TOOLS_SPEC);

// The system prompt header Brain 2 receives every augment run. Stated role + recoverability rule +
// the 7-step workflow + the `# TOOLS AVAILABLE` menu + the antml `# TOOL CALLING FORMAT` contract +
// the 6 critical rules. extraRole lets a caller append a run-specific directive.
const SYSTEM_PROMPT_HEADER = `You are the noxem Brain 2 memory curator. You have READ, WRITE, REFINE, ANNOTATE, RANK, FLAG, MERGE, LINK, COMPACT, RESOLVE, and AUDIT tools over the memory corpus. Brain 1 (the semantic engine) just chunked the conversation at a small embedding context and stored facts — possibly splitting a single fact across chunks, rephrasing it, or missing a fact that spanned a chunk boundary. Your job is to verify and supplement what Brain 1 stored by looking at the FULL conversation (which you see at full context), and to RECONCILE tensions/redundancy the corpus has accumulated (see the RECONCILE section below).

RECOVERABILITY RULE (NON-NEGOTIABLE): standalone AI deletion is forbidden — you may NEVER remove a fact from retrieval by your own judgment. There is NO standalone delete tool. memory_edit rewrites text in place (previous text audited in metadata); memory_flag_superseded ONLY downranks + footnotes a stale fact — the row STAYS active and retrievable, so a wrong judgment reverses later. TWO narrow carve-outs where removal IS permitted, both with the content preserved so they self-heal:
- memory_merge absorbs REDUNDANT same-entity originals into a Brain2-authored merge row and hard-deletes the originals ONLY as that post-merge step. The originals' text survives inside the merge text + citation_log — so merge deletes NOTHING the merge row does not already contain. Low confidence (<0.7) does NOT delete: originals are soft-superseded (reversible) + flagged brain2_review_pending for a later reconcile.
- memory_compact REVERSIBLY archives a TRUE orphan (a row with NO related memory to enrich-merge into) — a status flip + vector prune. The row + its embedding BLOB survive; reactivate-on-reference (E7) restores it. compact is NOT a delete.
L0 episode + L3 persona rows survive BOTH carve-outs forever (the cardinal guard refuses them). NEVER compact a row that has a related memory to merge into — MERGE-FIRST, COMPACT-ONLY-AS-FALLBACK. Prefer editing/annotating over storing a near-duplicate; prefer flag_superseded over discarding nuance; prefer merge/resolve over compact.

WORKFLOW:
1. Use memory_list_session to see the facts Brain 1 just stored from this conversation.
2. Use memory_search / memory_get to cross-check each chunked fact against older stored memories and against the full conversation below.
3. For a chunked fact that is INCOMPLETE or WRONG, use memory_edit to fix it in place (cite why in the reason field).
4. For a nuance / uncertainty / source caveat, use memory_annotate.
5. For a fact Brain 1 MISSED entirely (present in the conversation, absent from storage), use memory_store.
6. For a stored fact that a NEWER fact supersedes, use memory_flag_superseded (soft — both stay retrievable).
7. When done, output a one-line summary of what you changed/stored and STOP (no further tool calls).

Be surgical: small in-place edits beat wholesale rewrites. When in doubt, annotate rather than flag.

RECONCILE (merge / link / resolve / compact / audit) — separate from the per-conversation verification above:
8. Start a reconcile pass with memory_audit_report to SEE the open tensions, do not guess: it returns status totals, the open contradiction pairs AWAITING a verdict, the low-confidence merges awaiting review (brain2_review_pending), the merged-row count, and a live edge histogram.
9. CONTRADICTIONS — two rows that genuinely conflict (linked status='contradicted' by the detect pass) get an EXPLICIT verdict via memory_resolve_contradiction, NEVER a silent pick: unlink (false alarm — clear the pair, both active), uphold (winner_id wins — soft-flag the loser superseded-by winner, both stay retrievable), or merge (the two are facets of one truth — fold them into a canonical merge_text; same confidence rules as memory_merge). Read both rows (memory_get) before deciding.
9b. SIMILAR PAIRS — rows linked status='similar_pending' by the cron's dedup flag-pass (near-duplicates the cron flagged but did NOT merge) get an EXPLICIT verdict via memory_resolve_similar, NEVER a silent skip: distinct (they are genuinely different facts/facets — unlink + keep both active), supersede (winner_id wins — reversible soft-flag the loser; both stay retrievable), or merge (fold into one canonical merge_text; low confidence does NOT hard-delete). Read both rows (memory_get) before deciding. A pair you verdict distinct STAYS distinct — a watermark+cooldown stops the cron from re-flagging the same unchanged pair every tick, so do not re-litigate it.
10. REDUNDANCY — N (>=2) rows that RESTATE the same fact (same entity, same cone layer, genuinely redundant — NOT distinct facets) fold into ONE canonical merge_text via memory_merge. Author a merge_text that preserves EVERY distinct detail from the originals (do not drop nuance). High confidence (>=0.7) hard-deletes the absorbed originals; low confidence (<0.7) soft-supersedes them reversibly + raises brain2_review_pending — never silently finalize an uncertain merge. When unsure whether two rows are redundant or are distinct facets, annotate + flag_superseded, do NOT merge.
11. LINKING — when your reasoning surfaces a relationship the cone layers / supersede chain cannot express, author a FREE-FORM edge with memory_link. The relation label is not a fixed enum — invent exactly the link you found (relates_to, caused_by, prerequisites, dual_of, supersedes_explains, …). Optionally bi-temporal (valid_from/valid_until) + a 0-1 strength. Always pass a reason (recorded in edge metadata). NEVER link a memory to itself.
12. COMPACT (orphan fallback ONLY) — a stale L1/L2 row that you have searched (memory_search) and confirmed has NO related memory to enrich-merge into may be REVERSIBLY archived via memory_compact. This is the LAST resort: merge-with-a-neighbor is always preferred when a neighbor exists. Never compact a row in an open contradiction pair (resolve it first); never compact L0/L3 (the guard refuses them anyway).
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
export async function runBrain2Agent({ systemPrompt, messages, maxTurns = B2_MAX_TURNS, maxTokens = B2_MAX_TOKENS, temperature = 0.2, dispatch } = {}) {
  if (!systemPrompt || !Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'bad-args', turns: 0, toolCalls: 0 };
  }
  const convo = [{ role: 'system', content: systemPrompt }, ...messages];
  // Optional dispatch override: runAugment injects the augment session_id into memory_store
  // calls (Brain 2's store tool doesn't expose session_id, so brand-new augment-stored facts
  // would otherwise carry session_id="" and vanish from per-session scans). Falls back to the
  // shared dispatchTool when no override is passed (standalone agent use).
  const d = dispatch || dispatchTool;
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
      const result = await d(c.name, c.arguments);
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
  return { ..._augmentState, running: _augmentState.running, b2_busy: _b2Busy, queue: getB2QueueStatus() };
}

// ── E23 verdict QUEUE (SQLite-backed, durable) ───────────────────────────
// The old single-flight DROP ("if (_augmentState.running) return 'already-running'") is gone. An augment
// OR a cron-triggered reconcile now ENQUEUES a job onto the durable pending_verdicts table (survives a
// segfault — counter-C FM2: in-process JS would lose ALL queued verdicts on a crash). A single global
// drain runs jobs sequentially (concurrency=1 across BOTH augment + reconcile — NIM rule + one Brain2 at
// a time), bounded by BRAIN2_MAX_QUEUE_DEPTH=2. Overflow rejects the enqueue: for a cron-reconcile that
// means the pair stays in open_similar_pairs + the cron re-scans it the next tick (counter-D: no silent
// loss — the dedup→resolve loop never drops a verdict). Permanent LLM errors move a job to
// pending_verdicts_dlq; transient errors re-queue for the next tick (ceiling E23_MAX_ATTEMPTS, then DLQ).
const _pvEnq = db.prepare("INSERT INTO pending_verdicts (kind, payload_json, content_hash, status) VALUES (?, ?, ?, 'queued')");
const _pvClaim = db.prepare("UPDATE pending_verdicts SET status='processing', started_at=datetime('now'), attempts=attempts+1 WHERE id=?");
const _pvDone = db.prepare("UPDATE pending_verdicts SET status='done' WHERE id=?");
const _pvReset = db.prepare("UPDATE pending_verdicts SET status='queued', started_at=NULL WHERE id=?");
const _pvDlqInsert = db.prepare("INSERT INTO pending_verdicts_dlq (kind, payload_json, content_hash, attempts, reason, enqueued_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
const _pvRm = db.prepare("DELETE FROM pending_verdicts WHERE id=?");
const _pvCountQueued = db.prepare("SELECT COUNT(*) AS c FROM pending_verdicts WHERE status='queued'");
const _pvNext = db.prepare("SELECT id, kind, payload_json, attempts FROM pending_verdicts WHERE status='queued' ORDER BY enqueued_at ASC, id ASC LIMIT 1");
const _pvStale = db.prepare("UPDATE pending_verdicts SET status='queued', started_at=NULL WHERE status='processing' AND started_at IS NOT NULL AND started_at < datetime('now', ?)");
const _pvQueueDump = db.prepare("SELECT id, kind, status, attempts, enqueued_at, started_at FROM pending_verdicts ORDER BY enqueued_at DESC LIMIT 50");

// Non-retryable error signatures (5xx / DNS / hard LLM refusal). Everything else is a transient retry.
const _B2_NONRETRY = /HTTP 5\d\d|^llm-failed|ENOTFOUND|ECONNRESET|EAI_AGAIN|socket hang up|timeout|non-retryable/i;
function _classifyB2Error(err) {
  const m = String((err && err.message) || err || '');
  return _B2_NONRETRY.test(m) ? { retryable: false, reason: m } : { retryable: true, reason: m };
}
function _toDlq(row, reason) {
  try { _pvDlqInsert.run(row.kind, row.payload_json, row.content_hash, Number(row.attempts) || 0, String(reason).slice(0, 500)); _pvRm.run(row.id); }
  catch (e) { LOG_DEBUG && console.error('[E23] DLQ insert failed:', e.message); }
}
function _tryClaimNext() {
  _pvStale.run(`-${Math.floor(BRAIN2_STALE_JOB_MS / 1000)} seconds`); // resurrect a crashed 'processing' job
  const row = _pvNext.get();
  if (!row || !row.id) return null;
  _pvClaim.run(row.id);
  return row;
}

export function enqueueB2Job(kind, payload, contentHash = null) {
  if (kind !== 'augment' && kind !== 'reconcile') return { ok: false, reason: 'bad-kind' };
  const queuedNow = _pvCountQueued.get().c;
  if (queuedNow >= BRAIN2_MAX_QUEUE_DEPTH) return { ok: false, reason: 'queue-full', depth: BRAIN2_MAX_QUEUE_DEPTH, queued: queuedNow };
  const info = _pvEnq.run(kind, JSON.stringify(payload || {}), contentHash != null ? String(contentHash) : null);
  return { ok: true, id: Number(info.lastInsertRowid), queued: queuedNow + 1, depth: BRAIN2_MAX_QUEUE_DEPTH };
}

export function enqueueReconcileJob(contentHash = null) { return enqueueB2Job('reconcile', { triggered_by: 'cron' }, contentHash); }

export function getB2QueueStatus() {
  return { busy: _b2Busy, queued: _pvCountQueued.get().c, depth: BRAIN2_MAX_QUEUE_DEPTH, jobs: _pvQueueDump.all() };
}

/**
 * drainB2Queue — claim + execute the oldest queued job, strictly one at a time (concurrency=1). Idempotent:
 * a second drain while one is running returns {ok,reason:'busy'} and neither enqueues nor drops. Called
 * fire-and-forget from runAugment (after an enqueue) AND from the maintenance cron tick (after a reconcile
 * enqueue) — the cron "flags then PINGS Brain 2". Never throws to the caller.
 */
export async function drainB2Queue() {
  if (_b2Busy) return { ok: false, reason: 'busy' };
  _b2Busy = true;
  try {
    const claimed = _tryClaimNext();
    if (!claimed) return { ok: true, reason: 'idle', drained: 0 };
    const out = await _executeB2Job(claimed);
    return { ok: true, drained: 1, kind: claimed.kind, outcome: out };
  } finally {
    _b2Busy = false;
  }
}

async function _executeB2Job(row) {
  let payload;
  try { payload = JSON.parse(row.payload_json || '{}'); }
  catch (e) { _toDlq(row, 'bad-payload-json: ' + e.message); return { ok: false, reason: 'dlq-bad-payload' }; }
  let result;
  try {
    result = (row.kind === 'augment') ? await _runAugmentInternal(payload) : await _runReconcileInternal(payload);
  } catch (e) {
    const cls = _classifyB2Error(e);
    if (!cls.retryable) { _toDlq(row, 'non-retryable: ' + cls.reason); return { ok: false, reason: 'dlq', error: cls.reason }; }
    _pvReset.run(row.id); // transient — back to 'queued' for the next tick
    if (LOG_DEBUG) console.error('[E23] job transient error, re-queued:', cls.reason);
    return { ok: false, reason: 'retry-queued', error: cls.reason };
  }
  if (result && result.ok === false) {
    const attempts = Number(row.attempts) || 1;
    if (attempts < E23_MAX_ATTEMPTS) { _pvReset.run(row.id); return { ok: false, reason: 'retry-queued', attempts }; }
    _toDlq(row, 'exhausted-attempts: ' + (result.reason || 'unknown'));
    return { ok: false, reason: 'dlq-exhausted', attempts };
  }
  _pvDone.run(row.id);
  return { ok: true, kind: row.kind };
}

/**
 * runAugment — given the session context + the list of facts Brain 1 just stored, ENQUEUE an augment job
 * + kick the sequential drain. Returns immediately ({ok,reason:'enqueued'}) so the fire-and-forget sync
 * caller is never blocked. Queue-full ⇒ reject (best-effort Brain2 refinement skipped this cycle; the
 * stored Brain1 facts survive as-is — no fact is lost, only this refinement pass). The actual agent loop
 * runs later in _runAugmentInternal via drainB2Queue, one job at a time.
 * @param {object} ctx
 * @param {string} ctx.sessionId
 * @param {string} ctx.userMessage   - the user side of the synced exchange
 * @param {string} ctx.assistantResponse - the assistant side
 * @param {Array<{id,text,type,entity,attribute,importance}>} ctx.storedMemories - Brain 1's chunked facts
 */
export async function runAugment({ sessionId, userMessage, assistantResponse, storedMemories }) {
  const enq = enqueueB2Job('augment', { sessionId, userMessage, assistantResponse, storedMemories });
  if (enq.ok !== true) {
    _augmentState.lastError = `queue-full (${enq.queued || 0}/${BRAIN2_MAX_QUEUE_DEPTH})`;
    if (LOG_DEBUG) console.log(`[Brain2] augment rejected: ${enq.reason}`);
    return { ok: false, reason: enq.reason, queued: enq.queued };
  }
  _augmentState.runs++;
  if (LOG_DEBUG) console.log(`[Brain2] augment enqueued #${enq.id}, kicking drain`);
  drainB2Queue().catch(e => { LOG_DEBUG && console.error('[Brain2] drain kick failed:', e.message); });
  return { ok: true, reason: 'enqueued', id: enq.id, queued: enq.queued };
}

// _runAugmentInternal — the OLD runAugment body, run by the queue drain (one job at a time). No single-flight
// (the queue's _b2Busy gate replaces _augmentState.running). Records the per-run telemetry + returns the
// agent result so _executeB2Job can apply retry/DLQ policy on ok:false.
async function _runAugmentInternal({ sessionId, userMessage, assistantResponse, storedMemories }) {
  _augmentState.lastStartedAt = new Date().toISOString();
  try {
    const systemPrompt = buildSystemPrompt();
    const storedBlock = (storedMemories && storedMemories.length)
      ? storedMemories.map((m, i) =>
          `${i + 1}. [id=${m.id}] (${m.type || 'fact'}${m.entity ? `, entity=${m.entity}` : ''}${m.attribute ? `, attribute=${m.attribute}` : ''}, importance=${Number(m.importance || 0).toFixed(2)}): ${m.text}`
        ).join('\n')
      : '(Brain 1 stored no facts from this exchange.)';
    const userMsg = `SESSION: ${sessionId || '(none)'}\n\n=== FULL CONVERSATION (you see this at full context; Brain 1 had to chunk it) ===\nUSER:\n${userMessage || ''}\n\nASSISTANT:\n${assistantResponse || ''}\n\n=== FACTS BRAIN 1 ALREADY STORED FROM THIS EXCHANGE ===\n${storedBlock}\n\nYour task: verify each stored fact against the full conversation, EDIT incomplete/wrong ones in place, STORE any fact Brain 1 missed, ANNOTATE nuance, and (softly) FLAG any a newer fact supersedes. Respect the recoverability rule — never delete. Begin by listing the session's stored memories, then act. End with a one-line summary.`;
    const dispatch = (name, args) => {
      const a = (name === 'memory_store' && args && !args.session_id) ? { ...args, session_id: sessionId || '' } : args;
      return dispatchTool(name, a);
    };
    const result = await runBrain2Agent({ systemPrompt, messages: [{ role: 'user', content: userMsg }], dispatch });
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
    LOG_DEBUG && console.error('[Brain2] _runAugmentInternal error:', e.message);
    return { ok: false, reason: 'throw', error: e.message };
  }
}

// _runReconcileInternal — cron-triggered verdict pass over OPEN pairs (status=similar_pending from the
// dedup flag-pass + status=contradicted from the contradiction detect-pass). Builds an audit-driven prompt,
// drives the Brain2 agent loop to emit memory_resolve_similar / memory_resolve_contradiction verdicts, returns
// the agent result. Idles out when no pairs are open (returns ok:true idle-no-work — not a failure).
async function _runReconcileInternal(payload = {}) {
  const audit = getAuditReport();
  const similarPairs = Array.isArray(audit.open_similar_pairs) ? audit.open_similar_pairs : [];
  const contraPairs = Array.isArray(audit.open_contradiction_pairs) ? audit.open_contradiction_pairs : [];
  if (similarPairs.length === 0 && contraPairs.length === 0 && !payload.force) {
    if (LOG_DEBUG) console.log('[Brain2] reconcile idle — no open pairs awaiting a verdict');
    return { ok: true, reason: 'idle-no-work', reconciled: 0, similar: similarPairs.length, contradictions: contraPairs.length };
  }
  const fmt = (arr) => arr.length
    ? arr.map((p, i) => `${i + 1}. pair #${p.id}↔#${p.pair_id}${p.entity ? ` entity=${p.entity}${p.attribute ? '/' + p.attribute : ''}` : ''}: "${String(p.text || '').slice(0, 200)}"`).join('\n')
    : '(none)';
  const extraRole = `RECONCILE PASS (cron-triggered). Open similar-pair flags awaiting your verdict: ${similarPairs.length}. Open contradiction pairs: ${contraPairs.length}.
Resolve EVERY open similar pair with memory_resolve_similar: read BOTH rows (memory_get) first, then pick mode=distinct (they are genuinely different facts/facets — unlink, keep both active), supersede (winner_id wins — reversible soft-flag the loser; both stay retrievable), or merge (fold the two into one canonical merge_text). The watermark instinct: a pair you verdict distinct STAYS distinct until its text mutates or the cooldown lapses — do not re-litigate an already-judged pair.`;
  const systemPrompt = buildSystemPrompt(extraRole);
  const userMsg = `=== OPEN SIMILAR PAIRS (status=similar_pending, awaiting your verdict) ===\n${fmt(similarPairs)}\n\n=== OPEN CONTRADICTION PAIRS (status=contradicted, awaiting your verdict) ===\n${fmt(contraPairs)}\n\nResolve each open pair now with memory_resolve_similar / memory_resolve_contradiction. When all are resolved, output a one-line summary and STOP.`;
  const result = await runBrain2Agent({ systemPrompt, messages: [{ role: 'user', content: userMsg }] });
  if (LOG_DEBUG) console.log(`[Brain2] reconcile done: ok=${result.ok} turns=${result.turns} toolCalls=${result.toolCalls}${result.ok ? '' : ' reason=' + (result.reason || '')}`);
  return result;
}
