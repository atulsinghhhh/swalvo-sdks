import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:swalvo_chat/swalvo_chat.dart';
import 'package:swalvo_chat/src/rest_client.dart';

import 'fake_chat_socket.dart';

/// A stand-in for the Swalvo REST API: routes keyed `METHOD /path`.
///
/// Unrouted requests come back 404 with a chat-shaped error body, which is
/// what makes a test that forgot a route fail loudly instead of hanging.
class FakeApi {
  final requests = <http.Request>[];
  final routes = <String, http.Response Function(http.Request request)>{};

  /// While true, every request fails as if the device were offline.
  bool offline = false;

  late final MockClient client = MockClient((request) async {
    requests.add(request);
    if (offline) throw Exception('offline');
    final key = '${request.method} ${request.url.path}';
    final handler = routes[key];
    if (handler == null) {
      return http.Response(
        jsonEncode({'code': 'ROOM_NOT_FOUND', 'message': 'no route for $key'}),
        404,
      );
    }
    return handler(request);
  });

  /// Encoded as UTF-8 bytes: `http.Response`'s String constructor uses
  /// latin1 and throws on an emoji, which then looks like a network error.
  void json(String key, Object? body, {int status = 200}) {
    routes[key] = (_) => http.Response.bytes(
          utf8.encode(jsonEncode(body)),
          status,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
  }

  Iterable<http.Request> matching(String method, String path) => requests
      .where((request) => request.method == method && request.url.path == path);
}

/// One client, its sockets and its fake API, wired for fast deterministic
/// reconnects.
class Harness {
  Harness({
    String token = 'test-token',
    SwalvoOutboxStorage? storage,
    Duration reconnectDelay = const Duration(milliseconds: 1),
    this.userId = 'alice',
  }) {
    chat = SwalvoChat(
      token: token,
      apiUrl: 'https://api.example.test',
      outboxStorage: storage,
      gapFillDelay: const Duration(milliseconds: 20),
      reconnectDelay: (_) => reconnectDelay,
      restClient: SwalvoRestClient(
        baseUrl: 'https://api.example.test',
        token: token,
        httpClient: api.client,
      ),
      connectChannel: (uri) {
        final socket = FakeChatSocket();
        sockets.add(socket);
        // The hello must land after the client subscribes, which happens
        // synchronously just after this factory returns.
        scheduleMicrotask(
            () => socket.receive({'type': 'connected', 'userId': userId}));
        return socket;
      },
    );
  }

  final String userId;
  final api = FakeApi();
  final sockets = <FakeChatSocket>[];
  late final SwalvoChat chat;
  final _answered = <String>{};

  FakeChatSocket get socket => sockets.last;

  /// Connects and acks the join with the room's public id.
  Future<void> connect([String room = 'conv_1']) async {
    final connecting = chat.connect(room);
    await waitFor(
        () => sockets.isNotEmpty && socket.ofType('room.join').isNotEmpty);
    ackJoins(socket);
    await connecting;
  }

  /// Acks every unanswered `room.join` on [target] as the real gateway
  /// does: with the conversation's public id.
  void ackJoins(FakeChatSocket target) {
    for (final frame in target.ofType('room.join').toList()) {
      final id = frame['id'] as String;
      if (!_answered.add(id)) continue;
      target.receive({
        'type': 'room.joined',
        'id': id,
        'room': frame['room'],
      });
    }
  }

  /// Answers the newest unanswered frame of [type] with an ack.
  void ack(String type, [Object? data]) {
    final frame = socket.ofType(type).lastWhere(
        (frame) => !_answered.contains(frame['id']),
        orElse: () => throw StateError('no unanswered $type frame'));
    _answered.add(frame['id'] as String);
    socket
        .receive({'type': 'ack', 'id': frame['id'], 'ok': true, 'data': data});
  }

  /// Answers the newest unanswered frame of [type] with an error.
  void reject(String type, String code,
      {Map<String, dynamic> extra = const {}}) {
    final frame = socket
        .ofType(type)
        .lastWhere((frame) => !_answered.contains(frame['id']));
    _answered.add(frame['id'] as String);
    socket.receive({
      'type': 'error',
      'id': frame['id'],
      'code': code,
      'message': code,
      ...extra
    });
  }

  /// Drops the socket and waits for the replacement to join.
  Future<FakeChatSocket> reconnect({int code = 1006}) async {
    final before = sockets.length;
    socket.drop(code);
    await waitFor(
        () => sockets.length > before && socket.ofType('room.join').isNotEmpty);
    ackJoins(socket);
    await pump();
    return socket;
  }

  void dispose() => chat.dispose();
}

/// Lets microtasks and zero-length timers run.
Future<void> pump([int times = 10]) async {
  for (var i = 0; i < times; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// Polls [condition] with short real delays, failing after two seconds.
Future<void> waitFor(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 2));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition never became true');
    }
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

/// A message the way the server serializes one.
Map<String, dynamic> messageJson(
  int n, {
  String room = 'conv_1',
  String sender = 'bob',
  List<String>? mentions,
  Map<String, dynamic>? metadata,
  String? clientMessageId,
}) {
  final createdAt =
      DateTime.utc(2026, 1, 1).add(Duration(milliseconds: n)).toIso8601String();
  final id = 'msg_${n.toString().padLeft(4, '0')}';
  return {
    'id': id,
    'cursor': 'cur_$n',
    'seq': '$n',
    'roomId': room,
    'conversationId': room,
    'senderId': sender,
    'type': 'text',
    'text': 'm$n',
    'reactions': <dynamic>[],
    'mentions': mentions ?? <String>[],
    if (metadata != null) 'metadata': metadata,
    if (clientMessageId != null) 'clientMessageId': clientMessageId,
    'edited': false,
    'deleted': false,
    'createdAt': createdAt,
    'updatedAt': createdAt,
  };
}

/// A syntactically valid JWT with the given claims. Nothing checks the
/// signature client-side.
String fakeJwt(Map<String, dynamic> claims) {
  String encode(Object value) =>
      base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${encode({'alg': 'HS256'})}.${encode(claims)}.sig';
}
