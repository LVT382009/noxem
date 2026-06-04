"""Headroom Proxy Server.

A transparent proxy that sits between LLM clients (Claude Code, Cursor, etc.)
and LLM APIs (Anthropic, OpenAI), applying Headroom optimizations.

Usage:
    # Start the proxy
    python -m headroom.proxy.server

    # Use with Claude Code
    ANTHROPIC_BASE_URL=http://localhost:8787 claude

    # Use with Cursor (if using Anthropic)
    Set base URL in Cursor settings to http://localhost:8787
"""

from .server import create_app, run_server

__all__ = ["create_app", "run_server"]
