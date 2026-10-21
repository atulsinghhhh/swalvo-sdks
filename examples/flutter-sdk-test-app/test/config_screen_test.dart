import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:swalvo_sdk_test_app/config/app_config.dart';
import 'package:swalvo_sdk_test_app/screens/config_screen.dart';
import 'package:swalvo_sdk_test_app/services/backend_client.dart';
import 'package:swalvo_sdk_test_app/services/diagnostic_log.dart';

Future<void> _pumpConfigScreen(
  WidgetTester tester, {
  required Future<http.Response> Function(http.Request request) handler,
  ValueChanged<BackendClient>? onConnected,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: ConfigScreen(
        config: AppConfig(),
        diagnostics: DiagnosticLog(),
        onConnected: onConnected ?? (_) {},
        clientFactory: (baseUrl) => BackendClient(baseUrl: baseUrl, httpClient: MockClient((r) => handler(r))),
      ),
    ),
  );
}

void main() {
  testWidgets('API key field is obscured', (tester) async {
    await _pumpConfigScreen(tester, handler: (_) async => http.Response('{}', 200));

    final field = tester.widget<TextField>(find.byKey(const Key('apiKeyField')));
    expect(field.obscureText, isTrue);
  });

  testWidgets('Save & Connect goes Not configured -> Connected on success', (tester) async {
    BackendClient? connected;
    await _pumpConfigScreen(
      tester,
      onConnected: (client) => connected = client,
      handler: (request) async {
        if (request.url.path == '/api/configure') return http.Response('{"ok":true}', 200);
        if (request.url.path == '/api/health') {
          return http.Response(jsonEncode({'configured': true, 'baseUrl': 'http://localhost:4100'}), 200);
        }
        return http.Response('not found', 404);
      },
    );

    expect(find.text('Not configured.'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('apiKeyField')), 'rvk_test.secret');
    await tester.tap(find.byKey(const Key('saveAndConnectButton')));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Connected.'), findsOneWidget);
    expect(connected, isNotNull);
    // The key field is cleared once it has done its one job.
    final field = tester.widget<TextField>(find.byKey(const Key('apiKeyField')));
    expect(field.controller!.text, isEmpty);
  });

  testWidgets('a backend error surfaces a sanitized message and a working Retry button', (tester) async {
    var attempts = 0;
    await _pumpConfigScreen(
      tester,
      handler: (request) async {
        attempts++;
        if (request.url.path == '/api/configure') {
          return http.Response(jsonEncode({'error': 'apiKey is required'}), 400);
        }
        return http.Response('{}', 200);
      },
    );

    await tester.enterText(find.byKey(const Key('apiKeyField')), 'x');
    await tester.tap(find.byKey(const Key('saveAndConnectButton')));
    await tester.pumpAndSettle();

    expect(find.textContaining('apiKey is required'), findsOneWidget);
    expect(attempts, 1);

    await tester.ensureVisible(find.byKey(const Key('retryButton')));
    await tester.tap(find.byKey(const Key('retryButton')));
    await tester.pumpAndSettle();

    expect(attempts, 2);
  });
}
