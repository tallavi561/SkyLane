const ISRAEL_CENTER = [31.8, 34.9];
const POLL_MS = 1500;
const COMPLETED_VISIBLE_MS = 4000;

const map = L.map('map').setView(ISRAEL_CENTER, 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const STATUS_COLOR = {
  idle: '#94a3b8',
  to_pickup: '#2563eb',
  awaiting_pickup: '#f97316',
  to_destination: '#7c3aed',
  awaiting_delivery: '#eab308',
  returning_home: '#14b8a6',
};

const STATUS_LABEL = {
  idle: 'פנוי',
  to_pickup: 'הרחפן בדרך לנקודת האיסוף...',
  awaiting_pickup: 'הרחפן הגיע לנקודת האיסוף.',
  to_destination: 'הרחפן בדרך ליעד...',
  awaiting_delivery: 'הרחפן הגיע ליעד.',
  returning_home: 'נמסר! הרחפן חוזר לבסיס.',
};

const droneMarkers = new Map(); // droneId -> L.CircleMarker
const routeLines = new Map(); // droneId -> { line, arrowMarker }
const completedSeenAt = new Map(); // orderId -> timestamp first seen completed

const orderBtn = document.getElementById('orderBtn');
const statusEl = document.getElementById('status');
const actionMsgEl = document.getElementById('actionMsg');

const composerPanel = document.getElementById('composerPanel');
const pickSourceBtn = document.getElementById('pickSourceBtn');
const pickDestinationBtn = document.getElementById('pickDestinationBtn');
const nameStep = document.getElementById('nameStep');
const orderNameInput = document.getElementById('orderNameInput');
const submitOrderBtn = document.getElementById('submitOrderBtn');
const cancelOrderBtn = document.getElementById('cancelOrderBtn');

const orderPanel = document.getElementById('orderPanel');
const orderListEl = document.getElementById('orderList');

let actionMsgTimeoutId = null;

// --- Action feedback banner (separate from the ambient status line, so a
// background poll never overwrites a message before it can be read) ---
function showActionMessage(text, type = 'info', durationMs = 3500) {
  actionMsgEl.textContent = text;
  actionMsgEl.className = type;
  if (actionMsgTimeoutId !== null) clearTimeout(actionMsgTimeoutId);
  if (durationMs > 0) {
    actionMsgTimeoutId = setTimeout(() => {
      actionMsgEl.className = '';
      actionMsgEl.textContent = '';
    }, durationMs);
  }
}

function clearActionMessage() {
  if (actionMsgTimeoutId !== null) clearTimeout(actionMsgTimeoutId);
  actionMsgEl.className = '';
  actionMsgEl.textContent = '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

// --- Order composer flow: "הזמן משלוח" -> pick source -> pick destination -> name ---
let composerOpen = false;
let pickingMode = null; // null | 'source' | 'destination'
let pendingSource = null;
let pendingDestination = null;
let sourceMarker = null;
let destinationMarker = null;

function resetComposer() {
  pickingMode = null;
  pendingSource = null;
  pendingDestination = null;
  pickSourceBtn.classList.remove('chosen', 'active');
  pickDestinationBtn.classList.remove('chosen', 'active');
  pickDestinationBtn.disabled = true;
  nameStep.style.display = 'none';
  orderNameInput.value = '';
  if (sourceMarker) {
    map.removeLayer(sourceMarker);
    sourceMarker = null;
  }
  if (destinationMarker) {
    map.removeLayer(destinationMarker);
    destinationMarker = null;
  }
}

function openComposer() {
  composerOpen = true;
  composerPanel.classList.add('open');
  resetComposer();
  orderBtn.classList.add('active');
}

function closeComposer() {
  composerOpen = false;
  composerPanel.classList.remove('open');
  resetComposer();
  orderBtn.classList.remove('active');
}

orderBtn.addEventListener('click', () => {
  if (composerOpen) closeComposer();
  else openComposer();
});

cancelOrderBtn.addEventListener('click', closeComposer);

pickSourceBtn.addEventListener('click', () => {
  pickingMode = 'source';
  pickSourceBtn.classList.add('active');
  pickDestinationBtn.classList.remove('active');
  showActionMessage('לחץ על נקודת ההתחלה במפה', 'info', 0);
});

pickDestinationBtn.addEventListener('click', () => {
  if (pickDestinationBtn.disabled) return;
  pickingMode = 'destination';
  pickDestinationBtn.classList.add('active');
  pickSourceBtn.classList.remove('active');
  showActionMessage('לחץ על נקודת היעד במפה', 'info', 0);
});

map.on('click', (e) => {
  if (!pickingMode) return;
  const point = { lat: e.latlng.lat, lng: e.latlng.lng };

  if (pickingMode === 'source') {
    pendingSource = point;
    if (sourceMarker) map.removeLayer(sourceMarker);
    sourceMarker = L.marker([point.lat, point.lng], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:22px;">🟢</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(map);
    pickSourceBtn.classList.add('chosen');
    pickSourceBtn.classList.remove('active');
    pickDestinationBtn.disabled = false;
    pickingMode = null;
    clearActionMessage();
  } else if (pickingMode === 'destination') {
    pendingDestination = point;
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([point.lat, point.lng], {
      icon: L.divIcon({ className: '', html: '<div style="font-size:22px;">🔴</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(map);
    pickDestinationBtn.classList.add('chosen');
    pickDestinationBtn.classList.remove('active');
    pickingMode = null;
    clearActionMessage();
    nameStep.style.display = 'block';
    orderNameInput.focus();
  }
});

submitOrderBtn.addEventListener('click', submitOrder);
orderNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitOrder();
});

async function submitOrder() {
  const name = orderNameInput.value.trim();
  if (!name) {
    showActionMessage('יש להזין שם להזמנה', 'error');
    return;
  }

  try {
    const res = await fetch('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source: pendingSource, destination: pendingDestination }),
    });
    const body = await res.json();
    if (!res.ok) {
      showActionMessage(`ההזמנה נדחתה: ${body.error}`, 'error', 5000);
      closeComposer();
      return;
    }

    closeComposer();
    showActionMessage(`הזמנה "${body.name}" (${body.id}) נוצרה - ${body.droneId} בדרך לאיסוף`, 'success');
  } catch (err) {
    showActionMessage('שגיאה ביצירת הזמנה - אין חיבור לשרת', 'error', 5000);
    closeComposer();
  }
}

// --- Confirm actions: available to anyone viewing the shared order list ---
const actionInFlight = new Set();

async function confirmPickup(orderId) {
  if (actionInFlight.has(orderId)) return;
  actionInFlight.add(orderId);
  try {
    const res = await fetch(`/orders/${orderId}/confirm-pickup`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json();
      showActionMessage(`שגיאה באישור איסוף: ${body.error}`, 'error');
      return;
    }
    showActionMessage('איסוף אושר - הרחפן בדרך ליעד', 'success');
  } catch (err) {
    showActionMessage('שגיאה באישור איסוף - אין חיבור לשרת', 'error');
  } finally {
    actionInFlight.delete(orderId);
  }
}

async function confirmDelivery(orderId) {
  if (actionInFlight.has(orderId)) return;
  actionInFlight.add(orderId);
  try {
    const res = await fetch(`/orders/${orderId}/confirm-delivery`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json();
      showActionMessage(`שגיאה באישור מסירה: ${body.error}`, 'error');
      return;
    }
    showActionMessage('מסירה אושרה - הרחפן חוזר לבסיס', 'success');
  } catch (err) {
    showActionMessage('שגיאה באישור מסירה - אין חיבור לשרת', 'error');
  } finally {
    actionInFlight.delete(orderId);
  }
}

// An order stays visible to every viewer for a little while after it's
// completed (or timed out), then quietly drops off each browser's own list.
function isOrderVisible(order) {
  if (order.status !== 'completed' && order.status !== 'timed_out') return true;
  if (!completedSeenAt.has(order.id)) completedSeenAt.set(order.id, Date.now());
  return Date.now() - completedSeenAt.get(order.id) < COMPLETED_VISIBLE_MS;
}

function renderOrders(orders, dronesById) {
  const visible = orders.filter(isOrderVisible);
  orderPanel.classList.toggle('open', visible.length > 0);
  orderListEl.innerHTML = '';

  for (const order of visible) {
    const drone = dronesById.get(order.droneId);
    const droneStatus = drone ? drone.status : null;
    const statusText =
      order.status === 'timed_out' ? 'אין תגובה בזמן - ההזמנה בוטלה, הרחפן חוזר לבסיס' : STATUS_LABEL[droneStatus] || order.status;

    const card = document.createElement('div');
    card.className = 'order-card';

    const nameEl = document.createElement('div');
    nameEl.className = 'order-name';
    nameEl.textContent = `${order.name} (${order.id})`;
    card.appendChild(nameEl);

    const statusEl2 = document.createElement('div');
    statusEl2.className = 'order-status';
    statusEl2.textContent = statusText;
    card.appendChild(statusEl2);

    if (drone && drone.inputWarning && order.status !== 'timed_out') {
      const warningEl = document.createElement('div');
      warningEl.className = 'order-warning';
      warningEl.textContent = '⚠ אין תגובה - הרחפן יחזור לבסיס בקרוב אם לא תאשר';
      card.appendChild(warningEl);
    }

    if (order.price !== null && order.price !== undefined) {
      const priceEl = document.createElement('div');
      priceEl.className = 'order-price';
      priceEl.textContent = `${order.price} ₪ · ${order.distanceKm} ק"מ · כ-${order.etaMinutes} דק'`;
      card.appendChild(priceEl);
    }

    if (droneStatus === 'awaiting_pickup' && order.status === 'assigned') {
      const btn = document.createElement('button');
      btn.textContent = 'אשר איסוף';
      btn.onclick = () => confirmPickup(order.id);
      card.appendChild(btn);
    } else if (droneStatus === 'awaiting_delivery' && order.status === 'in_transit') {
      const btn = document.createElement('button');
      btn.textContent = 'אשר מסירה';
      btn.onclick = () => confirmDelivery(order.id);
      card.appendChild(btn);
    }

    orderListEl.appendChild(card);
  }
}

// --- Map rendering: drone markers + in-place route lines (updated, not
// recreated, every poll - recreating them each tick is what caused the
// flicker/behavior bugs in an earlier version) ---
function upsertDroneMarker(drone, orderNameByDroneId) {
  const color = STATUS_COLOR[drone.status] || '#64748b';
  const orderName = orderNameByDroneId.get(drone.id);
  const popupText = `${drone.id}<br/>סטטוס: ${STATUS_LABEL[drone.status] || drone.status}${orderName ? `<br/>הזמנה: ${orderName}` : ''}`;
  let marker = droneMarkers.get(drone.id);
  if (!marker) {
    marker = L.circleMarker([drone.lat, drone.lng], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.85,
    }).addTo(map);
    marker.bindPopup(popupText);
    droneMarkers.set(drone.id, marker);
  } else {
    marker.setLatLng([drone.lat, drone.lng]);
    marker.setStyle({ color, fillColor: color });
    marker.setPopupContent(popupText);
  }
}

function bearingDeg(from, to) {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  return (Math.atan2(dLng, dLat) * 180) / Math.PI;
}

function arrowIcon(color, angle) {
  return L.divIcon({
    className: 'route-arrow',
    html: `<div style="transform: rotate(${angle}deg); color: ${color};">▲</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function upsertRoute(drone) {
  if (!drone.target) {
    removeRoute(drone.id);
    return;
  }

  const latlngs = [
    [drone.lat, drone.lng],
    [drone.target.lat, drone.target.lng],
  ];
  const color = STATUS_COLOR[drone.status] || '#64748b';
  const angle = bearingDeg({ lat: drone.lat, lng: drone.lng }, drone.target);
  let entry = routeLines.get(drone.id);

  if (!entry) {
    const line = L.polyline(latlngs, { color, weight: 2, dashArray: '6,8', opacity: 0.7 }).addTo(map);
    const arrowMarker = L.marker([drone.target.lat, drone.target.lng], {
      icon: arrowIcon(color, angle),
      interactive: false,
    }).addTo(map);
    routeLines.set(drone.id, { line, arrowMarker });
  } else {
    entry.line.setLatLngs(latlngs);
    entry.line.setStyle({ color });
    entry.arrowMarker.setLatLng([drone.target.lat, drone.target.lng]);
    entry.arrowMarker.setIcon(arrowIcon(color, angle));
  }
}

function removeRoute(droneId) {
  const entry = routeLines.get(droneId);
  if (!entry) return;
  map.removeLayer(entry.line);
  map.removeLayer(entry.arrowMarker);
  routeLines.delete(droneId);
}

async function pollAll() {
  try {
    const [dronesRes, ordersRes] = await Promise.all([fetch('/drones'), fetch('/orders')]);
    if (!dronesRes.ok) {
      setStatus(`שגיאה בטעינת רחפנים (${dronesRes.status})`);
      return;
    }
    const drones = await dronesRes.json();
    const orders = ordersRes.ok ? await ordersRes.json() : [];

    const orderNameByDroneId = new Map();
    for (const order of orders) {
      if (order.status !== 'completed') orderNameByDroneId.set(order.droneId, order.name);
    }

    drones.forEach((d) => upsertDroneMarker(d, orderNameByDroneId));
    drones.forEach(upsertRoute);

    const dronesById = new Map(drones.map((d) => [d.id, d]));
    renderOrders(orders, dronesById);

    const busy = drones.filter((d) => d.status !== 'idle').length;
    setStatus(`${busy} רחפנים בפעולה מתוך ${drones.length}`);
  } catch (err) {
    setStatus('אין חיבור לשרת');
  }
}
setInterval(pollAll, POLL_MS);
pollAll();
