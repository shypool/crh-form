# Chauffeur Mobile (Flutter Android)

App sa a pèmèt chauffeur yo:
- Login ak PIN chauffeur (epi JWT opsyonèl)
- Demare vwayaj estanda
- Demare misyon anbilans (pickup, referans viktim, lopital)
- Voye pozisyon GPS an tan reyèl
- Voye alèt ijans
- Mete kantite pasaje/viktim ajou
- Fini vwayaj oswa fini misyon lè anbilans rive lopital

Tout aksyon yo ale dirèk sou backend FastAPI a, epi observer dashboard la resevwa yo sou websocket li deja genyen.

## 1) Kreye boilerplate Flutter la
Nan `chauffeur_mobile/` kouri:

```powershell
flutter create .
```

Apre sa, kenbe fichye sa yo jan yo ye nan repo a:
- `pubspec.yaml`
- `lib/main.dart`
- `android/app/src/main/AndroidManifest.xml`

## 2) Enstale depandans
```powershell
flutter pub get
```

## 3) Lanse backend la
```powershell
cd ..\backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## 4) Konekte API sou Android
App la itilize pa default:
- `http://10.0.2.2:8000` (Android emulator)

Pou telefòn reyèl, pase IP machin ou a:
```powershell
flutter run --dart-define=API_BASE=http://192.168.1.50:8000
```

## 5) PIN login ak JWT
PIN default la se `1234`.

Pou chanje PIN lan pandan `run`:
```powershell
flutter run --dart-define=DRIVER_PIN=9876
```

JWT se opsyonèl: si ou antre li nan ekran login an, app la ap voye
`Authorization: Bearer <token>` sou tout demann API yo.

## 6) Lanse app la
```powershell
flutter run
```

## Nòt
- Si backend la pa HTTPS, kèk aparèy ka mande `network_security_config` pou cleartext HTTP.
- Observer dashboard la deja konekte ak evènman sa yo (`TRIP_STARTED`, `LOCATION`, `ALERT`, `PASSENGER_UPDATE`, `TRIP_FINISHED`).

