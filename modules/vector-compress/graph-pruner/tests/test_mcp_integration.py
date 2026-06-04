#!/usr/bin/env python3
"""
Test script for MCP integration implementations.

This script tests the basic functionality of the MCP readers and RAG applications
without requiring actual MCP servers to be running.
"""

import sys
from pathlib import Path

# Add the parent directory to the path so we can import from apps
sys.path.append(str(Path(__file__).parent.parent))

from apps.slack_data.slack_mcp_reader import SlackMCPReader
from apps.slack_rag import SlackMCPRAG
from apps.twitter_data.twitter_mcp_reader import TwitterMCPReader
from apps.twitter_rag import TwitterMCPRAG


def test_slack_reader_initialization():
    """Test that SlackMCPReader can be initialized with various parameters."""
    print("Testing SlackMCPReader initialization...")

    # Test basic initialization
    reader = SlackMCPReader("slack-mcp-server")
    assert reader.mcp_server_command == "slack-mcp-server"
    assert reader.concatenate_conversations
    assert reader.max_messages_per_conversation == 100

    # Test with custom parameters
    reader = SlackMCPReader(
        "custom-slack-server",
        workspace_name="test-workspace",
        concatenate_conversations=False,
        max_messages_per_conversation=50,
    )
    assert reader.workspace_name == "test-workspace"
    assert not reader.concatenate_conversations
    assert reader.max_messages_per_conversation == 50

    print("✅ SlackMCPReader initialization tests passed")


def test_twitter_reader_initialization():
    """Test that TwitterMCPReader can be initialized with various parameters."""
    print("Testing TwitterMCPReader initialization...")

    # Test basic initialization
    reader = TwitterMCPReader("twitter-mcp-server")
    assert reader.mcp_server_command == "twitter-mcp-server"
    assert reader.include_tweet_content
    assert reader.include_metadata
    assert reader.max_bookmarks == 1000

    # Test with custom parameters
    reader = TwitterMCPReader(
        "custom-twitter-server",
        username="testuser",
        include_tweet_content=False,
        include_metadata=False,
        max_bookmarks=500,
    )
    assert reader.username == "testuser"
    assert not reader.include_tweet_content
    assert not reader.include_metadata
    assert reader.max_bookmarks == 500

    print("✅ TwitterMCPReader initialization tests passed")


def test_slack_message_formatting():
    """Test Slack message formatting functionality."""
    print("Testing Slack message formatting...")

    reader = SlackMCPReader("slack-mcp-server")

    # Test basic message formatting
    message = {
        "text": "Hello, world!",
        "user": "john_doe",
        "channel": "general",
        "ts": "1234567890.123456",
    }

    formatted = reader._format_message(message)
    assert "Channel: #general" in formatted
    assert "User: john_doe" in formatted
    assert "Message: Hello, world!" in formatted
    assert "Time:" in formatted

    # Test with missing fields
    message = {"text": "Simple message"}
    formatted = reader._format_message(message)
    assert "Message: Simple message" in formatted

    print("✅ Slack message formatting tests passed")


def test_twitter_bookmark_formatting():
    """Test Twitter bookmark formatting functionality."""
    print("Testing Twitter bookmark formatting...")

    reader = TwitterMCPReader("twitter-mcp-server")

    # Test basic bookmark formatting
    bookmark = {
        "text": "This is a great article about AI!",
        "author": "ai_researcher",
        "created_at": "2024-01-01T12:00:00Z",
        "url": "https://twitter.com/ai_researcher/status/123456789",
        "likes": 42,
        "retweets": 15,
    }

    formatted = reader._format_bookmark(bookmark)
    assert "=== Twitter Bookmark ===" in formatted
    assert "Author: @ai_researcher" in formatted
    assert "Content:" in formatted
    assert "This is a great article about AI!" in formatted
    assert "URL: https://twitter.com" in formatted
    assert "Likes: 42" in formatted
    assert "Retweets: 15" in formatted

    # Test with minimal data
    bookmark = {"text": "Simple tweet"}
    formatted = reader._format_bookmark(bookmark)
    assert "=== Twitter Bookmark ===" in formatted
    assert "Simple tweet" in formatted

    print("✅ Twitter bookmark formatting tests passed")


def test_slack_rag_initialization():
    """Test that SlackMCPRAG can be initialized."""
    print("Testing SlackMCPRAG initialization...")

    app = SlackMCPRAG()
    assert app.default_index_name == "slack_messages"
    assert hasattr(app, "parser")

    print("✅ SlackMCPRAG initialization tests passed")


def test_twitter_rag_initialization():
    """Test that TwitterMCPRAG can be initialized."""
    print("Testing TwitterMCPRAG initialization...")

    app = TwitterMCPRAG()
    assert app.default_index_name == "twitter_bookmarks"
    assert hasattr(app, "parser")

    print("✅ TwitterMCPRAG initialization tests passed")


def test_concatenated_content_creation():
    """Test creation of concatenated content from multiple messages."""
    print("Testing concatenated content creation...")

    reader = SlackMCPReader("slack-mcp-server", workspace_name="test-workspace")

    messages = [
        {"text": "First message", "user": "alice", "ts": "1000"},
        {"text": "Second message", "user": "bob", "ts": "2000"},
        {"text": "Third message", "user": "charlie", "ts": "3000"},
    ]

    content = reader._create_concatenated_content(messages, "general")

    assert "Slack Channel: #general" in content
    assert "Message Count: 3" in content
    assert "Workspace: test-workspace" in content
    assert "First message" in content
    assert "Second message" in content
    assert "Third message" in content

    print("✅ Concatenated content creation tests passed")


def main():
    """Run all tests."""
    print("🧪 Running MCP Integration Tests")
    print("=" * 50)

    try:
        test_slack_reader_initialization()
        test_twitter_reader_initialization()
        test_slack_message_formatting()
        test_twitter_bookmark_formatting()
        test_slack_rag_initialization()
        test_twitter_rag_initialization()
        test_concatenated_content_creation()

        print("\n" + "=" * 50)
        print("🎉 All tests passed! MCP integration is working correctly.")
        print("\nNext steps:")
        print("1. Install actual MCP servers for Slack and Twitter")
        print("2. Configure API credentials")
        print("3. Test with --test-connection flag")
        print("4. Start indexing your live data!")

    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
