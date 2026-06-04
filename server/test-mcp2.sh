#!/usr/bin/env bash
# Test MCP server tool calls via stdio
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false

# Send initialize + tools/list + memory_search in sequence
# MCP stdio uses newline-delimited JSON (each message on its own line)
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"test","limit":5}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_store","arguments":{"text":"MCP test memory","type":"fact","entity":"test"}}}'
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_release","arguments":{"token_budget":500}}}'
} | timeout 30 node mcp-server.mjs 2>/dev/null | while IFS= read -r line; do
  # Only print JSON lines
  if echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    :
  fi
done
