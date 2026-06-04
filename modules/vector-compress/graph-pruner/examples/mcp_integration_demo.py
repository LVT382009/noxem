#!/usr/bin/env python3
"""
MCP Integration Examples for LEANN

This script demonstrates how to use LEANN with different MCP servers for
RAG on various platforms like Slack and Twitter.

Examples:
1. Slack message RAG via MCP
2. Twitter bookmark RAG via MCP
3. Testing MCP server connections
"""

import asyncio
import sys
from pathlib import Path

# Add the parent directory to the path so we can import from apps
sys.path.append(str(Path(__file__).parent.parent))


async def demo_slack_mcp():
    """Demonstrate Slack MCP integration."""
    print("=" * 60)
    print("🔥 Slack MCP RAG Demo")
    print("=" * 60)

    print("\n1. Testing Slack MCP server connection...")

    # This would typically use a real MCP server command
    # For demo purposes, we show what the command would look like
    # slack_app = SlackMCPRAG()  # Would be used for actual testing

    # Simulate command line arguments for testing
    class MockArgs:
        mcp_server = "slack-mcp-server"  # This would be the actual MCP server command
        workspace_name = "my-workspace"
        channels = ["general", "random", "dev-team"]
        no_concatenate_conversations = False
        max_messages_per_channel = 50
        test_connection = True

    print(f"MCP Server Command: {MockArgs.mcp_server}")
    print(f"Workspace: {MockArgs.workspace_name}")
    print(f"Channels: {', '.join(MockArgs.channels)}")

    # In a real scenario, you would run:
    # success = await slack_app.test_mcp_connection(MockArgs)

    print("\n📝 Example usage:")
    print("python -m apps.slack_rag \\")
    print("  --mcp-server 'slack-mcp-server' \\")
    print("  --workspace-name 'my-team' \\")
    print("  --channels general dev-team \\")
    print("  --test-connection")

    print("\n🔍 After indexing, you could query:")
    print("- 'What did the team discuss about the project deadline?'")
    print("- 'Find messages about the new feature launch'")
    print("- 'Show me conversations about budget planning'")


async def demo_twitter_mcp():
    """Demonstrate Twitter MCP integration."""
    print("\n" + "=" * 60)
    print("🐦 Twitter MCP RAG Demo")
    print("=" * 60)

    print("\n1. Testing Twitter MCP server connection...")

    # twitter_app = TwitterMCPRAG()  # Would be used for actual testing

    class MockArgs:
        mcp_server = "twitter-mcp-server"
        username = None  # Fetch all bookmarks
        max_bookmarks = 500
        no_tweet_content = False
        no_metadata = False
        test_connection = True

    print(f"MCP Server Command: {MockArgs.mcp_server}")
    print(f"Max Bookmarks: {MockArgs.max_bookmarks}")
    print(f"Include Content: {not MockArgs.no_tweet_content}")
    print(f"Include Metadata: {not MockArgs.no_metadata}")

    print("\n📝 Example usage:")
    print("python -m apps.twitter_rag \\")
    print("  --mcp-server 'twitter-mcp-server' \\")
    print("  --max-bookmarks 1000 \\")
    print("  --test-connection")

    print("\n🔍 After indexing, you could query:")
    print("- 'What AI articles did I bookmark last month?'")
    print("- 'Find tweets about machine learning techniques'")
    print("- 'Show me bookmarked threads about startup advice'")


async def show_mcp_server_setup():
    """Show how to set up MCP servers."""
    print("\n" + "=" * 60)
    print("⚙️  MCP Server Setup Guide")
    print("=" * 60)

    print("\n🔧 Setting up Slack MCP Server:")
    print("1. Install a Slack MCP server (example commands):")
    print("   npm install -g slack-mcp-server")
    print("   # OR")
    print("   pip install slack-mcp-server")

    print("\n2. Configure Slack credentials:")
    print("   export SLACK_BOT_TOKEN='xoxb-your-bot-token'")
    print("   export SLACK_APP_TOKEN='xapp-your-app-token'")

    print("\n3. Test the server:")
    print("   slack-mcp-server --help")

    print("\n🔧 Setting up Twitter MCP Server:")
    print("1. Install a Twitter MCP server:")
    print("   npm install -g twitter-mcp-server")
    print("   # OR")
    print("   pip install twitter-mcp-server")

    print("\n2. Configure Twitter API credentials:")
    print("   export TWITTER_API_KEY='your-api-key'")
    print("   export TWITTER_API_SECRET='your-api-secret'")
    print("   export TWITTER_ACCESS_TOKEN='your-access-token'")
    print("   export TWITTER_ACCESS_TOKEN_SECRET='your-access-token-secret'")

    print("\n3. Test the server:")
    print("   twitter-mcp-server --help")


async def show_integration_benefits():
    """Show the benefits of MCP integration."""
    print("\n" + "=" * 60)
    print("🌟 Benefits of MCP Integration")
    print("=" * 60)

    benefits = [
        ("🔄 Live Data Access", "Fetch real-time data from platforms without manual exports"),
        ("🔌 Standardized Protocol", "Use any MCP-compatible server with minimal code changes"),
        ("🚀 Easy Extension", "Add new platforms by implementing MCP readers"),
        ("🔒 Secure Access", "MCP servers handle authentication and API management"),
        ("📊 Rich Metadata", "Access full platform metadata (timestamps, engagement, etc.)"),
        ("⚡ Efficient Processing", "Stream data directly into LEANN without intermediate files"),
    ]

    for title, description in benefits:
        print(f"\n{title}")
        print(f"   {description}")


async def main():
    """Main demo function."""
    print("🎯 LEANN MCP Integration Examples")
    print("This demo shows how to integrate LEANN with MCP servers for various platforms.")

    await demo_slack_mcp()
    await demo_twitter_mcp()
    await show_mcp_server_setup()
    await show_integration_benefits()

    print("\n" + "=" * 60)
    print("✨ Next Steps")
    print("=" * 60)
    print("1. Install and configure MCP servers for your platforms")
    print("2. Test connections using --test-connection flag")
    print("3. Run indexing to build your RAG knowledge base")
    print("4. Start querying your personal data!")

    print("\n📚 For more information:")
    print("- Check the README for detailed setup instructions")
    print("- Look at the apps/slack_rag.py and apps/twitter_rag.py for implementation details")
    print("- Explore other MCP servers for additional platforms")


if __name__ == "__main__":
    asyncio.run(main())
