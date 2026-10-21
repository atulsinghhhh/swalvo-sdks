import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_sdk_test_app/services/diagnostic_log.dart';

void main() {
  group('redactSecrets', () {
    test('redacts a Bearer token', () {
      final out = redactSecrets('Authorization: Bearer abc.def-123_XYZ');
      expect(out, 'Authorization: Bearer [REDACTED]');
    });

    test('redacts an rvk-style API key anywhere in the string', () {
      final out = redactSecrets('failed with key rvk_live.supersecret123');
      expect(out, isNot(contains('supersecret123')));
      expect(out, contains('[REDACTED_KEY]'));
    });

    test('redacts a JSON-shaped token/apiKey field', () {
      final out = redactSecrets('{"token": "abc123", "other": "fine"}');
      expect(out, isNot(contains('abc123')));
      expect(out, contains('other'));
      expect(out, contains('fine'));
    });

    test('leaves ordinary text untouched', () {
      const message = 'Joined room sdk-test-room as tester';
      expect(redactSecrets(message), message);
    });
  });

  group('DiagnosticLog', () {
    test('log() redacts before storing and newest event is first', () {
      final log = DiagnosticLog();
      log.log(DiagnosticCategory.connection, 'ok');
      log.log(DiagnosticCategory.error, 'Bearer sekrit-token-value failed');

      expect(log.events, hasLength(2));
      expect(log.events.first.message, isNot(contains('sekrit-token-value')));
      expect(log.events.first.category, DiagnosticCategory.error);
      expect(log.events.last.category, DiagnosticCategory.connection);
    });

    test('caps the buffer at maxEvents', () {
      final log = DiagnosticLog();
      for (var i = 0; i < DiagnosticLog.maxEvents + 10; i++) {
        log.log(DiagnosticCategory.room, 'event $i');
      }
      expect(log.events.length, DiagnosticLog.maxEvents);
      // Oldest events were dropped; the newest survives.
      expect(log.events.first.message, 'event ${DiagnosticLog.maxEvents + 9}');
    });

    test('clear() empties the log and notifies listeners', () {
      final log = DiagnosticLog();
      log.log(DiagnosticCategory.chat, 'hello');

      var notified = false;
      log.addListener(() => notified = true);
      log.clear();

      expect(log.events, isEmpty);
      expect(notified, isTrue);
    });
  });
}
