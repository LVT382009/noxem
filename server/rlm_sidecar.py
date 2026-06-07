#!/usr/bin/env python3
"""
RLM (Recursive Language Model) Sidecar — Brain 2 upgrade.

NDJSON protocol over stdin/stdout:
  Request:  {"task": "pre_compress_analysis|advice|session_end_analysis", "context": {...}, "llmUrl": "...", "llmModel": "...", "config": {...}}
  Response: {"status": "ok|degraded|error", "data": {...}, "metadata": {"calls": N, "tokens": N, "elapsed_ms": N}}

Decomposition strategies:
  pre_compress_analysis: peek → classify → extract → synthesize (3 sub-calls)
  advice: context_check → memory_relevance → advise (2-3 sub-calls)
  session_end_analysis: partition → batch_extract → dedup (2-3 sub-calls)
"""

import os
import sys
import json
import time
import asyncio
import re
import signal

# Ignore SIGPIPE so parent process closing the pipe doesn't kill us with traceback
try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except AttributeError:
    pass  # Windows has no SIGPIPE

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

# Default per-call LLM timeout (seconds). Cloud LLMs need more than the old 15s default.
_llm_timeout = [int(os.environ.get("RLM_LLM_TIMEOUT", "60"))]

# ── Token Budget ──────────────────────────────────────────

class TokenBudget:
    def __init__(self, max_calls=5, max_total_tokens=4096):
        self.max_calls = max_calls
        self.max_total_tokens = max_total_tokens
        self.calls_made = 0
        self.tokens_used = 0
        self.start_time = time.time()

    def check(self, estimated=512):
        if self.calls_made >= self.max_calls:
            return False
        if self.tokens_used + estimated > self.max_total_tokens:
            return False
        return True

    def consume(self, tokens):
        self.calls_made += 1
        self.tokens_used += tokens

    def elapsed_ms(self):
        return int((time.time() - self.start_time) * 1000)

    def summary(self):
        return {
            "calls": self.calls_made,
            "tokens": self.tokens_used,
            "elapsed_ms": self.elapsed_ms(),
        }


# ── LLM Call ──────────────────────────────────────────────

async def call_llm(url, model, messages, max_tokens=512, temperature=0.1, timeout=None, api_key=""):
    """Call the LLM endpoint. Returns (content_string, tokens_used)."""
    if timeout is None:
        timeout = _llm_timeout[0]
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    if HAS_HTTPX:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    else:
        # Fallback: use urllib (no httpx installed)
        import urllib.request
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage", {})
    tokens = usage.get("total_tokens", len(content) // 4)
    return content, tokens


_last_llm_error = [None]  # Track last error to suppress repeats

async def call_llm_safe(url, model, messages, max_tokens=512, temperature=0.1, timeout=None, api_key=""):
    """Call LLM, return empty string on error instead of raising."""
    if timeout is None:
        timeout = _llm_timeout[0]
    try:
        content, tokens = await call_llm(url, model, messages, max_tokens, temperature, timeout, api_key)
        _last_llm_error[0] = None
        return content, tokens
    except Exception as e:
        err_msg = str(e)
        # Suppress repeated identical errors (e.g. Connection refused on every sub-call)
        if _last_llm_error[0] != err_msg:
            _last_llm_error[0] = err_msg
            # Short format for connection errors — no full traceback noise
            if 'Connection refused' in err_msg or 'ConnectError' in err_msg:
                print(f"[RLM] LLM unreachable: {url.split('//')[-1].split('/')[0]}", file=sys.stderr)
            else:
                print(f"[RLM] LLM call failed: {e}", file=sys.stderr)
        return "", 0


# ── Task Decomposition ────────────────────────────────────

# Extract balanced JSON object from LLM output (handles nested braces)
def _extract_json_object(text):
    """Find the first balanced { ... } in text, respecting string escaping."""
    start = text.find('{')
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == '\\' and in_str:
            escape = True
            continue
        if ch == '"' and not escape:
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '{':
            depth += 1
        if ch == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


# Extract balanced JSON array from LLM output (handles nested brackets)
def _extract_json_array(text):
    """Find the first balanced [ ... ] in text, respecting string escaping."""
    start = text.find('[')
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == '\\' and in_str:
            escape = True
            continue
        if ch == '"' and not escape:
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == '[':
            depth += 1
        if ch == ']':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


async def analyze_before_compress(req, budget):
    """
    Decompose: peek → classify → extract → synthesize.
    Sub-calls: 3 (peek+classify parallelized as 1 batch, extract=1, synthesize=root)
    """
    llm_url = req["llmUrl"]
    llm_model = req["llmModel"]
    llm_api_key = req.get("llmApiKey", "")
    ctx = req.get("context", {})
    history = ctx.get("conversationHistory", [])
    memories = ctx.get("sessionMemories", [])

    # Step 1: Peek — identify structure (which turns contain decisions vs small talk)
    if not budget.check(256):
        return await _single_shot_compress(req, budget)

    turns_text = []
    for i, t in enumerate(history):
        role = (t.get("role") or "user").upper()
        content = (t.get("content") or "")[:500]
        turns_text.append(f"[{i}] {role}: {content}")

    all_turns = "\n".join(turns_text)

    peek_prompt = f"""Classify each conversation turn. Return ONLY a JSON array of objects:
[{{"index": 0, "category": "decision|fact|code|social|setup", "salience": 0.0-1.0}}]
Mark turns with salience >= 0.6 as high-priority for extraction.

Conversation:
{all_turns[:3000]}"""

    peek_content, peek_tokens = await call_llm_safe(
        llm_url, llm_model,
        [{"role": "system", "content": "You classify conversation turns by type and importance. Return only valid JSON."},
         {"role": "user", "content": peek_prompt}],
        256, 0.1, api_key=llm_api_key
    )
    budget.consume(peek_tokens)

    # Parse high-salience turns
    high_indices = set()
    try:
        result_str = _extract_json_array(peek_content)
        if result_str:
            classifications = json.loads(result_str)
            for c in classifications:
                if c.get("salience", 0) >= 0.6:
                    high_indices.add(c.get("index", -1))
    except (json.JSONDecodeError, AttributeError):
        # Fallback: use last 30% of turns
        fallback_count = max(3, len(history) // 3)
        high_indices = set(range(len(history) - fallback_count, len(history)))

    # Step 2: Extract from high-salience turns only
    if not budget.check(1024):
        return await _single_shot_compress(req, budget)

    priority_turns = [history[i] for i in sorted(high_indices) if i < len(history)]
    priority_text = "\n".join(
        f"{t.get('role', 'user').upper()}: {(t.get('content') or '')[:1000]}"
        for t in priority_turns
    )

    memory_text = "\n".join(f"[{m.get('type', 'fact')}] {m.get('text', '')}" for m in memories[:20])

    extract_prompt = f"""Analyze the high-priority conversation turns and session memories.
Return JSON:
{{"critical_context": ["..."], "task_drift_warnings": ["..."], "key_facts": ["..."], "advice": "..."}}

Session memories:
{memory_text or 'None'}

High-priority turns:
{priority_text[:4000]}

Extract critical context, drift warnings, key facts, and advice:"""

    extract_content, extract_tokens = await call_llm_safe(
        llm_url, llm_model,
        [{"role": "system", "content": "You are a second-brain advisor. Extract critical context from conversations. Return valid JSON."},
         {"role": "user", "content": extract_prompt}],
        1024, 0.2, api_key=llm_api_key
    )
    budget.consume(extract_tokens)

    # Parse extraction result
    try:
        result_str = _extract_json_object(extract_content)
        if result_str:
            result = json.loads(result_str)
            return {
                "critical_context": result.get("critical_context", []),
                "task_drift_warnings": result.get("task_drift_warnings", []),
                "key_facts": result.get("key_facts", []),
                "advice": result.get("advice", ""),
            }
    except (json.JSONDecodeError, AttributeError):
        pass

    # If JSON parse failed, return raw text
    return {"critical_context": [extract_content], "task_drift_warnings": [], "key_facts": [], "advice": ""}


async def get_advice(req, budget, turn_limit=1500):
    """
    Decompose: context_check → memory_relevance → advise.
    Sub-calls: 2 (check+relevance parallelized, advise=1)
    """
    llm_url = req["llmUrl"]
    llm_model = req["llmModel"]
    llm_api_key = req.get("llmApiKey", "")
    ctx = req.get("context", {})
    user_msg = ctx.get("userMessage", "")
    history = ctx.get("conversationHistory", [])
    memories = ctx.get("activeMemories", [])

    # Step 1: Check context for drift (parallel with memory relevance)
    if not budget.check(512):
        return await _single_shot_advice(req, budget)

    recent_text = "\n".join(
        f"{t.get('role', 'user').upper()}: {(t.get('content') or '')[:turn_limit]}"
        for t in (history or [])[-6:]
    )

    memory_text = "\n".join(f"[{m.get('type', 'fact')}] {m.get('text', '')}" for m in (memories or [])[:15])

    advise_prompt = f"""You are a second-brain advisor. Check for task drift and provide advice.

Current memories:
{memory_text or 'None'}

Recent conversation:
{recent_text or 'Starting new conversation'}

User says: {user_msg[:500]}

Return JSON:
{{"drift_detected": false, "drift_details": [], "relevant_memories": [], "advice_text": "...", "severity": "none|low|medium|high"}}"""

    content, tokens = await call_llm_safe(
        llm_url, llm_model,
        [{"role": "system", "content": "You detect task drift and provide advice. Return valid JSON."},
         {"role": "user", "content": advise_prompt}],
        800, 0.2, api_key=llm_api_key
    )
    budget.consume(tokens)

    try:
        result_str = _extract_json_object(content)
        if result_str:
            result = json.loads(result_str)
            return {
                "drift_detected": result.get("drift_detected", False),
                "drift_details": result.get("drift_details", []),
                "relevant_memories": result.get("relevant_memories", []),
                "advice_text": result.get("advice_text", ""),
                "severity": result.get("severity", "none"),
            }
    except (json.JSONDecodeError, AttributeError):
        pass

    return {"drift_detected": False, "drift_details": [], "relevant_memories": [], "advice_text": content, "severity": "none"}


async def analyze_session_end(req, budget, turn_limit=1500):
    """
    Decompose: partition → batch_extract → dedup.
    Sub-calls: 2-3 (1 batched extract + 1 dedup)
    """
    llm_url = req["llmUrl"]
    llm_model = req["llmModel"]
    llm_api_key = req.get("llmApiKey", "")
    ctx = req.get("context", {})
    history = ctx.get("conversationHistory", [])

    if not history:
        return {"memories": [], "session_summary": "", "statistics": {"turns_analyzed": 0, "memories_extracted": 0, "deduplication_merges": 0}}

    # Step 1: Partition into chunks of ~5 turns
    chunk_size = 5
    chunks = [history[i:i+chunk_size] for i in range(0, len(history), chunk_size)]

    # Step 2: Batch extract memories from each chunk
    all_memories = []
    for chunk in chunks[:10]:  # Max 10 chunks = 50 turns
        if not budget.check(512):
            break

        chunk_text = "\n".join(
            f"{t.get('role', 'user').upper()}: {(t.get('content') or '')[:turn_limit]}"
            for t in chunk
        )

        prompt = f"""Extract factual memories from this conversation chunk.
Return ONLY a JSON array: [{{"text": "...", "type": "fact|preference|project|goal|pattern|entity|event|issue|setup|learning|profile"}}]

Rules: Extract only non-obvious, durable facts. Omit greetings, small talk, confirmations.

Conversation chunk:
{chunk_text}

Extract memories:"""

        content, tokens = await call_llm_safe(
            llm_url, llm_model,
            [{"role": "system", "content": "You extract memories from conversations. Return only valid JSON arrays."},
             {"role": "user", "content": prompt}],
            512, 0.1, api_key=llm_api_key
        )
        budget.consume(tokens)

        try:
            result_str = _extract_json_array(content)
            if result_str:
                chunk_mems = json.loads(result_str)
                if isinstance(chunk_mems, list):
                    all_memories.extend([m for m in chunk_mems if m.get("text") and m.get("type")])
        except (json.JSONDecodeError, AttributeError):
            pass

    # Step 3: Dedup — merge overlapping memories
    if not budget.check(256):
        # Simple dedup by text similarity
        deduped = _simple_dedup(all_memories)
        return {
            "memories": deduped,
            "session_summary": f"Extracted {len(deduped)} memories from {len(history)} turns",
            "statistics": {"turns_analyzed": len(history), "memories_extracted": len(deduped), "deduplication_merges": len(all_memories) - len(deduped)},
        }

    if len(all_memories) > 2:
        dedup_prompt = f"""Merge overlapping or duplicate memories from this list.
Return ONLY a JSON array of unique memories: [{{"text": "...", "type": "..."}}]

Memories to dedup:
{json.dumps(all_memories[:15], ensure_ascii=False)}

Deduplicated memories:"""

        content, tokens = await call_llm_safe(
            llm_url, llm_model,
            [{"role": "system", "content": "You deduplicate memories. Return only valid JSON arrays."},
             {"role": "user", "content": dedup_prompt}],
            512, 0.1, api_key=llm_api_key
        )
        budget.consume(tokens)

        try:
            result_str = _extract_json_array(content)
            if result_str:
                deduped = json.loads(result_str)
                if isinstance(deduped, list):
                    return {
                        "memories": [m for m in deduped if m.get("text") and m.get("type")],
                        "session_summary": f"Extracted {len(deduped)} unique memories from {len(history)} turns",
                        "statistics": {"turns_analyzed": len(history), "memories_extracted": len(deduped), "deduplication_merges": len(all_memories) - len(deduped)},
                    }
        except (json.JSONDecodeError, AttributeError):
            pass

    deduped = _simple_dedup(all_memories)
    return {
        "memories": deduped,
        "session_summary": f"Extracted {len(deduped)} memories from {len(history)} turns",
        "statistics": {"turns_analyzed": len(history), "memories_extracted": len(deduped), "deduplication_merges": len(all_memories) - len(deduped)},
    }


# ── Fallbacks ─────────────────────────────────────────────

async def _single_shot_compress(req, budget):
    """Single LLM call fallback for pre_compress_analysis."""
    ctx = req.get("context", {})
    history = ctx.get("conversationHistory", [])
    memories = ctx.get("sessionMemories", [])

    turns_text = "\n".join(
        f"{t.get('role', 'user').upper()}: {(t.get('content') or '')[:1000]}"
        for t in (history or [])[-10:]
    )
    mem_text = "\n".join(f"[{m.get('type', 'fact')}] {m.get('text', '')}" for m in (memories or [])[-10:])

    content, tokens = await call_llm_safe(
        req["llmUrl"], req["llmModel"],
        [{"role": "system", "content": "You are a second-brain advisor. Return JSON: {\"critical_context\":[],\"task_drift_warnings\":[],\"key_facts\":[],\"advice\":\"\"}"},
         {"role": "user", "content": f"Memories:\n{mem_text}\n\nConversation:\n{turns_text}"}],
        1024, 0.2, api_key=req.get("llmApiKey", "")
    )
    budget.consume(tokens)

    try:
        result_str = _extract_json_object(content)
        if result_str:
            return json.loads(result_str)
    except (json.JSONDecodeError, AttributeError):
        pass

    return {"critical_context": [content], "task_drift_warnings": [], "key_facts": [], "advice": ""}


async def _single_shot_advice(req, budget):
    """Single LLM call fallback for advice."""
    ctx = req.get("context", {})

    content, tokens = await call_llm_safe(
        req["llmUrl"], req["llmModel"],
        [{"role": "system", "content": "You are a second-brain advisor. Return JSON: {\"drift_detected\":false,\"drift_details\":[],\"relevant_memories\":[],\"advice_text\":\"\",\"severity\":\"none\"}"},
         {"role": "user", "content": ctx.get("userMessage", "")[:500]}],
        800, 0.2, api_key=req.get("llmApiKey", "")
    )
    budget.consume(tokens)

    try:
        result_str = _extract_json_object(content)
        if result_str:
            return json.loads(result_str)
    except (json.JSONDecodeError, AttributeError):
        pass

    return {"drift_detected": False, "drift_details": [], "relevant_memories": [], "advice_text": content, "severity": "none"}


def _simple_dedup(memories):
    """Text-similarity dedup without LLM."""
    seen = set()
    unique = []
    for m in memories:
        text = m.get("text", "").lower().strip()
        key = text[:60]
        if key not in seen:
            seen.add(key)
            unique.append(m)
    return unique


# ── Main Loop ─────────────────────────────────────────────

async def process_task(req):
    task = req.get("task", "")
    config = req.get("config", {})
    budget = TokenBudget(
        max_calls=config.get("maxSubCalls", 5),
        max_total_tokens=config.get("maxTokensBudget", 4096),
    )
    # Scale per-turn content limit based on LLM context window
    # 8192 context -> 1500 chars/turn; 32768 -> 6000 chars/turn; etc.
    _ctx_window = config.get("contextWindow", 8192)
    turn_limit = min(int(_ctx_window * 0.18), 32000)
    # Override per-call LLM timeout if bridge sends one
    _req_llm_timeout = config.get("llmTimeout")
    if _req_llm_timeout:
        _llm_timeout[0] = int(_req_llm_timeout)

    try:
        if task == "pre_compress_analysis":
            data = await analyze_before_compress(req, budget)
        elif task == "advice":
            data = await get_advice(req, budget, turn_limit)
        elif task == "session_end_analysis":
            data = await analyze_session_end(req, budget, turn_limit)
        else:
            return {"status": "error", "error": f"unknown task: {task}", "metadata": budget.summary()}

        return {"status": "ok", "data": data, "metadata": budget.summary()}
    except Exception as e:
        return {"status": "error", "error": str(e), "metadata": budget.summary()}


def main():
    """NDJSON main loop: read JSON lines from stdin, write JSON lines to stdout."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Use readline in executor to avoid blocking the event loop on Windows
    def _read_line():
        try:
            return sys.stdin.readline()
        except Exception:
            return None

    while True:
        line = loop.run_until_complete(
            loop.run_in_executor(None, _read_line)
        )
        if not line:
            break  # EOF
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"status": "error", "error": f"invalid JSON: {e}", "metadata": {"calls": 0, "tokens": 0, "elapsed_ms": 0}}
            try:
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
            except BrokenPipeError:
                break
            continue

        result = loop.run_until_complete(process_task(req))
        try:
            sys.stdout.write(json.dumps(result) + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            break
if __name__ == "__main__":
    main()
