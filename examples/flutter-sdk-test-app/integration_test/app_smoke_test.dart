// A real on-device/on-emulator smoke test: boots the actual app (not a
// widget wrapped in a test harness) and asserts the Config screen renders.
//
// Deliberately does not touch the network, camera, or microphone, and does
// not require a running dev-helper backend — those scenarios need a real
// backend and/or a second device and are covered in MANUAL_TESTING.md
// instead. There is no existing `integration_test` usage elsewhere in this
// repo to extend further than this.
//
// Run with: flutter test integration_test/app_smoke_test.dart
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:swalvo_sdk_test_app/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('app boots to the Config screen', (tester) async {
    app.main();
    await tester.pumpAndSettle();

    expect(find.text('Swalvo SDK Test App'), findsWidgets);
    expect(find.byKey(const Key('apiKeyField')), findsOneWidget);
    expect(find.byKey(const Key('backendUrlField')), findsOneWidget);
    expect(find.byKey(const Key('saveAndConnectButton')), findsOneWidget);
  });
}
