/// Data messages v2 envelope (docs/architecture/phase7-contracts.md §1.2-1.3).
///
/// Client → SFU:
/// `0x52 0x02 | flags | topicLen | topic | destCount | (idLen | id)* | payload`
///
/// SFU → client:
/// `0x52 0x03 | senderLen | sender | topicLen | topic | payload`
///
/// Anything that is not a well-formed delivery frame is a legacy message.
/// Every SDK checks itself against docs/architecture/data-envelope-vectors.json.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../errors.dart';

const dataEnvelopeMagic = 0x52;
const dataEnvelopeClientVersion = 0x02;
const dataEnvelopeDeliveryVersion = 0x03;

const maxDataTopicBytes = 255;
const maxDataDestinations = 64;
const maxDataIdentityBytes = 255;
const maxReliableDataPayloadBytes = 65536;
const maxLossyDataPayloadBytes = 1200;

/// Builds a v2 envelope. Throws [SwalvoException] (`invalidArgument`) when
/// the topic or destinations do not fit the format.
Uint8List encodeDataEnvelope(
  List<int> payload, {
  String? topic,
  List<String>? destinationIdentities,
}) {
  final topicBytes = utf8.encode(topic ?? '');
  if (topicBytes.length > maxDataTopicBytes) {
    throw SwalvoException(
      SwalvoErrorCode.invalidArgument,
      'The data topic is ${topicBytes.length} bytes once UTF-8 encoded, over the $maxDataTopicBytes-byte limit.',
    );
  }
  final destinations = destinationIdentities ?? const <String>[];
  if (destinations.length > maxDataDestinations) {
    throw SwalvoException(
      SwalvoErrorCode.invalidArgument,
      'A data message can target at most $maxDataDestinations participants, not ${destinations.length}.',
    );
  }
  final ids = <Uint8List>[];
  for (final identity in destinations) {
    final bytes = utf8.encode(identity);
    if (bytes.isEmpty || bytes.length > maxDataIdentityBytes) {
      throw SwalvoException(
        SwalvoErrorCode.invalidArgument,
        'A destination identity must be 1-$maxDataIdentityBytes bytes once UTF-8 encoded.',
      );
    }
    ids.add(bytes);
  }

  final builder = BytesBuilder(copy: false)
    ..addByte(dataEnvelopeMagic)
    ..addByte(dataEnvelopeClientVersion)
    ..addByte(0) // flags: all reserved
    ..addByte(topicBytes.length)
    ..add(topicBytes)
    ..addByte(ids.length);
  for (final id in ids) {
    builder
      ..addByte(id.length)
      ..add(id);
  }
  builder.add(payload);
  return builder.toBytes();
}

/// One received data message, decoded.
class DecodedDataMessage {
  const DecodedDataMessage({
    required this.payload,
    required this.legacy,
    this.senderIdentity,
    this.topic,
  });

  final Uint8List payload;

  /// True for a message without (or with a malformed) delivery header.
  final bool legacy;

  /// Null for legacy; `''` means the server sent it.
  final String? senderIdentity;

  /// Null for legacy; may be `''`.
  final String? topic;
}

/// Decodes what arrived on a data channel. Never throws.
DecodedDataMessage decodeDataDelivery(List<int> input) {
  final bytes = input is Uint8List ? input : Uint8List.fromList(input);
  DecodedDataMessage legacy() =>
      DecodedDataMessage(payload: bytes, legacy: true);

  if (bytes.length < 3 ||
      bytes[0] != dataEnvelopeMagic ||
      bytes[1] != dataEnvelopeDeliveryVersion) {
    return legacy();
  }
  var offset = 2;
  final senderLen = bytes[offset++];
  if (offset + senderLen > bytes.length) return legacy();
  final senderBytes = bytes.sublist(offset, offset + senderLen);
  offset += senderLen;
  if (offset >= bytes.length) return legacy();
  final topicLen = bytes[offset++];
  if (offset + topicLen > bytes.length) return legacy();
  final topicBytes = bytes.sublist(offset, offset + topicLen);
  offset += topicLen;

  final String sender;
  final String topic;
  try {
    sender = utf8.decode(senderBytes);
    topic = utf8.decode(topicBytes);
  } on FormatException {
    return legacy();
  }
  return DecodedDataMessage(
    payload: Uint8List.sublistView(bytes, offset),
    legacy: false,
    senderIdentity: sender,
    topic: topic,
  );
}
