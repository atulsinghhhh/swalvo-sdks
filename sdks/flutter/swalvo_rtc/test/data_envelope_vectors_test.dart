import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/errors.dart';
import 'package:swalvo_rtc/src/internal/data_envelope.dart';

/// Checks the data message v2 envelope codec against the shared vectors
/// (docs/architecture/data-envelope-vectors.json, phase7-contracts
/// §1.2-1.3). Every client SDK runs the same cases byte for byte.
void main() {
  final vectors = jsonDecode(
    File('../../../docs/architecture/data-envelope-vectors.json')
        .readAsStringSync(),
  ) as Map<String, dynamic>;

  Uint8List hex(String value) => Uint8List.fromList([
        for (var i = 0; i < value.length; i += 2)
          int.parse(value.substring(i, i + 2), radix: 16),
      ]);
  String toHex(List<int> bytes) =>
      bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

  test('limits match the vectors file', () {
    final limits = (vectors['format'] as Map<String, dynamic>)['limits']
        as Map<String, dynamic>;
    expect(limits['maxTopicBytes'], maxDataTopicBytes);
    expect(limits['maxDestinations'], maxDataDestinations);
    expect(limits['maxIdentityBytes'], maxDataIdentityBytes);
    expect(limits['maxReliablePayloadBytes'], maxReliableDataPayloadBytes);
    expect(limits['maxLossyPayloadBytes'], maxLossyDataPayloadBytes);
  });

  group('encode', () {
    for (final raw in vectors['encode'] as List<dynamic>) {
      final c = raw as Map<String, dynamic>;
      test(c['name'] as String, () {
        final input = c['input'] as Map<String, dynamic>;
        final encoded = encodeDataEnvelope(
          hex(input['payloadHex'] as String),
          topic: input['topic'] as String,
          destinationIdentities:
              (input['destinationIdentities'] as List<dynamic>).cast<String>(),
        );
        expect(toHex(encoded), c['expectedHex']);
      });
    }
  });

  group('encode errors', () {
    for (final raw in vectors['encodeErrors'] as List<dynamic>) {
      final c = raw as Map<String, dynamic>;
      test(c['name'] as String, () {
        final input = c['input'] as Map<String, dynamic>;
        expect(
          () => encodeDataEnvelope(
            hex(input['payloadHex'] as String),
            topic: input['topic'] as String,
            destinationIdentities:
                (input['destinationIdentities'] as List<dynamic>)
                    .cast<String>(),
          ),
          throwsA(isA<SwalvoException>()
              .having((e) => e.code, 'code', SwalvoErrorCode.invalidArgument)),
        );
      });
    }
  });

  group('decode', () {
    for (final raw in vectors['decode'] as List<dynamic>) {
      final c = raw as Map<String, dynamic>;
      test(c['name'] as String, () {
        final expected = c['expected'] as Map<String, dynamic>;
        final decoded = decodeDataDelivery(hex(c['inputHex'] as String));
        expect(decoded.legacy, expected['legacy']);
        expect(decoded.senderIdentity, expected['senderIdentity']);
        expect(decoded.topic, expected['topic']);
        expect(toHex(decoded.payload), expected['payloadHex']);
      });
    }
  });
}
