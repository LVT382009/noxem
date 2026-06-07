#!/usr/bin/env bash
# Test MCP server by piping JSON-RPC messages via stdin
cd "$(dirname "$0")"

# MCP stdio transport: client sends JSON-RPC on stdin, server responds on stdout
# We need to: initialize, then call a tool, then shutdown

INIT_MSG='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'
INIT_RESP=$(echo "$INIT_MSG" | timeout 15 node mcp-server.mjs 2>/dev/null)

echo "=== Initialize Response ==="
echo "$INIT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d, indent=2))" 2>/dev/null || echo "RAW: $INIT_RESP"

# Test tool list
LIST_MSG='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
LIST_RESP=$(echo -e "$INIT_MSG\n$LIST_MSG" | timeout 15 node mcp-server.mjs 2>/dev/null | tail -1)

echo ""
echo "=== Tool List ==="
echo "$LIST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); tools=[t['name'] for t in d.get('result',{}).get('tools',[])]; print(f'Found {len(tools)} tools:', tools)" 2>/dev/null || echo "RAW: $(echo $LIST_RESP | head -c 200)"
