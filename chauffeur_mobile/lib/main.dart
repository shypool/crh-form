import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  runApp(const CarTrackingApp());
}

enum TripMode { standard, ambulance }
enum AmbulanceFlowStep { baseToFixed, fixedToHospital, hospitalToFixed }

class FleetCatalog {
  const FleetCatalog({
    required this.drivers,
    required this.fieldVehicles,
    required this.ambulances,
    required this.hospitals,
  });

  final List<String> drivers;
  final List<String> fieldVehicles;
  final List<String> ambulances;
  final List<String> hospitals;

  factory FleetCatalog.fromJson(Map<String, dynamic> json) {
    List<String> parseList(dynamic value) {
      if (value is! List<dynamic>) return const <String>[];
      return value
          .map((dynamic item) => item.toString().trim())
          .where((String item) => item.isNotEmpty)
          .toSet()
          .toList();
    }

    return FleetCatalog(
      drivers: parseList(json['drivers']),
      fieldVehicles: parseList(json['field_vehicles']),
      ambulances: parseList(json['ambulances']),
      hospitals: parseList(json['hospitals']),
    );
  }
}

class CarTrackingApp extends StatelessWidget {
  const CarTrackingApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Car Tracking',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFD62828)),
        useMaterial3: true,
      ),
      home: const DriverScreen(),
    );
  }
}

class DriverScreen extends StatefulWidget {
  const DriverScreen({super.key});

  @override
  State<DriverScreen> createState() => _DriverScreenState();
}

class _DriverScreenState extends State<DriverScreen> {
  static const String apiBase = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'http://127.0.0.1:8000',
  );
  static const LatLng defaultCenter = LatLng(18.5392, -72.3364);
  static const int maxLogItems = 200;

  static const Map<String, LatLng> destinationCoords = <String, LatLng>{
    'crh base': LatLng(18.5392, -72.3364),
    'hueh - hopital general': LatLng(18.5449, -72.3399),
    'hopital universitaire de mirebalais': LatLng(18.8347, -72.1044),
    'hopital bernard mevs': LatLng(18.5715, -72.3259),
    'hopital ofatma': LatLng(18.5571, -72.2986),
    'hopital la paix': LatLng(18.5985, -72.2264),
    'hopital saint damien': LatLng(18.5609, -72.2957),
  };

  static const List<String> defaultDrivers = <String>[
    'Jean Michel',
    'Rose Marie',
    'Samuel Pierre',
    'David Louis',
  ];
  static const List<String> defaultFieldVehicles = <String>[
    'MOB-01', 'MOB-02', 'MOB-03', 'MOB-04',
  ];
  static const List<String> defaultAmbulances = <String>[
    'AMB-01', 'AMB-02', 'AMB-03', 'AMB-04',
  ];
  static const List<String> defaultHospitals = <String>[
    'HUEH - Hopital General',
    'Hopital Universitaire de Mirebalais',
    'Hopital Bernard Mevs',
    'Hopital OFATMA',
    'Hopital La Paix',
    'Hopital Saint Damien',
  ];
  static const List<String> alerts = <String>[
    'EMERGENCY', 'MAYDAY', 'ATTACK', 'ACCIDENT',
  ];

  final MapController _mapController = MapController();
  final List<String> _eventLogs = <String>[];
  final List<LatLng> _routePoints = <LatLng>[];

  final TextEditingController _originController =
      TextEditingController(text: 'CRH Base');
  final TextEditingController _destinationController = TextEditingController();
  final TextEditingController _passengerController =
      TextEditingController(text: '0');
  final TextEditingController _fixedPointController = TextEditingController();
  final TextEditingController _victimReferenceController =
      TextEditingController();
  final TextEditingController _victimCountController =
      TextEditingController(text: '1');

  String? _selectedFieldDriver;
  String? _selectedFieldVehicle;
  String? _selectedAmbulanceDriver;
  String? _selectedAmbulanceVehicle;
  String? _selectedHospital;
  List<String> _drivers = List<String>.from(defaultDrivers);
  List<String> _fieldVehicles = List<String>.from(defaultFieldVehicles);
  List<String> _ambulances = List<String>.from(defaultAmbulances);
  List<String> _hospitals = List<String>.from(defaultHospitals);

  String? _tripId;
  TripMode? _tripMode;
  String? _activeMissionType;
  AmbulanceFlowStep _ambulanceFlowStep = AmbulanceFlowStep.baseToFixed;

  bool _busy = false;
  Position? _lastPosition;
  LatLng? _driverLatLng;
  LatLng? _destinationLatLng;
  String _tripStatus = 'Aucun trajet actif.';
  String _ambulanceStatus = 'Aucune mission ambulance active.';
  String _destinationStatus = 'Destination non définie.';
  double _distanceKm = 0;
  bool _destinationFound = false;
  bool _catalogLoading = false;
  String? _catalogError;

  StreamSubscription<Position>? _positionSubscription;
  WebSocketChannel? _ws;
  StreamSubscription<dynamic>? _wsSub;
  Timer? _wsReconnect;

  @override
  void initState() {
    super.initState();
    _loadFleetCatalogs();
    _connectWs();
  }

  @override
  void dispose() {
    _originController.dispose();
    _destinationController.dispose();
    _passengerController.dispose();
    _fixedPointController.dispose();
    _victimReferenceController.dispose();
    _victimCountController.dispose();
    _positionSubscription?.cancel();
    _wsReconnect?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    super.dispose();
  }

  Uri _wsUri() {
    final String wsBase = apiBase.replaceFirst(RegExp(r'^http'), 'ws');
    return Uri.parse('$wsBase/ws/observers');
  }

  void _connectWs() {
    _wsReconnect?.cancel();
    try {
      _ws = WebSocketChannel.connect(_wsUri());
      _wsSub = _ws!.stream.listen(
        (dynamic data) {
          final Map<String, dynamic> msg =
              jsonDecode(data as String) as Map<String, dynamic>;
          _handleLiveMessage(msg);
        },
        onError: (_) => _scheduleReconnect(),
        onDone: _scheduleReconnect,
      );
      _addLog('Canal live connecté.');
    } catch (_) {
      _scheduleReconnect();
    }
  }

  Future<void> _loadFleetCatalogs() async {
    if (_catalogLoading) return;
    setState(() {
      _catalogLoading = true;
      _catalogError = null;
    });
    try {
      final http.Response response = await http.get(
        Uri.parse('$apiBase/api/fleet/catalogs'),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('Chargement flotte refuse (${response.statusCode})');
      }
      final Map<String, dynamic> body =
          jsonDecode(response.body) as Map<String, dynamic>;
      final FleetCatalog catalog = FleetCatalog.fromJson(body);
      setState(() {
        final List<String> nextDrivers = catalog.drivers.isEmpty
            ? List<String>.from(defaultDrivers)
            : catalog.drivers;
        final List<String> nextFieldVehicles = catalog.fieldVehicles.isEmpty
            ? List<String>.from(defaultFieldVehicles)
            : catalog.fieldVehicles;
        final List<String> nextAmbulances = catalog.ambulances.isEmpty
            ? List<String>.from(defaultAmbulances)
            : catalog.ambulances;
        final List<String> nextHospitals = catalog.hospitals.isEmpty
            ? List<String>.from(defaultHospitals)
            : catalog.hospitals;
        _drivers = nextDrivers;
        _fieldVehicles = nextFieldVehicles;
        _ambulances = nextAmbulances;
        _hospitals = nextHospitals;
        if (_selectedFieldDriver != null && !nextDrivers.contains(_selectedFieldDriver)) {
          _selectedFieldDriver = null;
        }
        if (_selectedAmbulanceDriver != null &&
            !nextDrivers.contains(_selectedAmbulanceDriver)) {
          _selectedAmbulanceDriver = null;
        }
        if (_selectedFieldVehicle != null &&
            !nextFieldVehicles.contains(_selectedFieldVehicle)) {
          _selectedFieldVehicle = null;
        }
        if (_selectedAmbulanceVehicle != null &&
            !nextAmbulances.contains(_selectedAmbulanceVehicle)) {
          _selectedAmbulanceVehicle = null;
        }
        if (_selectedHospital != null && !nextHospitals.contains(_selectedHospital)) {
          _selectedHospital = null;
        }
      });
      _addLog('Catalogue flotte charge.');
    } catch (error) {
      setState(() => _catalogError = 'Catalogue indisponible. Fallback local actif.');
      _addLog('Catalogue indisponible: $error');
    } finally {
      if (mounted) setState(() => _catalogLoading = false);
    }
  }

  void _scheduleReconnect() {
    _wsReconnect?.cancel();
    _wsReconnect = Timer(const Duration(milliseconds: 2500), _connectWs);
  }

  void _handleLiveMessage(Map<String, dynamic> msg) {
    final String type = (msg['type'] ?? '').toString();
    final String tripId = (msg['trip_id'] ?? '').toString();
    if (type.isEmpty) return;
    if (_tripId != null && tripId.isNotEmpty && tripId != _tripId) return;
    if (type == 'LOCATION') {
      final dynamic payload = msg['payload'];
      if (payload is Map<String, dynamic>) {
        final double? distance = (payload['total_distance_km'] as num?)?.toDouble();
        if (distance != null && mounted) {
          setState(() => _distanceKm = distance);
        }
      }
    }
    _addLog('LIVE: $type ${tripId.isEmpty ? '' : '($tripId)'}'.trim());
  }

  void _addLog(String message) {
    if (!mounted) return;
    final String line = '[${TimeOfDay.now().format(context)}] $message';
    setState(() {
      _eventLogs.insert(0, line);
      if (_eventLogs.length > maxLogItems) {
        _eventLogs.removeRange(maxLogItems, _eventLogs.length);
      }
    });
  }

  String _flowLabel() {
    return switch (_ambulanceFlowStep) {
      AmbulanceFlowStep.baseToFixed => 'Étape active: Base -> Point fixe',
      AmbulanceFlowStep.fixedToHospital => 'Étape active: Point fixe -> Hôpital',
      AmbulanceFlowStep.hospitalToFixed => 'Étape active: Hôpital -> Point fixe',
    };
  }

  String? _optionalVictimReference() {
    final String value = _victimReferenceController.text.trim();
    return value.isEmpty ? null : value;
  }

  LatLng? _resolveDestination(String destination) {
    final Match? parsed = RegExp(
      r'^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$',
    ).firstMatch(destination);
    if (parsed != null) {
      final double? lat = double.tryParse(parsed.group(1)!);
      final double? lng = double.tryParse(parsed.group(2)!);
      if (lat != null && lng != null) return LatLng(lat, lng);
    }
    return destinationCoords[destination.trim().toLowerCase()];
  }

  Future<void> _startTrip({
    required String driverName,
    required String vehicleNumber,
    required String origin,
    required String destination,
    required int passengerCount,
    required String missionType,
    required TripMode mode,
    required String statusMessage,
  }) async {
    if (_tripId != null || _busy) return;
    setState(() => _busy = true);
    try {
      final http.Response response = await http.post(
        Uri.parse('$apiBase/api/trips/start'),
        headers: const <String, String>{'Content-Type': 'application/json'},
        body: jsonEncode(<String, dynamic>{
          'driver_name': driverName,
          'vehicle_number': vehicleNumber,
          'origin': origin,
          'destination': destination,
          'passenger_count': passengerCount,
          'mission_type': missionType,
          'victim_reference': _optionalVictimReference(),
        }),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('Démarrage refusé (${response.statusCode})');
      }
      final Map<String, dynamic> body =
          jsonDecode(response.body) as Map<String, dynamic>;
      final LatLng? dest = _resolveDestination(destination);
      setState(() {
        _tripId = body['trip_id'] as String;
        _tripMode = mode;
        _activeMissionType = missionType;
        _distanceKm = 0;
        _tripStatus = statusMessage;
        _ambulanceStatus = mode == TripMode.ambulance
            ? '$statusMessage | ID: ${_tripId!}'
            : 'Aucune mission ambulance active.';
        _destinationLatLng = dest;
        _destinationFound = dest != null;
        _destinationStatus = dest == null
            ? 'Destination non géocodée: $destination'
            : 'Destination définie: $destination';
        _routePoints.clear();
      });
      _addLog('Trajet démarré: $driverName -> $destination');
      await _startLocationTracking();
    } catch (error) {
      _showSnack(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _startStandardTrip() async {
    final String? driver = _selectedFieldDriver;
    final String? vehicle = _selectedFieldVehicle;
    final int passengers = int.tryParse(_passengerController.text) ?? -1;
    final String origin = _originController.text.trim();
    final String destination = _destinationController.text.trim();
    if (driver == null || vehicle == null) {
      _showSnack('Sélectionnez chauffeur et véhicule.');
      return;
    }
    if (origin.isEmpty || destination.isEmpty || passengers < 0) {
      _showSnack('Complétez correctement le formulaire trajet.');
      return;
    }
    await _startTrip(
      driverName: driver,
      vehicleNumber: vehicle,
      origin: origin,
      destination: destination,
      passengerCount: passengers,
      missionType: 'STANDARD',
      mode: TripMode.standard,
      statusMessage: 'Trajet actif: $origin -> $destination',
    );
  }

  Future<void> _startAmbulanceBaseToFixed() async {
    if (_ambulanceFlowStep != AmbulanceFlowStep.baseToFixed) {
      _showSnack('Ordre requis: suivez l’étape active.');
      return;
    }
    final String? driver = _selectedAmbulanceDriver;
    final String? vehicle = _selectedAmbulanceVehicle;
    final String fixedPoint = _fixedPointController.text.trim();
    if (driver == null || vehicle == null || fixedPoint.isEmpty) {
      _showSnack('Renseignez chauffeur, ambulance et point fixe.');
      return;
    }
    await _startTrip(
      driverName: driver,
      vehicleNumber: vehicle,
      origin: 'CRH Base',
      destination: fixedPoint,
      passengerCount: 0,
      missionType: 'AMBULANCE_BASE_TO_FIXED',
      mode: TripMode.ambulance,
      statusMessage: 'Mission ambulance active: CRH Base -> $fixedPoint',
    );
  }

  Future<void> _startAmbulanceFixedToHospital() async {
    if (_ambulanceFlowStep != AmbulanceFlowStep.fixedToHospital) {
      _showSnack('Ordre requis: Base -> Point fixe d’abord.');
      return;
    }
    final String? driver = _selectedAmbulanceDriver;
    final String? vehicle = _selectedAmbulanceVehicle;
    final String fixedPoint = _fixedPointController.text.trim();
    final String hospital = (_selectedHospital ?? '').trim();
    final int victims = int.tryParse(_victimCountController.text) ?? -1;
    if (driver == null ||
        vehicle == null ||
        fixedPoint.isEmpty ||
        hospital.isEmpty ||
        victims < 1) {
      _showSnack('Renseignez données ambulance correctement.');
      return;
    }
    await _startTrip(
      driverName: driver,
      vehicleNumber: vehicle,
      origin: fixedPoint,
      destination: hospital,
      passengerCount: victims,
      missionType: 'AMBULANCE_FIXED_TO_HOSPITAL',
      mode: TripMode.ambulance,
      statusMessage: 'Mission ambulance active: $fixedPoint -> $hospital',
    );
  }

  Future<void> _startAmbulanceHospitalToFixed() async {
    if (_ambulanceFlowStep != AmbulanceFlowStep.hospitalToFixed) {
      _showSnack('Ordre requis: Point fixe -> Hôpital d’abord.');
      return;
    }
    final String? driver = _selectedAmbulanceDriver;
    final String? vehicle = _selectedAmbulanceVehicle;
    final String fixedPoint = _fixedPointController.text.trim();
    final String hospital = (_selectedHospital ?? '').trim();
    if (driver == null ||
        vehicle == null ||
        fixedPoint.isEmpty ||
        hospital.isEmpty) {
      _showSnack('Renseignez données ambulance correctement.');
      return;
    }
    await _startTrip(
      driverName: driver,
      vehicleNumber: vehicle,
      origin: hospital,
      destination: fixedPoint,
      passengerCount: 0,
      missionType: 'AMBULANCE_HOSPITAL_TO_FIXED',
      mode: TripMode.ambulance,
      statusMessage: 'Mission ambulance active: $hospital -> $fixedPoint',
    );
  }

  Future<void> _startLocationTracking() async {
    final bool enabled = await Geolocator.isLocationServiceEnabled();
    if (!enabled) {
      _showSnack('Activez le GPS.');
      return;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      _showSnack('Permission GPS obligatoire.');
      return;
    }
    await _positionSubscription?.cancel();
    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.best,
        distanceFilter: 10,
      ),
    ).listen((Position pos) async {
      final LatLng p = LatLng(pos.latitude, pos.longitude);
      setState(() {
        _lastPosition = pos;
        _driverLatLng = p;
        _routePoints.add(p);
      });
      if (_routePoints.length % 4 == 0) _mapController.move(p, 14);
      try {
        await _sendLocation(pos.latitude, pos.longitude);
      } catch (error) {
        _addLog('ERREUR GPS: $error');
      }
    });
  }

  Future<void> _sendLocation(double latitude, double longitude) async {
    if (_tripId == null) return;
    final http.Response response = await http.post(
      Uri.parse('$apiBase/api/trips/${_tripId!}/location'),
      headers: const <String, String>{'Content-Type': 'application/json'},
      body: jsonEncode(<String, dynamic>{
        'latitude': latitude,
        'longitude': longitude,
      }),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw Exception('Échec mise à jour GPS (${response.statusCode})');
    }
    final Map<String, dynamic> body = jsonDecode(response.body) as Map<String, dynamic>;
    final double? distance = (body['distance_km'] as num?)?.toDouble();
    if (distance != null && mounted) {
      setState(() => _distanceKm = distance);
    }
    _addLog(
      'GPS: ${latitude.toStringAsFixed(5)}, ${longitude.toStringAsFixed(5)} | Distance: ${_formatKm(_distanceKm)}',
    );
  }

  Future<void> _sendAlert(String alertType) async {
    if (_tripId == null || _busy) return;
    setState(() => _busy = true);
    try {
      final http.Response response = await http.post(
        Uri.parse('$apiBase/api/trips/${_tripId!}/alert'),
        headers: const <String, String>{'Content-Type': 'application/json'},
        body: jsonEncode(<String, dynamic>{'alert_type': alertType}),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('Alerte refusée (${response.statusCode})');
      }
      _addLog('ALERTE ENVOYÉE: $alertType');
    } catch (error) {
      _showSnack(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _updatePassengers() async {
    if (_tripId == null || _busy) return;
    final int count = _tripMode == TripMode.ambulance
        ? (int.tryParse(_victimCountController.text) ?? -1)
        : (int.tryParse(_passengerController.text) ?? -1);
    if (count < 0) {
      _showSnack('Nombre invalide.');
      return;
    }
    setState(() => _busy = true);
    try {
      final http.Response response = await http.post(
        Uri.parse('$apiBase/api/trips/${_tripId!}/passengers'),
        headers: const <String, String>{'Content-Type': 'application/json'},
        body: jsonEncode(<String, dynamic>{'passenger_count': count}),
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('Mise à jour refusée (${response.statusCode})');
      }
      _addLog('Passagers/victimes: $count');
    } catch (error) {
      _showSnack(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _finishTrip() async {
    if (_tripId == null || _busy) return;
    final String? mission = _activeMissionType;
    setState(() => _busy = true);
    try {
      final http.Response response =
          await http.post(Uri.parse('$apiBase/api/trips/${_tripId!}/finish'));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('Fin trajet refusée (${response.statusCode})');
      }
      await _positionSubscription?.cancel();
      _positionSubscription = null;
      setState(() {
        _tripId = null;
        _tripMode = null;
        _activeMissionType = null;
        _distanceKm = 0;
        _tripStatus = 'Aucun trajet actif.';
        _ambulanceStatus = 'Aucune mission ambulance active.';
        if (mission == 'AMBULANCE_BASE_TO_FIXED') {
          _ambulanceFlowStep = AmbulanceFlowStep.fixedToHospital;
        } else if (mission == 'AMBULANCE_FIXED_TO_HOSPITAL') {
          _ambulanceFlowStep = AmbulanceFlowStep.hospitalToFixed;
        } else if (mission == 'AMBULANCE_HOSPITAL_TO_FIXED') {
          _ambulanceFlowStep = AmbulanceFlowStep.baseToFixed;
        }
      });
      _addLog('Trajet terminé.');
    } catch (error) {
      _showSnack(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  String _formatKm(double value) => '${value.toStringAsFixed(2)} km';

  BoxDecoration _cardDecoration({Color? color, Border? border}) {
    return BoxDecoration(
      color: color ?? Colors.white,
      border: border ?? Border.all(color: const Color(0xFFDCE3ED)),
      borderRadius: BorderRadius.circular(12),
      boxShadow: const <BoxShadow>[
        BoxShadow(
          color: Color.fromRGBO(13, 32, 61, 0.08),
          blurRadius: 28,
          offset: Offset(0, 8),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool hasTrip = _tripId != null;
    final bool toHospital = _activeMissionType == 'AMBULANCE_FIXED_TO_HOSPITAL';
    final bool canBaseToFixed =
        !hasTrip && _ambulanceFlowStep == AmbulanceFlowStep.baseToFixed;
    final bool canFixedToHospital =
        !hasTrip && _ambulanceFlowStep == AmbulanceFlowStep.fixedToHospital;
    final bool canHospitalToFixed =
        !hasTrip && _ambulanceFlowStep == AmbulanceFlowStep.hospitalToFixed;
    final List<Marker> markers = <Marker>[
      if (_driverLatLng != null)
        Marker(
          point: _driverLatLng!,
          width: 40,
          height: 40,
          child: Transform.rotate(
            angle: _routePoints.length > 1
                ? _bearing(_routePoints[_routePoints.length - 2], _routePoints.last)
                : 0,
            child: Container(
              decoration: BoxDecoration(
                color: const Color(0xFFC7162B),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(Icons.local_hospital, color: Colors.white),
            ),
          ),
        ),
      if (_destinationLatLng != null)
        Marker(
          point: _destinationLatLng!,
          width: 26,
          height: 26,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: const Color(0xFFFFDEE3),
              border: Border.all(color: const Color(0xFFC7162B), width: 2),
            ),
          ),
        ),
    ];

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment.topRight,
            radius: 1.4,
            colors: <Color>[Color(0xFFDDE9F8), Color(0xFFF7F9FC)],
          ),
        ),
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(14),
            children: <Widget>[
              _buildHeaderCard(),
              const SizedBox(height: 12),
              _buildTripCard(hasTrip),
              const SizedBox(height: 12),
              _buildAmbulanceCard(hasTrip, canBaseToFixed, canFixedToHospital, canHospitalToFixed),
              const SizedBox(height: 12),
              _buildSecurityCard(hasTrip, toHospital),
              const SizedBox(height: 12),
              _buildMapCard(markers),
              const SizedBox(height: 12),
              _buildEventsCard(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeaderCard() => Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                const Expanded(
                  child: Text('Application Chauffeur CRH',
                      style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20)),
                ),
                IconButton(
                  onPressed: _catalogLoading ? null : _loadFleetCatalogs,
                  tooltip: 'Rafraichir la flotte',
                  icon: _catalogLoading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Tablette du véhicule: GPS en direct + alertes de sécurité',
              style: TextStyle(color: Color(0xFF52647F)),
            ),
          ],
        ),
      );

  Widget _buildTripCard(bool hasTrip) => Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          const Text('Démarrer un Trajet', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _selectedFieldDriver,
            decoration: const InputDecoration(labelText: 'Nom du chauffeur'),
            items: _drivers.map((String v) => DropdownMenuItem<String>(value: v, child: Text(v))).toList(),
            onChanged: hasTrip ? null : (String? v) => setState(() => _selectedFieldDriver = v),
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _selectedFieldVehicle,
            decoration: const InputDecoration(labelText: 'Numéro du véhicule'),
            items: _fieldVehicles.map((String v) => DropdownMenuItem<String>(value: v, child: Text(v))).toList(),
            onChanged: hasTrip ? null : (String? v) => setState(() => _selectedFieldVehicle = v),
          ),
          const SizedBox(height: 8),
          TextField(controller: _originController, enabled: !hasTrip, decoration: const InputDecoration(labelText: 'Point de départ')),
          const SizedBox(height: 8),
          TextField(controller: _destinationController, enabled: !hasTrip, decoration: const InputDecoration(labelText: 'Destination')),
          const SizedBox(height: 8),
          TextField(controller: _passengerController, enabled: !hasTrip, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Nombre de passagers')),
          const SizedBox(height: 10),
          FilledButton(onPressed: hasTrip ? null : _startStandardTrip, child: const Text('Quitter la base')),
          const SizedBox(height: 8),
          Text(_destinationStatus, style: TextStyle(color: _destinationFound ? const Color(0xFF1F7A5C) : const Color(0xFF8D5D11), fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Text(_tripStatus, style: const TextStyle(fontWeight: FontWeight.w700)),
          if (hasTrip) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              'Distance parcourue: ${_formatKm(_distanceKm)}',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
          if (_catalogError != null) ...<Widget>[
            const SizedBox(height: 6),
            Text(_catalogError!, style: const TextStyle(color: Color(0xFFB00020))),
          ],
        ]),
      );

  Widget _buildAmbulanceCard(bool hasTrip, bool canBaseToFixed, bool canFixedToHospital, bool canHospitalToFixed) =>
      Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(
          color: const Color(0xFFFFFBFC),
          border: Border.all(color: const Color(0xFFF1CAD0)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          const Text('Mission Ambulance (Victime -> Hôpital)', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(_flowLabel(), style: const TextStyle(color: Color(0xFF52647F))),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _selectedAmbulanceDriver,
            decoration: const InputDecoration(labelText: 'Nom du chauffeur ambulance'),
            items: _drivers.map((String v) => DropdownMenuItem<String>(value: v, child: Text(v))).toList(),
            onChanged: hasTrip ? null : (String? v) => setState(() => _selectedAmbulanceDriver = v),
          ),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _selectedAmbulanceVehicle,
            decoration: const InputDecoration(labelText: 'Numéro ambulance'),
            items: _ambulances.map((String v) => DropdownMenuItem<String>(value: v, child: Text(v))).toList(),
            onChanged: hasTrip ? null : (String? v) => setState(() => _selectedAmbulanceVehicle = v),
          ),
          const SizedBox(height: 8),
          TextField(controller: _fixedPointController, enabled: !hasTrip, decoration: const InputDecoration(labelText: 'Nom du point fixe')),
          const SizedBox(height: 8),
          TextField(controller: _victimReferenceController, enabled: !hasTrip, decoration: const InputDecoration(labelText: 'Référence victime')),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _selectedHospital,
            decoration: const InputDecoration(labelText: 'Hôpital de destination'),
            items: _hospitals.map((String v) => DropdownMenuItem<String>(value: v, child: Text(v))).toList(),
            onChanged: hasTrip ? null : (String? v) => setState(() => _selectedHospital = v),
          ),
          const SizedBox(height: 8),
          TextField(controller: _victimCountController, enabled: !hasTrip, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Nombre de victimes')),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: canBaseToFixed ? _startAmbulanceBaseToFixed : null, child: const Text('Base -> Point fixe')),
          const SizedBox(height: 8),
          FilledButton(onPressed: canFixedToHospital ? _startAmbulanceFixedToHospital : null, child: const Text('Point fixe -> Hôpital')),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: canHospitalToFixed ? _startAmbulanceHospitalToFixed : null, child: const Text('Hôpital -> Point fixe')),
          const SizedBox(height: 8),
          Text(_ambulanceStatus, style: const TextStyle(fontWeight: FontWeight.w700)),
        ]),
      );

  Widget _buildSecurityCard(bool hasTrip, bool toHospital) => Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          const Text('Actions de Sécurité', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: alerts
                .map((String a) => OutlinedButton(onPressed: hasTrip ? () => _sendAlert(a) : null, child: Text(a)))
                .toList(),
          ),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: hasTrip ? _updatePassengers : null, child: const Text('Mettre à jour passagers')),
          const SizedBox(height: 8),
          if (toHospital)
            FilledButton.tonal(onPressed: hasTrip ? _finishTrip : null, child: const Text('Arrivé à l\'hôpital')),
          if (!toHospital)
            FilledButton(
              onPressed: hasTrip ? _finishTrip : null,
              style: FilledButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
              child: const Text('Terminer le trajet'),
            ),
          if (_lastPosition != null) ...<Widget>[
            const SizedBox(height: 8),
            Text('Point GPS: ${_lastPosition!.latitude.toStringAsFixed(5)}, ${_lastPosition!.longitude.toStringAsFixed(5)}'),
          ],
        ]),
      );

  Widget _buildMapCard(List<Marker> markers) => Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          const Text('Carte en Direct', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          SizedBox(
            height: 390,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: FlutterMap(
                mapController: _mapController,
                options: const MapOptions(initialCenter: defaultCenter, initialZoom: 12),
                children: <Widget>[
                  TileLayer(
                    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                    userAgentPackageName: 'com.example.chauffeur_mobile',
                  ),
                  if (_routePoints.isNotEmpty)
                    PolylineLayer(
                      polylines: <Polyline>[
                        Polyline(points: _routePoints, strokeWidth: 4, color: const Color(0xFF0F6BCE)),
                      ],
                    ),
                  MarkerLayer(markers: markers),
                ],
              ),
            ),
          ),
        ]),
      );

  Widget _buildEventsCard() => Container(
        padding: const EdgeInsets.all(14),
        decoration: _cardDecoration(),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          const Text('Événements en Direct', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          if (_eventLogs.isEmpty)
            const Text('Aucun événement pour le moment.')
          else
            SizedBox(
              height: 240,
              child: ListView.separated(
                itemCount: _eventLogs.length,
                separatorBuilder: (_, __) => const SizedBox(height: 8),
                itemBuilder: (BuildContext context, int i) => Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF9FBFF),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFDCE3ED)),
                  ),
                  child: Text(_eventLogs[i]),
                ),
              ),
            ),
        ]),
      );
}

double _bearing(LatLng from, LatLng to) {
  final double lat1 = from.latitude * math.pi / 180;
  final double lat2 = to.latitude * math.pi / 180;
  final double dLon = (to.longitude - from.longitude) * math.pi / 180;
  final double y = math.sin(dLon) * math.cos(lat2);
  final double x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dLon);
  final double deg = (math.atan2(y, x) * 180 / math.pi + 360) % 360;
  return (deg - 90) * math.pi / 180;
}
