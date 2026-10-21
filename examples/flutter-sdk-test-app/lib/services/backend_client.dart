import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:swalvo_rtc/swalvo_rtc.dart' show SwalvoIceServer;

/// Thrown for any non-2xx response from the dev-helper backend. Carries
/// the backend's own sanitized error message (never a raw Swalvo secret —
/// the backend itself never echoes the API key back).
class BackendException implements Exception {
  BackendException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => 'BackendException($statusCode): $message';
}

class BackendHealth {
  const BackendHealth({required this.configured, this.baseUrl});

  factory BackendHealth.fromJson(Map<String, dynamic> json) => BackendHealth(
        configured: json['configured'] as bool? ?? false,
        baseUrl: json['baseUrl'] as String?,
      );

  final bool configured;
  final String? baseUrl;
}

/// What `POST /api/session` hands back: two independent short-lived
/// tokens, mirroring `examples/flutter-rtc-chat/lib/main.dart`'s `Session`.
class SessionCredentials {
  const SessionCredentials({
    required this.identity,
    required this.rtcToken,
    required this.endpoint,
    required this.roomName,
    required this.chatToken,
    required this.chatApiUrl,
    required this.chatRoomId,
    required this.iceServers,
  });

  factory SessionCredentials.fromJson(String identity, Map<String, dynamic> json) {
    final rtc = json['rtc'] as Map<String, dynamic>;
    final chat = json['chat'] as Map<String, dynamic>;

    return SessionCredentials(
      identity: identity,
      rtcToken: rtc['token'] as String,
      endpoint: rtc['endpoint'] as String,
      roomName: rtc['roomName'] as String,
      chatToken: chat['token'] as String,
      chatApiUrl: chat['apiUrl'] as String,
      chatRoomId: chat['roomId'] as String,
      iceServers: (rtc['iceServers'] as List<dynamic>? ?? const [])
          .map((value) => SwalvoIceServer.fromJson(value as Map<String, dynamic>))
          .toList(growable: false),
    );
  }

  final String identity;
  final String rtcToken;
  final String endpoint;
  final String roomName;
  final String chatToken;
  final String chatApiUrl;
  final String chatRoomId;
  final List<SwalvoIceServer> iceServers;
}

class LiveStatus {
  const LiveStatus({required this.streamId, required this.status, this.viewerCount, this.peakViewerCount});

  factory LiveStatus.fromJson(Map<String, dynamic> json) => LiveStatus(
        streamId: json['streamId'] as String,
        status: json['status'] as String? ?? 'UNKNOWN',
        viewerCount: json['viewerCount'] as int?,
        peakViewerCount: json['peakViewerCount'] as int?,
      );

  final String streamId;
  final String status;
  final int? viewerCount;
  final int? peakViewerCount;
}

/// Talks only to this example's own dev-helper backend (`server.mjs`) —
/// never directly to Swalvo. See app_config.dart and server.mjs for why.
class BackendClient {
  BackendClient({required this.baseUrl, http.Client? httpClient}) : _http = httpClient ?? http.Client();

  final String baseUrl;
  final http.Client _http;

  static const _jsonHeaders = {'content-type': 'application/json'};

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Future<void> configure({required String apiKey, String? swalvoBaseUrl}) async {
    final response = await _http.post(
      _uri('/api/configure'),
      headers: _jsonHeaders,
      body: jsonEncode({'apiKey': apiKey, if (swalvoBaseUrl != null) 'baseUrl': swalvoBaseUrl}),
    );
    _checkOk(response);
  }

  Future<BackendHealth> health() async {
    final response = await _http.get(_uri('/api/health'));
    _checkOk(response);
    return BackendHealth.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<SessionCredentials> createSession({required String room, required String identity}) async {
    final response = await _http.post(
      _uri('/api/session'),
      headers: _jsonHeaders,
      body: jsonEncode({'room': room, 'identity': identity}),
    );
    _checkOk(response);
    return SessionCredentials.fromJson(identity, jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// Returns the raw decoded credential JSON: it mirrors
  /// `SwalvoLiveStreamCredentials.fromJson` field-for-field (see
  /// swalvo_live's types.dart), so the caller passes it straight through
  /// rather than this client re-modeling it.
  Future<Map<String, dynamic>> createLiveHost({
    String? streamId,
    String? title,
    required String identity,
  }) async {
    final response = await _http.post(
      _uri('/api/live/host'),
      headers: _jsonHeaders,
      body: jsonEncode({
        if (streamId != null) 'streamId': streamId,
        if (title != null) 'title': title,
        'identity': identity,
      }),
    );
    _checkOk(response);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> createLiveViewer({
    required String streamId,
    required String identity,
    bool acceptPlayback = false,
  }) async {
    final response = await _http.post(
      _uri('/api/live/viewer'),
      headers: _jsonHeaders,
      body: jsonEncode({'streamId': streamId, 'identity': identity, 'acceptPlayback': acceptPlayback}),
    );
    _checkOk(response);
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<LiveStatus> liveStatus(String streamId) async {
    final response = await _http.get(_uri('/api/live/$streamId/status'));
    _checkOk(response);
    return LiveStatus.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  Future<void> startLiveStream(String streamId) async {
    _checkOk(await _http.post(_uri('/api/live/$streamId/start')));
  }

  Future<void> endLiveStream(String streamId) async {
    _checkOk(await _http.post(_uri('/api/live/$streamId/end')));
  }

  void _checkOk(http.Response response) {
    if (response.statusCode >= 400) {
      var message = 'Request failed (${response.statusCode})';
      try {
        final body = jsonDecode(response.body) as Map<String, dynamic>;
        message = body['error'] as String? ?? message;
      } catch (_) {
        // Non-JSON error body: fall back to the generic message above.
      }
      throw BackendException(message, statusCode: response.statusCode);
    }
  }

  void dispose() => _http.close();
}
