import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
const FLIGHT_PLAN_URL = process.env.FLIGHT_PLAN_URL || 'http://localhost:4001';
const TICK_MS = 1000;

// Mutable at runtime via POST /config - stands in for the ZooKeeper-style
// dynamic config the spec asked for.
const config = {
  VEHICLE_COUNT: Number(process.env.VEHICLE_COUNT ?? 6),
  MIN_SEPARATION_M: Number(process.env.MIN_SEPARATION_M ?? 500),
  ERROR_RATE: Number(process.env.ERROR_RATE ?? 0.05),
};

// Bounding box roughly covering Israel, used to spawn random simulated flights.
const BOUNDS = { minLat: 29.5, maxLat: 33.3, minLng: 34.2, maxLng: 35.9 };

const ARRIVAL_THRESHOLD_M = 75;
const CONFLICT_ALTITUDE_DIFF_M = 50;
const CONFLICT_LOG_THROTTLE_MS = 5000;

/** @type {Map<string, Vehicle>} */
const vehicles = new Map();
let nextSimId = 1;
const lastConflictLogAt = new Map(); // pairKey -> timestamp

function logEvent(event, details) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'traffic-service', event, ...details }));
}

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

async function requestFlightPlan(from, to) {
  const res = await fetch(`${FLIGHT_PLAN_URL}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || `flight-plan-service returned ${res.status}` };
  }
  const plan = await res.json();
  return { ok: true, plan };
}

async function spawnSimulatedVehicle() {
  const from = randomPointInBounds();
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const to = randomPointInBounds();
    const result = await requestFlightPlan(from, to);
    if (result.ok) {
      const id = `SIM-${nextSimId++}`;
      vehicles.set(id, {
        id,
        source: 'simulated',
        from,
        to,
        lat: from.lat,
        lng: from.lng,
        altitude: result.plan.altitude,
        speed: result.plan.speed,
        status: 'airborne',
      });
      return;
    }
  }
}

function moveVehicle(vehicle) {
  if (vehicle.source !== 'simulated' || vehicle.status !== 'airborne') return;

  const remainingM = haversineMeters(vehicle, vehicle.to);
  if (remainingM <= ARRIVAL_THRESHOLD_M) {
    vehicle.status = 'landed';
    vehicle.lat = vehicle.to.lat;
    vehicle.lng = vehicle.to.lng;
    logEvent('LANDED', { vehicleId: vehicle.id, at: vehicle.to });
    return;
  }

  const stepM = (vehicle.speed * 1000 / 3600) * (TICK_MS / 1000);
  const fraction = Math.min(stepM / remainingM, 1);
  vehicle.lat += (vehicle.to.lat - vehicle.lat) * fraction;
  vehicle.lng += (vehicle.to.lng - vehicle.lng) * fraction;
}

function resolveConflicts() {
  const airborne = [...vehicles.values()].filter((v) => v.status === 'airborne');
  for (let i = 0; i < airborne.length; i++) {
    for (let j = i + 1; j < airborne.length; j++) {
      const a = airborne[i];
      const b = airborne[j];
      const horizontalM = haversineMeters(a, b);
      const altitudeDiffM = Math.abs(a.altitude - b.altitude);
      if (horizontalM < config.MIN_SEPARATION_M && altitudeDiffM < CONFLICT_ALTITUDE_DIFF_M) {
        // The vehicle with the lexicographically greater id yields.
        const yielding = a.id > b.id ? a : b;
        yielding.altitude += 50;
        yielding.speed = Math.round(yielding.speed * 0.85);

        const pairKey = [a.id, b.id].sort().join('|');
        const now = Date.now();
        if (now - (lastConflictLogAt.get(pairKey) ?? 0) > CONFLICT_LOG_THROTTLE_MS) {
          lastConflictLogAt.set(pairKey, now);
          logEvent('CONFLICT_RESOLVED', {
            vehicles: [a.id, b.id],
            separationM: Math.round(horizontalM),
            yielded: yielding.id,
            newAltitude: yielding.altitude,
          });
        }
      }
    }
  }
}

function removeLandedVehicles() {
  for (const [id, vehicle] of vehicles) {
    if (vehicle.status === 'landed') vehicles.delete(id);
  }
}

async function tick() {
  const airborneSimCount = [...vehicles.values()].filter(
    (v) => v.source === 'simulated' && v.status === 'airborne'
  ).length;
  if (airborneSimCount < config.VEHICLE_COUNT) {
    await spawnSimulatedVehicle();
  }

  for (const vehicle of vehicles.values()) moveVehicle(vehicle);
  resolveConflicts();
  removeLandedVehicles();
}

setInterval(() => {
  tick().catch((err) => logEvent('ERROR', { message: err.message }));
}, TICK_MS);

function maybeInjectError(res) {
  if (Math.random() < config.ERROR_RATE) {
    logEvent('ERROR', { message: 'injected synthetic failure', errorRate: config.ERROR_RATE });
    res.status(500).json({ error: 'synthetic failure (ERROR_RATE injected)' });
    return true;
  }
  return false;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/health', (_req, res) => res.json({ status: 'ok', config }));

app.get('/vehicles', (_req, res) => {
  if (maybeInjectError(res)) return;
  res.json([...vehicles.values()]);
});

app.post('/flights', async (req, res) => {
  const { to, from } = req.body ?? {};
  if (!to || typeof to.lat !== 'number' || typeof to.lng !== 'number') {
    return res.status(400).json({ error: 'to must be { lat, lng }' });
  }
  const origin = from && typeof from.lat === 'number' ? from : randomPointInBounds();

  const result = await requestFlightPlan(origin, to);
  if (!result.ok) {
    return res.status(409).json({ error: result.error });
  }

  const id = `USER-${nextSimId++}`;
  const vehicle = {
    id,
    source: 'simulated',
    from: origin,
    to,
    lat: origin.lat,
    lng: origin.lng,
    altitude: result.plan.altitude,
    speed: result.plan.speed,
    status: 'airborne',
  };
  vehicles.set(id, vehicle);
  res.status(201).json(vehicle);
});

app.post('/gps', (req, res) => {
  if (maybeInjectError(res)) return;

  const { vehicleId, lat, lng } = req.body ?? {};
  if (!vehicleId || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'vehicleId, lat and lng are required' });
  }

  const existing = vehicles.get(vehicleId);
  if (existing) {
    existing.lat = lat;
    existing.lng = lng;
  } else {
    vehicles.set(vehicleId, {
      id: vehicleId,
      source: 'phone',
      lat,
      lng,
      altitude: 0,
      speed: 0,
      status: 'airborne',
    });
  }
  res.json({ status: 'ok' });
});

app.post('/config', (req, res) => {
  const { VEHICLE_COUNT, MIN_SEPARATION_M, ERROR_RATE } = req.body ?? {};
  if (VEHICLE_COUNT !== undefined) config.VEHICLE_COUNT = Number(VEHICLE_COUNT);
  if (MIN_SEPARATION_M !== undefined) config.MIN_SEPARATION_M = Number(MIN_SEPARATION_M);
  if (ERROR_RATE !== undefined) config.ERROR_RATE = Number(ERROR_RATE);
  res.json(config);
});

app.listen(PORT, () => {
  console.log(`traffic-service listening on :${PORT} (flight-plan-service at ${FLIGHT_PLAN_URL})`);
});
