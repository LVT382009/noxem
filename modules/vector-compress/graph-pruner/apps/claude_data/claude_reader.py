"""
Claude export data reader.

Reads and processes Claude conversation data from exported JSON files.
"""

import json
from pathlib import Path
from typing import Any
from zipfile import ZipFile

from llama_index.core import Document
from llama_index.core.readers.base import BaseReader


class ClaudeReader(BaseReader):
    """
    Claude export data reader.

    Reads Claude conversation data from exported JSON files or zip archives.
    Processes conversations into structured documents with metadata.
    """

    def __init__(self, concatenate_conversations: bool = True) -> None:
        """
        Initialize.

        Args:
            concatenate_conversations: Whether to concatenate messages within conversations for better context
        """
        self.concatenate_conversations = concatenate_conversations

    def _extract_json_from_zip(self, zip_path: Path) -> list[str]:
        """
        Extract JSON files from Claude export zip file.

        Args:
            zip_path: Path to the Claude export zip file

        Returns:
            List of JSON content strings, or empty list if not found
        """
        json_contents = []
        try:
            with ZipFile(zip_path, "r") as zip_file:
                # Look for JSON files
                json_files = [f for f in zip_file.namelist() if f.endswith(".json")]

                if not json_files:
                    print(f"No JSON files found in {zip_path}")
                    return []

                print(f"Found {len(json_files)} JSON files in archive")

                for json_file in json_files:
                    with zip_file.open(json_file) as f:
                        content = f.read().decode("utf-8", errors="ignore")
                        json_contents.append(content)

        except Exception as e:
            print(f"Error extracting JSON from zip {zip_path}: {e}")

        return json_contents

    def _parse_claude_json(self, json_content: str) -> list[dict]:
        """
        Parse Claude JSON export to extract conversations.

        Args:
            json_content: JSON content from Claude export

        Returns:
            List of conversation dictionaries
        """
        try:
            data = json.loads(json_content)
        except json.JSONDecodeError as e:
            print(f"Error parsing JSON: {e}")
            return []

        conversations = []

        # Handle different possible JSON structures
        if isinstance(data, list):
            # If data is a list of conversations
            for item in data:
                conversation = self._extract_conversation_from_json(item)
                if conversation:
                    conversations.append(conversation)
        elif isinstance(data, dict):
            # Check for common structures
            if "conversations" in data:
                # Structure: {"conversations": [...]}
                for item in data["conversations"]:
                    conversation = self._extract_conversation_from_json(item)
                    if conversation:
                        conversations.append(conversation)
            elif "messages" in data:
                # Single conversation with messages
                conversation = self._extract_conversation_from_json(data)
                if conversation:
                    conversations.append(conversation)
            else:
                # Try to treat the whole object as a conversation
                conversation = self._extract_conversation_from_json(data)
                if conversation:
                    conversations.append(conversation)

        return conversations

    def _extract_conversation_from_json(self, conv_data: dict) -> dict | None:
        """
        Extract conversation data from a JSON object.

        Args:
            conv_data: Dictionary containing conversation data

        Returns:
            Dictionary with conversation data or None
        """
        if not isinstance(conv_data, dict):
            return None

        messages = []

        # Look for messages in various possible structures
        message_sources = []
        if "messages" in conv_data:
            message_sources = conv_data["messages"]
        elif "chat" in conv_data:
            message_sources = conv_data["chat"]
        elif "conversation" in conv_data:
            message_sources = conv_data["conversation"]
        else:
            # If no clear message structure, try to extract from the object itself
            if "content" in conv_data and "role" in conv_data:
                message_sources = [conv_data]

        for msg_data in message_sources:
            message = self._extract_message_from_json(msg_data)
            if message:
                messages.append(message)

        if not messages:
            return None

        # Extract conversation metadata
        title = self._extract_title_from_conversation(conv_data, messages)
        timestamp = self._extract_timestamp_from_conversation(conv_data)

        return {"title": title, "messages": messages, "timestamp": timestamp}

    def _extract_message_from_json(self, msg_data: dict) -> dict | None:
        """
        Extract message data from a JSON message object.

        Args:
            msg_data: Dictionary containing message data

        Returns:
            Dictionary with message data or None
        """
        if not isinstance(msg_data, dict):
            return None

        # Extract content from various possible fields
        content = ""
        content_fields = ["content", "text", "message", "body"]
        for field in content_fields:
            if msg_data.get(field):
                content = str(msg_data[field])
                break

        if not content or len(content.strip()) < 3:
            return None

        # Extract role (user/assistant/human/ai/claude)
        role = "mixed"  # Default role
        role_fields = ["role", "sender", "from", "author", "type"]
        for field in role_fields:
            if msg_data.get(field):
                role_value = str(msg_data[field]).lower()
                if role_value in ["user", "human", "person"]:
                    role = "user"
                elif role_value in ["assistant", "ai", "claude", "bot"]:
                    role = "assistant"
                break

        # Extract timestamp
        timestamp = self._extract_timestamp_from_message(msg_data)

        return {"role": role, "content": content, "timestamp": timestamp}

    def _extract_timestamp_from_message(self, msg_data: dict) -> str | None:
        """Extract timestamp from message data."""
        timestamp_fields = ["timestamp", "created_at", "date", "time"]
        for field in timestamp_fields:
            if msg_data.get(field):
                return str(msg_data[field])
        return None

    def _extract_timestamp_from_conversation(self, conv_data: dict) -> str | None:
        """Extract timestamp from conversation data."""
        timestamp_fields = ["timestamp", "created_at", "date", "updated_at", "last_updated"]
        for field in timestamp_fields:
            if conv_data.get(field):
                return str(conv_data[field])
        return None

    def _extract_title_from_conversation(self, conv_data: dict, messages: list) -> str:
        """Extract or generate title for conversation."""
        # Try to find explicit title
        title_fields = ["title", "name", "subject", "topic"]
        for field in title_fields:
            if conv_data.get(field):
                return str(conv_data[field])

        # Generate title from first user message
        for message in messages:
            if message.get("role") == "user":
                content = message.get("content", "")
                if content:
                    # Use first 50 characters as title
                    title = content[:50].strip()
                    if len(content) > 50:
                        title += "..."
                    return title

        return "Claude Conversation"

    def _create_concatenated_content(self, conversation: dict) -> str:
        """
        Create concatenated content from conversation messages.

        Args:
            conversation: Dictionary containing conversation data

        Returns:
            Formatted concatenated content
        """
        title = conversation.get("title", "Claude Conversation")
        messages = conversation.get("messages", [])
        timestamp = conversation.get("timestamp", "Unknown")

        # Build message content
        message_parts = []
        for message in messages:
            role = message.get("role", "mixed")
            content = message.get("content", "")
            msg_timestamp = message.get("timestamp", "")

            if role == "user":
                prefix = "[You]"
            elif role == "assistant":
                prefix = "[Claude]"
            else:
                prefix = "[Message]"

            # Add timestamp if available
            if msg_timestamp:
                prefix += f" ({msg_timestamp})"

            message_parts.append(f"{prefix}: {content}")

        concatenated_text = "\n\n".join(message_parts)

        # Create final document content
        doc_content = f"""Conversation: {title}
Date: {timestamp}
Messages ({len(messages)} messages):

{concatenated_text}
"""
        return doc_content

    def load_data(self, input_dir: str | None = None, **load_kwargs: Any) -> list[Document]:
        """
        Load Claude export data.

        Args:
            input_dir: Directory containing Claude export files or path to specific file
            **load_kwargs:
                max_count (int): Maximum number of conversations to process
                claude_export_path (str): Specific path to Claude export file/directory
                include_metadata (bool): Whether to include metadata in documents
        """
        docs: list[Document] = []
        max_count = load_kwargs.get("max_count", -1)
        claude_export_path = load_kwargs.get("claude_export_path", input_dir)
        include_metadata = load_kwargs.get("include_metadata", True)

        if not claude_export_path:
            print("No Claude export path provided")
            return docs

        export_path = Path(claude_export_path)

        if not export_path.exists():
            print(f"Claude export path not found: {export_path}")
            return docs

        json_contents = []

        # Handle different input types
        if export_path.is_file():
            if export_path.suffix.lower() == ".zip":
                # Extract JSON from zip file
                json_contents = self._extract_json_from_zip(export_path)
            elif export_path.suffix.lower() == ".json":
                # Read JSON file directly
                try:
                    with open(export_path, encoding="utf-8", errors="ignore") as f:
                        json_contents.append(f.read())
                except Exception as e:
                    print(f"Error reading JSON file {export_path}: {e}")
                    return docs
            else:
                print(f"Unsupported file type: {export_path.suffix}")
                return docs

        elif export_path.is_dir():
            # Look for JSON files in directory
            json_files = list(export_path.glob("*.json"))
            zip_files = list(export_path.glob("*.zip"))

            if json_files:
                print(f"Found {len(json_files)} JSON files in directory")
                for json_file in json_files:
                    try:
                        with open(json_file, encoding="utf-8", errors="ignore") as f:
                            json_contents.append(f.read())
                    except Exception as e:
                        print(f"Error reading JSON file {json_file}: {e}")
                        continue

            if zip_files:
                print(f"Found {len(zip_files)} ZIP files in directory")
                for zip_file in zip_files:
                    zip_contents = self._extract_json_from_zip(zip_file)
                    json_contents.extend(zip_contents)

            if not json_files and not zip_files:
                print(f"No JSON or ZIP files found in {export_path}")
                return docs

        if not json_contents:
            print("No JSON content found to process")
            return docs

        # Parse conversations from JSON content
        print("Parsing Claude conversations from JSON...")
        all_conversations = []
        for json_content in json_contents:
            conversations = self._parse_claude_json(json_content)
            all_conversations.extend(conversations)

        if not all_conversations:
            print("No conversations found in JSON content")
            return docs

        print(f"Found {len(all_conversations)} conversations")

        # Process conversations into documents
        count = 0
        for conversation in all_conversations:
            if max_count > 0 and count >= max_count:
                break

            if self.concatenate_conversations:
                # Create one document per conversation with concatenated messages
                doc_content = self._create_concatenated_content(conversation)

                metadata = {}
                if include_metadata:
                    metadata = {
                        "title": conversation.get("title", "Claude Conversation"),
                        "timestamp": conversation.get("timestamp", "Unknown"),
                        "message_count": len(conversation.get("messages", [])),
                        "source": "Claude Export",
                    }

                doc = Document(text=doc_content, metadata=metadata)
                docs.append(doc)
                count += 1

            else:
                # Create separate documents for each message
                for message in conversation.get("messages", []):
                    if max_count > 0 and count >= max_count:
                        break

                    role = message.get("role", "mixed")
                    content = message.get("content", "")
                    msg_timestamp = message.get("timestamp", "")

                    if not content.strip():
                        continue

                    # Create document content with context
                    doc_content = f"""Conversation: {conversation.get("title", "Claude Conversation")}
Role: {role}
Timestamp: {msg_timestamp or conversation.get("timestamp", "Unknown")}
Message: {content}
"""

                    metadata = {}
                    if include_metadata:
                        metadata = {
                            "conversation_title": conversation.get("title", "Claude Conversation"),
                            "role": role,
                            "timestamp": msg_timestamp or conversation.get("timestamp", "Unknown"),
                            "source": "Claude Export",
                        }

                    doc = Document(text=doc_content, metadata=metadata)
                    docs.append(doc)
                    count += 1

        print(f"Created {len(docs)} documents from Claude export")
        return docs
