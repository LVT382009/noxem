#!/usr/bin/env bash
# Test Bundle Search with embeddings enabled
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=true
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
rm -f data/hermes-memory.db

node memory-server.mjs &
SERVER_PID=$!
for i in $(seq 1 30); do
  STATUS=$(curl -s http://127.0.0.1:3001/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('embedding',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "True" ] || [ "$STATUS" = "true" ]; then
    echo "Server ready with embedding after ${i}s"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "TIMEOUT: embedding not ready"
    kill $SERVER_PID 2>/dev/null; exit 1
  fi
  sleep 1
done

echo "=== Store 5 memories about redis ==="
for txt in \
  '{"text":"Redis cache invalidation strategy for microservices","type":"learning","entity":"redis","attribute":"cache","importance":0.8}' \
  '{"text":"Redis pub/sub for event-driven architecture","type":"fact","entity":"redis","attribute":"pubsub","importance":0.6}' \
  '{"text":"Redis connection pool tuning with maxIdle and maxActive","type":"setup","entity":"redis","attribute":"connection","importance":0.7}' \
  '{"text":"PostgreSQL WAL configuration for replication","type":"setup","entity":"postgresql","attribute":"wal","importance":0.5}' \
  '{"text":"Docker compose health check for Redis container","type":"setup","entity":"redis","attribute":"docker","importance":0.4}'; do
  R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d "$txt")
  echo "  Stored: $(echo $R | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','ERR'))" 2>/dev/null)"
  sleep 2  # Let embed queue process
done

# Wait for embeddings to settle
sleep 10
echo "=== Embedding status ==="
curl -s http://127.0.0.1:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'embedding={d[\"embedding\"]}, vector_index={d[\"vector_index\"]}')" 2>/dev/null

echo "=== Bundle Search: redis ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/bundle-search -H "Content-Type: application/json" -d '{"query":"redis cache invalidation","topK":5}')
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'ok={d.get(\"ok\")}, episodes={len(d.get(\"episodes\",[]))}, layers={d.get(\"layers_searched\",{})}')" 2>/dev/null || echo "PARSE_ERR: $(echo $R | head -c 200)"

echo "=== FTS+Vector Hybrid Search: redis ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=redis+cache&limit=5")
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'method={d.get(\"method\")}, results={len(d.get(\"results\",[]))}')" 2>/dev/null

echo "=== Graph Traverse from memory 1 ==="
R=$(curl -s "http://127.0.0.1:3001/memory/graph/traverse?from_id=1&max_depth=2&limit=10")
echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'ok={d.get(\"ok\")}, steps={len(d.get(\"steps\",[]))}')" 2>/dev/null

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -f data/hermes-memory.db
