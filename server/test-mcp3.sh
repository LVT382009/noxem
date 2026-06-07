#!/usr/bin/env bash
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false

# Write messages to a file, then pipe with delays
cat > /tmp/mcp-input.jsonl << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"redis","limit":3}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_store","arguments":{"text":"MCP test memory","type":"fact","entity":"mcp"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_release","arguments":{"token_budget":500}}}
EOF

cat /tmp/mcp-input.jsonl | timeout 30 node mcp-server.mjs 2>/dev/null | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"): continue
    try:
        d = json.loads(line)
        rid = d.get("id")
        if d.get("result",{}).get("content"):
            text = d["result"]["content"][0]["text"][:150]
            err = d["result"].get("isError", False)
            print(f"id={rid} {"ERROR" if err else "OK"}: {text}")
        elif d.get("result",{}).get("serverInfo"):
            print(f"id={rid} INIT: {d["result"]["serverInfo"]["name"]} v{d["result"]["serverInfo"]["version"]}")
        elif d.get("error"):
            print(f"id={rid} ERROR: {d["error"]["message"]}")
        else:
            print(f"id={rid} OTHER: {json.dumps(d)[:150]}")
    except Exception as e:
        pass
'
