"""
iMessage data reader.

Reads and processes iMessage conversation data from the macOS Messages database.
"""

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from llama_index.core import Document
from llama_index.core.readers.base import BaseReader


class IMessageReader(BaseReader):
    """
    iMessage data reader.

    Reads iMessage conversation data from the macOS Messages database (chat.db).
    Processes conversations into structured documents with metadata.
    """

    def __init__(self, concatenate_conversations: bool = True) -> None:
        """
        Initialize.

        Args:
            concatenate_conversations: Whether to concatenate messages within conversations for better context
        """
        self.concatenate_conversations = concatenate_conversations

    def _get_default_chat_db_path(self) -> Path:
        """
        Get the default path to the iMessage chat database.

        Returns:
            Path to the chat.db file
        """
        home = Path.home()
        return home / "Library" / "Messages" / "chat.db"

    def _convert_cocoa_timestamp(self, cocoa_timestamp: int) -> str:
        """
        Convert Cocoa timestamp to readable format.

        Args:
            cocoa_timestamp: Timestamp in Cocoa format (nanoseconds since 2001-01-01)

        Returns:
            Formatted timestamp string
        """
        if cocoa_timestamp == 0:
            return "Unknown"

        try:
            # Cocoa timestamp is nanoseconds since 2001-01-01 00:00:00 UTC
            # Convert to seconds and add to Unix epoch
            cocoa_epoch = datetime(2001, 1, 1)
            unix_timestamp = cocoa_timestamp / 1_000_000_000  # Convert nanoseconds to seconds
            message_time = cocoa_epoch.timestamp() + unix_timestamp
            return datetime.fromtimestamp(message_time).strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, OSError):
            return "Unknown"

    def _get_contact_name(self, handle_id: str) -> str:
        """
        Get a readable contact name from handle ID.

        Args:
            handle_id: The handle ID (phone number or email)

        Returns:
            Formatted contact name
        """
        if not handle_id:
            return "Unknown"

        # Clean up phone numbers and emails for display
        if "@" in handle_id:
            return handle_id  # Email address
        elif handle_id.startswith("+"):
            return handle_id  # International phone number
        else:
            # Try to format as phone number
            digits = "".join(filter(str.isdigit, handle_id))
            if len(digits) == 10:
                return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
            elif len(digits) == 11 and digits[0] == "1":
                return f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
            else:
                return handle_id

    def _read_messages_from_db(self, db_path: Path) -> list[dict]:
        """
        Read messages from the iMessage database.

        Args:
            db_path: Path to the chat.db file

        Returns:
            List of message dictionaries
        """
        if not db_path.exists():
            print(f"iMessage database not found at: {db_path}")
            return []

        try:
            # Connect to the database
            conn = sqlite3.connect(str(db_path))
            cursor = conn.cursor()

            # Query to get messages with chat and handle information
            query = """
            SELECT
                m.ROWID as message_id,
                m.text,
                m.date,
                m.is_from_me,
                m.service,
                c.chat_identifier,
                c.display_name as chat_display_name,
                h.id as handle_id,
                c.ROWID as chat_id
            FROM message m
            LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
            LEFT JOIN chat c ON cmj.chat_id = c.ROWID
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.text IS NOT NULL AND m.text != ''
            ORDER BY c.ROWID, m.date
            """

            cursor.execute(query)
            rows = cursor.fetchall()

            messages = []
            for row in rows:
                (
                    message_id,
                    text,
                    date,
                    is_from_me,
                    service,
                    chat_identifier,
                    chat_display_name,
                    handle_id,
                    chat_id,
                ) = row

                message = {
                    "message_id": message_id,
                    "text": text,
                    "timestamp": self._convert_cocoa_timestamp(date),
                    "is_from_me": bool(is_from_me),
                    "service": service or "iMessage",
                    "chat_identifier": chat_identifier or "Unknown",
                    "chat_display_name": chat_display_name or "Unknown Chat",
                    "handle_id": handle_id or "Unknown",
                    "contact_name": self._get_contact_name(handle_id or ""),
                    "chat_id": chat_id,
                }
                messages.append(message)

            conn.close()
            print(f"Found {len(messages)} messages in database")
            return messages

        except sqlite3.Error as e:
            print(f"Error reading iMessage database: {e}")
            return []
        except Exception as e:
            print(f"Unexpected error reading iMessage database: {e}")
            return []

    def _group_messages_by_chat(self, messages: list[dict]) -> dict[int, list[dict]]:
        """
        Group messages by chat ID.

        Args:
            messages: List of message dictionaries

        Returns:
            Dictionary mapping chat_id to list of messages
        """
        chats = {}
        for message in messages:
            chat_id = message["chat_id"]
            if chat_id not in chats:
                chats[chat_id] = []
            chats[chat_id].append(message)

        return chats

    def _create_concatenated_content(self, chat_id: int, messages: list[dict]) -> str:
        """
        Create concatenated content from chat messages.

        Args:
            chat_id: The chat ID
            messages: List of messages in the chat

        Returns:
            Concatenated text content
        """
        if not messages:
            return ""

        # Get chat info from first message
        first_msg = messages[0]
        chat_name = first_msg["chat_display_name"]
        chat_identifier = first_msg["chat_identifier"]

        # Build message content
        message_parts = []
        for message in messages:
            timestamp = message["timestamp"]
            is_from_me = message["is_from_me"]
            text = message["text"]
            contact_name = message["contact_name"]

            if is_from_me:
                prefix = "[You]"
            else:
                prefix = f"[{contact_name}]"

            if timestamp != "Unknown":
                prefix += f" ({timestamp})"

            message_parts.append(f"{prefix}: {text}")

        concatenated_text = "\n\n".join(message_parts)

        doc_content = f"""Chat: {chat_name}
Identifier: {chat_identifier}
Messages ({len(messages)} messages):

{concatenated_text}
"""
        return doc_content

    def _create_individual_content(self, message: dict) -> str:
        """
        Create content for individual message.

        Args:
            message: Message dictionary

        Returns:
            Formatted message content
        """
        timestamp = message["timestamp"]
        is_from_me = message["is_from_me"]
        text = message["text"]
        contact_name = message["contact_name"]
        chat_name = message["chat_display_name"]

        sender = "You" if is_from_me else contact_name

        return f"""Message from {sender} in chat "{chat_name}"
Time: {timestamp}
Content: {text}
"""

    def load_data(self, input_dir: str | None = None, **load_kwargs: Any) -> list[Document]:
        """
        Load iMessage data and return as documents.

        Args:
            input_dir: Optional path to directory containing chat.db file.
                      If not provided, uses default macOS location.
            **load_kwargs: Additional arguments (unused)

        Returns:
            List of Document objects containing iMessage data
        """
        docs = []

        # Determine database path
        if input_dir:
            db_path = Path(input_dir) / "chat.db"
        else:
            db_path = self._get_default_chat_db_path()

        print(f"Reading iMessage database from: {db_path}")

        # Read messages from database
        messages = self._read_messages_from_db(db_path)
        if not messages:
            return docs

        if self.concatenate_conversations:
            # Group messages by chat and create concatenated documents
            chats = self._group_messages_by_chat(messages)

            for chat_id, chat_messages in chats.items():
                if not chat_messages:
                    continue

                content = self._create_concatenated_content(chat_id, chat_messages)

                # Create metadata
                first_msg = chat_messages[0]
                last_msg = chat_messages[-1]

                metadata = {
                    "source": "iMessage",
                    "chat_id": chat_id,
                    "chat_name": first_msg["chat_display_name"],
                    "chat_identifier": first_msg["chat_identifier"],
                    "message_count": len(chat_messages),
                    "first_message_date": first_msg["timestamp"],
                    "last_message_date": last_msg["timestamp"],
                    "participants": list(
                        {msg["contact_name"] for msg in chat_messages if not msg["is_from_me"]}
                    ),
                }

                doc = Document(text=content, metadata=metadata)
                docs.append(doc)

        else:
            # Create individual documents for each message
            for message in messages:
                content = self._create_individual_content(message)

                metadata = {
                    "source": "iMessage",
                    "message_id": message["message_id"],
                    "chat_id": message["chat_id"],
                    "chat_name": message["chat_display_name"],
                    "chat_identifier": message["chat_identifier"],
                    "timestamp": message["timestamp"],
                    "is_from_me": message["is_from_me"],
                    "contact_name": message["contact_name"],
                    "service": message["service"],
                }

                doc = Document(text=content, metadata=metadata)
                docs.append(doc)

        print(f"Created {len(docs)} documents from iMessage data")
        return docs
