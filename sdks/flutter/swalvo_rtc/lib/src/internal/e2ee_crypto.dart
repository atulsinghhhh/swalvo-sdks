import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// The E2EE key schedule (docs/architecture/phase5-contracts.md §3.1), in
/// pure Dart. Byte-for-byte the web SDK's `packages/sdk/src/e2ee/crypto.ts`
/// and checked against docs/architecture/e2ee-vectors.json.
///
/// ```
/// material  = PBKDF2-HMAC-SHA256(utf8(passphrase), utf8("LivqenoE2EE:" + roomId), 100000, 32)
/// aesKey    = HKDF-SHA256(material, salt "LivqenoRatchet", info 128 zero bytes, 16)   // native FrameCryptor
/// material' = HKDF-SHA256(material, salt "LivqenoRatchet", info 128 zero bytes, 32)   // ratchet
/// ```
///
/// Only the first line runs here at call time: flutter_webrtc's
/// `FrameCryptor` (libwebrtc) is handed `material` and does the HKDF steps
/// and the frame encryption natively, configured by [ratchetSalt] and
/// `KeyDerivationAlgorithm.kHKDF`. [hkdfSha256] is here so a ratchet asked
/// for before the native key provider exists still lands on the same key,
/// and so the derivation is unit-testable without a device.

// legacy: KDF labels — changing them breaks E2EE with every other client.
const passphraseSaltPrefix = 'LivqenoE2EE:';
const ratchetSaltString = 'LivqenoRatchet';
const pbkdf2Iterations = 100000;
const defaultRatchetWindow = 8;

/// `utf8("LivqenoRatchet")`, the `ratchetSalt` handed to the native key provider.
final Uint8List ratchetSalt =
    Uint8List.fromList(utf8.encode(ratchetSaltString));

Uint8List pbkdf2Sha256(
  List<int> password,
  List<int> salt,
  int iterations,
  int length,
) {
  final hmac = Hmac(sha256, password);
  final out = BytesBuilder(copy: false);
  var block = 1;
  while (out.length < length) {
    final first = <int>[
      ...salt,
      (block >> 24) & 0xff,
      (block >> 16) & 0xff,
      (block >> 8) & 0xff,
      block & 0xff,
    ];
    var u = hmac.convert(first).bytes;
    final t = Uint8List.fromList(u);
    for (var i = 1; i < iterations; i++) {
      u = hmac.convert(u).bytes;
      for (var j = 0; j < t.length; j++) {
        t[j] ^= u[j];
      }
    }
    out.add(t);
    block++;
  }
  return Uint8List.fromList(out.takeBytes().sublist(0, length));
}

Uint8List hkdfSha256(
    List<int> ikm, List<int> salt, List<int> info, int length) {
  final prk = Hmac(sha256, salt).convert(ikm).bytes;
  final expand = Hmac(sha256, prk);
  final out = BytesBuilder(copy: false);
  var previous = <int>[];
  var counter = 1;
  while (out.length < length) {
    previous = expand.convert([...previous, ...info, counter]).bytes;
    out.add(previous);
    counter++;
  }
  return Uint8List.fromList(out.takeBytes().sublist(0, length));
}

final _hkdfInfo = Uint8List(128);

/// Shared-passphrase mode: the 32 bytes of key material for [roomId] (the
/// token's `rid`, which is also the `roomId` sent in `room.join`).
Uint8List deriveMaterialFromPassphrase(String passphrase, String roomId) =>
    pbkdf2Sha256(
      utf8.encode(passphrase),
      utf8.encode('$passphraseSaltPrefix$roomId'),
      pbkdf2Iterations,
      32,
    );

/// The 16-byte AES-GCM key libwebrtc derives from [material].
Uint8List aesKeyFromMaterial(List<int> material) =>
    hkdfSha256(material, ratchetSalt, _hkdfInfo, 16);

/// One ratchet step.
Uint8List ratchetMaterial(List<int> material) =>
    hkdfSha256(material, ratchetSalt, _hkdfInfo, 32);

/// Args for running [deriveMaterialFromPassphrase] through `compute`.
Uint8List deriveMaterialFromPassphraseArgs(List<String> args) =>
    deriveMaterialFromPassphrase(args[0], args[1]);
