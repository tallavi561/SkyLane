#!/usr/bin/env bash
# Stops SkyLane processes started by run.sh, by matching their listening ports.
for port in 4000 4001; do
  pid=$(netstat -ano 2>/dev/null | grep "LISTENING" | grep ":$port " | awk '{print $NF}' | head -n1)
  if [ -n "$pid" ]; then
    echo "Stopping process on port $port (pid $pid)"
    taskkill //PID "$pid" //F >/dev/null 2>&1 || true
  fi
done
