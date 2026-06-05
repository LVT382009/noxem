"""Noxem — AI-powered memory provider for Hermes Agent.

Two-brain architecture:
- Brain 1: Semantic engine → embedding search, dedup, contradiction detection
- Brain 2: Reasoning engine → advisor, context recovery, background web research

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
import platform
import re
import signal
import subprocess
import time
import threading
import urllib.parse
import sys
import warnings
import atexit
from collections import deque
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

# Suppress huggingface_hub deprecation warning from vendored packages (e.g., faster_whisper)
warnings.filterwarnings('ignore', message='.*local_dir_use_symlinks.*', category=UserWarning)

logger = logging.getLogger(__name__)

MEMORY_SERVER_DEFAULT = "http://127.0.0.1:3001"
# P-#31: For SSL/TLS, set NOXEM_SERVER to https:// URL and ensure the
# Node.js server is started with --tls-cert and --tls-key flags, e.g.:
#   node server/memory-server.mjs --tls-cert=/path/to/cert.pem --tls-key=/path/to/key.pem
# For self-signed certs, set NODE_TLS_REJECT_UNAUTHORIZED=0 in env (dev only).


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
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        """Called at agent startup."""
        self._session_id = session_id
        self._hermes_home = kwargs.get("hermes_home", os.environ.get("HERMES_HOME", "~/.hermes"))
        self._hermes_home = str(Path(self._hermes_home).expanduser())  # P-#27
        self._server_url = os.environ.get("NOXEM_SERVER", MEMORY_SERVER_DEFAULT)
        self._llm_url = os.environ.get("LLM_URL", os.environ.get("GEMMA_URL", "http://127.0.0.1:8000/v1/chat/completions"))
        self._sync_thread = None
        self._server_start_thread = None
        self._server_reachable = threading.Event()  # P-#19
        self._sync_fail_count = 0
        self._sync_lock = threading.Lock()  # P-#18
        self._shutdown_event = threading.Event()  # P-#24
        self._pending_queue = deque(maxlen=50)
        self._queue_lock = threading.Lock()
        self._server_procs = []
        self._stderr_logs = []  # P-#22
        atexit.register(self.shutdown)

        # Load noxem.json and propagate to env vars if not already set
        # This bridges the gap: config saved by `hermes memory setup` reaches Node.js servers
        self._load_noxem_config()

        # Try auto-starting both servers in background if memory server not reachable
        if not self._check_server_health():
            self._try_start_servers_async()
        else:
            self._check_server_health(log_init=True)

    def _try_start_servers_async(self):
        """Start both servers (memory + LLM) in background thread, then check health."""
        def _start():
            try:
                self._try_start_servers()
                self._check_server_health(log_init=True)
            except Exception:
                pass  # Prevent daemon thread exception during interpreter shutdown
        t = threading.Thread(target=_start, daemon=True)
        t.start()
        self._server_start_thread = t

    def _load_noxem_config(self):
        """Read noxem.json and propagate saved values to env vars if not already set.

        This bridges the config gap: `hermes memory setup` saves to noxem.json,
        but Node.js server processes only read from process.env. By setting env
        vars here, child processes (launched by the launcher or auto-start) inherit them.
        """
        config_path = Path(self._hermes_home).expanduser() / "noxem.json"
        if not config_path.exists():
            return
        try:
            cfg = json.loads(config_path.read_text())
        except Exception:
            return

        env_map = {
            "memory_server": "NOXEM_SERVER",
            "brain2_provider": "BRAIN2_PROVIDER",
            "llm_url": "LLM_URL",
            "llm_model": "LLM_MODEL",
            "embedding_enabled": "ENABLE_EMBEDDING",
        }
        # Store API key separately — only pass to child server processes, not global env
        self._llm_api_key = cfg.get("llm_api_key", "")
        for json_key, env_var in env_map.items():
            val = cfg.get(json_key)
            if val and env_var not in os.environ:
                os.environ[env_var] = str(val)

        # Also set GEMMA_URL/GEMMA_MODEL as legacy fallback aliases
        if "llm_url" in cfg and "GEMMA_URL" not in os.environ:
            os.environ["GEMMA_URL"] = str(cfg["llm_url"])
        if "llm_model" in cfg and "GEMMA_MODEL" not in os.environ:
            os.environ["GEMMA_MODEL"] = str(cfg["llm_model"])

        # Update self._server_url if config changed it
        if "NOXEM_SERVER" in os.environ:
            self._server_url = os.environ["NOXEM_SERVER"]
        if "LLM_URL" in os.environ:
            self._llm_url = os.environ["LLM_URL"]

        logger.debug(f"Noxem config loaded from {config_path}: provider={cfg.get('brain2_provider', 'qwenproxy')}")

    def _try_start_servers(self):
        """Attempt to start both the memory server and LLM server from the deployed location."""
        import shutil
        node_bin = shutil.which("node")
        if not node_bin:
            logger.debug("Cannot auto-start: 'node' not found in PATH")
            return False

        home = Path(self._hermes_home).expanduser()
        env = os.environ.copy()
        env.setdefault("ENABLE_EMBEDDING", "true")
        env.setdefault("ENABLE_ADVISOR", "true")
        env.setdefault("ENABLE_MAINTENANCE", "true")
        env.setdefault("ENABLE_RESEARCH", "true")
        env.setdefault("NODE_OPTIONS", "--dns-result-order=ipv4first")
        # Pass API key only to child server processes, not global env
        if self._llm_api_key:
            env["LLM_API_KEY"] = self._llm_api_key
        # Propagate HF mirror setting if configured
        if "HF_ENDPOINT" not in env and os.environ.get("HF_ENDPOINT"):
            env["HF_ENDPOINT"] = os.environ["HF_ENDPOINT"]

        # Start LLM server first (takes longer to initialize)
        llm_candidates = [
            home / "noxem-server" / "server" / "llm-server.mjs",
            home / ".hermes" / "noxem-server" / "server" / "gemma4-server.mjs",
        ]
        for path in llm_candidates:
            if path.exists():
                try:
                    _llm_stderr_log = open(home / "noxem-server-stderr.log", "a")  # P-#22
                    self._stderr_logs.append(_llm_stderr_log)
                    popen_kwargs = {
                        "cwd": str(path.parent),
                        "env": env,
                        "stdout": subprocess.DEVNULL,
                        "stderr": _llm_stderr_log,
                        "start_new_session": True,
                    }
                    if platform.system() == "Windows":
                        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
                    proc = subprocess.Popen(
                        [node_bin, str(path)],
                        **popen_kwargs,
                    )
                    self._server_procs.append(proc)
                    self._write_pid_file(home / 'noxem-server.pid', proc.pid)  # P-#29
                    logger.info(f"Noxem auto-started LLM server from {path} (PID {proc.pid})")
                    sys.stderr.write(f"[Noxem] Auto-starting LLM server... (PID {proc.pid})\n")
                    break
                except Exception as e:
                    logger.debug(f"Failed to auto-start LLM from {path}: {e}")

        # Start memory server
        memory_candidates = [
            home / "noxem-server" / "server" / "memory-server.mjs",
            home / ".hermes" / "noxem-server" / "server" / "memory-server.mjs",
        ]
        started = False
        for path in memory_candidates:
            if path.exists():
                try:
                    _mem_stderr_log = open(home / "noxem-memory-stderr.log", "a")  # P-#22
                    self._stderr_logs.append(_mem_stderr_log)
                    popen_kwargs = {
                        "cwd": str(path.parent),
                        "env": env,
                        "stdout": subprocess.DEVNULL,
                        "stderr": _mem_stderr_log,
                        "start_new_session": True,
                    }
                    if platform.system() == "Windows":
                        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
                    proc = subprocess.Popen(
                        [node_bin, str(path)],
                        **popen_kwargs,
                    )
                    self._server_procs.append(proc)
                    logger.info(f"Noxem auto-started memory server from {path} (PID {proc.pid})")
                    sys.stderr.write(f"[Noxem] Auto-starting memory server... (PID {proc.pid})\n")
                    started = True
                    break
                except Exception as e:
                    logger.debug(f"Failed to auto-start memory server from {path}: {e}")

        if not started:
            return False

        # Wait up to 90s for memory server to become ready
        # LLM server takes longer but we don't block on it — the advisor gracefully handles it
        for i in range(90):
            if self._shutdown_event.is_set():  # P-#24
                return False
            self._shutdown_event.wait(1)  # P-#24
            # Check /ready endpoint first (faster than full /health)
            try:
                url = f"{self._server_url}/ready"
                req = Request(url, headers={"Accept": "application/json"})
                with urlopen(req, timeout=2) as resp:
                    data = json.loads(resp.read().decode())
                    if data.get("ok"):
                        logger.info(f"Noxem memory server ready after {i+1}s")
                        self._server_reachable.set()  # P-#19
                        return True
            except Exception:
                pass
        return False

    def _check_server_health(self, log_init=False):
        """Probe /health and update server_reachable state."""
        try:
            url = f"{self._server_url}/health"
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                self._server_reachable.set()  # P-#19
                with self._sync_lock:  # P-#19
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
            self._server_reachable.clear()  # P-#19
            if log_init:
                logger.warning(
                    f"Noxem server NOT reachable at {self._server_url} — "
                    f"memories will NOT be saved until server starts. "
                    f"Auto-start was attempted — check server logs."
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
        for i, data in enumerate(items):
            try:
                result = self._api_post("/memory/sync", data)
                if result.get("stored", 0) is not None:
                    flushed += 1
            except Exception:
                # Re-queue only the items that were NOT yet successfully flushed
                with self._queue_lock:
                    for item in items[i:]:
                        self._pending_queue.append(item)
                    break

        if flushed > 0:
            logger.info(f"Noxem flushed {flushed} buffered turns to memory server")

    # P-#29: PID file helpers for reliable process cleanup on Windows
    def _write_pid_file(self, path, pid):
        try:
            path.write_text(str(pid))
        except Exception:
            pass

    def _clean_pid_file(self, path):
        try:
            if path.exists():
                path.unlink()
        except Exception:
            pass

    def _kill_stale_pid(self, path):
        """Kill process from stale PID file (crash recovery)."""
        try:
            if path.exists():
                pid = int(path.read_text().strip())
                if platform.system() == "Windows":
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                   capture_output=True, timeout=5)
                else:
                    os.kill(pid, signal.SIGTERM)
                logger.info(f"Noxem killed stale PID {pid} from {path.name}")
            self._clean_pid_file(path)
        except (ProcessLookupError, PermissionError, OSError,
                subprocess.TimeoutExpired):
            self._clean_pid_file(path)
        except Exception:
            pass

    def shutdown(self) -> None:
        """Process exit cleanup. Join daemon threads then kill auto-started server processes."""
        self._shutdown_event.set()  # P-#24
        if self._server_start_thread and self._server_start_thread.is_alive():
            self._server_start_thread.join(timeout=5.0)
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=3.0)
        try:
            sys.stdout.flush()
        except Exception:
            pass
        for proc in self._server_procs:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                logger.info(f"Noxem stopped auto-started server PID {proc.pid}")
            except (ProcessLookupError, PermissionError, OSError):
                pass
        self._server_procs.clear()
        # P-#29: Clean up PID files on shutdown
        home = Path(self._hermes_home).expanduser()
        self._clean_pid_file(home / 'noxem-server.pid')
        self._clean_pid_file(home / 'noxem-memory.pid')
        for log_fh in self._stderr_logs:  # P-#22
            try:
                log_fh.close()
            except Exception:
                pass
        self._stderr_logs.clear()
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
                "key": "brain2_provider",
                "description": "Brain 2 provider: qwenproxy (cloud) or local (any OpenAI-compatible LLM)",
                "default": "qwenproxy",
                "choices": ["qwenproxy", "local"],
                "required": False,
            },
            {
                "key": "llm_url",
                "description": "LLM API endpoint (for advisor + extraction)",
                "default": "http://127.0.0.1:8000/v1/chat/completions",
                "required": False,
            },
            {
                "key": "llm_model",
                "description": "Model name for LLM calls (ignored for QwenProxy — auto-normalized)",
                "default": "qwen3.6-plus-no-thinking",
                "required": False,
            },
            {
                "key": "llm_api_key",
                "description": "API key for LLM endpoint (optional, not needed for Ollama/llama.cpp)",
                "default": "",
                "required": False,
            },
            {
                "key": "embedding_enabled",
                "description": "Enable Brain-1 for vector search",
                "default": "true",
                "choices": ["true", "false"],
                "required": False,
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "noxem.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        # Merge with existing config so we don't lose previously saved fields
        existing = {}
        if config_path.exists():
            try:
                existing = json.loads(config_path.read_text())
            except Exception:
                pass
        existing.update(values)
        config_path.write_text(json.dumps(existing, indent=2))
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
            {
                "name": "memory_feedback",
                "description": "Report which memory IDs were actually used in your response (improves future ranking). Call after memory_search if results were helpful.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "memory_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "IDs of memories that influenced your response",
                        },
                    },
                    "required": ["memory_ids"],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict) -> str:
        if name == "memory_search":
            query = urllib.parse.quote(args.get('query', ''), safe='')
            method = args.get('method', 'hybrid')
            url = f"/memory/search?q={query}&limit={args.get('limit', 5)}&method={method}"
            result = self._api_get(url)
            return json.dumps(result)
        elif name == "memory_store":
            result = self._api_post("/memory/store", {
                "text": args["text"],
                "type": args.get("type", "fact"),
                "session_id": self._session_id,
            })
            return json.dumps(result)
        elif name == "memory_supersede":
            if "old_id" not in args or "new_id" not in args:  # P-#28
                missing = [k for k in ("old_id", "new_id") if k not in args]
                return json.dumps({"error": f"Missing required parameter(s): {', '.join(missing)}"})
            result = self._api_post("/memory/supersede", {
                "old_id": args["old_id"],
                "new_id": args["new_id"],
                "reason": args.get("reason", "contradiction"),
            })
            return json.dumps(result)
        elif name == "memory_lineage":
            if "id" not in args:  # P-#28
                return json.dumps({"error": "Missing required parameter: id"})
            result = self._api_get(f"/memory/{args['id']}/lineage")
            return json.dumps(result)
        elif name == "memory_contradiction_check":
            result = self._api_post("/memory/contradiction-check", {
                "entity": args["entity"],
                "attribute": args["attribute"],
                "text": args.get("text", ""),
            })
            return json.dumps(result)
        elif name == "memory_feedback":
            result = self._api_post("/memory/search/feedback", {
                "memory_ids": args.get("memory_ids", []),
            })
            return json.dumps(result)
        return json.dumps({"error": f"Unknown tool: {name}"})

    # ── Optional Hooks ────────────────────────────────────────

    def system_prompt_block(self):
        status = "CONNECTED" if self._server_reachable.is_set() else "OFFLINE — memories will NOT be saved until server starts"
        return (
            f"[Noxem Memory — {status}]\n"
            "Brain-1 for semantic search + dedup. "
            "Brain-2 for advisor + context recovery + background web research.\n"
            "Memory types: preference, fact, project, goal, pattern, entity, event, issue, setup, learning, profile.\n"
            "Use `memory_search` to look up past info and `memory_store` to save facts."
        )

    MAX_MEMORY_TOKENS = 2000
    try:
        MAX_MEMORY_TOKENS = int(os.environ.get("NOXEM_MAX_MEMORY_TOKENS", "2000"))
    except (ValueError, TypeError):
        pass

    def prefetch(self, query: str, **kwargs):
        """Curated context injection via /memory/release + research hints, fallback to /memory/search."""
        if not query or not query.strip():
            return None

        parts = []
        session_id = kwargs.get("session_id", self._session_id or "")

        # 1) Main memory recall via /memory/release
        try:
            result = self._api_get(
                f"/memory/release?tokens={self.MAX_MEMORY_TOKENS}&session_id={self._urlencode(session_id)}"
            )
            text = result.get("text", "")
            count = result.get("memories", 0)
            if text and text.strip():
                self._server_reachable.set()  # P-#19
                parts.append(f"[Noxem Memory Recall — {count} memories]\n{text}")
        except Exception:
            pass

        # 2) Research hint injection — compact hints (~20 tokens each)
        #    Tells Hermes that background-researched facts exist, without dumping them into context.
        #    Hermes calls memory_search if it wants the full details.
        try:
            hints = self._api_get(f"/memory/research/hints?session_id={self._urlencode(session_id)}")
            topics = hints.get("topics", [])
            if topics:
                hint_lines = []
                for t in topics[:5]:
                    topic = t.get("topic", "")
                    fact_count = t.get("fact_count", 0)
                    if topic and fact_count > 0:
                        hint_lines.append(f'"{topic}" — {fact_count} facts available')
                if hint_lines:
                    parts.append(
                        "[Noxem Research — background web research ready]\n"
                        + "\n".join(hint_lines)
                        + "\nUse memory_search to retrieve research facts."
                    )
        except Exception:
            pass

        if parts:
            return "\n\n".join(parts)

        # 3) Fallback: direct search if /memory/release returned nothing
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
                self._server_reachable.set()  # P-#19
                return f"[Noxem Memory Recall]\n" + "\n".join(lines)
        except Exception as e:
            logger.debug(f"prefetch failed: {e}")
        return None

    def queue_prefetch(self, query: str, **kwargs) -> None:
        """Smarter prefetch: warm release endpoint + keyword-based search + research hints."""
        session_id = kwargs.get("session_id", self._session_id or "")

        def _warm():
            # 1) Warm /memory/release (the primary prefetch endpoint)
            try:
                self._api_get(
                    f"/memory/release?tokens={self.MAX_MEMORY_TOKENS}&session_id={self._urlencode(session_id)}"
                )
            except Exception:
                pass

            # 2) Warm search by full query
            if query and query.strip():
                try:
                    self._api_get(f"/memory/search?q={self._urlencode(query)}&limit=3&method=hybrid")
                except Exception:
                    pass

            # 3) Extract keywords from query for additional warmup
            keywords = self._extract_keywords(query or "")
            for kw in keywords[:3]:
                try:
                    self._api_get(f"/memory/search?q={self._urlencode(kw)}&limit=2&method=hybrid")
                except Exception:
                    pass

            # 4) Warm research hints
            try:
                self._api_get(f"/memory/research/hints?session_id={self._urlencode(session_id)}")
            except Exception:
                pass

        t = threading.Thread(target=_warm, daemon=True)
        t.start()

    @staticmethod
    def _extract_keywords(text, max_keywords=5):
        """Extract meaningful keywords from a query for prefetch warmup."""
        # Remove common stop words
        stop_words = frozenset({
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
            'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
            'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
            'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
            'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
            'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
            'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
            'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
            'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
            'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
            'she', 'her', 'it', 'its', 'they', 'them', 'their',
        })
        # Split on non-alphanumeric, filter stop words and short tokens
        tokens = re.findall(r'[a-zA-Z_][a-zA-Z0-9_]{2,}', text)
        keywords = [t for t in tokens if t.lower() not in stop_words]
        return keywords[:max_keywords]

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        """Health-check every 10 turns if server was unreachable. Flush queue on reconnect."""
        if not self._server_reachable.is_set() and turn_number % 10 == 1:
            if self._check_server_health():
                self._flush_pending_queue()
                logger.info(f"Noxem server reconnected at turn {turn_number}")

    def sync_turn(self, user_content: str, assistant_content: str, **kwargs) -> None:
        """Persist conversation turn with retry + local buffering. Non-blocking."""
        session_id = kwargs.get("session_id", self._session_id or "")

        def _sync():
            try:
                _sync_impl(session_id, user_content, assistant_content)
            except Exception:
                pass  # Prevent daemon thread exception during interpreter shutdown

        def _sync_impl(session_id, user_content, assistant_content):
            data = {
                "user_message": (user_content or "")[:2000],
                "assistant_response": (assistant_content or "")[:4000],
                "session_id": session_id,
            }
            # Try once
            try:
                result = self._api_post("/memory/sync", data)
                if result.get("error"):  # P-#25
                    raise Exception(result["error"])
                self._server_reachable.set()  # P-#19
                with self._sync_lock:  # P-#19
                    self._sync_fail_count = 0
                self._flush_pending_queue()
                return
            except Exception:
                with self._sync_lock:  # P-#19
                    self._sync_fail_count += 1

        # Retry once after 2s (server might be starting up)
        # Release _sync_lock before sleep to avoid blocking other threads
        with self._sync_lock: # P-#19
            _fail_count = self._sync_fail_count
            _should_retry = _fail_count <= 3
        if _should_retry:
            time.sleep(2.0)
            try:
                result = self._api_post("/memory/sync", data)
                if result.get("error"): # P-#25
                    raise Exception(result["error"])
                self._server_reachable.set() # P-#19
                with self._sync_lock: # P-#19
                    self._sync_fail_count = 0
                self._flush_pending_queue()
                return
            except Exception:
                pass

            # Buffer turn for later replay
            with self._queue_lock:
                if len(self._pending_queue) >= self._pending_queue.maxlen:  # P-#23
                    logger.warning(
                        f"Noxem pending queue at capacity ({self._pending_queue.maxlen}), "
                        f"oldest items will be dropped"
                    )
                self._pending_queue.append(data)
                queue_len = len(self._pending_queue)

            with self._sync_lock:  # P-#19
                _fail_count = self._sync_fail_count
            if _fail_count == 1:
                logger.warning(
                    f"sync_turn failed — server at {self._server_url} not reachable. "
                    f"Turn buffered (queue: {queue_len}). Server will retry on next sync."
                )
            elif _fail_count % 20 == 0:  # P-#19
                logger.warning(f"sync_turn failed {_fail_count}x — queue: {queue_len}")

        # Join previous sync thread if still running, then start new one
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_sync, daemon=True)
        self._sync_thread.start()

    def on_session_end(self, messages: list) -> None:
        try:
            result = self._api_post("/memory/session/end", {
            "conversation_history": messages[-50:],
                "session_id": self._session_id,
            })
            count = result.get("extracted", 0)
            if count > 0:
                logger.info(f"Noxem extracted {count} memories at session end")
        except Exception as e:
            logger.warning(f"on_session_end failed: {e}")

    def on_pre_compress(self, messages: list):
        try:
            # P-#32: Truncate conversation history to prevent oversized payloads
            max_msgs = 50
            truncated = messages[-max_msgs:] if len(messages) > max_msgs else messages
            result = self._api_post("/memory/advisor/compress", {
                "conversation_history": truncated,  # P-#32
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
        # Validate URL scheme
        if not self._server_url.startswith(("http://", "https://")):
            return {"error": f"Invalid server URL scheme: {self._server_url}"}
        url = f"{self._server_url}{path}"
        req = Request(url, headers={"Accept": "application/json"})
        try:
            with urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode())
        except URLError as e:
            logger.debug(f"Noxem API GET {path} failed: {e}")
            return {"error": "unreachable"}
        except Exception as e:
            logger.debug(f"Noxem API GET {path} error: {e}")
            return {"error": "unreachable"}

    def _api_post(self, path: str, data: dict) -> dict:
        if not self._server_url.startswith(("http://", "https://")):
            return {"error": f"Invalid server URL scheme: {self._server_url}"}
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
            logger.debug(f"Noxem API POST {path} failed: {e}")
            return {"error": str(e)}
        except Exception as e:
            logger.debug(f"Noxem API POST {path} error: {e}")
            return {"error": str(e)}

    @staticmethod
    def _urlencode(s: str) -> str:
        return urllib.parse.quote(s, safe="")


def register(ctx) -> None:
    """Plugin entry point — registers noxem as a memory provider."""
    ctx.register_memory_provider(NoxemMemoryProvider())
