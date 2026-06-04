#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
rm -f data/hermes-v2test.db
node memory-server.mjs &
SERVER_PID=$!
for i in $(seq 1 15); do
  if curl -s http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "Server ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== Test /memory/procedures ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' http://127.0.0.1:3001/memory/procedures)
echo "$R"

echo ""
echo "=== Test /memory/procedures/search?q=test ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' "http://127.0.0.1:3001/memory/procedures/search?q=test")
echo "$R"

echo ""
echo "=== Test /memory/notfound (should 404 or fall through) ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' http://127.0.0.1:3001/memory/notfound)
echo "$R"

echo ""
echo "=== Test /memory/123 (should 404 - no memory with that id) ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' http://127.0.0.1:3001/memory/123)
echo "$R"

echo ""
echo "=== Test /memory/pipeline/status ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' http://127.0.0.1:3001/memory/pipeline/status)
echo "$R"

echo ""
echo "=== Test /fetch/screenshot ==="
R=$(curl -s -w '\nHTTP_CODE:%{http_code}' -X POST http://127.0.0.1:3001/fetch/screenshot -H 'Content-Type: application/json' -d '{"url":"https://example.com"}')
echo "$R"

echo ""
echo "=== DB check ==="
node -e "const Database = require('better-sqlite3'); const db = new Database('data/hermes-v2test.db'); console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name)); console.log('user_version:', db.pragma('user_version', {simple:true})); try { console.log('Procedures:', db.prepare('SELECT count(*) as c FROM procedures').get()); } catch(e) { console.log('procedures table error:', e.message); }"

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -f data/hermes-v2test.db
