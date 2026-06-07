#!/usr/bin/env bash
cd "$(dirname "$0")"
fuser -k 3001/tcp 2>/dev/null
sleep 2
rm -f data/hermes-memory.db*
export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
timeout 90 bash run-test.sh > /tmp/noxem-test-out.txt 2>&1
echo "EXIT=$?"
grep -c "PASS:" /tmp/noxem-test-out.txt || echo "0 passes"
grep -c "FAIL:" /tmp/noxem-test-out.txt || echo "0 fails"
grep "FAIL:" /tmp/noxem-test-out.txt
grep "Results:" /tmp/noxem-test-out.txt
