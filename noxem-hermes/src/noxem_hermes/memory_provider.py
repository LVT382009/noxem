"""Noxem Memory Provider for Hermes Agent - implements MemoryProvider ABC."""

import os
import sqlite3
import json
import uuid
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional

# Import from noxem-core for storage logic
try:
    from noxem_core import NoxemStorage, MemoryItem, MemoryType
    from noxem_core.memory_item import MemoryExtractor
except ImportError:
    NoxemStorage = None
    MemoryExtractor = None


class NoxemMemoryProvider:
    """
    Noxem memory provider implementing Hermes MemoryProvider interface.

    Uses SQLite+FTS5 for storage with pattern-based extraction.
    """

    def __init__(self):
        import os
        self.session_id: str = ""
        # Use os.path.expanduser for WSL compatibility
        hermes_home = os.path.expanduser("~/.hermes")
        self.hermes_home: Path = Path(hermes_home)
        self.user_id: str = "default"
        self.db_path: Path = self.hermes_home / "noxem.db"
        self.recall_limit: int = 5
        self.storage = None
        self.extractor = None

    @property
    def name(self) -> str:
        return "noxem"

    def is_available(self) -> bool:
        """Check if Noxem can activate (NO network calls)."""
        return True

    def initialize(self, session_id: str, hermes_home: Path, **kwargs) -> None:
        """Initialize on agent startup."""
        self.session_id = session_id
        # hermes_home is already an absolute Path from Hermes
        self.hermes_home = hermes_home
        self.db_path = self.hermes_home / "noxem.db"
        self.user_id = kwargs.get("user_id", "default")
        self.recall_limit = kwargs.get("recall_limit", 5)

        # Initialize noxem-core storage if available
        if NoxemStorage:
            self.storage = NoxemStorage(str(self.db_path))
            self.extractor = MemoryExtractor()
        else:
            # Fallback to direct SQLite
            self._init_db()

    def _init_db(self):
        """Create database schema if needed (fallback)."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                session_id TEXT,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                summary TEXT,
                importance REAL DEFAULT 0.5,
                created_at TEXT NOT NULL
            )
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_user ON memories(user_id, session_id)
        """)

        conn.commit()
        conn.close()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return tool schemas for injection."""
        return [
            {
                "type": "function",
                "function": {
                    "name": "recall_memory",
                    "description": "Recall information from long-term memory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "What to search for in memory"
                            }
                        },
                        "required": ["query"]
                    }
                }
            }
        ]

    def handle_tool_call(self, name: str, args: Dict[str, Any], **kwargs) -> str:
        """
        Handle a tool call for one of this provider's tools.

        Args:
            name: Tool name
            args: Tool arguments
            **kwargs: Additional context (session_id, etc.)

        Returns:
            Tool result as string
        """
        if name == "recall_memory":
            return self._recall(args.get("query", ""))
        return f"Unknown tool: {name}"

    def _recall(self, query: str) -> str:
        """Search and return relevant memories."""
        if self.storage:
            try:
                results = self.storage.search(query, user_id=self.user_id, limit=self.recall_limit)
                if not results:
                    return "No relevant memories found."
                return "\n".join([f"- [{m.type.value}] {m.content[:100]}" for m in results])
            except Exception:
                pass

        # Fallback to direct SQLite
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            SELECT content, type, importance FROM memories
            WHERE user_id = ?
            ORDER BY importance DESC
            LIMIT ?
        """, (self.user_id, self.recall_limit))
        results = cursor.fetchall()
        conn.close()

        if not results:
            return "No relevant memories found."

        return "\n".join([f"- [{t}] {c[:100]}" for c, t, _ in results])

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """
        Recall relevant context for the upcoming turn.

        Called before each LLM invocation to pre-load relevant memories.

        Args:
            query: Current user query/message
            session_id: Current session identifier

        Returns:
            String containing relevant memory context, or empty string if none found
        """
        if not self.storage:
            return ""

        try:
            results = self.storage.search(
                query,
                user_id=self.user_id,
                limit=self.recall_limit
            )

            if not results:
                return ""

            context_lines = []
            for mem in results:
                summary = mem.summary or mem.content[:150]
                context_lines.append(f"[{mem.type.value.upper()}] {summary}")

            return "\n".join(context_lines)

        except Exception as e:
            return f"Error retrieving memory: {str(e)}"

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """
        Queue a background recall for the NEXT turn.

        Pre-fetches memories in a background thread to avoid blocking.

        Args:
            query: Current user query
            session_id: Current session identifier
        """
        # For now, just call prefetch - could be made async with threading
        try:
            self.prefetch(query, session_id=session_id)
        except Exception:
            pass  # Silently fail to avoid blocking

    def sync_turn(self, user: str, asst: str, *, session_id: str = "") -> None:
        """
        Persist a completed turn to the backend.

        Called after each assistant response to save conversation history.

        Args:
            user: User message content
            asst: Assistant response content
            session_id: Session identifier
        """
        # Always use SQLite for reliable persistence
        # noxem-core memory extraction is unreliable, so we use direct SQLite storage
        self._save_memory(user, "user_message", session_id or self.session_id)
        self._save_memory(asst, "assistant_response", session_id or self.session_id)

    def _save_memory(self, content: str, memory_type: str, session_id: str):
        """Internal method to save a memory (fallback)."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        cursor.execute("""
            INSERT OR IGNORE INTO memories (id, user_id, session_id, type, content, importance, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            str(uuid.uuid4()),
            self.user_id,
            session_id,
            memory_type,
            content,
            0.5,
            datetime.now().isoformat()
        ))

        conn.commit()
        conn.close()

    def on_session_end(self, messages: List[Dict]) -> None:
        """Called when conversation ends — trigger session summary on memory server."""
        try:
            import urllib.request
            import json as _json
            url = "http://127.0.0.1:3001/memory/session/end"
            data = _json.dumps({
                "session_id": self.session_id,
                "conversation_history": messages[-20:] if messages else [],
            }).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    def system_prompt_block(self) -> str:
        """
        Return text to include in the system prompt.

        Returns:
            String containing memory context for the system prompt, or empty string
        """
        # Could return user profile, preferences, or other persistent context
        # For now, return empty - can be extended later
        return ""

    def on_pre_compress(self, messages: List[Dict]) -> str:
        """
        Called before context compression.

        Args:
            messages: List of message dicts about to be compressed

        Returns:
            String to inject into compressed context, or empty string
        """
        # Save checkpoint before compression
        if self.storage:
            try:
                self.storage.save_checkpoint(
                    session_id=self.session_id,
                    user_id=self.user_id,
                    context_length=sum(len(m.get("content", "")) for m in messages),
                    active_task=None,
                    open_files=[],
                    next_steps=[],
                    decisions_made=[]
                )
            except Exception:
                pass

        return ""

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror to backend (optional)."""
        pass

    def get_config_schema(self) -> List[Dict[str, Any]]:
        """Define configuration fields."""
        return [
            {
                "key": "user_id",
                "description": "User identifier for memory isolation",
                "default": "default",
                "required": False
            },
            {
                "key": "recall_limit",
                "description": "Max memories to recall per query",
                "default": 5,
                "choices": [3, 5, 10, 20]
            }
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: Path) -> None:
        """Persist non-secret configuration."""
        config_file = hermes_home / "noxem_config.json"
        with open(config_file, 'w') as f:
            json.dump(values, f, indent=2)

    def shutdown(self) -> None:
        """Clean up on agent shutdown."""
        pass


def register(ctx) -> None:
    """Register with Hermes memory plugin system."""
    ctx.register_memory_provider(NoxemMemoryProvider())
