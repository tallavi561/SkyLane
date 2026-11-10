const ISRAEL_CENTER = [31.8, 34.9];
const POLL_MS = 1500;

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
  to_pickup: 'בדרך לאיסוף',
  awaiting_pickup: 'ממתין לאישור איסוף',
  to_destination: 'בדרך ליעד',
  awaiting_delivery: 'ממתין לאישור מסירה',
  returning_home: 'חוזר לבסיס',
};

const droneMarkers = new Map(); // droneId -> L.CircleMarker
const routeLines = new Map(); // droneId -> { line, arrowMarker }

const orderBtn = document.getElementById('orderBtn');
const statusEl = document.getElementById('status');
const actionMsgEl = document.getElementById('actionMsg');

const composerPanel = document.getElementById('composerPanel');
const pickSourceBtn = document.getElementById('pickSourceBtn');
const pickDestinationBtn = document.getElementById('pickDestinationBtn');
const cancelOrderBtn = document.getElementById('cancelOrderBtn');

const orderPanel = document.getElementById('orderPanel');
const orderTitleEl = document.getElementById('orderTitle');
const orderStatusTextEl = document.getElementById('orderStatusText');
const orderActionBtn = document.getElementById('orderActionBtn');

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

function setStatus(text) {
  statusEl.textContent = text;
}

// --- Order composer flow: "הזמן משלוח" -> pick source -> pick destination ---
let composerOpen = false;
let pickingMode = null; // null | 'source' | 'destination'
let pendingSource = null;
let pendingDestination = null;
let sourceMarker = null;
let destinationMarker = null;
let activeOrder = null; // { id, droneId, status }

function resetComposer() {
  pickingMode = null;
  pendingSource = null;
  pendingDestination = null;
  pickSourceBtn.classList.remove('chosen', 'active');
  pickDestinationBtn.classList.remove('chosen', 'active');
  pickDestinationBtn.disabled = true;
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
  if (activeOrder) {
    showActionMessage('יש כבר הזמנה פעילה - סיים אותה לפני שתפתח הזמנה חדשה', 'error');
    return;
  }
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

map.on('click', async (e) => {
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
    await submitOrder();
  }
});

function clearActionMessage() {
  if (actionMsgTimeoutId !== null) clearTimeout(actionMsgTimeoutId);
  actionMsgEl.className = '';
  actionMsgEl.textContent = '';
}

async function submitOrder() {
  try {
    const res = await fetch('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: pendingSource, destination: pendingDestination }),
    });
    const body = await res.json();
    if (!res.ok) {
      showActionMessage(`ההזמנה נדחתה: ${body.error}`, 'error', 5000);
      closeComposer();
      return;
    }

    activeOrder = { id: body.id, droneId: body.droneId, status: body.status };
    closeComposer();
    showOrderPanel();
    showActionMessage(`הזמנה ${body.id} נוצרה - ${body.droneId} בדרך לאיסוף`, 'success');
  } catch (err) {
    showActionMessage('שגיאה ביצירת הזמנה - אין חיבור לשרת', 'error', 5000);
    closeComposer();
  }
}

function showOrderPanel() {
  orderPanel.classList.add('open');
  orderTitleEl.textContent = activeOrder.id;
  orderActionBtn.style.display = 'none';
  updateOrderPanelText('to_pickup');
}

function updateOrderPanelText(droneStatus) {
  const texts = {
    to_pickup: 'הרחפן בדרך לנקודת האיסוף...',
    awaiting_pickup: 'הרחפן הגיע לנקודת האיסוף.',
    to_destination: 'הרחפן בדרך ליעד...',
    awaiting_delivery: 'הרחפן הגיע ליעד.',
    returning_home: 'ההזמנה הושלמה! הרחפן חוזר לבסיס.',
  };
  orderStatusTextEl.textContent = texts[droneStatus] || '';
}

let orderActionInFlight = false;

async function confirmPickup() {
  if (orderActionInFlight || !activeOrder) return;
  orderActionInFlight = true;
  try {
    const res = await fetch(`/orders/${activeOrder.id}/confirm-pickup`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json();
      showActionMessage(`שגיאה באישור איסוף: ${body.error}`, 'error');
      return;
    }
    activeOrder.status = 'in_transit';
    orderActionBtn.style.display = 'none';
    showActionMessage('איסוף אושר - הרחפן בדרך ליעד', 'success');
  } catch (err) {
    showActionMessage('שגיאה באישור איסוף - אין חיבור לשרת', 'error');
  } finally {
    orderActionInFlight = false;
  }
}

async function confirmDelivery() {
  if (orderActionInFlight || !activeOrder) return;
  orderActionInFlight = true;
  try {
    const res = await fetch(`/orders/${activeOrder.id}/confirm-delivery`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json();
      showActionMessage(`שגיאה באישור מסירה: ${body.error}`, 'error');
      return;
    }
    activeOrder.status = 'completed';
    orderActionBtn.style.display = 'none';
    showActionMessage('מסירה אושרה - הרחפן חוזר לבסיס', 'success');
  } catch (err) {
    showActionMessage('שגיאה באישור מסירה - אין חיבור לשרת', 'error');
  } finally {
    orderActionInFlight = false;
  }
}

function closeOrderPanel() {
  orderPanel.classList.remove('open');
  activeOrder = null;
  if (sourceMarker) {
    map.removeLayer(sourceMarker);
    sourceMarker = null;
  }
  if (destinationMarker) {
    map.removeLayer(destinationMarker);
    destinationMarker = null;
  }
}

// Reacts to the assigned drone's live status on every poll, since that's the
// only place that knows when the drone has actually arrived.
function reactToDroneStatus(drone) {
  if (!activeOrder || drone.id !== activeOrder.droneId) return;

  updateOrderPanelText(drone.status);

  if (drone.status === 'awaiting_pickup' && activeOrder.status === 'assigned') {
    orderActionBtn.textContent = 'אשר איסוף';
    orderActionBtn.onclick = confirmPickup;
    orderActionBtn.style.display = 'block';
  } else if (drone.status === 'to_destination') {
    orderActionBtn.style.display = 'none';
  } else if (drone.status === 'awaiting_delivery' && activeOrder.status === 'in_transit') {
    orderActionBtn.textContent = 'אשר מסירה';
    orderActionBtn.onclick = confirmDelivery;
    orderActionBtn.style.display = 'block';
  } else if (drone.status === 'returning_home' || drone.status === 'idle') {
    setTimeout(closeOrderPanel, 2500);
  }
}

// --- Map rendering: drone markers + in-place route lines (updated, not
// recreated, every poll - recreating them each tick is what caused the
// flicker/behavior bugs in the previous version) ---
function upsertDroneMarker(drone) {
  const color = STATUS_COLOR[drone.status] || '#64748b';
  const popupText = `${drone.id}<br/>סטטוס: ${STATUS_LABEL[drone.status] || drone.status}${drone.orderId ? `<br/>הזמנה: ${drone.orderId}` : ''}`;
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

async function pollDrones() {
  try {
    const res = await fetch('/drones');
    if (!res.ok) {
      setStatus(`שגיאה בטעינת רחפנים (${res.status})`);
      return;
    }
    const drones = await res.json();
    drones.forEach(upsertDroneMarker);
    drones.forEach(upsertRoute);
    drones.forEach(reactToDroneStatus);

    const busy = drones.filter((d) => d.status !== 'idle').length;
    setStatus(`${busy} רחפנים בפעולה מתוך ${drones.length}`);
  } catch (err) {
    setStatus('אין חיבור לשרת');
  }
}
setInterval(pollDrones, POLL_MS);
pollDrones();
