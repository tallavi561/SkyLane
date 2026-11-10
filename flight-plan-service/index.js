import express from 'express';

const PORT = process.env.PORT || 4001;

// No-Fly Zones: a fixed list of circles. Any flight whose destination falls
// inside one is rejected. Coordinates are illustrative, not operational.
const RESTRICTED_ZONES = [
  { name: 'Ben Gurion Airport (LLBG)', lat: 32.0055, lng: 34.8854, radiusM: 8000 },
  { name: 'Military Zone - Palmachim', lat: 31.8961, lng: 34.6906, radiusM: 5000 },
];

const ALTITUDE_BY_DIRECTION = {
  east: { short: 100, long: 300 },
  west: { short: 200, long: 400 },
};

const SPEED_BY_ALTITUDE = {
  100: 120,
  200: 160,
  300: 220,
  400: 280,
};

const LONG_HAUL_THRESHOLD_KM = 40;

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

function bearingIsEastward(from, to) {
  return to.lng >= from.lng;
}

function isInRestrictedZone(point) {
  return RESTRICTED_ZONES.find((zone) => haversineMeters(point, zone) <= zone.radiusM);
}

function logEvent(event, details) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'flight-plan-service', event, ...details }));
}

function validatePoint(point, label) {
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/plan', (req, res) => {
  const { from, to } = req.body ?? {};

  if (!validatePoint(from, 'from') || !validatePoint(to, 'to')) {
    return res.status(400).json({ error: 'from and to must each be { lat, lng }' });
  }

  const blockedZone = isInRestrictedZone(to);
  if (blockedZone) {
    logEvent('FLIGHT_REJECTED', { from, to, reason: `destination inside restricted zone: ${blockedZone.name}` });
    return res.status(403).json({ error: `destination is inside a no-fly zone: ${blockedZone.name}` });
  }

  const distanceKm = haversineMeters(from, to) / 1000;
  const direction = bearingIsEastward(from, to) ? 'east' : 'west';
  const haul = distanceKm < LONG_HAUL_THRESHOLD_KM ? 'short' : 'long';
  const altitude = ALTITUDE_BY_DIRECTION[direction][haul];
  const speed = SPEED_BY_ALTITUDE[altitude];

  logEvent('FLIGHT_PLANNED', { from, to, distanceKm: Math.round(distanceKm), direction, altitude, speed });
  res.json({ altitude, speed });
});

app.listen(PORT, () => {
  console.log(`flight-plan-service listening on :${PORT}`);
});
