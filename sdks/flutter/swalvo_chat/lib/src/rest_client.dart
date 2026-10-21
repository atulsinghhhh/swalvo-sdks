import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'errors.dart';

/// The HTTP half of the chat SDK.
///
/// Real-time delivery rides the WebSocket; history, attachments and
/// one-off reads go through here. Asking a socket for a paginated list is
/// the wrong shape: it blocks the frame the next message is waiting on;
/// and history is exactly what you need when the socket *isn't* up.
///
/// Authenticated with the same chat token as the socket: one credential,
/// two transports.
class SwalvoRestClient {
  SwalvoRestClient({
    required String baseUrl,
    required String token,
    http.Client? httpClient,
  })  : _baseUrl = baseUrl.replaceAll(RegExp(r'/$'), ''),
        _token = token,
        _http = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  final String _baseUrl;
  final http.Client _http;
  final bool _ownsClient;
  String _token;

  set token(String value) => _token = value;

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? query,
  }) async =>
      _send('GET', path, query: query);

  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,
  }) async =>
      _send('POST', path, body: body);

  Future<Map<String, dynamic>> patch(
    String path, {
    Map<String, dynamic>? body,
  }) async =>
      _send('PATCH', path, body: body);

  Future<Map<String, dynamic>> delete(String path) async =>
      _send('DELETE', path);

  Future<List<dynamic>> getList(
    String path, {
    Map<String, String>? query,
  }) async {
    final response = await _raw('GET', path, query: query);
    final decoded = _decode(response);
    return decoded is List ? decoded : const [];
  }

  /// Any method, any response shape: a bare list, a wrapped page, or
  /// nothing. For the Phase 3 routes whose response shape the SDK reads
  /// defensively rather than assumes.
  Future<Object?> requestAny(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async =>
      _decode(await _raw(method, path, body: body, query: query));

  /// A raw `PUT` of bytes to an absolute URL — the signed object-storage
  /// upload URL of an attachment ticket. No chat token: the URL itself is
  /// the credential, and sending ours to a storage host would leak it.
  /// Returns the HTTP status.
  Future<int> putBytes(
    Uri url,
    Uint8List bytes, {
    Map<String, String> headers = const {},
  }) async {
    final request = http.Request('PUT', url)
      ..headers.addAll(headers)
      ..bodyBytes = bytes;
    try {
      final streamed = await _http.send(request);
      final response = await http.Response.fromStream(streamed);
      return response.statusCode;
    } catch (error) {
      throw SwalvoChatException(
        SwalvoChatErrorCode.networkError,
        'Could not reach object storage to upload the file.',
        cause: error,
      );
    }
  }

  Future<void> close() async {
    // Only close a client we created. Closing one the app handed us would
    // break every other request it's making.
    if (_ownsClient) {
      _http.close();
    }
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    final response = await _raw(method, path, body: body, query: query);
    final decoded = _decode(response);
    return decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
  }

  Future<http.Response> _raw(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    final uri = Uri.parse('$_baseUrl$path').replace(
      queryParameters: query == null || query.isEmpty ? null : query,
    );

    final request = http.Request(method, uri)
      ..headers['content-type'] = 'application/json'
      ..headers['authorization'] = 'Bearer $_token';

    if (body != null) {
      request.body = jsonEncode(body);
    }

    try {
      final streamed = await _http.send(request);
      return await http.Response.fromStream(streamed);
    } catch (error) {
      // A genuine transport failure. DNS, offline, TLS. An HTTP error
      // status is not this; that arrives as a response and is handled in
      // _decode.
      throw SwalvoChatException(
        SwalvoChatErrorCode.networkError,
        'Could not reach Swalvo.',
        cause: error,
      );
    }
  }

  Object? _decode(http.Response response) {
    if (response.body.isEmpty) {
      // An empty error body is still an error. Returning null here used to
      // turn a bodiless 4xx/5xx into an apparent success.
      if (response.statusCode >= 400) {
        throw SwalvoChatException(
          SwalvoChatErrorCode.internalError,
          'Request failed with status ${response.statusCode}.',
        );
      }
      return null;
    }
    if (response.statusCode == 204) {
      return null;
    }

    Object? payload;
    try {
      payload = jsonDecode(response.body);
    } catch (error) {
      throw SwalvoChatException(
        SwalvoChatErrorCode.internalError,
        'Swalvo returned a response that could not be parsed.',
        cause: error,
      );
    }

    if (response.statusCode >= 400) {
      // Surface the server's own Swalvo code rather than the HTTP status,
      // so a caller can tell MESSAGE_TOO_LARGE from ATTACHMENT_TOO_LARGE
      // even though both are 413.
      if (payload is Map<String, dynamic>) {
        throw SwalvoChatException.fromServer(payload);
      }
      throw SwalvoChatException(
        SwalvoChatErrorCode.internalError,
        'Request failed with status ${response.statusCode}.',
      );
    }

    return payload;
  }
}
