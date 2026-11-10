import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const DRONE_FLEET_URL = process.env.DRONE_FLEET_URL || 'http://localhost:4001';
const PRICING_URL = process.env.PRICING_URL || 'http://localhost:4002';

const config = {
  ERROR_RATE: Number(process.env.ERROR_RATE ?? 0.03),
};

// --- MoSes Monitor integration (see moses-monitoring-skill.md) ---
const MOSES_BASE_URL = process.env.MOSES_BASE_URL || 'https://api-gateway-x17f.onrender.com';
const MOSES_SERVICE_NAME = 'order-service';
const MOSES_HEARTBEAT_MS = 20000;

function sendMosesHeartbeat(status = 'UP') {
  fetch(`${MOSES_BASE_URL}/api/process/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceName: MOSES_SERVICE_NAME,
      status,
      description: 'Delivery order API; assigns drones and prices orders',
      connections: ['drone-fleet-service', 'pricing-service'],
    }),
  }).catch((err) => console.error(`[moses] heartbeat failed: ${err.message}`));
}

function sendMosesLog(logLevel, rawMessage) {
  fetch(`${MOSES_BASE_URL}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceName: MOSES_SERVICE_NAME, logLevel, rawMessage }),
  }).catch(() => {});
}

sendMosesHeartbeat();
setInterval(() => sendMosesHeartbeat(), MOSES_HEARTBEAT_MS);

// No-fly zones: orders whose source or destination falls inside one are rejected.
const RESTRICTED_ZONES = [
  { name: 'Ben Gurion Airport (LLBG)', lat: 32.0055, lng: 34.8854, radiusM: 8000 },
  { name: 'Military Zone - Palmachim', lat: 31.8961, lng: 34.6906, radiusM: 5000 },
];

let nextOrderId = 1;
/** @type {Map<string, any>} */
const orders = new Map();

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

function findRestrictedZone(point) {
  return RESTRICTED_ZONES.find((zone) => haversineMeters(point, zone) <= zone.radiusM);
}

const LOG_LEVEL = { INFO: 2, WARN: 3, ERROR: 4 };

function logEvent(event, details, logLevel = event === 'ERROR' ? LOG_LEVEL.ERROR : LOG_LEVEL.INFO) {
  const payload = { ts: new Date().toISOString(), service: 'order-service', event, ...details };
  console.log(JSON.stringify(payload));
  sendMosesLog(logLevel, `${event} ${JSON.stringify(details)}`);
}

function validatePoint(point) {
  return (
    point &&
    typeof point.lat === 'number' &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng)
  );
}

async function getDroneSpeedKmh() {
  const res = await fetch(`${DRONE_FLEET_URL}/health`);
  const body = await res.json();
  return body.speedKmh;
}

async function getQuote(distanceKm, etaMinutes) {
  const res = await fetch(`${PRICING_URL}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distanceKm, etaMinutes }),
  });
  if (!res.ok) throw new Error(`pricing-service returned ${res.status}`);
  return res.json();
}

// drone-fleet-service gives up on an unconfirmed pickup/delivery on its own
// (see INPUT_TIMEOUT_MS there) and sends the drone home. This periodically
// notices that - the drone no longer references the order - and marks the
// order accordingly, so its confirm button doesn't linger forever.
const ORDER_TIMEOUT_CHECK_MS = 3000;

async function checkForTimedOutOrders() {
  const pending = [...orders.values()].filter((o) => o.status === 'assigned' || o.status === 'in_transit');
  if (pending.length === 0) return;

  try {
    const res = await fetch(`${DRONE_FLEET_URL}/drones`);
    if (!res.ok) return;
    const drones = await res.json();
    const dronesById = new Map(drones.map((d) => [d.id, d]));

    for (const order of pending) {
      const drone = dronesById.get(order.droneId);
      if (!drone || drone.orderId !== order.id) {
        order.status = 'timed_out';
        logEvent('ORDER_TIMED_OUT', { orderId: order.id, droneId: order.droneId }, LOG_LEVEL.WARN);
      }
    }
  } catch (err) {
    // drone-fleet-service unreachable - try again on the next tick.
  }
}

setInterval(() => {
  checkForTimedOutOrders();
}, ORDER_TIMEOUT_CHECK_MS);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/health', (_req, res) => res.json({ status: 'ok', config }));

// Proxied so the frontend only talks to one origin, and so every poll shows
// up as a real inter-service call for monitoring.
app.get('/drones', async (_req, res) => {
  if (Math.random() < config.ERROR_RATE) {
    logEvent('ERROR', { message: 'injected synthetic failure on /drones' });
    return res.status(500).json({ error: 'synthetic failure (ERROR_RATE injected)' });
  }
  try {
    const upstream = await fetch(`${DRONE_FLEET_URL}/drones`);
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(502).json({ error: 'drone-fleet-service unreachable' });
  }
});

app.post('/orders', async (req, res) => {
  const { name, source, destination } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!validatePoint(source) || !validatePoint(destination)) {
    return res.status(400).json({ error: 'source and destination must each be { lat, lng }' });
  }

  const blockedZone = findRestrictedZone(source) || findRestrictedZone(destination);
  if (blockedZone) {
    logEvent('ORDER_REJECTED', { name, source, destination, reason: `inside restricted zone: ${blockedZone.name}` });
    return res.status(403).json({ error: `point is inside a no-fly zone: ${blockedZone.name}` });
  }

  const distanceKm = haversineMeters(source, destination) / 1000;
  let etaMinutes = null;
  let price = null;
  try {
    const speedKmh = await getDroneSpeedKmh();
    etaMinutes = Math.round((distanceKm / speedKmh) * 60 * 10) / 10;
    const quote = await getQuote(distanceKm, etaMinutes);
    price = quote.price;
  } catch (err) {
    // Pricing is informational - an order can still be created without it.
    logEvent('ERROR', { message: `pricing unavailable: ${err.message}` });
  }

  const id = `ORDER-${nextOrderId++}`;
  try {
    const upstream = await fetch(`${DRONE_FLEET_URL}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: id, source, destination }),
    });
    const body = await upstream.json();
    if (!upstream.ok) {
      logEvent('ORDER_REJECTED', { orderId: id, name, source, destination, reason: body.error });
      return res.status(upstream.status).json(body);
    }

    const order = {
      id,
      name: name.trim(),
      source,
      destination,
      droneId: body.droneId,
      status: 'assigned',
      distanceKm: Math.round(distanceKm * 100) / 100,
      etaMinutes,
      price,
    };
    orders.set(id, order);
    logEvent('ORDER_CREATED', { orderId: id, name: order.name, droneId: body.droneId, distanceKm: order.distanceKm, etaMinutes, price });
    res.status(201).json(order);
  } catch (err) {
    res.status(502).json({ error: 'drone-fleet-service unreachable' });
  }
});

app.get('/orders', (_req, res) => res.json([...orders.values()]));

app.get('/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json(order);
});

app.post('/orders/:id/confirm-pickup', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });

  try {
    const upstream = await fetch(`${DRONE_FLEET_URL}/drones/${order.droneId}/confirm-pickup`, { method: 'POST' });
    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(body);

    order.status = 'in_transit';
    logEvent('ORDER_PICKED_UP', { orderId: order.id, droneId: order.droneId });
    res.json(order);
  } catch (err) {
    res.status(502).json({ error: 'drone-fleet-service unreachable' });
  }
});

app.post('/orders/:id/confirm-delivery', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });

  try {
    const upstream = await fetch(`${DRONE_FLEET_URL}/drones/${order.droneId}/confirm-delivery`, { method: 'POST' });
    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(body);

    order.status = 'completed';
    logEvent('ORDER_DELIVERED', { orderId: order.id, droneId: order.droneId });
    res.json(order);
  } catch (err) {
    res.status(502).json({ error: 'drone-fleet-service unreachable' });
  }
});

app.post('/config', (req, res) => {
  const { ERROR_RATE } = req.body ?? {};
  if (ERROR_RATE !== undefined) config.ERROR_RATE = Number(ERROR_RATE);
  res.json(config);
});

app.listen(PORT, () => {
  console.log(`order-service listening on :${PORT} (drone-fleet-service at ${DRONE_FLEET_URL})`);
});
