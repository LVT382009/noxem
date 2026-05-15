"""Hermes Agent plugin for Noxem memory system - using working tool call hooks."""

import sqlite3
import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional
from uuid import uuid4
from datetime import datetime

from noxem_core import (
    MemoryItem,
    MemoryType,
    NoxemStorage,
    MemoryExtractor,
    NoxemRetriever,
    NoxemEntityGraph,
    NoxemEmbeddings,
    HybridSearchRetriever,
)

# Memory server URL for session-based conversation storage
MEMORY_SERVER_URL = "http://127.0.0.1:3001"


def _post_to_memory_server(endpoint, data):
    """POST JSON data to the memory server (fire-and-forget, non-blocking)."""
    try:
        url = f"{MEMORY_SERVER_URL}{endpoint}"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[Noxem] Memory server POST failed ({endpoint}): {e}")
        return None


def _get_from_memory_server(endpoint):
    """GET from the memory server."""
    try:
        url = f"{MEMORY_SERVER_URL}{endpoint}"
        with urllib.request.urlopen(url, timeout=3) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[Noxem] Memory server GET failed ({endpoint}): {e}")
        return None


class NoxemMemoryPlugin:
    """
    Hermes plugin that integrates Noxem memory system.

    Uses pre_tool_call and post_tool_call hooks which ARE invoked by Hermes.
    The pre_llm_call and post_llm_call hooks are documented but NOT actually called.

    This implementation:
    1. Tracks user messages and tool calls
    2. Saves conversation turns to SQLite on post_tool_call
    3. Stores tool calls in session_messages via memory server
    4. Retrieves relevant memories + cross-session context on pre_tool_call
    5. Manages session lifecycle (start/end/finalize) via memory server
    """

    def __init__(self, config: Dict[str, Any]):
        self.user_id = config.get("user_id", "default")
        self.session_id: Optional[str] = None
        self.pending_user_message: Optional[str] = None

        db_path = config.get("db_path")
        self.storage = NoxemStorage(db_path)
        self.extractor = MemoryExtractor()
        self.retriever = NoxemRetriever(self.storage)

        try:
            self.graph = NoxemEntityGraph(self.storage)
            self.graph.build(user_id=self.user_id)
            self.graph_available = True
        except (ImportError, Exception):
            self.graph = None
            self.graph_available = False

        self.recall_limit = config.get("recall_limit", 5)
        self.include_recent = config.get("include_recent", True)

    def set_session(self, session_id: str):
        """Set current session ID."""
        self.session_id = session_id

    async def on_session_start_hook(self, session_id: str, **kwargs):
        """Called when a new session starts — register session in memory server."""
        self.set_session(session_id)
        print(f"[Noxem] Session started: {session_id}")
        _post_to_memory_server("/memory/store", {
            "session_id": session_id,
            "type": "session_start",
            "text": f"Session {session_id} started",
            "importance": 0.1,
        })

    async def on_session_end_hook(self, session_id: str, **kwargs):
        """Called when a session ends — trigger summary + cleanup via memory server."""
        self.set_session(session_id)
        print(f"[Noxem] Session ending: {session_id}")
        _post_to_memory_server("/memory/session/end", {
            "session_id": session_id,
            "conversation_history": [],
        })

    async def on_session_finalize_hook(self, session_id: str, **kwargs):
        """Called when session is torn down — final flush."""
        if session_id:
            print(f"[Noxem] Session finalized: {session_id}")

    async def pre_tool_call_hook(
        self,
        session_id: str,
        tool_name: str,
        tool_args: Dict[str, Any],
        conversation_history: List[Dict[str, Any]],
        **kwargs,
    ) -> Optional[Dict[str, any]]:
        """Hermes pre_tool_call hook - retrieve memories + cross-session context."""
        self.set_session(session_id)

        last_user_message = None
        for msg in reversed(conversation_history):
            if msg.get("role") == "user":
                last_user_message = msg.get("content", "")
                break

        if not last_user_message:
            return None

        relevant_memories = self.retriever.recall(
            query=last_user_message,
            user_id=self.user_id,
            session_id=session_id,
            limit=self.recall_limit,
            include_recent=self.include_recent,
        )

        # Cross-session search via memory server
        cross_session_context = ""
        try:
            cross_result = _post_to_memory_server("/memory/cross-session-search", {
                "query": last_user_message[:200],
                "session_id": session_id,
                "limit": 5,
            })
            if cross_result and cross_result.get("results"):
                cross_lines = []
                for r in cross_result["results"][:5]:
                    role = r.get("role", "?")
                    text = r.get("content_text", "")[:150]
                    session = r.get("session_id", "")[:8]
                    cross_lines.append(f"[{role}@{session}]: {text}")
                if cross_lines:
                    cross_session_context = "\nCross-session context:\n" + "\n".join(cross_lines)
        except Exception as e:
            print(f"[Noxem] Cross-session search error: {e}")

        if not relevant_memories and not cross_session_context:
            return None

        context = ""
        if relevant_memories:
            context = self.retriever.build_context(
                memories=relevant_memories,
                max_tokens=1000,
                format="bullet",
            )

        if not context and not cross_session_context:
            return None

        memory_section = f"\n{context}\n" if context else ""
        return {
            "context": f"""
# Relevant Memory Context
{memory_section}
{cross_session_context}

"""
        }

    async def post_tool_call_hook(
        self,
        session_id: str,
        tool_name: str,
        tool_result: Any,
        conversation_history: List[Dict[str, Any]],
        duration_ms: int = 0,
        **kwargs,
    ) -> None:
        """Hermes post_tool_call hook - save turns + tool call data to memory server."""
        self.set_session(session_id)

        # Send tool call to memory server session storage
        if session_id:
            tool_args_data = kwargs.get("tool_args") or kwargs.get("args") or {}
            _post_to_memory_server("/memory/sync", {
                "session_id": session_id,
                "user_message": "",
                "assistant_response": f"Tool: {tool_name} -> {str(tool_result)[:500]}",
                "tool_calls": [{"name": tool_name, "arguments": tool_args_data if isinstance(tool_args_data, dict) else {}}],
            })

        # Extract the last user message and assistant response from history
        user_message = None
        assistant_response = None

        for msg in reversed(conversation_history):
            role = msg.get("role")
            content = msg.get("content", "")
            if not content:
                continue
            if role == "user" and not user_message:
                user_message = content
            if role == "assistant" and not assistant_response:
                assistant_response = content
            if user_message and assistant_response:
                break

        if user_message and assistant_response:
            self._save_conversation_turn(
                session_id=session_id,
                user_message=user_message,
                assistant_response=assistant_response,
            )

    def _get_memory_count(self) -> int:
        try:
            conn = sqlite3.connect(str(self.storage.db_path))
            count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            conn.close()
            return count
        except:
            return -1

    def _save_conversation_turn(self, session_id: str, user_message: str, assistant_response: str) -> None:
        try:
            conn = sqlite3.connect(str(self.storage.db_path))
            cursor = conn.cursor()
            now = datetime.now().isoformat()
            cursor.execute(
                "INSERT INTO memories (id, user_id, session_id, type, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid4()), self.user_id, session_id, "user_message", user_message, 0.7, now, now),
            )
            cursor.execute(
                "INSERT INTO memories (id, user_id, session_id, type, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid4()), self.user_id, session_id, "assistant_response", assistant_response, 0.6, now, now),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Noxem: Failed to save conversation turn: {e}")

    def _save_memory_direct(self, session_id: str, content: str, memory_type: str) -> None:
        try:
            conn = sqlite3.connect(str(self.storage.db_path))
            cursor = conn.cursor()
            now = datetime.now().isoformat()
            cursor.execute(
                "INSERT INTO memories (id, user_id, session_id, type, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (str(uuid4()), self.user_id, session_id, memory_type, content, 0.5, now, now),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Noxem: Failed to save memory: {e}")

    def get_memory(self, memory_id: str) -> Optional[MemoryItem]:
        return self.storage.get(memory_id, self.user_id)

    def save_memory(self, memory: MemoryItem) -> MemoryItem:
        memory.user_id = memory.user_id or self.user_id
        return self.storage.save(memory)

    def delete_memory(self, memory_id: str) -> bool:
        return self.storage.delete(memory_id, self.user_id)

    def search_memories(self, query: str, types: Optional[List[MemoryType]] = None, limit: int = 10) -> List[MemoryItem]:
        return self.storage.search(query=query, user_id=self.user_id, types=types, limit=limit)

    def get_stats(self) -> Dict[str, Any]:
        return self.storage.get_stats(self.user_id)


def register(ctx):
    """Hermes plugin registration function."""
    config = ctx.config.get("noxem", {})
    plugin = NoxemMemoryPlugin(config)

    ctx.register_hook("pre_tool_call", plugin.pre_tool_call_hook)
    ctx.register_hook("post_tool_call", plugin.post_tool_call_hook)
    ctx.register_hook("on_session_start", plugin.on_session_start_hook)
    ctx.register_hook("on_session_end", plugin.on_session_end_hook)
    ctx.register_hook("on_session_finalize", plugin.on_session_finalize_hook)

    from .memory_provider import NoxemMemoryProvider
    ctx.register_memory_provider(NoxemMemoryProvider())

    return {
        "name": "noxem",
        "version": "1.1.0",
        "description": "Noxem memory system for Hermes Agent (session-based conversation storage + cross-session search)",
        "hook_count": 5,
        "working_hooks": ["pre_tool_call", "post_tool_call", "on_session_start", "on_session_end", "on_session_finalize"],
    }
