const ISRAEL_CENTER = [31.8, 34.9];
const POLL_MS = 1500;
const GPS_REPORT_MS = 3000;

const map = L.map('map').setView(ISRAEL_CENTER, 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const markers = new Map(); // vehicleId -> L.Marker

const newFlightBtn = document.getElementById('newFlightBtn');
const vehicleModeBtn = document.getElementById('vehicleModeBtn');
const statusEl = document.getElementById('status');

let awaitingDestinationClick = false;
let vehicleModeActive = false;
let watchId = null;
let gpsIntervalId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function altitudeColor(altitude) {
  if (altitude <= 100) return '#22c55e';
  if (altitude <= 200) return '#eab308';
  if (altitude <= 300) return '#f97316';
  return '#ef4444';
}

function upsertMarker(vehicle) {
  const popupText = `${vehicle.id}<br/>גובה: ${vehicle.altitude}מ'<br/>מהירות: ${vehicle.speed} קמ"ש<br/>מקור: ${vehicle.source}`;
  let marker = markers.get(vehicle.id);
  if (!marker) {
    marker = L.circleMarker([vehicle.lat, vehicle.lng], {
      radius: 7,
      color: altitudeColor(vehicle.altitude),
      fillColor: altitudeColor(vehicle.altitude),
      fillOpacity: 0.85,
    }).addTo(map);
    marker.bindPopup(popupText);
    markers.set(vehicle.id, marker);
  } else {
    marker.setLatLng([vehicle.lat, vehicle.lng]);
    marker.setStyle({ color: altitudeColor(vehicle.altitude), fillColor: altitudeColor(vehicle.altitude) });
    marker.setPopupContent(popupText);
  }
}

function pruneMarkers(currentIds) {
  for (const [id, marker] of markers) {
    if (!currentIds.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }
}

async function pollVehicles() {
  try {
    const res = await fetch('/vehicles');
    if (!res.ok) {
      setStatus(`שגיאה בטעינת רכבים (${res.status})`);
      return;
    }
    const vehicles = await res.json();
    const ids = new Set(vehicles.map((v) => v.id));
    vehicles.forEach(upsertMarker);
    pruneMarkers(ids);
    setStatus(`${vehicles.length} רכבים באוויר`);
  } catch (err) {
    setStatus('אין חיבור לשרת');
  }
}
setInterval(pollVehicles, POLL_MS);
pollVehicles();

newFlightBtn.addEventListener('click', () => {
  awaitingDestinationClick = !awaitingDestinationClick;
  newFlightBtn.classList.toggle('active', awaitingDestinationClick);
  setStatus(awaitingDestinationClick ? 'לחץ על נקודה במפה לקביעת יעד' : '');
});

map.on('click', async (e) => {
  if (!awaitingDestinationClick) return;
  awaitingDestinationClick = false;
  newFlightBtn.classList.remove('active');

  const to = { lat: e.latlng.lat, lng: e.latlng.lng };
  try {
    const res = await fetch('/flights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(`טיסה נדחתה: ${body.error}`);
      return;
    }
    setStatus(`טיסה חדשה נוצרה: ${body.id}`);
    pollVehicles();
  } catch (err) {
    setStatus('שגיאה ביצירת טיסה');
  }
});

function getVehicleId() {
  let id = localStorage.getItem('skylane_vehicle_id');
  if (!id) {
    id = `PHONE-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem('skylane_vehicle_id', id);
  }
  return id;
}

async function reportPosition(position) {
  const { latitude, longitude } = position.coords;
  try {
    await fetch('/gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicleId: getVehicleId(), lat: latitude, lng: longitude }),
    });
  } catch (err) {
    // ignore transient network errors from a moving phone
  }
}

vehicleModeBtn.addEventListener('click', () => {
  vehicleModeActive = !vehicleModeActive;
  vehicleModeBtn.classList.toggle('active', vehicleModeActive);

  if (vehicleModeActive) {
    if (!navigator.geolocation) {
      setStatus('הדפדפן לא תומך ב-GPS');
      vehicleModeActive = false;
      vehicleModeBtn.classList.remove('active');
      return;
    }
    watchId = navigator.geolocation.watchPosition(reportPosition, () => setStatus('שגיאת GPS'), {
      enableHighAccuracy: true,
    });
    gpsIntervalId = setInterval(() => {
      navigator.geolocation.getCurrentPosition(reportPosition);
    }, GPS_REPORT_MS);
    setStatus(`משדר מיקום בתור ${getVehicleId()}`);
  } else {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    if (gpsIntervalId !== null) clearInterval(gpsIntervalId);
    watchId = null;
    gpsIntervalId = null;
    setStatus('');
  }
});
