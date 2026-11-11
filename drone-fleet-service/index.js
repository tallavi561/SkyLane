import express from 'express';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const PORT = process.env.PORT || 4001;
const TICK_MS = 1000;
const FLEET_SIZE = Number(process.env.FLEET_SIZE ?? 10);
const SPEED_KMH = Number(process.env.SPEED_KMH ?? 5000);
const ARRIVAL_THRESHOLD_M = 150;

// How long a drone waits in `awaiting_pickup` / `awaiting_delivery` for a
// human to confirm before giving up: a warning is logged first, then the
// drone abandons the order and heads home if still no input.
const INPUT_WARNING_MS = Number(process.env.INPUT_WARNING_MS ?? 15000);
const INPUT_TIMEOUT_MS = Number(process.env.INPUT_TIMEOUT_MS ?? 30000);

// --- MoSes Monitor integration (see moses-monitoring-skill.md) ---
const MOSES_BASE_URL = process.env.MOSES_BASE_URL || 'https://api-gateway-x17f.onrender.com';
const MOSES_SERVICE_NAME = 'drone-fleet-service';
const MOSES_HEARTBEAT_MS = 20000;

// Resource metrics sampled at each heartbeat - cpuPercent is the delta of
// process.cpuUsage() over the interval, as a percent of one core.
let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = Date.now();

function sampleResourceUsage() {
  const now = Date.now();
  const elapsedMs = now - lastCpuSampleAt;
  const diff = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  lastCpuSampleAt = now;

  const metrics = {};
  if (elapsedMs > 0) {
    metrics.cpuPercent = Math.round(((diff.user + diff.system) / (elapsedMs * 1000)) * 1000) / 10;
  }
  const memoryMb = process.memoryUsage().rss / (1024 * 1024);
  if (Number.isFinite(memoryMb)) metrics.memoryMb = Math.round(memoryMb * 10) / 10;
  return metrics;
}

// Request-scoped trace context (traceId/spanId), set by the trace middleware
// below and read automatically by logEvent/sendMosesLog.
const traceContext = new AsyncLocalStorage();
function currentTrace() {
  return traceContext.getStore() || {};
}

function sendMosesHeartbeat(status = 'UP') {
  fetch(`${MOSES_BASE_URL}/api/process/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceName: MOSES_SERVICE_NAME,
      status,
      description: "Owns the drone fleet's live state and movement simulation",
      ...sampleResourceUsage(),
    }),
  }).catch((err) => console.error(`[moses] heartbeat failed: ${err.message}`));
}

function sendMosesLog(logLevel, rawMessage, ip) {
  const { traceId, spanId } = currentTrace();
  fetch(`${MOSES_BASE_URL}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceName: MOSES_SERVICE_NAME,
      logLevel,
      rawMessage,
      ...(ip ? { ip } : {}),
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
    }),
  }).catch(() => {});
}

sendMosesHeartbeat();
setInterval(() => sendMosesHeartbeat(), MOSES_HEARTBEAT_MS);

// Bounding box roughly covering Israel - used for each drone's fixed home base.
const BOUNDS = { minLat: 29.5, maxLat: 33.3, minLng: 34.2, maxLng: 35.9 };

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomPointInBounds() {
  return { lat: randomBetween(BOUNDS.minLat, BOUNDS.maxLat), lng: randomBetween(BOUNDS.minLng, BOUNDS.maxLng) };
}

const LOG_LEVEL = { INFO: 2, WARN: 3, ERROR: 4 };

function logEvent(event, details, logLevel = LOG_LEVEL.INFO, ip) {
  const payload = { ts: new Date().toISOString(), service: 'drone-fleet-service', event, ...details };
  console.log(JSON.stringify(payload));
  sendMosesLog(logLevel, `${event} ${JSON.stringify(details)}`, ip);
}

/** @typedef {'idle'|'to_pickup'|'awaiting_pickup'|'to_destination'|'awaiting_delivery'|'returning_home'} DroneStatus */

const drones = Array.from({ length: FLEET_SIZE }, (_, i) => {
  const home = randomPointInBounds();
  return {
    id: `DRONE-${i + 1}`,
    home,
    lat: home.lat,
    lng: home.lng,
    status: /** @type {DroneStatus} */ ('idle'),
    target: null,
    orderId: null,
    pendingDestination: null,
    awaitingSince: null,
    inputWarning: false,
  };
});

function findNearestIdleDrone(point) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const drone of drones) {
    if (drone.status !== 'idle') continue;
    const dist = haversineMeters(drone, point);
    if (dist < nearestDist) {
      nearest = drone;
      nearestDist = dist;
    }
  }
  return nearest;
}

function sendDroneHome(drone) {
  drone.status = 'returning_home';
  drone.target = drone.home;
  drone.orderId = null;
  drone.pendingDestination = null;
  drone.awaitingSince = null;
  drone.inputWarning = false;
}

function moveDrone(drone) {
  if (!drone.target) return;

  const remainingM = haversineMeters(drone, drone.target);
  if (remainingM <= ARRIVAL_THRESHOLD_M) {
    drone.lat = drone.target.lat;
    drone.lng = drone.target.lng;
    const arrivedStatus = drone.status;
    drone.target = null;

    if (arrivedStatus === 'to_pickup') {
      drone.status = 'awaiting_pickup';
      drone.awaitingSince = Date.now();
      logEvent('DRONE_ARRIVED_PICKUP', { droneId: drone.id, orderId: drone.orderId });
    } else if (arrivedStatus === 'to_destination') {
      drone.status = 'awaiting_delivery';
      drone.awaitingSince = Date.now();
      logEvent('DRONE_ARRIVED_DESTINATION', { droneId: drone.id, orderId: drone.orderId });
    } else if (arrivedStatus === 'returning_home') {
      drone.status = 'idle';
      logEvent('DRONE_RETURNED_HOME', { droneId: drone.id });
    }
    return;
  }

  const stepM = (SPEED_KMH * 1000 / 3600) * (TICK_MS / 1000);
  const fraction = Math.min(stepM / remainingM, 1);
  drone.lat += (drone.target.lat - drone.lat) * fraction;
  drone.lng += (drone.target.lng - drone.lng) * fraction;
}

function checkInputTimeout(drone) {
  if (drone.status !== 'awaiting_pickup' && drone.status !== 'awaiting_delivery') return;
  if (!drone.awaitingSince) return;

  const waitedMs = Date.now() - drone.awaitingSince;

  if (waitedMs >= INPUT_TIMEOUT_MS) {
    logEvent(
      'DRONE_INPUT_TIMEOUT',
      { droneId: drone.id, orderId: drone.orderId, status: drone.status, waitedMs },
      LOG_LEVEL.WARN
    );
    sendDroneHome(drone);
    return;
  }

  if (waitedMs >= INPUT_WARNING_MS && !drone.inputWarning) {
    drone.inputWarning = true;
    logEvent(
      'DRONE_INPUT_WARNING',
      { droneId: drone.id, orderId: drone.orderId, status: drone.status, waitedMs },
      LOG_LEVEL.WARN
    );
  }
}

setInterval(() => {
  for (const drone of drones) {
    moveDrone(drone);
    checkInputTimeout(drone);
  }
}, TICK_MS);

const app = express();
app.use(express.json());

// Trace correlation + request logging (see moses-monitoring-skill.md).
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || crypto.randomUUID();
  const spanId = crypto.randomBytes(4).toString('hex');
  const parentSpanId = req.headers['x-parent-span-id'] || undefined;
  const startedAt = Date.now();

  traceContext.run({ traceId, spanId, parentSpanId }, () => {
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const level = res.statusCode >= 500 ? LOG_LEVEL.ERROR : res.statusCode >= 400 ? LOG_LEVEL.WARN : LOG_LEVEL.INFO;
      logEvent('REQUEST', { method: req.method, path: req.originalUrl, status: res.statusCode, durationMs }, level, req.ip);
    });
    next();
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', fleetSize: FLEET_SIZE, speedKmh: SPEED_KMH }));

app.get('/drones', (_req, res) => {
  res.json(drones.map(({ pendingDestination, awaitingSince, ...publicFields }) => publicFields));
});

app.post('/reserve', (req, res) => {
  const { orderId, source, destination } = req.body ?? {};
  if (!orderId || !source || !destination) {
    return res.status(400).json({ error: 'orderId, source and destination are required' });
  }

  const drone = findNearestIdleDrone(source);
  if (!drone) {
    return res.status(409).json({ error: 'no drones available' });
  }

  drone.status = 'to_pickup';
  drone.target = source;
  drone.orderId = orderId;
  drone.pendingDestination = destination;

  logEvent('DRONE_ASSIGNED', { droneId: drone.id, orderId, source, destination });
  res.status(201).json({ droneId: drone.id });
});

app.post('/drones/:id/confirm-pickup', (req, res) => {
  const drone = drones.find((d) => d.id === req.params.id);
  if (!drone) return res.status(404).json({ error: 'drone not found' });
  if (drone.status !== 'awaiting_pickup') {
    return res.status(409).json({ error: `drone is not awaiting pickup (status: ${drone.status})` });
  }

  drone.status = 'to_destination';
  drone.target = drone.pendingDestination;
  drone.pendingDestination = null;
  drone.awaitingSince = null;
  drone.inputWarning = false;

  logEvent('DRONE_PICKED_UP', { droneId: drone.id, orderId: drone.orderId });
  res.json({ status: 'ok' });
});

app.post('/drones/:id/confirm-delivery', (req, res) => {
  const drone = drones.find((d) => d.id === req.params.id);
  if (!drone) return res.status(404).json({ error: 'drone not found' });
  if (drone.status !== 'awaiting_delivery') {
    return res.status(409).json({ error: `drone is not awaiting delivery (status: ${drone.status})` });
  }

  logEvent('DRONE_DELIVERED', { droneId: drone.id, orderId: drone.orderId });
  sendDroneHome(drone);

  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`drone-fleet-service listening on :${PORT} (fleet size ${FLEET_SIZE})`);
});
