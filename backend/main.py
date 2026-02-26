import json
import os
from datetime import date, datetime, time, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Literal, Set
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


app = FastAPI(title="CRH Driver Tracking API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TripStatus(str, Enum):
    ACTIVE = "ACTIVE"
    FINISHED = "FINISHED"


class StartTripRequest(BaseModel):
    driver_name: str = Field(min_length=2)
    vehicle_number: str = Field(min_length=1)
    origin: str
    destination: str
    passenger_count: int = Field(ge=0)
    mission_type: str = Field(default="STANDARD", min_length=3)
    victim_reference: str | None = None


class LocationRequest(BaseModel):
    latitude: float
    longitude: float


class AlertRequest(BaseModel):
    alert_type: str = Field(min_length=2)


class PassengerUpdateRequest(BaseModel):
    passenger_count: int = Field(ge=0)


class TripEvent(BaseModel):
    type: str
    timestamp: datetime
    payload: Dict[str, Any]


class TripRecord(BaseModel):
    trip_id: str
    driver_name: str
    vehicle_number: str
    origin: str
    destination: str
    passenger_count: int
    mission_type: str = "STANDARD"
    victim_reference: str | None = None
    status: TripStatus
    created_at: datetime
    updated_at: datetime
    events: List[TripEvent] = Field(default_factory=list)


class FleetCatalog(BaseModel):
    drivers: List[str]
    field_vehicles: List[str]
    ambulances: List[str]
    hospitals: List[str] = Field(default_factory=list)


class AdminAuthRequest(BaseModel):
    password: str = Field(min_length=1)


class FleetItemRequest(BaseModel):
    value: str = Field(min_length=1)


class FleetItemUpdateRequest(BaseModel):
    current_value: str = Field(min_length=1)
    new_value: str = Field(min_length=1)


class ObserverHub:
    def __init__(self) -> None:
        self.connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        stale: List[WebSocket] = []
        for connection in list(self.connections):
            try:
                await connection.send_json(message)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.disconnect(connection)


TRIPS: Dict[str, TripRecord] = {}
HUB = ObserverHub()
ALERT_HUB = ObserverHub()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "SNCRH_2026")
FLEET_STORAGE_PATH = Path(
    os.getenv("FLEET_STORAGE_PATH", str(Path(__file__).with_name("fleet_catalog.json")))
)
DEFAULT_CATALOG = FleetCatalog(
    drivers=["Jean Michel", "Rose Marie", "Samuel Pierre", "David Louis"],
    field_vehicles=["MOB-01", "MOB-02", "MOB-03", "MOB-04"],
    ambulances=["AMB-01", "AMB-02", "AMB-03", "AMB-04"],
    hospitals=[
        "HUEH - Hopital General",
        "Hopital Universitaire de Mirebalais",
        "Hopital Bernard Mevs",
        "Hopital OFATMA",
        "Hopital La Paix",
        "Hopital Saint Damien",
    ],
)


def normalize_item(value: str) -> str:
    return " ".join(value.strip().split())


def dedupe_preserve(items: List[str]) -> List[str]:
    output: List[str] = []
    seen: Set[str] = set()
    for raw in items:
        normalized = normalize_item(raw)
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append(normalized)
    return output


def clean_catalog(catalog: FleetCatalog) -> FleetCatalog:
    drivers = dedupe_preserve(catalog.drivers)
    field_vehicles = dedupe_preserve(catalog.field_vehicles)
    ambulances = dedupe_preserve(catalog.ambulances)
    hospitals = dedupe_preserve(catalog.hospitals)
    if not drivers:
        drivers = list(DEFAULT_CATALOG.drivers)
    if not field_vehicles:
        field_vehicles = list(DEFAULT_CATALOG.field_vehicles)
    if not ambulances:
        ambulances = list(DEFAULT_CATALOG.ambulances)
    if not hospitals:
        hospitals = list(DEFAULT_CATALOG.hospitals)
    return FleetCatalog(
        drivers=drivers,
        field_vehicles=field_vehicles,
        ambulances=ambulances,
        hospitals=hospitals,
    )


def load_catalog_from_disk() -> FleetCatalog:
    if not FLEET_STORAGE_PATH.exists():
        return DEFAULT_CATALOG
    try:
        payload = json.loads(FLEET_STORAGE_PATH.read_text(encoding="utf-8"))
        return clean_catalog(FleetCatalog.model_validate(payload))
    except Exception:
        return DEFAULT_CATALOG


def save_catalog_to_disk(catalog: FleetCatalog) -> None:
    clean = clean_catalog(catalog)
    FLEET_STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FLEET_STORAGE_PATH.write_text(
        json.dumps(clean.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


CATALOG = load_catalog_from_disk()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def build_event_message(
    trip: TripRecord,
    event_type: str,
    timestamp: datetime,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "trip_id": trip.trip_id,
        "driver_name": trip.driver_name,
        "vehicle_number": trip.vehicle_number,
        "mission_type": trip.mission_type,
        "victim_reference": trip.victim_reference,
        "status": trip.status,
        "type": event_type,
        "timestamp": timestamp.isoformat(),
        "payload": payload,
    }


def verify_admin_password(x_admin_password: str | None) -> None:
    if x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Admin authentication required")


def catalog_list_ref(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
) -> List[str]:
    if catalog_name == "drivers":
        return CATALOG.drivers
    if catalog_name == "field_vehicles":
        return CATALOG.field_vehicles
    if catalog_name == "ambulances":
        return CATALOG.ambulances
    return CATALOG.hospitals


def add_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    value: str,
) -> FleetCatalog:
    normalized = normalize_item(value)
    if not normalized:
        raise HTTPException(status_code=400, detail="Value cannot be empty")
    target = catalog_list_ref(catalog_name)
    if any(item.lower() == normalized.lower() for item in target):
        raise HTTPException(status_code=409, detail="Item already exists")
    target.append(normalized)
    cleaned = clean_catalog(CATALOG)
    CATALOG.drivers = cleaned.drivers
    CATALOG.field_vehicles = cleaned.field_vehicles
    CATALOG.ambulances = cleaned.ambulances
    CATALOG.hospitals = cleaned.hospitals
    save_catalog_to_disk(CATALOG)
    return CATALOG


def rename_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    current_value: str,
    new_value: str,
) -> FleetCatalog:
    current = normalize_item(current_value)
    updated = normalize_item(new_value)
    if not current or not updated:
        raise HTTPException(status_code=400, detail="Values cannot be empty")

    target = catalog_list_ref(catalog_name)
    match_index = next(
        (index for index, item in enumerate(target) if item.lower() == current.lower()),
        None,
    )
    if match_index is None:
        raise HTTPException(status_code=404, detail="Item not found")
    if any(
        item.lower() == updated.lower() and idx != match_index
        for idx, item in enumerate(target)
    ):
        raise HTTPException(status_code=409, detail="New value already exists")

    target[match_index] = updated
    cleaned = clean_catalog(CATALOG)
    CATALOG.drivers = cleaned.drivers
    CATALOG.field_vehicles = cleaned.field_vehicles
    CATALOG.ambulances = cleaned.ambulances
    CATALOG.hospitals = cleaned.hospitals
    save_catalog_to_disk(CATALOG)
    return CATALOG


def remove_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    value: str,
) -> FleetCatalog:
    normalized = normalize_item(value)
    target = catalog_list_ref(catalog_name)
    match_index = next(
        (index for index, item in enumerate(target) if item.lower() == normalized.lower()),
        None,
    )
    if match_index is None:
        raise HTTPException(status_code=404, detail="Item not found")
    if len(target) <= 1:
        raise HTTPException(status_code=400, detail="At least one item is required")
    del target[match_index]
    save_catalog_to_disk(CATALOG)
    return CATALOG


def ensure_trip_catalog_compatibility(payload: StartTripRequest) -> None:
    driver = normalize_item(payload.driver_name).lower()
    if driver not in {item.lower() for item in CATALOG.drivers}:
        raise HTTPException(status_code=400, detail="Unknown driver")

    mission_upper = payload.mission_type.upper()
    vehicle = normalize_item(payload.vehicle_number).lower()
    if "AMBULANCE" in mission_upper:
        allowed = {item.lower() for item in CATALOG.ambulances}
        if vehicle not in allowed:
            raise HTTPException(status_code=400, detail="Unknown ambulance")
    else:
        allowed = {item.lower() for item in CATALOG.field_vehicles}
        if vehicle not in allowed:
            raise HTTPException(status_code=400, detail="Unknown field vehicle")


async def append_and_broadcast(
    trip: TripRecord, event_type: str, payload: Dict[str, Any]
) -> None:
    now = utc_now()
    trip.updated_at = now
    trip.events.append(TripEvent(type=event_type, timestamp=now, payload=payload))
    message = build_event_message(trip, event_type, now, payload)
    await HUB.broadcast(message)
    if event_type == "ALERT":
        await ALERT_HUB.broadcast(message)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/fleet/catalogs")
def get_public_catalogs() -> FleetCatalog:
    return clean_catalog(CATALOG)


@app.post("/api/admin/auth")
def admin_auth(payload: AdminAuthRequest) -> Dict[str, str]:
    if payload.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid admin password")
    return {"message": "ok"}


@app.get("/api/admin/fleet/catalogs")
def get_admin_catalogs(x_admin_password: str | None = Header(default=None)) -> FleetCatalog:
    verify_admin_password(x_admin_password)
    return clean_catalog(CATALOG)


@app.post("/api/admin/fleet/{catalog_name}/items")
def admin_add_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    payload: FleetItemRequest,
    x_admin_password: str | None = Header(default=None),
) -> FleetCatalog:
    verify_admin_password(x_admin_password)
    return add_catalog_item(catalog_name, payload.value)


@app.patch("/api/admin/fleet/{catalog_name}/items")
def admin_rename_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    payload: FleetItemUpdateRequest,
    x_admin_password: str | None = Header(default=None),
) -> FleetCatalog:
    verify_admin_password(x_admin_password)
    return rename_catalog_item(catalog_name, payload.current_value, payload.new_value)


@app.delete("/api/admin/fleet/{catalog_name}/items/{item_value}")
def admin_delete_catalog_item(
    catalog_name: Literal["drivers", "field_vehicles", "ambulances", "hospitals"],
    item_value: str,
    x_admin_password: str | None = Header(default=None),
) -> FleetCatalog:
    verify_admin_password(x_admin_password)
    return remove_catalog_item(catalog_name, item_value)


@app.websocket("/ws/observers")
async def observers_socket(websocket: WebSocket) -> None:
    await HUB.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        HUB.disconnect(websocket)


@app.websocket("/ws/observers/alerts")
async def observer_alerts_socket(websocket: WebSocket) -> None:
    await ALERT_HUB.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ALERT_HUB.disconnect(websocket)


@app.post("/api/trips/start")
async def start_trip(payload: StartTripRequest) -> Dict[str, str]:
    ensure_trip_catalog_compatibility(payload)
    trip_id = str(uuid4())
    now = utc_now()

    record = TripRecord(
        trip_id=trip_id,
        driver_name=payload.driver_name,
        vehicle_number=payload.vehicle_number,
        origin=payload.origin,
        destination=payload.destination,
        passenger_count=payload.passenger_count,
        mission_type=payload.mission_type,
        victim_reference=payload.victim_reference,
        status=TripStatus.ACTIVE,
        created_at=now,
        updated_at=now,
        events=[],
    )
    TRIPS[trip_id] = record

    await append_and_broadcast(record, "TRIP_STARTED", payload.model_dump())
    return {"trip_id": trip_id}


@app.post("/api/trips/{trip_id}/location")
async def add_location(trip_id: str, payload: LocationRequest) -> Dict[str, str]:
    trip = get_trip_or_404(trip_id)
    ensure_active(trip)
    event_payload = {"latitude": payload.latitude, "longitude": payload.longitude}
    await append_and_broadcast(trip, "LOCATION", event_payload)
    return {"message": "location saved"}


@app.post("/api/trips/{trip_id}/alert")
async def add_alert(trip_id: str, payload: AlertRequest) -> Dict[str, str]:
    trip = get_trip_or_404(trip_id)
    ensure_active(trip)
    event_payload = {"alert_type": payload.alert_type}
    await append_and_broadcast(trip, "ALERT", event_payload)
    return {"message": "alert saved"}


@app.post("/api/trips/{trip_id}/passengers")
async def update_passengers(
    trip_id: str, payload: PassengerUpdateRequest
) -> Dict[str, str]:
    trip = get_trip_or_404(trip_id)
    ensure_active(trip)
    trip.passenger_count = payload.passenger_count
    event_payload = {"passenger_count": payload.passenger_count}
    await append_and_broadcast(trip, "PASSENGER_UPDATE", event_payload)
    return {"message": "passengers updated"}


@app.post("/api/trips/{trip_id}/finish")
async def finish_trip(trip_id: str) -> Dict[str, str]:
    trip = get_trip_or_404(trip_id)
    ensure_active(trip)
    trip.status = TripStatus.FINISHED
    await append_and_broadcast(trip, "TRIP_FINISHED", {})
    return {"message": "trip finished"}


@app.get("/api/trips/active")
def get_active_trips() -> List[TripRecord]:
    return [trip for trip in TRIPS.values() if trip.status == TripStatus.ACTIVE]


@app.get("/api/trips/{trip_id}/history")
def get_trip_history(trip_id: str) -> TripRecord:
    return get_trip_or_404(trip_id)


@app.get("/api/reports/weekly")
def get_weekly_report(week_start: date) -> Dict[str, Any]:
    start_dt = datetime.combine(week_start, time.min, tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(days=7)

    def in_range(ts: datetime) -> bool:
        return start_dt <= ts < end_dt

    detailed_trips: List[Dict[str, Any]] = []
    for trip in TRIPS.values():
        in_window = in_range(trip.created_at) or any(in_range(event.timestamp) for event in trip.events)
        if not in_window:
            continue

        alerts = [
            str(event.payload.get("alert_type", "UNKNOWN"))
            for event in trip.events
            if event.type == "ALERT"
        ]
        location_events = [event for event in trip.events if event.type == "LOCATION"]
        finished_event = next((event for event in trip.events if event.type == "TRIP_FINISHED"), None)

        detailed_trips.append(
            {
                "trip_id": trip.trip_id,
                "driver_name": trip.driver_name,
                "vehicle_number": trip.vehicle_number,
                "origin": trip.origin,
                "destination": trip.destination,
                "mission_type": trip.mission_type,
                "victim_reference": trip.victim_reference,
                "status": trip.status,
                "passenger_count": trip.passenger_count,
                "created_at": trip.created_at.isoformat(),
                "finished_at": finished_event.timestamp.isoformat() if finished_event else None,
                "alert_actions": alerts,
                "alert_count": len(alerts),
                "location_updates": len(location_events),
                "has_security_action": len(alerts) > 0,
            }
        )

    detailed_trips.sort(key=lambda item: item["created_at"])

    return {
        "week_start": start_dt.date().isoformat(),
        "week_end": (end_dt - timedelta(days=1)).date().isoformat(),
        "total_trips": len(detailed_trips),
        "total_alert_actions": sum(int(item["alert_count"]) for item in detailed_trips),
        "ambulance_missions": sum(1 for item in detailed_trips if item["mission_type"] == "AMBULANCE"),
        "standard_missions": sum(1 for item in detailed_trips if item["mission_type"] != "AMBULANCE"),
        "trips": detailed_trips,
    }


def get_trip_or_404(trip_id: str) -> TripRecord:
    trip = TRIPS.get(trip_id)
    if trip is None:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


def ensure_active(trip: TripRecord) -> None:
    if trip.status != TripStatus.ACTIVE:
        raise HTTPException(status_code=400, detail="Trip is not active")
