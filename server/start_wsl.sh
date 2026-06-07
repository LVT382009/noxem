#!/bin/bash
export PATH=/usr/local/node22/bin:$PATH
cd "/mnt/c/Users/Le Van Tam/hermes-memory/server"
node --version
npm install 2>&1 | tail -5
nohup node memory-server.mjs > /tmp/noxem.log 2>&1 &
echo "SERVER_PID: $!"
sleep 5
cat /tmp/noxem.log | head -15
