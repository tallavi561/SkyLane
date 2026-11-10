import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const DRONE_FLEET_URL = process.env.DRONE_FLEET_URL || 'http://localhost:4001';

const config = {
  ERROR_RATE: Number(process.env.ERROR_RATE ?? 0.03),
};

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

function logEvent(event, details) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'order-service', event, ...details }));
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
  const { source, destination } = req.body ?? {};
  if (!validatePoint(source) || !validatePoint(destination)) {
    return res.status(400).json({ error: 'source and destination must each be { lat, lng }' });
  }

  const blockedZone = findRestrictedZone(source) || findRestrictedZone(destination);
  if (blockedZone) {
    logEvent('ORDER_REJECTED', { source, destination, reason: `inside restricted zone: ${blockedZone.name}` });
    return res.status(403).json({ error: `point is inside a no-fly zone: ${blockedZone.name}` });
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
      logEvent('ORDER_REJECTED', { orderId: id, source, destination, reason: body.error });
      return res.status(upstream.status).json(body);
    }

    const order = { id, source, destination, droneId: body.droneId, status: 'assigned' };
    orders.set(id, order);
    logEvent('ORDER_CREATED', { orderId: id, droneId: body.droneId, source, destination });
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
