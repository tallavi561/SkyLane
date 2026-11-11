import express from 'express';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const PORT = process.env.PORT || 4002;

const BASE_FEE = Number(process.env.BASE_FEE ?? 15);
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM ?? 3);
const PRICE_PER_MINUTE = Number(process.env.PRICE_PER_MINUTE ?? 1);

// --- MoSes Monitor integration (see moses-monitoring-skill.md) ---
const MOSES_BASE_URL = process.env.MOSES_BASE_URL || 'https://api-gateway-x17f.onrender.com';
const MOSES_SERVICE_NAME = 'pricing-service';
const MOSES_HEARTBEAT_MS = 20000;

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
      description: "Quotes a delivery's price from its distance and estimated flight time",
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

const LOG_LEVEL = { INFO: 2, WARN: 3, ERROR: 4 };

function logEvent(event, details, logLevel = LOG_LEVEL.INFO, ip) {
  const payload = { ts: new Date().toISOString(), service: 'pricing-service', event, ...details };
  console.log(JSON.stringify(payload));
  sendMosesLog(logLevel, `${event} ${JSON.stringify(details)}`, ip);
}

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
