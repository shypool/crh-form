const API_BASE =
    window.CRH_API_BASE ||
    (
        window.location && window.location.hostname
            ? `${window.location.protocol}//${window.location.hostname}:8000`
            : "http://127.0.0.1:8000"
    );
const WS_BASE = API_BASE.replace(/^http/i, "ws");
const MAX_LOG_ITEMS = 200;
const OBSERVER_RECONNECT_MS = 2500;
const ALERT_TONE_INTERVAL_MS = 420;
const ALERT_TONE_DEFAULT_BURSTS = 6;
const ALERT_TONE_URGENT_BURSTS = 12;
const GEOSEARCH_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const DEFAULT_TRIP_STATUS = "Aucun trajet actif.";
const DEFAULT_AMBULANCE_STATUS = "Aucune mission ambulance active.";
const AMBULANCE_FLOW = Object.freeze({
    BASE_TO_FIXED: "BASE_TO_FIXED",
    FIXED_TO_HOSPITAL: "FIXED_TO_HOSPITAL",
    HOSPITAL_TO_FIXED: "HOSPITAL_TO_FIXED"
});
const DEFAULT_DRIVER_OPTIONS = [
    "Jean Michel",
    "Rose Marie",
    "Samuel Pierre",
    "David Louis"
];
const DEFAULT_FIELD_VEHICLE_OPTIONS = [
    "MOB-01",
    "MOB-02",
    "MOB-03",
    "MOB-04"
];
const DEFAULT_AMBULANCE_VEHICLE_OPTIONS = [
    "AMB-01",
    "AMB-02",
    "AMB-03",
    "AMB-04"
];
const ADMIN_ACCESS_SESSION_KEY = "crh_admin_access_unlocked";
const ADMIN_PASSWORD_SESSION_KEY = "crh_admin_password_value";
const HOSPITAL_OPTIONS = [
    "HUEH - Hopital General",
    "Hopital Universitaire de Mirebalais",
    "Hopital Bernard Mevs",
    "Hopital OFATMA",
    "Hopital La Paix",
    "Hopital Saint Damien"
];
const DESTINATION_COORDS = {
    "crh base": [18.5392, -72.3364],
    "hueh - hopital general": [18.5449, -72.3399],
    "hopital universitaire de mirebalais": [18.8347, -72.1044],
    "hopital bernard mevs": [18.5715, -72.3259],
    "hopital ofatma": [18.5571, -72.2986],
    "hopital la paix": [18.5985, -72.2264],
    "hopital saint damien": [18.5609, -72.2957]
};

const map = L.map("map").setView([18.5392, -72.3364], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let driverMarker = null;
let destinationMarker = null;
let routeLine = null;
let routePoints = [];
let activeTripId = null;
let watcherId = null;
let observerSocket = null;
let reconnectTimer = null;
let currentHeading = 90;
let audioContext = null;
let alertToneTimer = null;
let remainingAlertBursts = 0;
let activeTripMode = null;
let activeAmbulanceMissionType = null;
let ambulanceFlowStep = AMBULANCE_FLOW.BASE_TO_FIXED;
let destinationTargetLatLng = null;
const destinationGeocodeCache = new Map();
const destinationGeocodeInFlight = new Map();
let DRIVER_OPTIONS = [...DEFAULT_DRIVER_OPTIONS];
let FIELD_VEHICLE_OPTIONS = [...DEFAULT_FIELD_VEHICLE_OPTIONS];
let AMBULANCE_VEHICLE_OPTIONS = [...DEFAULT_AMBULANCE_VEHICLE_OPTIONS];
let adminSessionPassword = sessionStorage.getItem(ADMIN_PASSWORD_SESSION_KEY) || "";

const localTripIds = new Set();
const ambulanceIcon = L.divIcon({
    className: "crh-vehicle-icon-wrapper",
    html: '<div class="crh-vehicle-icon" aria-hidden="true"><span class="crh-vehicle-beacon"></span><span class="crh-vehicle-cross"></span></div>',
    iconSize: [34, 20],
    iconAnchor: [17, 10],
    popupAnchor: [0, -10]
});

const tripForm = document.getElementById("tripForm");
const tripStatus = document.getElementById("tripStatus");
const ambulanceTripForm = document.getElementById("ambulanceTripForm");
const ambulanceTripStatus = document.getElementById("ambulanceTripStatus");
const ambulanceSubmitBtn = ambulanceTripForm.querySelector('button[type="submit"]');
const adminDriverForm = document.getElementById("adminDriverForm");
const adminDriverInput = document.getElementById("adminDriverInput");
const adminFieldVehicleForm = document.getElementById("adminFieldVehicleForm");
const adminFieldVehicleInput = document.getElementById("adminFieldVehicleInput");
const adminAmbulanceForm = document.getElementById("adminAmbulanceForm");
const adminAmbulanceInput = document.getElementById("adminAmbulanceInput");
const adminDriverList = document.getElementById("adminDriverList");
const adminFieldVehicleList = document.getElementById("adminFieldVehicleList");
const adminAmbulanceList = document.getElementById("adminAmbulanceList");
const adminAccessForm = document.getElementById("adminAccessForm");
const adminPasswordInput = document.getElementById("adminPasswordInput");
const adminAccessMessage = document.getElementById("adminAccessMessage");
const adminLockPanel = document.getElementById("adminLockPanel");
const adminContent = document.getElementById("adminContent");
const adminLockBtn = document.getElementById("adminLockBtn");
const driverNameInput = document.getElementById("driverName");
const vehicleNumberInput = document.getElementById("vehicleNumber");
const ambulanceDriverNameInput = document.getElementById("ambulanceDriverName");
const ambulanceVehicleNumberInput = document.getElementById("ambulanceVehicleNumber");
const eventLog = document.getElementById("eventLog");
const passengerCountInput = document.getElementById("passengerCount");
const pickupTypeInput = document.getElementById("pickupType");
const fixedPointField = document.getElementById("fixedPointField");
const fixedPointNameInput = document.getElementById("fixedPointName");
const victimReferenceInput = document.getElementById("victimReference");
const victimCountInput = document.getElementById("victimCount");
const hospitalDestinationInput = document.getElementById("hospitalDestination");
const arrivedHospitalBtn = document.getElementById("arrivedHospitalBtn");
const finishTripBtn = document.getElementById("finishTripBtn");
const updatePassengersBtn = document.getElementById("updatePassengersBtn");
const alertButtons = document.querySelectorAll("button[data-alert]");
const destinationStatus = document.getElementById("destinationStatus");
const driverAlertStack = document.getElementById("driverAlertStack");

function hasActiveTrip(actionLabel) {
    if (activeTripId) return true;
    addLog(`L action "${actionLabel}" nécessite un trajet actif.`);
    return false;
}

function setDestinationStatus(message, variant = "neutral") {
    if (!destinationStatus) return;
    destinationStatus.textContent = message;
    destinationStatus.classList.remove("is-ok", "is-warn", "is-neutral");
    destinationStatus.classList.add(
        variant === "ok" ? "is-ok" : variant === "warn" ? "is-warn" : "is-neutral"
    );
}

function setAdminAccessState(isUnlocked, message = "") {
    if (adminLockPanel) {
        adminLockPanel.classList.toggle("hidden", isUnlocked);
    }
    if (adminContent) {
        adminContent.classList.toggle("hidden", !isUnlocked);
    }
    if (adminAccessMessage) {
        adminAccessMessage.textContent = message || (isUnlocked ? "Section admin déverrouillée." : "Section verrouillée.");
    }
    if (adminPasswordInput && isUnlocked) {
        adminPasswordInput.value = "";
    }
}

async function unlockAdminSection(password) {
    const submittedPassword = String(password || "").trim();
    if (!submittedPassword) {
        setAdminAccessState(false, "Mot de passe requis.");
        return false;
    }

    try {
        const response = await fetch(`${API_BASE}/api/admin/auth`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: submittedPassword })
        });
        if (!response.ok) {
            setAdminAccessState(false, "Mot de passe invalide.");
            return false;
        }
        adminSessionPassword = submittedPassword;
        sessionStorage.setItem(ADMIN_ACCESS_SESSION_KEY, "1");
        sessionStorage.setItem(ADMIN_PASSWORD_SESSION_KEY, submittedPassword);
        setAdminAccessState(true, "Section admin déverrouillée.");
        addLog("ADMIN: section déverrouillée.");
        return true;
    } catch {
        setAdminAccessState(false, "API admin indisponible.");
        return false;
    }
}

function lockAdminSection() {
    adminSessionPassword = "";
    sessionStorage.removeItem(ADMIN_ACCESS_SESSION_KEY);
    sessionStorage.removeItem(ADMIN_PASSWORD_SESSION_KEY);
    setAdminAccessState(false, "Section verrouillée.");
    addLog("ADMIN: section verrouillée.");
}

async function initializeCatalogsAndAdmin() {
    await loadCatalogsFromApi();
    if (adminSessionPassword) {
        const restored = await unlockAdminSection(adminSessionPassword);
        if (!restored) {
            lockAdminSection();
        }
    } else {
        setAdminAccessState(false, "Section verrouillée.");
    }
}

setControls(false);
setTripFormsDisabled(false);
populateHospitalOptions();
bindAdminEvents();
connectObserverChannel();
toggleFixedPointField();
setDestinationStatus("Destination non définie.", "neutral");
syncAmbulanceFlowUi();

adminAccessForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await unlockAdminSection(adminPasswordInput?.value || "");
});

adminLockBtn?.addEventListener("click", () => {
    lockAdminSection();
});

initializeCatalogsAndAdmin();

tripForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const payload = {
        driver_name: driverNameInput.value.trim(),
        vehicle_number: vehicleNumberInput.value.trim(),
        origin: document.getElementById("origin").value.trim(),
        destination: document.getElementById("destination").value.trim(),
        passenger_count: Number(passengerCountInput.value),
        mission_type: "STANDARD"
    };

    await startTrip(payload, {
        statusMessage: `Trajet actif: ${payload.origin} -> ${payload.destination}`
    });
});

ambulanceTripForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fixedPoint = fixedPointNameInput.value.trim();
    const victimReference = victimReferenceInput.value.trim();
    const hospital = hospitalDestinationInput.value.trim();
    const victimCount = Number(victimCountInput.value);
    const commonFields = {
        driver_name: ambulanceDriverNameInput.value.trim(),
        vehicle_number: ambulanceVehicleNumberInput.value.trim(),
        victim_reference: victimReference || null
    };
    let payload = null;
    let statusMessage = "";

    if (!fixedPoint) {
        addLog("ERREUR: Indiquez le nom du point fixe.");
        fixedPointNameInput.focus();
        return;
    }

    if (ambulanceFlowStep === AMBULANCE_FLOW.BASE_TO_FIXED) {
        payload = {
            ...commonFields,
            origin: "CRH Base",
            destination: fixedPoint,
            passenger_count: 0,
            mission_type: "AMBULANCE_BASE_TO_FIXED"
        };
        statusMessage = `Mission ambulance active: CRH Base -> ${fixedPoint}`;
    } else if (ambulanceFlowStep === AMBULANCE_FLOW.FIXED_TO_HOSPITAL) {
        if (!hospital || !Number.isFinite(victimCount) || victimCount < 1) {
            addLog("ERREUR: Choisissez l'hôpital et une quantité valide de victimes.");
            return;
        }
        payload = {
            ...commonFields,
            origin: fixedPoint,
            destination: hospital,
            passenger_count: victimCount,
            mission_type: "AMBULANCE_FIXED_TO_HOSPITAL"
        };
        statusMessage = `Mission ambulance active: ${fixedPoint} -> ${hospital}`;
    } else if (ambulanceFlowStep === AMBULANCE_FLOW.HOSPITAL_TO_FIXED) {
        if (!hospital) {
            addLog("ERREUR: Choisissez l'hôpital avant le retour.");
            return;
        }
        payload = {
            ...commonFields,
            origin: hospital,
            destination: fixedPoint,
            passenger_count: 0,
            mission_type: "AMBULANCE_HOSPITAL_TO_FIXED"
        };
        statusMessage = `Mission ambulance active: ${hospital} -> ${fixedPoint}`;
    }

    if (!payload) return;

    await startTrip(payload, {
        isAmbulanceMission: true,
        statusMessage,
        victimReference
    });
});

arrivedHospitalBtn.addEventListener("click", async () => {
    if (!hasActiveTrip("Arrivée hôpital")) return;
    if (activeTripMode !== "AMBULANCE" || activeAmbulanceMissionType !== "AMBULANCE_FIXED_TO_HOSPITAL") {
        addLog("Cette action est disponible uniquement pour les missions ambulance.");
        return;
    }

    const completedMissionType = activeAmbulanceMissionType;
    try {
        const response = await fetch(`${API_BASE}/api/trips/${activeTripId}/finish`, { method: "POST" });
        if (!response.ok) throw new Error("Impossible de terminer la mission ambulance.");
        addLog(`AMBULANCE ARRIVÉE HÔPITAL: ${activeTripId}`);
        resetTripState({ completedMissionType });
    } catch (error) {
        addLog(`ERREUR arrivée hôpital: ${error.message}`);
    }
});

alertButtons.forEach((button) => {
    button.addEventListener("click", async () => {
        if (!hasActiveTrip(button.textContent.trim())) return;

        const alertType = button.dataset.alert;
        try {
            const response = await fetch(`${API_BASE}/api/trips/${activeTripId}/alert`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ alert_type: alertType })
            });
            if (!response.ok) throw new Error("Alerte pa pase.");
            addLog(`ALERTE ENVOYÉE: ${alertType}`);
            showDriverAlertPopup(alertType);
            playAlertTone(alertType === "ACCIDENT" ? ALERT_TONE_URGENT_BURSTS : ALERT_TONE_DEFAULT_BURSTS);
        } catch (error) {
            addLog(`ERREUR alerte: ${error.message}`);
        }
    });
});

updatePassengersBtn.addEventListener("click", async () => {
    if (!hasActiveTrip("Mettre à jour passagers")) return;

    const passengerCount =
        activeTripMode === "AMBULANCE"
            ? Number(victimCountInput.value)
            : Number(passengerCountInput.value);

    try {
        const response = await fetch(`${API_BASE}/api/trips/${activeTripId}/passengers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passenger_count: passengerCount })
        });
        if (!response.ok) throw new Error("Ajou pasaje echwe.");
        addLog(`Nombre passagers/victimes: ${passengerCount}`);
    } catch (error) {
        addLog(`ERREUR passagers: ${error.message}`);
    }
});

finishTripBtn.addEventListener("click", async () => {
    if (!hasActiveTrip("Terminer trajet")) return;
    if (activeTripMode === "AMBULANCE" && activeAmbulanceMissionType === "AMBULANCE_FIXED_TO_HOSPITAL") {
        addLog("Pou etap sa a, sèvi ak bouton 'Arrivé à l'hôpital'.");
        return;
    }

    const completedMissionType = activeAmbulanceMissionType;
    try {
        const response = await fetch(`${API_BASE}/api/trips/${activeTripId}/finish`, { method: "POST" });
        if (!response.ok) throw new Error("Terminer trajet echwe.");
        addLog(`Trajet terminé: ${activeTripId}`);
        resetTripState({ completedMissionType });
    } catch (error) {
        addLog(`ERREUR fin trajet: ${error.message}`);
    }
});

function setControls(isActive) {
    const isAmbulanceToHospital = isActive && activeAmbulanceMissionType === "AMBULANCE_FIXED_TO_HOSPITAL";
    finishTripBtn.disabled = !isActive || isAmbulanceToHospital;
    updatePassengersBtn.disabled = !isActive;
    arrivedHospitalBtn.disabled = !isAmbulanceToHospital;
    alertButtons.forEach((button) => {
        button.disabled = !isActive;
    });
}

function normalizeCatalogValue(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ");
}

function toUniqueCatalog(values) {
    const output = [];
    const seen = new Set();
    values.forEach((item) => {
        const normalized = normalizeCatalogValue(item);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        output.push(normalized);
    });
    return output;
}

function applyCatalogPayload(payload = {}) {
    const drivers = Array.isArray(payload.drivers) ? payload.drivers : DEFAULT_DRIVER_OPTIONS;
    const fieldVehicles = Array.isArray(payload.field_vehicles)
        ? payload.field_vehicles
        : DEFAULT_FIELD_VEHICLE_OPTIONS;
    const ambulances = Array.isArray(payload.ambulances)
        ? payload.ambulances
        : DEFAULT_AMBULANCE_VEHICLE_OPTIONS;

    DRIVER_OPTIONS = toUniqueCatalog(drivers);
    FIELD_VEHICLE_OPTIONS = toUniqueCatalog(fieldVehicles);
    AMBULANCE_VEHICLE_OPTIONS = toUniqueCatalog(ambulances);

    if (!DRIVER_OPTIONS.length) DRIVER_OPTIONS = [...DEFAULT_DRIVER_OPTIONS];
    if (!FIELD_VEHICLE_OPTIONS.length) FIELD_VEHICLE_OPTIONS = [...DEFAULT_FIELD_VEHICLE_OPTIONS];
    if (!AMBULANCE_VEHICLE_OPTIONS.length) AMBULANCE_VEHICLE_OPTIONS = [...DEFAULT_AMBULANCE_VEHICLE_OPTIONS];
}

async function loadCatalogsFromApi() {
    try {
        const response = await fetch(`${API_BASE}/api/fleet/catalogs`);
        if (!response.ok) {
            throw new Error("Impossible de charger le catalogue flotte.");
        }
        const payload = await response.json();
        applyCatalogPayload(payload);
    } catch (error) {
        DRIVER_OPTIONS = [...DEFAULT_DRIVER_OPTIONS];
        FIELD_VEHICLE_OPTIONS = [...DEFAULT_FIELD_VEHICLE_OPTIONS];
        AMBULANCE_VEHICLE_OPTIONS = [...DEFAULT_AMBULANCE_VEHICLE_OPTIONS];
        addLog(`ERREUR catalogue API: ${error.message}`);
    }

    populateDriverOptions();
    populateVehicleOptions();
    renderAdminLists();
}

function adminHeaders(json = true) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (adminSessionPassword) headers["X-Admin-Password"] = adminSessionPassword;
    return headers;
}

function toApiCatalogName(catalogName) {
    if (catalogName === "drivers") return "drivers";
    if (catalogName === "fieldVehicles") return "field_vehicles";
    return "ambulances";
}

async function addCatalogItem(catalogName, value) {
    const normalized = normalizeCatalogValue(value);
    if (!normalized) return;

    if (!adminSessionPassword) {
        addLog("ERREUR: accès admin non authentifié.");
        return;
    }

    try {
        const response = await fetch(
            `${API_BASE}/api/admin/fleet/${toApiCatalogName(catalogName)}/items`,
            {
                method: "POST",
                headers: adminHeaders(true),
                body: JSON.stringify({ value: normalized })
            }
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(detail || "Ajout refusé.");
        }
        const payload = await response.json();
        applyCatalogPayload(payload);
        populateDriverOptions();
        populateVehicleOptions();
        renderAdminLists();
        addLog(`ADMIN: élément ajouté (${normalized}).`);
    } catch (error) {
        addLog(`ERREUR admin ajout: ${error.message}`);
    }
}

async function editCatalogItem(catalogName, index) {
    const target =
        catalogName === "drivers"
            ? DRIVER_OPTIONS
            : catalogName === "fieldVehicles"
                ? FIELD_VEHICLE_OPTIONS
                : AMBULANCE_VEHICLE_OPTIONS;
    const current = target[index];
    if (!current) return;

    const next = window.prompt("Modifier la valeur:", current);
    if (next === null) return;
    const normalized = normalizeCatalogValue(next);
    if (!normalized) return;

    if (!adminSessionPassword) {
        addLog("ERREUR: accès admin non authentifié.");
        return;
    }

    try {
        const response = await fetch(
            `${API_BASE}/api/admin/fleet/${toApiCatalogName(catalogName)}/items`,
            {
                method: "PATCH",
                headers: adminHeaders(true),
                body: JSON.stringify({
                    current_value: current,
                    new_value: normalized
                })
            }
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(detail || "Modification refusée.");
        }
        const payload = await response.json();
        applyCatalogPayload(payload);
        populateDriverOptions();
        populateVehicleOptions();
        renderAdminLists();
        addLog(`ADMIN: élément modifié (${current} -> ${normalized}).`);
    } catch (error) {
        addLog(`ERREUR admin modification: ${error.message}`);
    }
}

async function removeCatalogItem(catalogName, index) {
    const target =
        catalogName === "drivers"
            ? DRIVER_OPTIONS
            : catalogName === "fieldVehicles"
                ? FIELD_VEHICLE_OPTIONS
                : AMBULANCE_VEHICLE_OPTIONS;
    if (!target[index]) return;
    if (!adminSessionPassword) {
        addLog("ERREUR: accès admin non authentifié.");
        return;
    }

    const removed = target[index];
    try {
        const encodedValue = encodeURIComponent(removed);
        const response = await fetch(
            `${API_BASE}/api/admin/fleet/${toApiCatalogName(catalogName)}/items/${encodedValue}`,
            {
                method: "DELETE",
                headers: adminHeaders(false)
            }
        );
        if (!response.ok) {
            const detail = await response.text();
            throw new Error(detail || "Suppression refusée.");
        }
        const payload = await response.json();
        applyCatalogPayload(payload);
        populateDriverOptions();
        populateVehicleOptions();
        renderAdminLists();
        addLog(`ADMIN: élément supprimé (${removed}).`);
    } catch (error) {
        addLog(`ERREUR admin suppression: ${error.message}`);
    }
}

function renderCatalogList(listElement, catalogName, values) {
    if (!listElement) return;
    listElement.innerHTML = "";

    values.forEach((value, index) => {
        const item = document.createElement("li");
        item.className = "admin-item";

        const label = document.createElement("span");
        label.className = "admin-item-label";
        label.textContent = value;

        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "admin-mini-btn";
        editButton.textContent = "Modifier";
        editButton.addEventListener("click", () => {
            editCatalogItem(catalogName, index);
        });

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "admin-mini-btn delete";
        deleteButton.textContent = "Supprimer";
        deleteButton.addEventListener("click", () => {
            removeCatalogItem(catalogName, index);
        });

        item.appendChild(label);
        item.appendChild(editButton);
        item.appendChild(deleteButton);
        listElement.appendChild(item);
    });
}

function renderAdminLists() {
    renderCatalogList(adminDriverList, "drivers", DRIVER_OPTIONS);
    renderCatalogList(adminFieldVehicleList, "fieldVehicles", FIELD_VEHICLE_OPTIONS);
    renderCatalogList(adminAmbulanceList, "ambulances", AMBULANCE_VEHICLE_OPTIONS);
}

function bindAdminEvents() {
    adminDriverForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        await addCatalogItem("drivers", adminDriverInput.value);
        adminDriverInput.value = "";
    });

    adminFieldVehicleForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        await addCatalogItem("fieldVehicles", adminFieldVehicleInput.value);
        adminFieldVehicleInput.value = "";
    });

    adminAmbulanceForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        await addCatalogItem("ambulances", adminAmbulanceInput.value);
        adminAmbulanceInput.value = "";
    });
}

function populateHospitalOptions() {
    if (!hospitalDestinationInput) return;

    hospitalDestinationInput.innerHTML = "";

    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = "Choisir hôpital";
    hospitalDestinationInput.appendChild(placeholderOption);

    HOSPITAL_OPTIONS.forEach((hospitalName) => {
        const option = document.createElement("option");
        option.value = hospitalName;
        option.textContent = hospitalName;
        hospitalDestinationInput.appendChild(option);
    });
}

function populateDriverOptions() {
    const selectedFieldDriver = driverNameInput.value;
    const selectedAmbulanceDriver = ambulanceDriverNameInput.value;
    populateSelectOptions(
        driverNameInput,
        DRIVER_OPTIONS,
        "Choisir chauffeur",
        selectedFieldDriver
    );
    populateSelectOptions(
        ambulanceDriverNameInput,
        DRIVER_OPTIONS,
        "Choisir chauffeur",
        selectedAmbulanceDriver
    );
}

function populateVehicleOptions() {
    const selectedFieldVehicle = vehicleNumberInput.value;
    const selectedAmbulanceVehicle = ambulanceVehicleNumberInput.value;
    populateSelectOptions(
        vehicleNumberInput,
        FIELD_VEHICLE_OPTIONS,
        "Choisir véhicule terrain",
        selectedFieldVehicle
    );
    populateSelectOptions(
        ambulanceVehicleNumberInput,
        AMBULANCE_VEHICLE_OPTIONS,
        "Choisir ambulance",
        selectedAmbulanceVehicle
    );
}

function populateSelectOptions(selectElement, options, placeholder, preferredValue = "") {
    if (!selectElement) return;
    const selectedBefore = preferredValue || selectElement.value;
    selectElement.innerHTML = "";

    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = placeholder;
    selectElement.appendChild(placeholderOption);

    options.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        selectElement.appendChild(option);
    });

    const hasSelected = options.some((value) => value === selectedBefore);
    if (hasSelected) {
        selectElement.value = selectedBefore;
    }
}

function setTripFormsDisabled(isDisabled) {
    [tripForm, ambulanceTripForm].forEach((form) => {
        form.querySelectorAll("input, select, button").forEach((element) => {
            if (element === arrivedHospitalBtn) {
                element.disabled = !(isDisabled && activeAmbulanceMissionType === "AMBULANCE_FIXED_TO_HOSPITAL");
                return;
            }
            element.disabled = isDisabled;
        });
    });

    if (!isDisabled) {
        toggleFixedPointField();
    }
}

function toggleFixedPointField() {
    if (pickupTypeInput) {
        pickupTypeInput.value = "FIXED_POINT";
        pickupTypeInput.disabled = true;
    }
    fixedPointField.classList.remove("hidden");
    fixedPointNameInput.required = true;
}

function getAmbulanceStepLabel(step) {
    if (step === AMBULANCE_FLOW.BASE_TO_FIXED) return "Étape active: Base -> Point fixe";
    if (step === AMBULANCE_FLOW.FIXED_TO_HOSPITAL) return "Étape active: Point fixe -> Hôpital";
    return "Étape active: Hôpital -> Point fixe (Retour)";
}

function syncAmbulanceFlowUi() {
    if (ambulanceSubmitBtn) {
        if (ambulanceFlowStep === AMBULANCE_FLOW.BASE_TO_FIXED) {
            ambulanceSubmitBtn.textContent = "Base -> Point fixe";
        } else if (ambulanceFlowStep === AMBULANCE_FLOW.FIXED_TO_HOSPITAL) {
            ambulanceSubmitBtn.textContent = "Point fixe -> Hôpital";
        } else {
            ambulanceSubmitBtn.textContent = "Hôpital -> Point fixe";
        }
    }

    if (!activeTripId || activeTripMode !== "AMBULANCE") {
        ambulanceTripStatus.textContent = `${DEFAULT_AMBULANCE_STATUS} | ${getAmbulanceStepLabel(ambulanceFlowStep)}`;
    }
}

function advanceAmbulanceFlow(completedMissionType) {
    if (completedMissionType === "AMBULANCE_BASE_TO_FIXED") {
        ambulanceFlowStep = AMBULANCE_FLOW.FIXED_TO_HOSPITAL;
    } else if (completedMissionType === "AMBULANCE_FIXED_TO_HOSPITAL") {
        ambulanceFlowStep = AMBULANCE_FLOW.HOSPITAL_TO_FIXED;
    } else if (completedMissionType === "AMBULANCE_HOSPITAL_TO_FIXED") {
        ambulanceFlowStep = AMBULANCE_FLOW.BASE_TO_FIXED;
    }
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

async function startTrip(payload, options = {}) {
    if (activeTripId) {
        addLog("Yon lot vwayaj deja aktif. Fini li avan.");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/trips/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error("Pa ka komanse vwayaj la.");

        const data = await response.json();
        activeTripId = data.trip_id;
        activeTripMode = options.isAmbulanceMission ? "AMBULANCE" : "STANDARD";
        activeAmbulanceMissionType = options.isAmbulanceMission ? payload.mission_type : null;
        destinationTargetLatLng = resolveDestinationLatLng(payload.destination);
        if (!destinationTargetLatLng) {
            destinationTargetLatLng = await geocodeDestination(payload.destination);
            if (!destinationTargetLatLng) {
                addLog(`Destination non géocodée: ${payload.destination} (la carte suivra le mouvement GPS).`);
                setDestinationStatus(`Destination introuvable: ${payload.destination}`, "warn");
            } else {
                setDestinationStatus(`Destination définie: ${payload.destination}`, "ok");
            }
        } else {
            setDestinationStatus(`Destination définie: ${payload.destination}`, "ok");
        }
        localTripIds.add(activeTripId);
        resetRoutePath();

        addLog(`Trajet démarré: ${payload.driver_name} -> ${payload.destination}`);
        if (options.isAmbulanceMission) {
            const victimNote = options.victimReference ? ` | Victime: ${options.victimReference}` : "";
            ambulanceTripStatus.textContent = `${options.statusMessage} | ID: ${activeTripId}${victimNote}`;
            tripStatus.textContent = `Trajet actif (ambulance): ${activeTripId}`;
            addLog(`MISSION AMBULANCE: ${payload.origin} -> ${payload.destination}${victimNote}`);
        } else {
            tripStatus.textContent = `${options.statusMessage} | ID: ${activeTripId}`;
            ambulanceTripStatus.textContent = DEFAULT_AMBULANCE_STATUS;
        }

        setControls(true);
        setTripFormsDisabled(true);
        startLocationTracking();
    } catch (error) {
        addLog(`ERREUR: ${error.message}`);
    }
}

function resetRoutePath() {
    routePoints = [];
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
    if (destinationMarker) {
        map.removeLayer(destinationMarker);
        destinationMarker = null;
    }
}

function resetTripState(options = {}) {
    tripStatus.textContent = DEFAULT_TRIP_STATUS;
    ambulanceTripStatus.textContent = DEFAULT_AMBULANCE_STATUS;
    stopLocationTracking();
    const completedMissionType = options.completedMissionType || activeAmbulanceMissionType || null;
    advanceAmbulanceFlow(completedMissionType);
    activeTripId = null;
    activeTripMode = null;
    activeAmbulanceMissionType = null;
    destinationTargetLatLng = null;
    setDestinationStatus("Destination non définie.", "neutral");
    setControls(false);
    setTripFormsDisabled(false);
    syncAmbulanceFlowUi();
}

function startLocationTracking() {
    if (!navigator.geolocation) {
        addLog("Le navigateur ne prend pas en charge le GPS.");
        return;
    }
    stopLocationTracking();

    const handlePositionUpdate = async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        updateMap(lat, lon);
        await sendLocation(lat, lon);
    };

    // Premye pwen an touswit pou marker la parÃ¨t imedyatman
    navigator.geolocation.getCurrentPosition(
        (position) => {
            handlePositionUpdate(position).catch((error) => {
                addLog(`ERREUR GPS premier point: ${error.message}`);
            });
        },
        (error) => {
            addLog(`ERREUR GPS premier point: ${error.message}`);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000
        }
    );

    watcherId = navigator.geolocation.watchPosition(
        (position) => {
            handlePositionUpdate(position).catch((error) => {
                addLog(`ERREUR GPS en direct: ${error.message}`);
            });
        },
        (error) => {
            addLog(`ERREUR GPS: ${error.message}`);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 4000,
            timeout: 10000
        }
    );
}

function stopLocationTracking() {
    if (watcherId !== null) {
        navigator.geolocation.clearWatch(watcherId);
        watcherId = null;
    }
}

async function sendLocation(latitude, longitude) {
    if (!activeTripId) return;

    try {
        const response = await fetch(`${API_BASE}/api/trips/${activeTripId}/location`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude, longitude })
        });
        if (!response.ok) throw new Error("Échec de mise à jour GPS.");
        addLog(`GPS: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    } catch (error) {
        addLog(`ERREUR envoi GPS: ${error.message}`);
    }
}

function updateMap(latitude, longitude) {
    const latLng = [latitude, longitude];
    const previousPoint = routePoints.length ? routePoints[routePoints.length - 1] : null;

    if (!driverMarker) {
        driverMarker = L.marker(latLng, { icon: ambulanceIcon }).addTo(map).bindPopup("Chauffeur aktif");
    } else {
        driverMarker.setLatLng(latLng);
    }

    if (destinationTargetLatLng && hasMeaningfulMovement(latLng, destinationTargetLatLng)) {
        currentHeading = getBearing(latLng, destinationTargetLatLng);
        if (!destinationMarker) {
            destinationMarker = L.circleMarker(destinationTargetLatLng, {
                radius: 7,
                color: "#c7162b",
                weight: 2,
                fillColor: "#ffdee3",
                fillOpacity: 0.95
            })
                .addTo(map)
                .bindPopup("Destination");
        } else {
            destinationMarker.setLatLng(destinationTargetLatLng);
        }
    } else if (previousPoint && hasMeaningfulMovement(previousPoint, latLng)) {
        currentHeading = getBearing(previousPoint, latLng);
    }
    applyVehicleHeading(currentHeading);

    routePoints.push(latLng);

    if (routeLine) {
        routeLine.setLatLngs(routePoints);
    } else {
        routeLine = L.polyline(routePoints, { color: "#0f6bce", weight: 4 }).addTo(map);
    }

    map.setView(latLng, 14);
}

function applyVehicleHeading(heading) {
    if (!driverMarker) return;
    const markerElement = driverMarker.getElement();
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

function addLog(message) {
    const timestamp = new Date().toLocaleString();
    const item = document.createElement("li");
    item.textContent = `[${timestamp}] ${message}`;
    eventLog.prepend(item);
    while (eventLog.children.length > MAX_LOG_ITEMS) {
        eventLog.removeChild(eventLog.lastElementChild);
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

    observerSocket.onopen = () => {
        addLog("Canal d observation temps réel connecté.");
    };

    observerSocket.onmessage = (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        handleObserverMessage(message);
    };

    observerSocket.onclose = () => {
        addLog("Canal temps réel déconnecté. Reconnexion...");
        scheduleReconnect();
    };

    observerSocket.onerror = () => {
        observerSocket.close();
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectObserverChannel();
    }, OBSERVER_RECONNECT_MS);
}

function handleObserverMessage(message) {
    if (!message || !message.type || !message.trip_id) return;

    const tripId = message.trip_id;
    const payload = message.payload || {};

    switch (message.type) {
        case "TRIP_STARTED":
            addLog(`LIVE: trajet démarré (${tripId})`);
            break;
        case "LOCATION":
            if (!localTripIds.has(tripId) && Number.isFinite(payload.latitude) && Number.isFinite(payload.longitude)) {
                updateMap(payload.latitude, payload.longitude);
            }
            break;
        case "ALERT":
            addLog(`ALERTE LIVE (${tripId}): ${payload.alert_type || "UNKNOWN"}`);
            showDriverAlertPopup(payload.alert_type || "UNKNOWN");
            playAlertTone(
                payload.alert_type === "ACCIDENT"
                    ? ALERT_TONE_URGENT_BURSTS
                    : ALERT_TONE_DEFAULT_BURSTS
            );
            break;
        case "PASSENGER_UPDATE":
            addLog(`LIVE Passagers (${tripId}): ${payload.passenger_count ?? "-"}`);
            break;
        case "TRIP_FINISHED":
            addLog(`LIVE: trajet terminé (${tripId})`);
            if (activeTripId === tripId) {
                resetTripState();
            }
            break;
        default:
            break;
    }
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

function showDriverAlertPopup(alertType) {
    if (!driverAlertStack) return;
    const item = document.createElement("article");
    item.className = "alert-popup";
    item.innerHTML =
        `<button type="button" class="alert-popup-close" aria-label="Fermer">x</button>` +
        `<p class="alert-popup-title">ALERT ${alertType}</p>` +
        `<p class="alert-popup-body">Trip: ${activeTripId || "-"}</p>`;

    const removeItem = () => {
        item.classList.add("alert-popup-out");
        window.setTimeout(() => item.remove(), 240);
    };

    const closeBtn = item.querySelector(".alert-popup-close");
    if (closeBtn) {
        closeBtn.addEventListener("click", removeItem);
    }
    driverAlertStack.prepend(item);
    window.setTimeout(removeItem, 10000);
}

