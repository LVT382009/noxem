"""
ChatGPT export data reader.

Reads and processes ChatGPT export data from chat.html files.
"""

import re
from pathlib import Path
from typing import Any
from zipfile import ZipFile

from bs4 import BeautifulSoup
from llama_index.core import Document
from llama_index.core.readers.base import BaseReader


class ChatGPTReader(BaseReader):
    """
    ChatGPT export data reader.

    Reads ChatGPT conversation data from exported chat.html files or zip archives.
    Processes conversations into structured documents with metadata.
    """

    def __init__(self, concatenate_conversations: bool = True) -> None:
        """
        Initialize.

        Args:
            concatenate_conversations: Whether to concatenate messages within conversations for better context
        """
        try:
            from bs4 import BeautifulSoup  # noqa
        except ImportError:
            raise ImportError("`beautifulsoup4` package not found: `pip install beautifulsoup4`")

        self.concatenate_conversations = concatenate_conversations

    def _extract_html_from_zip(self, zip_path: Path) -> str | None:
        """
        Extract chat.html from ChatGPT export zip file.

        Args:
            zip_path: Path to the ChatGPT export zip file

        Returns:
            HTML content as string, or None if not found
        """
        try:
            with ZipFile(zip_path, "r") as zip_file:
                # Look for chat.html or conversations.html
                html_files = [
                    f
                    for f in zip_file.namelist()
                    if f.endswith(".html") and ("chat" in f.lower() or "conversation" in f.lower())
                ]

                if not html_files:
                    print(f"No HTML chat file found in {zip_path}")
                    return None

                # Use the first HTML file found
                html_file = html_files[0]
                print(f"Found HTML file: {html_file}")

                with zip_file.open(html_file) as f:
                    return f.read().decode("utf-8", errors="ignore")

        except Exception as e:
            print(f"Error extracting HTML from zip {zip_path}: {e}")
            return None

    def _parse_chatgpt_html(self, html_content: str) -> list[dict]:
        """
        Parse ChatGPT HTML export to extract conversations.

        Args:
            html_content: HTML content from ChatGPT export

        Returns:
            List of conversation dictionaries
        """
        soup = BeautifulSoup(html_content, "html.parser")
        conversations = []

        # Try different possible structures for ChatGPT exports
        # Structure 1: Look for conversation containers
        conversation_containers = soup.find_all(
            ["div", "section"], class_=re.compile(r"conversation|chat", re.I)
        )

        if not conversation_containers:
            # Structure 2: Look for message containers directly
            conversation_containers = [soup]  # Use the entire document as one conversation

        for container in conversation_containers:
            conversation = self._extract_conversation_from_container(container)
            if conversation and conversation.get("messages"):
                conversations.append(conversation)

        # If no structured conversations found, try to extract all text as one conversation
        if not conversations:
            all_text = soup.get_text(separator="\n", strip=True)
            if all_text:
                conversations.append(
                    {
                        "title": "ChatGPT Conversation",
                        "messages": [{"role": "mixed", "content": all_text, "timestamp": None}],
                        "timestamp": None,
                    }
                )

        return conversations

    def _extract_conversation_from_container(self, container) -> dict | None:
        """
        Extract conversation data from a container element.

        Args:
            container: BeautifulSoup element containing conversation

        Returns:
            Dictionary with conversation data or None
        """
        messages = []

        # Look for message elements with various possible structures
        message_selectors = ['[class*="message"]', '[class*="chat"]', "[data-message]", "p", "div"]

        for selector in message_selectors:
            message_elements = container.select(selector)
            if message_elements:
                break
        else:
            message_elements = []

        # If no structured messages found, treat the entire container as one message
        if not message_elements:
            text_content = container.get_text(separator="\n", strip=True)
            if text_content:
                messages.append({"role": "mixed", "content": text_content, "timestamp": None})
        else:
            for element in message_elements:
                message = self._extract_message_from_element(element)
                if message:
                    messages.append(message)

        if not messages:
            return None

        # Try to extract conversation title
        title_element = container.find(["h1", "h2", "h3", "title"])
        title = title_element.get_text(strip=True) if title_element else "ChatGPT Conversation"

        # Try to extract timestamp from various possible locations
        timestamp = self._extract_timestamp_from_container(container)

        return {"title": title, "messages": messages, "timestamp": timestamp}

    def _extract_message_from_element(self, element) -> dict | None:
        """
        Extract message data from an element.

        Args:
            element: BeautifulSoup element containing message

        Returns:
            Dictionary with message data or None
        """
        text_content = element.get_text(separator=" ", strip=True)

        # Skip empty or very short messages
        if not text_content or len(text_content.strip()) < 3:
            return None

        # Try to determine role (user/assistant) from class names or content
        role = "mixed"  # Default role

        class_names = " ".join(element.get("class", [])).lower()
        if "user" in class_names or "human" in class_names:
            role = "user"
        elif "assistant" in class_names or "ai" in class_names or "gpt" in class_names:
            role = "assistant"
        elif text_content.lower().startswith(("you:", "user:", "me:")):
            role = "user"
            text_content = re.sub(r"^(you|user|me):\s*", "", text_content, flags=re.IGNORECASE)
        elif text_content.lower().startswith(("chatgpt:", "assistant:", "ai:")):
            role = "assistant"
            text_content = re.sub(
                r"^(chatgpt|assistant|ai):\s*", "", text_content, flags=re.IGNORECASE
            )

        # Try to extract timestamp
        timestamp = self._extract_timestamp_from_element(element)

        return {"role": role, "content": text_content, "timestamp": timestamp}

    def _extract_timestamp_from_element(self, element) -> str | None:
        """Extract timestamp from element."""
        # Look for timestamp in various attributes and child elements
        timestamp_attrs = ["data-timestamp", "timestamp", "datetime"]
        for attr in timestamp_attrs:
            if element.get(attr):
                return element.get(attr)

        # Look for time elements
        time_element = element.find("time")
        if time_element:
            return time_element.get("datetime") or time_element.get_text(strip=True)

        # Look for date-like text patterns
        text = element.get_text()
        date_patterns = [r"\d{4}-\d{2}-\d{2}", r"\d{1,2}/\d{1,2}/\d{4}", r"\w+ \d{1,2}, \d{4}"]

        for pattern in date_patterns:
            match = re.search(pattern, text)
            if match:
                return match.group()

        return None

    def _extract_timestamp_from_container(self, container) -> str | None:
        """Extract timestamp from conversation container."""
        return self._extract_timestamp_from_element(container)

    def _create_concatenated_content(self, conversation: dict) -> str:
        """
        Create concatenated content from conversation messages.

        Args:
            conversation: Dictionary containing conversation data

        Returns:
            Formatted concatenated content
        """
        title = conversation.get("title", "ChatGPT Conversation")
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
                prefix = "[ChatGPT]"
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
        Load ChatGPT export data.

        Args:
            input_dir: Directory containing ChatGPT export files or path to specific file
            **load_kwargs:
                max_count (int): Maximum number of conversations to process
                chatgpt_export_path (str): Specific path to ChatGPT export file/directory
                include_metadata (bool): Whether to include metadata in documents
        """
        docs: list[Document] = []
        max_count = load_kwargs.get("max_count", -1)
        chatgpt_export_path = load_kwargs.get("chatgpt_export_path", input_dir)
        include_metadata = load_kwargs.get("include_metadata", True)

        if not chatgpt_export_path:
            print("No ChatGPT export path provided")
            return docs

        export_path = Path(chatgpt_export_path)

        if not export_path.exists():
            print(f"ChatGPT export path not found: {export_path}")
            return docs

        html_content = None

        # Handle different input types
        if export_path.is_file():
            if export_path.suffix.lower() == ".zip":
                # Extract HTML from zip file
                html_content = self._extract_html_from_zip(export_path)
            elif export_path.suffix.lower() == ".html":
                # Read HTML file directly
                try:
                    with open(export_path, encoding="utf-8", errors="ignore") as f:
                        html_content = f.read()
                except Exception as e:
                    print(f"Error reading HTML file {export_path}: {e}")
                    return docs
            else:
                print(f"Unsupported file type: {export_path.suffix}")
                return docs

        elif export_path.is_dir():
            # Look for HTML files in directory
            html_files = list(export_path.glob("*.html"))
            zip_files = list(export_path.glob("*.zip"))

            if html_files:
                # Use first HTML file found
                html_file = html_files[0]
                print(f"Found HTML file: {html_file}")
                try:
                    with open(html_file, encoding="utf-8", errors="ignore") as f:
                        html_content = f.read()
                except Exception as e:
                    print(f"Error reading HTML file {html_file}: {e}")
                    return docs

            elif zip_files:
                # Use first zip file found
                zip_file = zip_files[0]
                print(f"Found zip file: {zip_file}")
                html_content = self._extract_html_from_zip(zip_file)

            else:
                print(f"No HTML or zip files found in {export_path}")
                return docs

        if not html_content:
            print("No HTML content found to process")
            return docs

        # Parse conversations from HTML
        print("Parsing ChatGPT conversations from HTML...")
        conversations = self._parse_chatgpt_html(html_content)

        if not conversations:
            print("No conversations found in HTML content")
            return docs

        print(f"Found {len(conversations)} conversations")

        # Process conversations into documents
        count = 0
        for conversation in conversations:
            if max_count > 0 and count >= max_count:
                break

            if self.concatenate_conversations:
                # Create one document per conversation with concatenated messages
                doc_content = self._create_concatenated_content(conversation)

                metadata = {}
                if include_metadata:
                    metadata = {
                        "title": conversation.get("title", "ChatGPT Conversation"),
                        "timestamp": conversation.get("timestamp", "Unknown"),
                        "message_count": len(conversation.get("messages", [])),
                        "source": "ChatGPT Export",
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
                    doc_content = f"""Conversation: {conversation.get("title", "ChatGPT Conversation")}
Role: {role}
Timestamp: {msg_timestamp or conversation.get("timestamp", "Unknown")}
Message: {content}
"""

                    metadata = {}
                    if include_metadata:
                        metadata = {
                            "conversation_title": conversation.get("title", "ChatGPT Conversation"),
                            "role": role,
                            "timestamp": msg_timestamp or conversation.get("timestamp", "Unknown"),
                            "source": "ChatGPT Export",
                        }

                    doc = Document(text=doc_content, metadata=metadata)
                    docs.append(doc)
                    count += 1

        print(f"Created {len(docs)} documents from ChatGPT export")
        return docs
