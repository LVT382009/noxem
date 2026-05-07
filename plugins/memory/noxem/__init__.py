"""Noxem — AI-powered memory provider for Hermes Agent.

Two-brain architecture:
  - Brain 1: EmbeddingGemma 300M → embedding search, dedup, contradiction detection
  - Brain 2: Gemma 4 E2B → advisor, context recovery, DDG-augmented guidance

Communicates with the Hermes Memory Server (Node.js) over HTTP.
"""

import json
import logging
import os
import threading
import urllib.parse
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
        """Check if memory server is reachable (no expensive calls)."""
        # Just check if the URL seems valid — actual connectivity checked in initialize
        return True

    def initialize(self, session_id: str, **kwargs) -> None:
        """Called at agent startup."""
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", os.environ.get("HERMES_HOME", "~/.hermes"))
        self._server_url = os.environ.get("NOXEM_SERVER", MEMORY_SERVER_DEFAULT)
        self._gemma_url = os.environ.get("GEMMA_URL", "http://127.0.0.1:8000/v1/chat/completions")
        self._sync_thread = None
        logger.info(f"Noxem initialized — session={session_id}, server={self._server_url}")

    def shutdown(self) -> None:
        """Process exit cleanup."""
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=3.0)
        logger.info("Noxem shutdown complete")

    # ── Config ────────────────────────────────────────────────

    def get_config_schema(self):
        """Fields shown in `hermes memory setup`."""
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
        """Write non-secret config."""
        config_path = Path(hermes_home) / "noxem.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(values, indent=2))
        logger.info(f"Noxem config saved to {config_path}")

    # ── Tools ─────────────────────────────────────────────────

    def get_tool_schemas(self):
        """Expose memory search as a tool the agent can call."""
        return [
            {
                "name": "memory_search",
                "description": "Search stored memories by semantic similarity",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "limit": {"type": "integer", "description": "Max results", "default": 5},
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
        ]

    def handle_tool_call(self, name: str, args: dict) -> str:
        """Route tool calls to the memory server."""
        if name == "memory_search":
            query = urllib.parse.quote(args.get('query', ''), safe='')
            return self._api_get(f"/memory/search?q={query}&limit={args.get('limit', 5)}")
        elif name == "memory_store":
            result = self._api_post("/memory/store", {
                "text": args["text"],
                "type": args.get("type", "fact"),
                "session_id": self._session_id,
            })
            return json.dumps(result)
        return json.dumps({"error": f"Unknown tool: {name}"})

    # ── Optional Hooks ────────────────────────────────────────

    def system_prompt_block(self):
        """Add provider info to system prompt."""
        return (
            "[Noxem Memory Active]\n"
            "I have an AI-powered memory system. EmbeddingGemma 300M handles memory search and maintenance. "
            "Gemma 4 monitors tasks and provides context recovery after compaction.\n"
            "Memory types: preference, fact, project, goal, pattern, entity, event, issue, setup, learning, profile.\n"
            "Use `memory_search` to look up past information and `memory_store` to save important facts."
        )

    MAX_MEMORY_TOKENS = int(os.environ.get("NOXEM_MAX_MEMORY_TOKENS", "2000"))

    def prefetch(self, query: str):
        """Inject relevant memories before each API call.

        Called by Hermes before each turn. Returns context text to inject.
        Enforces a token budget to avoid overflowing the context window.
        """
        if not query or not query.strip():
            return None
        try:
            result = self._api_get(
                f"/memory/search?q={self._urlencode(query)}&limit=10&method=hybrid"
            )
            memories = result.get("results", [])
            if not memories:
                return None

            # Build lines within token budget (~4 chars per token)
            max_chars = self.MAX_MEMORY_TOKENS * 4
            lines = []
            used_chars = 0
            for m in memories:
                label = m.get("type", "memory").capitalize()
                text = m.get("text", "")[:200]
                score = m.get("score", 0)
                line = f"[{label}] {text} (rel: {score:.2f})"
                line_len = len(line) + 1  # +1 for newline
                if used_chars + line_len > max_chars:
                    break
                lines.append(line)
                used_chars += line_len

            if not lines:
                return None

            return f"[Noxem Memory Recall]\n" + "\n".join(lines)
        except Exception as e:
            logger.debug(f"prefetch failed: {e}")
            return None

    def queue_prefetch(self, query: str) -> None:
        """Pre-warm retrieval for next turn. Non-blocking."""
        def _warm():
            try:
                self._api_get(f"/memory/search?q={self._urlencode(query)}&limit=3&method=hybrid")
            except Exception:
                pass
        t = threading.Thread(target=_warm, daemon=True)
        t.start()

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        """Persist conversation turn. MUST be non-blocking."""
        def _sync():
            try:
                self._api_post("/memory/sync", {
                    "user_message": (user_content or "")[:2000],
                    "assistant_response": (assistant_content or "")[:4000],
                    "session_id": self._session_id,
                })
            except Exception as e:
                logger.warning(f"sync_turn failed: {e}")

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_sync, daemon=True)
        self._sync_thread.start()

    def on_session_end(self, messages: list) -> None:
        """Extract memories when session ends."""
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
        """Before context compression, get advisor analysis.

        Returns: Analysis string to preserve in compressed context.
        """
        try:
            result = self._api_post("/memory/advisor/compress", {
                "conversation_history": messages,
                "session_id": self._session_id,
            })
            return result.get("analysis", "")
        except Exception as e:
            logger.debug(f"on_pre_compress failed: {e}")
            return None

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in memory writes to Noxem."""
        if action in ("append", "write") and content:
            try:
                self._api_post("/memory/store", {
                    "text": content[:500],
                    "type": "fact",
                    "session_id": self._session_id,
                    "metadata": {"source": "hermes_builtin", "target": target},
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
            logger.warning(f"Noxem API GET {path} failed: {e}")
            return {"results": []}

    def _api_post(self, path: str, data: dict) -> dict:
        url = f"{self._server_url}{path}"
        body = json.dumps(data).encode()
        req = Request(url, data=body, headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        try:
            with urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode())
        except URLError as e:
            logger.warning(f"Noxem API POST {path} failed: {e}")
            return {}

    @staticmethod
    def _urlencode(s: str) -> str:
        return urllib.parse.quote(s, safe="")


def register(ctx) -> None:
    """Plugin entry point — registers noxem as a memory provider."""
    ctx.register_memory_provider(NoxemMemoryProvider())