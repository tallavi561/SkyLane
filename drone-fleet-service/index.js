import express from 'express';

const PORT = process.env.PORT || 4001;
const TICK_MS = 1000;
const FLEET_SIZE = Number(process.env.FLEET_SIZE ?? 10);
const SPEED_KMH = Number(process.env.SPEED_KMH ?? 150);
const ARRIVAL_THRESHOLD_M = 150;

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

function logEvent(event, details) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'drone-fleet-service', event, ...details }));
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
      logEvent('DRONE_ARRIVED_PICKUP', { droneId: drone.id, orderId: drone.orderId });
    } else if (arrivedStatus === 'to_destination') {
      drone.status = 'awaiting_delivery';
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

setInterval(() => {
  for (const drone of drones) moveDrone(drone);
}, TICK_MS);

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', fleetSize: FLEET_SIZE }));

app.get('/drones', (_req, res) => {
  res.json(drones.map(({ pendingDestination, ...publicFields }) => publicFields));
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
  drone.status = 'returning_home';
  drone.target = drone.home;
  drone.orderId = null;

  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`drone-fleet-service listening on :${PORT} (fleet size ${FLEET_SIZE})`);
});
