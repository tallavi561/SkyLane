import express from 'express';

const PORT = process.env.PORT || 4002;

const BASE_FEE = Number(process.env.BASE_FEE ?? 15);
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM ?? 3);
const PRICE_PER_MINUTE = Number(process.env.PRICE_PER_MINUTE ?? 1);

// --- MoSes Monitor integration (see moses-monitoring-skill.md) ---
const MOSES_BASE_URL = process.env.MOSES_BASE_URL || 'https://api-gateway-x17f.onrender.com';
const MOSES_SERVICE_NAME = 'pricing-service';
const MOSES_HEARTBEAT_MS = 20000;

function sendMosesHeartbeat(status = 'UP') {
  fetch(`${MOSES_BASE_URL}/api/process/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serviceName: MOSES_SERVICE_NAME,
      status,
      description: "Quotes a delivery's price from its distance and estimated flight time",
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

function logEvent(event, details, logLevel = 2) {
  const payload = { ts: new Date().toISOString(), service: 'pricing-service', event, ...details };
  console.log(JSON.stringify(payload));
  sendMosesLog(logLevel, `${event} ${JSON.stringify(details)}`);
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', BASE_FEE, PRICE_PER_KM, PRICE_PER_MINUTE }));

app.post('/quote', (req, res) => {
  const { distanceKm, etaMinutes } = req.body ?? {};
  if (typeof distanceKm !== 'number' || typeof etaMinutes !== 'number' || distanceKm < 0 || etaMinutes < 0) {
    return res.status(400).json({ error: 'distanceKm and etaMinutes must be non-negative numbers' });
  }

  const distanceCost = distanceKm * PRICE_PER_KM;
  const timeCost = etaMinutes * PRICE_PER_MINUTE;
  const price = Math.round((BASE_FEE + distanceCost + timeCost) * 100) / 100;

  logEvent('PRICE_QUOTED', { distanceKm, etaMinutes, price });
  res.json({
    price,
    currency: 'ILS',
    breakdown: { baseFee: BASE_FEE, distanceCost: Math.round(distanceCost * 100) / 100, timeCost: Math.round(timeCost * 100) / 100 },
  });
});

app.listen(PORT, () => {
  console.log(`pricing-service listening on :${PORT}`);
});
