const API_BASE =
    window.CRH_API_BASE ||
    (
        window.location && window.location.hostname
            ? `${window.location.protocol}//${window.location.hostname}:8000`
            : "http://127.0.0.1:8000"
    );
const WS_BASE = API_BASE.replace(/^http/i, "ws");
const MAX_LOG_ITEMS = 250;
const RECONNECT_MS = 2500;
const ALERT_TONE_INTERVAL_MS = 420;
const ALERT_TONE_DEFAULT_BURSTS = 6;
const ALERT_TONE_URGENT_BURSTS = 12;
const GEOSEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const DESTINATION_COORDS = {
    "crh base": [18.5392, -72.3364],
    "hueh - hopital general": [18.5449, -72.3399],
    "hopital universitaire de mirebalais": [18.8347, -72.1044],
    "hopital bernard mevs": [18.5715, -72.3259],
    "hopital ofatma": [18.5571, -72.2986],
    "hopital la paix": [18.5985, -72.2264],
    "hopital saint damien": [18.5609, -72.2957]
};

const map = L.map("observerMap").setView([18.5392, -72.3364], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const activeVehicleList = document.getElementById("activeVehicleList");
const observerEventLog = document.getElementById("observerEventLog");
const activeTripsCount = document.getElementById("activeTripsCount");
const alertCount = document.getElementById("alertCount");
const lastEventAt = document.getElementById("lastEventAt");
const alertStack = document.getElementById("alertStack");
const weekStartDateInput = document.getElementById("weekStartDate");
const weeklyCoordinatorSignatureInput = document.getElementById("weeklyCoordinatorSignature");
const downloadWeeklyPdfBtn = document.getElementById("downloadWeeklyPdfBtn");

const trips = new Map();
let observerSocket = null;
let reconnectTimer = null;
let alertSocket = null;
let alertReconnectTimer = null;
let totalAlerts = 0;
let audioContext = null;
let alertToneTimer = null;
let remainingAlertBursts = 0;
const destinationGeocodeCache = new Map();
const destinationGeocodeInFlight = new Map();

const ambulanceIcon = L.divIcon({
    className: "crh-vehicle-icon-wrapper",
    html: '<div class="crh-vehicle-icon" aria-hidden="true"><span class="crh-vehicle-beacon"></span><span class="crh-vehicle-cross"></span></div>',
    iconSize: [34, 20],
    iconAnchor: [17, 10],
    popupAnchor: [0, -10]
});

loadActiveTrips();
connectObserverChannel();
connectAlertChannel();
ensureNotificationPermission();
initWeeklyReport();

async function loadActiveTrips() {
    try {
        const response = await fetch(`${API_BASE}/api/trips/active`);
        if (!response.ok) throw new Error("Impossible de charger les trajets actifs.");
        const activeTrips = await response.json();
        activeTrips.forEach((trip) => upsertTripBase(trip.trip_id, trip));
        redrawActiveVehicleList();
        refreshMetrics();
    } catch (error) {
        addLog(`ERREUR init: ${error.message}`);
    }
}

function upsertTripBase(tripId, trip = {}) {
    if (!trips.has(tripId)) {
        trips.set(tripId, {
            tripId,
            driverName: trip.driver_name || "Unknown",
            vehicleNumber: trip.vehicle_number || "-",
            origin: trip.origin || "-",
            destination: trip.destination || "-",
            passengerCount: Number.isFinite(trip.passenger_count) ? trip.passenger_count : 0,
            missionType: trip.mission_type || "STANDARD",
            victimReference: trip.victim_reference || "-",
            status: trip.status || "ACTIVE",
            marker: null,
            routeLine: null,
            destinationLine: null,
            destinationMarker: null,
            routePoints: [],
            currentHeading: 90,
            lastAlert: "-",
            destinationTargetLatLng: resolveDestinationLatLng(trip.destination)
        });
    } else if (trip.driver_name || trip.vehicle_number || trip.destination) {
        const model = trips.get(tripId);
        model.driverName = trip.driver_name || model.driverName;
        model.vehicleNumber = trip.vehicle_number || model.vehicleNumber;
        model.origin = trip.origin || model.origin;
        model.destination = trip.destination || model.destination;
        model.passengerCount = Number.isFinite(trip.passenger_count) ? trip.passenger_count : model.passengerCount;
        model.missionType = trip.mission_type || model.missionType;
        model.victimReference = trip.victim_reference || model.victimReference;
        model.status = trip.status || model.status;
        model.destinationTargetLatLng =
            resolveDestinationLatLng(model.destination) || model.destinationTargetLatLng;
        hydrateDestinationTarget(model);
    }
    const currentModel = trips.get(tripId);
    hydrateDestinationTarget(currentModel);
    return currentModel;
}

function normalizeDestinationKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function tryParseLatLng(value) {
    const match = String(value || "").trim().match(
        /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/
    );
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
}

function resolveDestinationLatLng(destination) {
    const parsed = tryParseLatLng(destination);
    if (parsed) return parsed;
    const key = normalizeDestinationKey(destination);
    return DESTINATION_COORDS[key] || null;
}

async function geocodeDestination(destination) {
    const key = normalizeDestinationKey(destination);
    if (!key) return null;

    if (destinationGeocodeCache.has(key)) {
        return destinationGeocodeCache.get(key);
    }

    if (destinationGeocodeInFlight.has(key)) {
        return destinationGeocodeInFlight.get(key);
    }

    const request = (async () => {
        try {
            const query = key.includes("haiti") ? destination : `${destination}, Haiti`;
            const url = `${GEOSEARCH_ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(query)}`;
            const response = await fetch(url, {
                headers: {
                    "Accept-Language": "ht,en"
                }
            });
            if (!response.ok) return null;
            const results = await response.json();
            const first = Array.isArray(results) ? results[0] : null;
            if (!first) return null;

            const lat = Number(first.lat);
            const lon = Number(first.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const latLng = [lat, lon];
            destinationGeocodeCache.set(key, latLng);
            return latLng;
        } catch {
            return null;
        } finally {
            destinationGeocodeInFlight.delete(key);
        }
    })();

    destinationGeocodeInFlight.set(key, request);
    return request;
}

function hydrateDestinationTarget(model) {
    if (!model || model.destinationTargetLatLng || !model.destination || model.destination === "-") {
        return;
    }
    geocodeDestination(model.destination).then((latLng) => {
        if (!latLng || !trips.has(model.tripId)) return;
        model.destinationTargetLatLng = latLng;
    });
}

function ensureNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
    }
}

function connectObserverChannel() {
    if (
        observerSocket &&
        (observerSocket.readyState === WebSocket.OPEN || observerSocket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    observerSocket = new WebSocket(`${WS_BASE}/ws/observers`);
    observerSocket.onopen = () => addLog("Tableau observateur connecté.");
    observerSocket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        handleEvent(message);
    };
    observerSocket.onclose = () => {
        addLog("Canal observateur déconnecté. Reconnexion...");
        scheduleReconnect();
    };
    observerSocket.onerror = () => observerSocket.close();
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectObserverChannel();
    }, RECONNECT_MS);
}

function connectAlertChannel() {
    if (
        alertSocket &&
        (alertSocket.readyState === WebSocket.OPEN || alertSocket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    alertSocket = new WebSocket(`${WS_BASE}/ws/observers/alerts`);
    alertSocket.onopen = () => addLog("Canal d alerte direct connecté.");
    alertSocket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        handleAlertSignal(message);
    };
    alertSocket.onclose = () => {
        addLog("Canal d alerte déconnecté. Reconnexion...");
        scheduleAlertReconnect();
    };
    alertSocket.onerror = () => alertSocket.close();
}

function scheduleAlertReconnect() {
    if (alertReconnectTimer) return;
    alertReconnectTimer = window.setTimeout(() => {
        alertReconnectTimer = null;
        connectAlertChannel();
    }, RECONNECT_MS);
}

function handleEvent(message) {
    if (!message || !message.trip_id || !message.type) return;
    const tripId = message.trip_id;
    const payload = message.payload || {};
    const model = upsertTripBase(tripId, message);

    switch (message.type) {
        case "TRIP_STARTED":
            model.status = "ACTIVE";
            model.passengerCount = Number.isFinite(payload.passenger_count) ? payload.passenger_count : model.passengerCount;
            model.missionType = payload.mission_type || model.missionType;
            model.victimReference = payload.victim_reference || model.victimReference;
            addLog(
                `Trajet démarré: ${model.driverName} (${tripId})` +
                `${model.missionType === "AMBULANCE" ? " [MISSION AMBULANCE]" : ""}`
            );
            break;
        case "LOCATION":
            if (Number.isFinite(payload.latitude) && Number.isFinite(payload.longitude)) {
                updateTripLocation(model, payload.latitude, payload.longitude);
            }
            break;
        case "PASSENGER_UPDATE":
            model.passengerCount = Number.isFinite(payload.passenger_count) ? payload.passenger_count : model.passengerCount;
            addLog(`Passagers mis à jour (${tripId}): ${model.passengerCount}`);
            break;
        case "ALERT":
            model.lastAlert = payload.alert_type || "UNKNOWN";
            break;
        case "TRIP_FINISHED":
            model.status = "FINISHED";
            addLog(`Trajet terminé (${tripId})`);
            removeTripFromMap(model);
            trips.delete(tripId);
            break;
        default:
            break;
    }

    redrawActiveVehicleList();
    refreshMetrics();
}

function handleAlertSignal(message) {
    if (!message || message.type !== "ALERT" || !message.trip_id) return;
    const tripId = message.trip_id;
    const payload = message.payload || {};
    const model = upsertTripBase(tripId, message);
    model.lastAlert = payload.alert_type || "UNKNOWN";
    const isUrgentAlert = ["ACCIDENT", "ATTACK", "EMERGENCY", "MAYDAY"].includes(model.lastAlert);

    totalAlerts += 1;
    addLog(`ALERTE DIRECTE (${tripId}): ${model.lastAlert}`);
    showAlertPopup(model);
    pushBrowserNotification(model);
    playAlertTone(isUrgentAlert ? ALERT_TONE_URGENT_BURSTS : ALERT_TONE_DEFAULT_BURSTS);

    redrawActiveVehicleList();
    refreshMetrics();
}

function showAlertPopup(model) {
    if (!alertStack) return;
    const item = document.createElement("article");
    item.className = "alert-popup";
    item.innerHTML =
        `<button type="button" class="alert-popup-close" aria-label="Fermer">x</button>` +
        `<p class="alert-popup-title">ALERT ${escapeHtml(model.lastAlert)}</p>` +
        `<p class="alert-popup-body">${escapeHtml(model.driverName)} | ${escapeHtml(model.vehicleNumber)}</p>` +
        `<p class="alert-popup-body">Trip: ${escapeHtml(model.tripId)} | Dest: ${escapeHtml(model.destination)}</p>`;

    const removeItem = () => {
        item.classList.add("alert-popup-out");
        window.setTimeout(() => item.remove(), 240);
    };

    const closeBtn = item.querySelector(".alert-popup-close");
    if (closeBtn) {
        closeBtn.addEventListener("click", removeItem);
    }

    alertStack.prepend(item);
    window.setTimeout(removeItem, 12000);
}

function pushBrowserNotification(model) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = `CRH ALERT: ${model.lastAlert}`;
    const body = `${model.driverName} (${model.vehicleNumber}) -> ${model.destination}`;
    try {
        const notification = new Notification(title, { body });
        window.setTimeout(() => notification.close(), 9000);
    } catch {
        // Ignore notification errors on restricted browsers.
    }
}

function initWeeklyReport() {
    if (!weekStartDateInput) return;

    weekStartDateInput.value = getCurrentWeekMondayISO();
    loadWeeklyDraft();

    weekStartDateInput.addEventListener("change", loadWeeklyDraft);
    weeklyCoordinatorSignatureInput?.addEventListener("input", saveWeeklyDraft);
    getWeeklyInputIds().forEach((id) => {
        const input = document.getElementById(id);
        input?.addEventListener("input", saveWeeklyDraft);
    });
    downloadWeeklyPdfBtn?.addEventListener("click", generateWeeklyPdfReport);
}

function getCurrentWeekMondayISO() {
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    now.setDate(now.getDate() + diffToMonday);
    return now.toISOString().slice(0, 10);
}

function getWeekStorageKey() {
    return `crh_weekly_report_${weekStartDateInput?.value || "unknown"}`;
}

function getWeeklyInputIds() {
    return [
        "obs_mon", "sig_mon",
        "obs_tue", "sig_tue",
        "obs_wed", "sig_wed",
        "obs_thu", "sig_thu",
        "obs_fri", "sig_fri",
        "obs_sat", "sig_sat",
        "obs_sun", "sig_sun"
    ];
}

function saveWeeklyDraft() {
    if (!weekStartDateInput) return;
    const payload = {
        week_start: weekStartDateInput.value,
        coordinator_signature: weeklyCoordinatorSignatureInput?.value || ""
    };
    getWeeklyInputIds().forEach((id) => {
        payload[id] = document.getElementById(id)?.value || "";
    });
    localStorage.setItem(getWeekStorageKey(), JSON.stringify(payload));
}

function loadWeeklyDraft() {
    if (!weekStartDateInput) return;
    getWeeklyInputIds().forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.value = "";
    });
    if (weeklyCoordinatorSignatureInput) {
        weeklyCoordinatorSignatureInput.value = "";
    }

    const raw = localStorage.getItem(getWeekStorageKey());
    if (!raw) return;
    try {
        const payload = JSON.parse(raw);
        getWeeklyInputIds().forEach((id) => {
            const input = document.getElementById(id);
            if (input) input.value = payload[id] || "";
        });
        if (weeklyCoordinatorSignatureInput) {
            weeklyCoordinatorSignatureInput.value = payload.coordinator_signature || "";
        }
    } catch {
        // Ignore invalid draft payload.
    }
}

async function generateWeeklyPdfReport() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
        addLog("PDF tool pa disponib. Verifye koneksyon entènèt la.");
        return;
    }

    saveWeeklyDraft();

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const weekStart = weekStartDateInput?.value || "-";
    const weekEnd = getWeekEndFromMonday(weekStart);
    const generatedAt = new Date().toLocaleString();
    const weeklyTripReport = await fetchWeeklyTripReport(weekStart);

    const rows = [
        ["Lendi", valueOf("obs_mon"), valueOf("sig_mon")],
        ["Madi", valueOf("obs_tue"), valueOf("sig_tue")],
        ["Mekredi", valueOf("obs_wed"), valueOf("sig_wed")],
        ["Jedi", valueOf("obs_thu"), valueOf("sig_thu")],
        ["Vandredi", valueOf("obs_fri"), valueOf("sig_fri")],
        ["Samdi", valueOf("obs_sat"), valueOf("sig_sat")],
        ["Dimanch", valueOf("obs_sun"), valueOf("sig_sun")]
    ];

    let contentTop = 16;
    try {
        const logoDataUrl = await loadImageAsDataUrl("assets/logo-crh.jpg");
        doc.addImage(logoDataUrl, "JPEG", 14, 10, 16, 16);
        contentTop = 30;
    } catch {
        // If logo fails to load, continue without blocking report generation.
        contentTop = 16;
    }

    doc.setFontSize(14);
    doc.text("CRH - Rapo Hebdomade Observateur", 34, contentTop);
    doc.setFontSize(10);
    doc.text(`Semaine: ${weekStart} à ${weekEnd}`, 14, contentTop + 8);
    doc.text(`Généré: ${generatedAt}`, 14, contentTop + 14);
    doc.text(`Total alertes (session): ${totalAlerts}`, 14, contentTop + 20);
    doc.text(`Trajets actifs actuellement: ${trips.size}`, 14, contentTop + 26);

    let y = contentTop + 36;
    doc.setFontSize(11);
    doc.text("Jour", 14, y);
    doc.text("Observateur", 54, y);
    doc.text("Signature", 150, y);
    y += 3;
    doc.line(14, y, 196, y);
    y += 6;

    doc.setFontSize(10);
    rows.forEach((row) => {
        doc.text(row[0], 14, y);
        doc.text(limit(row[1], 42), 54, y);
        doc.text(limit(row[2], 28), 150, y);
        y += 9;
    });

    y += 6;
    doc.text("Signature coordinateur semaine:", 14, y);
    doc.line(60, y + 0.5, 160, y + 0.5);
    doc.text(
        limit(weeklyCoordinatorSignatureInput?.value || "-", 40),
        62,
        y
    );

    doc.addPage();
    let dy = 16;
    doc.setFontSize(13);
    doc.text("Détails des trajets effectués dans la semaine", 14, dy);
    dy += 7;
    doc.setFontSize(10);
    doc.text(`Semaine: ${weekStart} à ${weekEnd}`, 14, dy);
    dy += 6;

    if (!weeklyTripReport || !Array.isArray(weeklyTripReport.trips) || weeklyTripReport.trips.length === 0) {
        doc.text("Aucune donnée de trajet pour cette semaine.", 14, dy);
    } else {
        doc.text(
            `Total: ${weeklyTripReport.total_trips} | Alertes: ${weeklyTripReport.total_alert_actions} | ` +
            `Ambulance: ${weeklyTripReport.ambulance_missions} | Standard: ${weeklyTripReport.standard_missions}`,
            14,
            dy
        );
        dy += 8;

        weeklyTripReport.trips.forEach((trip, index) => {
            if (dy > 266) {
                doc.addPage();
                dy = 14;
            }

            const startAt = formatDateTime(trip.created_at);
            const endAt = formatDateTime(trip.finished_at);
            const alerts = Array.isArray(trip.alert_actions) && trip.alert_actions.length
                ? trip.alert_actions.join(", ")
                : "Aucune";
            const missionTag = trip.mission_type === "AMBULANCE" ? "Wi" : "Non";

            doc.setFontSize(10);
            doc.text(`${index + 1}. ${limit(trip.driver_name || "-", 60)} | ${limit(trip.vehicle_number || "-", 20)}`, 14, dy);
            dy += 5;
            doc.setFontSize(9);
            doc.text(`Trip ID: ${limit(trip.trip_id || "-", 64)}`, 16, dy);
            dy += 4.6;
            doc.text(`Soti: ${limit(trip.origin || "-", 60)}  ->  Ale: ${limit(trip.destination || "-", 60)}`, 16, dy);
            dy += 4.6;
            doc.text(`Dat/Lè demaraj: ${startAt} | Fini: ${endAt}`, 16, dy);
            dy += 4.6;
            doc.text(`Mission ambulance: ${missionTag} | Réf victime: ${limit(trip.victim_reference || "-", 34)}`, 16, dy);
            dy += 4.6;
            doc.text(
                `Passagers: ${trip.passenger_count ?? "-"} | ` +
                `Actions de sécurité: ${alerts} | GPS updates: ${trip.location_updates ?? 0}`,
                16,
                dy
            );
            dy += 6.2;
            doc.line(14, dy - 1.8, 196, dy - 1.8);
            dy += 2;
        });
    }

    const filename = `rapo_hebdo_${weekStart || "unknown"}.pdf`;
    doc.save(filename);
    addLog(`PDF téléchargé: ${filename}`);
}

async function loadImageAsDataUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                reject(new Error("Canvas context unavailable"));
                return;
            }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/jpeg", 0.92));
        };
        img.onerror = () => reject(new Error(`Cannot load image: ${url}`));
        img.src = url;
    });
}

function getWeekEndFromMonday(weekStartIso) {
    const d = new Date(weekStartIso);
    if (Number.isNaN(d.getTime())) return "-";
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
}

function valueOf(id) {
    return document.getElementById(id)?.value?.trim() || "-";
}

function limit(value, max) {
    const v = String(value || "");
    return v.length <= max ? v : `${v.slice(0, max - 1)}...`;
}

async function fetchWeeklyTripReport(weekStart) {
    if (!weekStart || weekStart === "-") return null;
    try {
        const response = await fetch(`${API_BASE}/api/reports/weekly?week_start=${encodeURIComponent(weekStart)}`);
        if (!response.ok) throw new Error(`weekly report failed (${response.status})`);
        return await response.json();
    } catch (error) {
        addLog(`ERREUR rapport hebdo backend: ${error.message}`);
        return null;
    }
}

function formatDateTime(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString();
}

function updateTripLocation(model, latitude, longitude) {
    const latLng = [latitude, longitude];
    const previousPoint = model.routePoints.length ? model.routePoints[model.routePoints.length - 1] : null;

    if (!model.marker) {
        model.marker = L.marker(latLng, { icon: ambulanceIcon }).addTo(map);
    } else {
        model.marker.setLatLng(latLng);
    }

    if (model.destinationTargetLatLng && hasMeaningfulMovement(latLng, model.destinationTargetLatLng)) {
        model.currentHeading = getBearing(latLng, model.destinationTargetLatLng);
    } else if (previousPoint && hasMeaningfulMovement(previousPoint, latLng)) {
        model.currentHeading = getBearing(previousPoint, latLng);
    }
    applyVehicleHeading(model.marker, model.currentHeading);

    model.routePoints.push(latLng);
    if (model.routeLine) {
        model.routeLine.setLatLngs(model.routePoints);
    } else {
        model.routeLine = L.polyline(model.routePoints, { color: "#0f6bce", weight: 4 }).addTo(map);
    }

    if (model.destinationTargetLatLng) {
        if (!model.destinationLine) {
            model.destinationLine = L.polyline([latLng, model.destinationTargetLatLng], {
                color: "#c7162b",
                weight: 3,
                opacity: 0.9,
                dashArray: "10 8"
            }).addTo(map);
        } else {
            model.destinationLine.setLatLngs([latLng, model.destinationTargetLatLng]);
        }

        if (!model.destinationMarker) {
            model.destinationMarker = L.circleMarker(model.destinationTargetLatLng, {
                radius: 7,
                color: "#c7162b",
                weight: 2,
                fillColor: "#ffdee3",
                fillOpacity: 0.95
            })
                .addTo(map)
                .bindPopup(`Destination: ${escapeHtml(model.destination)}`);
        } else {
            model.destinationMarker.setLatLng(model.destinationTargetLatLng);
        }
    }

    model.marker.bindPopup(
        `<strong>${escapeHtml(model.driverName)}</strong><br>` +
        `Véhicule: ${escapeHtml(model.vehicleNumber)}<br>` +
        `Mission: ${escapeHtml(model.missionType)}<br>` +
        `Victime: ${escapeHtml(model.victimReference)}<br>` +
        `Destination: ${escapeHtml(model.destination)}`
    );
}

function redrawActiveVehicleList() {
    const sorted = [...trips.values()].sort((a, b) => a.vehicleNumber.localeCompare(b.vehicleNumber));
    if (!sorted.length) {
        activeVehicleList.innerHTML = '<p class="empty">Aucun véhicule actif sur la route actuellement.</p>';
        return;
    }

    activeVehicleList.innerHTML = sorted
        .map((trip) => {
            const alertValue = trip.lastAlert && trip.lastAlert !== "-" ? trip.lastAlert : "Aucune";
            return `<article class="vehicle-row">
                <span>${escapeHtml(trip.driverName)}</span>
                <span>${escapeHtml(trip.vehicleNumber)}</span>
                <span>${escapeHtml(trip.tripId)}</span>
                <span>${escapeHtml(trip.destination)}</span>
                <span>${trip.passengerCount}</span>
                <span>${escapeHtml(alertValue)}</span>
            </article>`;
        })
        .join("");
}

function refreshMetrics() {
    activeTripsCount.textContent = `${trips.size}`;
    alertCount.textContent = `${totalAlerts}`;
    lastEventAt.textContent = new Date().toLocaleTimeString();
}

function removeTripFromMap(model) {
    if (model.marker) {
        map.removeLayer(model.marker);
    }
    if (model.routeLine) {
        map.removeLayer(model.routeLine);
    }
    if (model.destinationLine) {
        map.removeLayer(model.destinationLine);
    }
    if (model.destinationMarker) {
        map.removeLayer(model.destinationMarker);
    }
}

function addLog(message) {
    const timestamp = new Date().toLocaleString();
    const item = document.createElement("li");
    item.textContent = `[${timestamp}] ${message}`;
    observerEventLog.prepend(item);
    while (observerEventLog.children.length > MAX_LOG_ITEMS) {
        observerEventLog.removeChild(observerEventLog.lastElementChild);
    }
}

function applyVehicleHeading(marker, heading) {
    if (!marker) return;
    const markerElement = marker.getElement();
    if (!markerElement) return;
    const vehicleElement = markerElement.querySelector(".crh-vehicle-icon");
    if (!vehicleElement) return;
    const normalizedHeading = Number.isFinite(heading) ? heading : 90;
    const rotation = normalizedHeading - 90;
    vehicleElement.style.transform = `rotate(${rotation.toFixed(1)}deg)`;
}

function hasMeaningfulMovement(from, to) {
    return Math.abs(from[0] - to[0]) > 0.00001 || Math.abs(from[1] - to[1]) > 0.00001;
}

function getBearing(from, to) {
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const toDegrees = (radians) => (radians * 180) / Math.PI;
    const lat1 = toRadians(from[0]);
    const lat2 = toRadians(to[0]);
    const deltaLon = toRadians(to[1] - from[1]);
    const y = Math.sin(deltaLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
    return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function playAlertTone(bursts = ALERT_TONE_DEFAULT_BURSTS) {
    const context = getAudioContext();
    if (!context) return;

    if (alertToneTimer) {
        window.clearInterval(alertToneTimer);
        alertToneTimer = null;
    }

    remainingAlertBursts = Math.max(1, bursts);
    emitAlertBeep(context);
    remainingAlertBursts -= 1;
    if (remainingAlertBursts <= 0) return;

    alertToneTimer = window.setInterval(() => {
        emitAlertBeep(context);
        remainingAlertBursts -= 1;
        if (remainingAlertBursts <= 0 && alertToneTimer) {
            window.clearInterval(alertToneTimer);
            alertToneTimer = null;
        }
    }, ALERT_TONE_INTERVAL_MS);
}

function getAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioContext) {
        audioContext = new AudioCtx();
    }
    if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
    }
    return audioContext;
}

function emitAlertBeep(context) {
    const start = context.currentTime;
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(880, start);
    oscillator.frequency.linearRampToValueAtTime(1040, start + 0.12);
    gainNode.gain.setValueAtTime(0.001, start);
    gainNode.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.22);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}


