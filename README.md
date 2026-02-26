# CRH Chauffeur Tracking MVP

## Sa ki ladan
- `index.html`, `style.css`, `script.js`: app chauffeur pou tablet nan machin (demare/fini vwayaj, GPS, alèt).
- `observer.html`, `observer.js`: dashboard observateur pou siveye tout vwayaj yo an tan reyèl.
- `backend/main.py`: FastAPI backend pou tracking, pasaje, alerte, fini vwayaj.

## Kijan pou lanse backend la
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Kijan pou lanse ak Docker (rekòmande pou transportation)
Nan rasin pwojè a:

```powershell
docker compose up --build -d
```

Sèvis yo:
- Web chauffeur + observer: `http://localhost:8080`
- API backend: `http://localhost:8000`
- Healthcheck: `http://localhost:8000/health`

Pou sispann:

```powershell
docker compose down
```

## Kijan pou itilize frontend la
1. Louvri `index.html` sou tablet chauffeur la.
2. Ranpli fòm nan epi klike `Kite baz la`.
3. Bay navigatè a pèmisyon GPS.
4. Itilize bouton `IJANS`, `MAYDAY`, `ATAK`, `AKSIDAN`, oswa `Mete pasaje ajou`.
5. Louvri `observer.html` sou pòs observateur la pou wè tout vwayaj aktif yo + alèt live.

## Espace Admin (web chauffeur)
- Nan `index.html`, gen yon seksyon **Espace Admin Flotte**.
- Seksyon an pwoteje pa modpas: `SNCRH_2026`.
- Ou ka ajoute/modifye/siprime:
  - nouvo chauffeur
  - nouvo mobile terrain
  - nouvo ambulance
- Lis yo jere nan backend API a (pa nan localStorage ankò), epi yo rete apre refresh/restart.

## Backend admin API
- Modpas admin backend:
  - env var `ADMIN_PASSWORD` (default: `SNCRH_2026`)
- Fichier catalog flotte:
  - env var `FLEET_STORAGE_PATH` (default: `backend/fleet_catalog.json`)

## Nòt enpòtan
- MVP sa a sere done an memwa (li pa pèsistan).
- Pou pwodiksyon, ajoute PostgreSQL + PostGIS, auth JWT, ak push notifications.
- Pou Android natif, ou ka konekte aplikasyon Kotlin/Flutter ak menm API sa a.
