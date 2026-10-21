import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:swalvo_sdk_test_app/services/backend_client.dart';

http.Client _fakeClient(Future<http.Response> Function(http.Request request) handler) =>
    MockClient((request) async => handler(request));

void main() {
  group('BackendClient.configure', () {
    test('posts apiKey and baseUrl as JSON', () async {
      http.Request? captured;
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient((request) async {
          captured = request;
          return http.Response('{"ok":true}', 200);
        }),
      );

      await client.configure(apiKey: 'rvk_test.secret', swalvoBaseUrl: 'http://localhost:4100');

      expect(captured!.url.toString(), 'http://backend.test/api/configure');
      final body = jsonDecode(captured!.body) as Map<String, dynamic>;
      expect(body['apiKey'], 'rvk_test.secret');
      expect(body['baseUrl'], 'http://localhost:4100');
    });

    test('throws BackendException with the server-reported message on failure', () async {
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient((request) async => http.Response(jsonEncode({'error': 'apiKey is required'}), 400)),
      );

      await expectLater(
        () => client.configure(apiKey: 'anything'),
        throwsA(isA<BackendException>().having((e) => e.message, 'message', 'apiKey is required')),
      );
    });
  });

  group('BackendClient.health', () {
    test('parses configured and baseUrl', () async {
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient(
          (request) async => http.Response(jsonEncode({'configured': true, 'baseUrl': 'http://localhost:4100'}), 200),
        ),
      );

      final health = await client.health();
      expect(health.configured, isTrue);
      expect(health.baseUrl, 'http://localhost:4100');
    });
  });

  group('BackendClient.createSession', () {
    test('builds SessionCredentials from the response shape', () async {
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient(
          (request) async => http.Response(
            jsonEncode({
              'rtc': {
                'token': 'rtc-token',
                'endpoint': 'wss://rtc.example',
                'roomName': 'standup',
                'iceServers': <Map<String, dynamic>>[],
              },
              'chat': {'token': 'chat-token', 'apiUrl': 'https://chat.example', 'roomId': 'conv-1'},
            }),
            200,
          ),
        ),
      );

      final session = await client.createSession(room: 'standup', identity: 'alice');
      expect(session.identity, 'alice');
      expect(session.rtcToken, 'rtc-token');
      expect(session.endpoint, 'wss://rtc.example');
      expect(session.roomName, 'standup');
      expect(session.chatToken, 'chat-token');
      expect(session.chatApiUrl, 'https://chat.example');
      expect(session.chatRoomId, 'conv-1');
    });

    test('never surfaces a raw key in a thrown error message', () async {
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient(
          (request) async => http.Response(jsonEncode({'error': 'Not configured: POST /api/configure first'}), 400),
        ),
      );

      try {
        await client.createSession(room: 'r', identity: 'i');
        fail('expected a BackendException');
      } on BackendException catch (error) {
        expect(error.message, isNot(contains('rvk_')));
        expect(error.statusCode, 400);
      }
    });
  });

  group('BackendClient live streaming', () {
    test('createLiveHost forwards streamId only when provided', () async {
      http.Request? captured;
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient((request) async {
          captured = request;
          return http.Response(jsonEncode({'streamId': 's1', 'role': 'HOST'}), 200);
        }),
      );

      final result = await client.createLiveHost(title: 'Demo', identity: 'host1');
      expect(result['streamId'], 's1');
      final body = jsonDecode(captured!.body) as Map<String, dynamic>;
      expect(body.containsKey('streamId'), isFalse);
      expect(body['title'], 'Demo');
    });

    test('liveStatus parses viewer counts', () async {
      final client = BackendClient(
        baseUrl: 'http://backend.test',
        httpClient: _fakeClient(
          (request) async => http.Response(
            jsonEncode({'streamId': 's1', 'status': 'LIVE', 'viewerCount': 3, 'peakViewerCount': 9}),
            200,
          ),
        ),
      );

      final status = await client.liveStatus('s1');
      expect(status.status, 'LIVE');
      expect(status.viewerCount, 3);
      expect(status.peakViewerCount, 9);
    });
  });
}
