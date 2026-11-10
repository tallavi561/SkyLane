#!/usr/bin/env bash
# Installs dependencies (if needed) and starts both SkyLane services in the
# background, logging to logs/*.log. Stop them with ./stop.sh.
set -e
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$root/logs"

for svc in drone-fleet-service order-service; do
  if [ ! -d "$root/$svc/node_modules" ]; then
    echo "Installing dependencies in $svc..."
    (cd "$root/$svc" && npm install)
  fi
done

(cd "$root/drone-fleet-service" && npm start > "$root/logs/drone-fleet-service.log" 2>&1 &)
(cd "$root/order-service" && npm start > "$root/logs/order-service.log" 2>&1 &)

echo "drone-fleet-service -> http://localhost:4001 (logs/drone-fleet-service.log)"
echo "order-service       -> http://localhost:4000 (logs/order-service.log)"
echo "Open http://localhost:4000 in your browser for the map."
echo "Stop both with: ./stop.sh"
