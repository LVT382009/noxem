"""Noxem — AI-powered memory provider for Hermes Agent.

Two-brain architecture:
- Brain 1: EmbeddingGemma 300M → embedding search, dedup, contradiction detection
- Brain 2: Gemma 4 E2B → advisor, context recovery, DDG-augmented guidance

Communicates with the Hermes Memory Server (Node.js) over HTTP.

Resilience features:
- Health check at init + periodic reconnect on_turn_start
- Local turn buffer with replay on reconnect (up to 50 turns)
- Retry with backoff for transient failures
- Graceful degradation: offline status in system_prompt_block
"""

import json
import logging
import os
import time
import threading
import urllib.parse
from collections import deque
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)

MEMORY_SERVER_DEFAULT = "http://127.0.0.1:3001"


class NoxemMemoryProvider:
    """MemoryProvider for Hermes Agent — connects to the Noxem memory server."""

    @property
    def name(self) -> str:
        return "noxem"

    # ── Lifecycle ─────────────────────────────────────────────

    def is_available(self) -> bool:
        """Check if memory server is reachable."""
        try:
            url = f"{os.environ.get('NOXEM_SERVER', MEMORY_SERVER_DEFAULT)}/health"
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                return data.get("ok", False)
        except Exception:
            return True

    def initialize(self, session_id: str, **kwargs) -> None:
        """Called at agent startup."""
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", os.environ.get("HERMES_HOME", "~/.hermes"))
        self._server_url = os.environ.get("NOXEM_SERVER", MEMORY_SERVER_DEFAULT)
        self._gemma_url = os.environ.get("GEMMA_URL", "http://127.0.0.1:8000/v1/chat/completions")
        self._sync_thread = None
        self._server_reachable = False
        self._sync_fail_count = 0
        self._pending_queue = deque(maxlen=50)
        self._queue_lock = threading.Lock()

        self._check_server_health(log_init=True)

    def _check_server_health(self, log_init=False):
        """Probe /health and update server_reachable state."""
        try:
            url = f"{self._server_url}/health"
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                self._server_reachable = True
                self._sync_fail_count = 0
                if log_init:
                    stats = data.get("memory", {})
                    emb = "ON" if data.get("embedding") else "OFF"
                    vec = "ON" if data.get("vector_index") else "OFF"
                    logger.info(
                        f"Noxem initialized — session={self._session_id}, "
                        f"server={self._server_url} "
                        f"(embedding={emb}, vector={vec}, memories={stats.get('active', 0)})"
                    )
                return True
        except Exception:
            self._server_reachable = False
            if log_init:
                logger.warning(
                    f"Noxem server NOT reachable at {self._server_url} — "
                    f"memories will NOT be saved until server starts. "
                    f"Run 'hermes-noxem' to start both servers."
                )
            return False

    def _flush_pending_queue(self):
        """Replay buffered turns to the memory server (called on reconnect)."""
        with self._queue_lock:
            if not self._pending_queue:
                return
            items = list(self._pending_queue)
            self._pending_queue.clear()

        flushed = 0
        for data in items:
            try:
                result = self._api_post("/memory/sync", data)
                if result.get("stored", 0) is not None:
                    flushed += 1
            except Exception:
                # Re-queue remaining items on failure
                with self._queue_lock:
                    self._pending_queue.appendleft(data)
                    for remaining in items[items.index(data) + 1:]:
                        self._pending_queue.append(remaining)
                break

        if flushed > 0:
            logger.info(f"Noxem flushed {flushed} buffered turns to memory server")

    def shutdown(self) -> None:
        """Process exit cleanup."""
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=3.0)
        logger.info("Noxem shutdown complete")

    # ── Config ────────────────────────────────────────────────

    def get_config_schema(self):
        return [
            {
                "key": "memory_server",
                "description": "Noxem memory server URL",
                "default": MEMORY_SERVER_DEFAULT,
                "required": False,
            },
            {
                "key": "gemma_url",
                "description": "Gemma 4 API endpoint (for advisor + extraction)",
                "default": "http://127.0.0.1:8000/v1/chat/completions",
                "required": False,
            },
            {
                "key": "embedding_enabled",
                "description": "Enable EmbeddingGemma 300M for vector search",
                "default": "true",
                "choices": ["true", "false"],
                "required": False,
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "noxem.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(values, indent=2))
        logger.info(f"Noxem config saved to {config_path}")

    # ── Tools ─────────────────────────────────────────────────

    def get_tool_schemas(self):
        return [
            {
                "name": "memory_search",
                "description": "Search stored memories by semantic similarity (hybrid: embedding + keyword)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "limit": {"type": "integer", "description": "Max results", "default": 5},
                        "method": {
                            "type": "string",
                            "description": "Search method: hybrid, embedding, or fts",
                            "enum": ["hybrid", "embedding", "fts"],
                            "default": "hybrid",
                        },
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memory_store",
                "description": "Store an important fact for future recall",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Fact to remember"},
                        "type": {
                            "type": "string",
                            "description": "Memory type",
                            "enum": ["fact", "preference", "project", "goal", "pattern", "entity", "event", "issue", "setup", "learning", "profile", "general"],
                            "default": "fact",
                        },
                    },
                    "required": ["text"],
                },
            },
            {
                "name": "memory_supersede",
                "description": "Mark an old memory as superseded by a newer one (e.g., preference changed)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "old_id": {"type": "integer", "description": "ID of the old memory to supersede"},
                        "new_id": {"type": "integer", "description": "ID of the new memory that replaces it"},
                        "reason": {"type": "string", "description": "Reason for supersession", "default": "contradiction"},
                    },
                    "required": ["old_id", "new_id"],
                },
            },
            {
                "name": "memory_lineage",
                "description": "Trace the provenance chain of a memory through supersession history",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "Memory ID to trace lineage for"},
                    },
                    "required": ["id"],
                },
            },
            {
                "name": "memory_contradiction_check",
                "description": "Check if a new memory contradicts existing memories with the same entity+attribute",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "entity": {"type": "string", "description": "Entity name (e.g., 'user')"},
                        "attribute": {"type": "string", "description": "Attribute name (e.g., 'prefer_dark_mode')"},
                        "text": {"type": "string", "description": "New memory text to check against existing"},
                    },
                    "required": ["entity", "attribute"],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict) -> str:
        if name == "memory_search":
            query = urllib.parse.quote(args.get('query', ''), safe='')
            method = args.get('method', 'hybrid')
            url = f"/memory/search?q={query}&limit={args.get('limit', 5)}&method={method}"
            return self._api_get(url)
        elif name == "memory_store":
            result = self._api_post("/memory/store", {
                "text": args["text"],
                "type": args.get("type", "fact"),
                "session_id": self._session_id,
            })
            return json.dumps(result)
        elif name == "memory_supersede":
            result = self._api_post("/memory/supersede", {
                "old_id": args["old_id"],
                "new_id": args["new_id"],
                "reason": args.get("reason", "contradiction"),
            })
            return json.dumps(result)
        elif name == "memory_lineage":
            result = self._api_get(f"/memory/{args['id']}/lineage")
            return json.dumps(result)
        elif name == "memory_contradiction_check":
            result = self._api_post("/memory/contradiction-check", {
                "entity": args["entity"],
                "attribute": args["attribute"],
                "text": args.get("text", ""),
            })
            return json.dumps(result)
        return json.dumps({"error": f"Unknown tool: {name}"})

    # ── Optional Hooks ────────────────────────────────────────

    def system_prompt_block(self):
        status = "CONNECTED" if self._server_reachable else "OFFLINE — memories will NOT be saved. Run 'hermes-noxem' first"
        return (
            f"[Noxem Memory — {status}]\n"
            "AI-powered memory system. EmbeddingGemma 300M for search + dedup. "
            "Gemma 4 for advisor + context recovery.\n"
            "Memory types: preference, fact, project, goal, pattern, entity, event, issue, setup, learning, profile.\n"
            "Use `memory_search` to look up past info and `memory_store` to save facts."
        )

    MAX_MEMORY_TOKENS = int(os.environ.get("NOXEM_MAX_MEMORY_TOKENS", "2000"))

    def prefetch(self, query: str, **kwargs):
        """Curated context injection via /memory/release, fallback to /memory/search."""
        if not query or not query.strip():
            return None

        try:
            session_id = kwargs.get("session_id", self._session_id or "")
            result = self._api_get(
                f"/memory/release?tokens={self.MAX_MEMORY_TOKENS}&session_id={self._urlencode(session_id)}"
            )
            text = result.get("text", "")
            count = result.get("memories", 0)
            if text and text.strip():
                self._server_reachable = True
                return f"[Noxem Memory Recall — {count} memories]\n{text}"
        except Exception:
            pass

        try:
            result = self._api_get(
                f"/memory/search?q={self._urlencode(query)}&limit=10&method=hybrid"
            )
            memories = result.get("results", [])
            if not memories:
                return None

            max_chars = self.MAX_MEMORY_TOKENS * 4
            lines = []
            used_chars = 0
            for m in memories:
                label = m.get("type", "memory").capitalize()
                text = m.get("text", "")[:200]
                score = m.get("score", 0)
                line = f"[{label}] {text} (rel: {score:.2f})"
                if used_chars + len(line) + 1 > max_chars:
                    break
                lines.append(line)
                used_chars += len(line) + 1

            if lines:
                self._server_reachable = True
                return f"[Noxem Memory Recall]\n" + "\n".join(lines)
        except Exception as e:
            logger.debug(f"prefetch failed: {e}")
        return None

    def queue_prefetch(self, query: str, **kwargs) -> None:
        def _warm():
            try:
                self._api_get(f"/memory/search?q={self._urlencode(query)}&limit=3&method=hybrid")
            except Exception:
                pass
        t = threading.Thread(target=_warm, daemon=True)
        t.start()

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        """Health-check every 10 turns if server was unreachable. Flush queue on reconnect."""
        if not self._server_reachable and turn_number % 10 == 1:
            if self._check_server_health():
                self._flush_pending_queue()
                logger.info(f"Noxem server reconnected at turn {turn_number}")

    def sync_turn(self, user_content: str, assistant_content: str, **kwargs) -> None:
        """Persist conversation turn with retry + local buffering. Non-blocking."""
        session_id = kwargs.get("session_id", self._session_id or "")

        def _sync():
            data = {
                "user_message": (user_content or "")[:2000],
                "assistant_response": (assistant_content or "")[:4000],
                "session_id": session_id,
            }
            # Try once
            try:
                result = self._api_post("/memory/sync", data)
                self._server_reachable = True
                self._sync_fail_count = 0
                self._flush_pending_queue()
                return
            except Exception:
                self._sync_fail_count += 1

            # Retry once after 2s (server might be starting up)
            if self._sync_fail_count <= 3:
                time.sleep(2.0)
                try:
                    result = self._api_post("/memory/sync", data)
                    self._server_reachable = True
                    self._sync_fail_count = 0
                    self._flush_pending_queue()
                    return
                except Exception:
                    pass

            # Buffer turn for later replay
            with self._queue_lock:
                self._pending_queue.append(data)
                queue_len = len(self._pending_queue)

            if self._sync_fail_count == 1:
                logger.warning(
                    f"sync_turn failed — server at {self._server_url} not reachable. "
                    f"Turn buffered (queue: {queue_len}). Run 'hermes-noxem' to start."
                )
            elif self._sync_fail_count % 20 == 0:
                logger.warning(f"sync_turn failed {self._sync_fail_count}x — queue: {queue_len}")

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_sync, daemon=True)
        self._sync_thread.start()

    def on_session_end(self, messages: list) -> None:
        try:
            result = self._api_post("/memory/session/end", {
                "conversation_history": messages,
                "session_id": self._session_id,
            })
            count = result.get("extracted", 0)
            if count > 0:
                logger.info(f"Noxem extracted {count} memories at session end")
        except Exception as e:
            logger.warning(f"on_session_end failed: {e}")

    def on_pre_compress(self, messages: list):
        try:
            result = self._api_post("/memory/advisor/compress", {
                "conversation_history": messages,
                "session_id": self._session_id,
            })
            return result.get("analysis", "")
        except Exception as e:
            logger.debug(f"on_pre_compress failed: {e}")
            return None

    def on_memory_write(self, action: str, target: str, content: str, metadata=None, **kwargs) -> None:
        """Mirror built-in memory writes to Noxem."""
        if action in ("add", "append", "replace", "write") and content:
            try:
                store_metadata = {"source": "hermes_builtin", "target": target}
                if metadata and isinstance(metadata, dict):
                    store_metadata.update(metadata)
                self._api_post("/memory/store", {
                    "text": content[:500],
                    "type": "fact",
                    "session_id": self._session_id,
                    "metadata": store_metadata,
                })
            except Exception as e:
                logger.debug(f"on_memory_write failed: {e}")

    # ── Internal ──────────────────────────────────────────────

    def _api_get(self, path: str) -> dict:
        url = f"{self._server_url}{path}"
        req = Request(url, headers={"Accept": "application/json"})
        try:
            with urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode())
        except URLError as e:
            logger.debug(f"Noxem API GET {path} failed: {e}")
            return {"results": []}
        except Exception as e:
            logger.debug(f"Noxem API GET {path} error: {e}")
            return {"results": []}

    def _api_post(self, path: str, data: dict) -> dict:
        url = f"{self._server_url}{path}"
        body = json.dumps(data).encode()
        req = Request(url, data=body, headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        with urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())

    @staticmethod
    def _urlencode(s: str) -> str:
        return urllib.parse.quote(s, safe="")


def register(ctx) -> None:
    """Plugin entry point — registers noxem as a memory provider."""
    ctx.register_memory_provider(NoxemMemoryProvider())
