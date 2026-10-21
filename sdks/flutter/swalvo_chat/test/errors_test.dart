import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';

void main() {
  group('parseChatErrorCode via fromServer', () {
    test('maps the server codes a client branches on', () {
      final cases = <String, SwalvoChatErrorCode>{
        'INVALID_TOKEN': SwalvoChatErrorCode.invalidToken,
        'TOKEN_EXPIRED': SwalvoChatErrorCode.tokenExpired,
        'TOKEN_REVOKED': SwalvoChatErrorCode.tokenRevoked,
        'PERMISSION_DENIED': SwalvoChatErrorCode.permissionDenied,
        'NOT_A_MEMBER': SwalvoChatErrorCode.notAMember,
        'ROOM_NOT_FOUND': SwalvoChatErrorCode.roomNotFound,
        'MESSAGE_TOO_LARGE': SwalvoChatErrorCode.messageTooLarge,
        'INVALID_CURSOR': SwalvoChatErrorCode.invalidCursor,
        'RATE_LIMITED': SwalvoChatErrorCode.rateLimited,
      };

      cases.forEach((raw, expected) {
        final error =
            SwalvoChatException.fromServer({'code': raw, 'message': 'x'});
        expect(error.code, expected, reason: raw);
      });
    });

    test('keeps an unrecognised code visible instead of discarding it', () {
      // A newer server must widen the model, not break an app, but the
      // developer still needs to see what actually arrived.
      final error = SwalvoChatException.fromServer({
        'code': 'SOME_FUTURE_CODE',
        'message': 'from a newer server',
      });

      expect(error.code, SwalvoChatErrorCode.unknown);
      expect(error.rawCode, 'SOME_FUTURE_CODE');
      expect(error.toString(), contains('SOME_FUTURE_CODE'));
    });

    test('carries retryAfterSeconds through on a rate limit', () {
      final error = SwalvoChatException.fromServer({
        'code': 'RATE_LIMITED',
        'message': 'slow down',
        'retryAfterSeconds': 7,
      });

      expect(error.retryAfterSeconds, 7);
      expect(error.isRetryable, isTrue);
    });
  });

  group('isRetryable', () {
    test('is true for transient failures', () {
      for (final code in [
        SwalvoChatErrorCode.networkError,
        SwalvoChatErrorCode.timeout,
        SwalvoChatErrorCode.connectionClosed,
        SwalvoChatErrorCode.rateLimited,
        SwalvoChatErrorCode.internalError,
      ]) {
        expect(
          SwalvoChatException(code, 'x').isRetryable,
          isTrue,
          reason: code.name,
        );
      }
    });

    test('is false for failures that would fail identically forever', () {
      // Retrying a rejected token or an oversized message just wastes
      // battery and hammers the server.
      for (final code in [
        SwalvoChatErrorCode.invalidToken,
        SwalvoChatErrorCode.tokenRevoked,
        SwalvoChatErrorCode.permissionDenied,
        SwalvoChatErrorCode.messageTooLarge,
        SwalvoChatErrorCode.notAMember,
      ]) {
        expect(
          SwalvoChatException(code, 'x').isRetryable,
          isFalse,
          reason: code.name,
        );
      }
    });
  });
}
