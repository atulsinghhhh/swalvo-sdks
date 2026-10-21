import 'dart:async';
import 'dart:convert';

import 'package:swalvo_rtc/src/internal/signaling_client.dart';

/// A socket a test drives directly.
///
/// This is why [SwalvoSocket] is an interface: the join handshake, the
/// error taxonomy and the reconnect decision are all worth testing, and
/// none of them needs a server or a WebRTC stack.
class FakeSocket implements SwalvoSocket {
  FakeSocket();

  final incoming = StreamController<dynamic>.broadcast();
  final _closed = Completer<int?>();
  final sent = <Map<String, dynamic>>[];
  bool closeCalled = false;

  @override
  Stream<dynamic> get messages => incoming.stream;

  @override
  Future<int?> get closed => _closed.future;

  @override
  void send(String data) => sent.add(jsonDecode(data) as Map<String, dynamic>);

  @override
  Future<void> close([int? code, String? reason]) async {
    closeCalled = true;
    if (!_closed.isCompleted) _closed.complete(code);
  }

  /// Delivers a server message.
  void receive(Map<String, dynamic> message) =>
      incoming.add(jsonEncode(message));

  /// Simulates the server or network closing the connection.
  void drop(int code) {
    if (!_closed.isCompleted) _closed.complete(code);
  }

  Map<String, dynamic>? lastSent(String type) {
    for (final message in sent.reversed) {
      if (message['type'] == type) return message;
    }
    return null;
  }
}

/// An unsigned Swalvo RTC token whose claims the client can read.
String fakeToken(Map<String, dynamic> claims) {
  String encode(Object value) =>
      base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${encode({'alg': 'HS256', 'typ': 'JWT'})}'
      '.${encode(claims)}'
      '.signature-not-checked-by-the-client';
}
