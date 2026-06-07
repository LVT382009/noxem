#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
rm -f data/hermes-memory.db
node memory-server.mjs &
SERVER_PID=$!
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "Server ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== Store postgresql memory ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text":"PostgreSQL connection pooling config","type":"setup","entity":"postgresql","attribute":"connection","context_prefix":"Setup for postgresql"}')
echo "$R"
sleep 1

echo "=== Store redis memory ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text":"Redis cache invalidation pattern for microservices","type":"learning","entity":"redis","attribute":"cache","context_prefix":"Learning about redis"}')
echo "$R"
sleep 1

echo "=== FTS5 search: postgresql ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=postgresql&limit=5")
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'method={d.get(\"method\")}, results={len(d.get(\"results\",[]))}')" 2>/dev/null || echo "PARSE_ERR: $R"

echo "=== FTS5 search: redis ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=redis&limit=5")
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'method={d.get(\"method\")}, results={len(d.get(\"results\",[]))}')" 2>/dev/null || echo "PARSE_ERR: $R"

echo "=== FTS5 search: connection pooling ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=connection+pooling&limit=5")
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'method={d.get(\"method\")}, results={len(d.get(\"results\",[]))}')" 2>/dev/null || echo "PARSE_ERR: $R"

echo "=== Raw FTS5 query test ==="
node -e "const Database = require('better-sqlite3'); const db = new Database('data/hermes-memory.db'); try { const r = db.prepare(\"SELECT rowid, text, entity FROM memories_fts WHERE memories_fts MATCH 'postgresql'\").all(); console.log('FTS5 rows:', r.length, r.map(x=>x.entity)); } catch(e) { console.log('FTS5 error:', e.message); } db.close();"

echo "=== Schema check ==="
node -e "const Database = require('better-sqlite3'); const db = new Database('data/hermes-memory.db'); const tables = db.prepare(\"SELECT sql FROM sqlite_master WHERE name='memories_fts'\").all(); console.log('FTS5 schema:', tables); const uv = db.pragma('user_version', {simple:true}); console.log('user_version:', uv); db.close();"

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -f data/hermes-memory.db
