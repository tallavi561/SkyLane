#!/usr/bin/env bash
# Installs dependencies (if needed) and starts both SkyLane services in the
# background, logging to logs/*.log. Stop them with ./stop.sh.
set -e
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$root/logs"

for svc in flight-plan-service traffic-service; do
  if [ ! -d "$root/$svc/node_modules" ]; then
    echo "Installing dependencies in $svc..."
    (cd "$root/$svc" && npm install)
  fi
done

(cd "$root/flight-plan-service" && npm start > "$root/logs/flight-plan-service.log" 2>&1 &)
(cd "$root/traffic-service" && npm start > "$root/logs/traffic-service.log" 2>&1 &)

echo "flight-plan-service -> http://localhost:4001 (logs/flight-plan-service.log)"
echo "traffic-service     -> http://localhost:4000 (logs/traffic-service.log)"
echo "Open http://localhost:4000 in your browser for the map."
echo "Stop both with: ./stop.sh"
