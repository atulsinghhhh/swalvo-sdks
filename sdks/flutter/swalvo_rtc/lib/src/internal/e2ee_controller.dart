import 'dart:async';
import 'dart:developer' as developer;
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show compute;
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;

import '../e2ee.dart';
import 'e2ee_crypto.dart' as crypto;

/// One state change, before the room turns the id into a participant.
typedef E2EEStateEvent = ({
  String participantId,
  bool local,
  SwalvoE2EEState state
});

/// Wires a [SwalvoKeyProvider] to flutter_webrtc's native `FrameCryptor`
/// (libwebrtc) for one connection: a native key provider configured for
/// the shared key schedule, and a frame cryptor per sender and receiver.
///
/// The frame format is libwebrtc's own, which is the format of
/// phase5-contracts §3.2 — the web SDK reimplements it in its worker — so
/// nothing about frames happens in Dart.
class E2EEController implements SwalvoKeyProviderListener {
  E2EEController(this.provider, {rtc.FrameCryptorFactory? factory})
      : _factory = factory ?? rtc.frameCryptorFactory;

  final SwalvoKeyProvider provider;
  final rtc.FrameCryptorFactory _factory;

  rtc.KeyProvider? _native;
  Future<rtc.KeyProvider>? _nativeCreating;
  String _localIdentity = '';
  bool _enabled = false;
  bool _started = false;
  bool _disposed = false;

  final _cryptors = <rtc.FrameCryptor>[];
  final _receiverCryptors = <String, List<rtc.FrameCryptor>>{};
  final _states = StreamController<E2EEStateEvent>.broadcast();

  /// Encryption state changes for every participant.
  Stream<E2EEStateEvent> get states => _states.stream;

  /// Whether the room requires E2EE and this controller is encrypting.
  bool get enabled => _enabled;

  /// The `KeyProviderOptions` every Swalvo SDK agrees on. Exposed for tests.
  rtc.KeyProviderOptions get nativeOptions => rtc.KeyProviderOptions(
        sharedKey: provider.isShared,
        ratchetSalt: crypto.ratchetSalt,
        ratchetWindowSize: provider.ratchetWindow,
        // No magic bytes: every frame in an E2EE room is encrypted.
        uncryptedMagicBytes: null,
        failureTolerance: -1,
        keyRingSize: 16,
        // Never let a frame through unencrypted while a cryptor is not ready.
        discardFrameWhenCryptorNotReady: true,
        keyDerivationAlgorithm: rtc.KeyDerivationAlgorithm.kHKDF,
      );

  Future<rtc.KeyProvider> _ensureNative() {
    final existing = _native;
    if (existing != null) return Future.value(existing);
    return _nativeCreating ??=
        _factory.createDefaultKeyProvider(nativeOptions).then((value) {
      _native = value;
      return value;
    });
  }

  /// Called on every join. [roomId] is the token's `rid` (the passphrase
  /// salt); [enabled] is whether the room is end-to-end encrypted.
  Future<void> start(
      {required String roomId,
      required String localIdentity,
      required bool enabled}) async {
    _localIdentity = localIdentity;
    _enabled = enabled;
    if (!enabled || _started || _disposed) return;
    _started = true;
    provider.addListener(this);
    final native = await _ensureNative();
    final passphrase = provider.passphrase;
    if (passphrase != null && !provider.hasExplicitSharedKey) {
      // 100k PBKDF2 rounds: off the UI isolate where there is one.
      final material = await compute(
          crypto.deriveMaterialFromPassphraseArgs, [passphrase, roomId]);
      await native.setSharedKey(key: material, index: 0);
    }
    for (final key in provider.explicitKeys) {
      await _pushKey(native, key.participantId, key.material, key.keyIndex);
    }
  }

  Future<void> _pushKey(rtc.KeyProvider native, String? participantId,
      Uint8List material, int keyIndex) async {
    if (participantId == null) {
      await native.setSharedKey(key: material, index: keyIndex);
    } else {
      await native.setKey(
          participantId: participantId, index: keyIndex, key: material);
    }
    if (participantId == null || participantId == _localIdentity) {
      for (final cryptor in _senderCryptors) {
        await cryptor.setKeyIndex(keyIndex);
      }
    }
  }

  final _senderCryptors = <rtc.FrameCryptor>[];

  @override
  Future<void> onKeySet(
      String? participantId, Uint8List material, int keyIndex) async {
    if (!_started || _disposed) return;
    await _pushKey(await _ensureNative(), participantId, material, keyIndex);
  }

  @override
  Future<Uint8List?> onRatchet(String? participantId, int keyIndex) async {
    if (!_started || _disposed) return null;
    final native = await _ensureNative();
    return participantId == null
        ? native.ratchetSharedKey(index: keyIndex)
        : native.ratchetKey(participantId: participantId, index: keyIndex);
  }

  /// Encrypts everything [sender] sends, from its first frame.
  Future<void> setupSender(rtc.RTCRtpSender sender) async {
    if (!_enabled || _disposed) return;
    final cryptor = await _factory.createFrameCryptorForRtpSender(
      participantId: _localIdentity,
      sender: sender,
      algorithm: rtc.Algorithm.kAesGcm,
      keyProvider: await _ensureNative(),
    );
    _watch(cryptor, local: true);
    _cryptors.add(cryptor);
    _senderCryptors.add(cryptor);
    await cryptor.setKeyIndex(provider.currentKeyIndex(_localIdentity));
    await cryptor.setEnabled(true);
  }

  /// Decrypts what [receiver] receives from [participantId].
  Future<void> setupReceiver(
      rtc.RTCRtpReceiver receiver, String participantId) async {
    if (!_enabled || _disposed) return;
    final cryptor = await _factory.createFrameCryptorForRtpReceiver(
      participantId: participantId,
      receiver: receiver,
      algorithm: rtc.Algorithm.kAesGcm,
      keyProvider: await _ensureNative(),
    );
    _watch(cryptor, local: false);
    _cryptors.add(cryptor);
    (_receiverCryptors[participantId] ??= []).add(cryptor);
    await cryptor.setEnabled(true);
  }

  void _watch(rtc.FrameCryptor cryptor, {required bool local}) {
    cryptor.onFrameCryptorStateChanged = (participantId, state) {
      final mapped = mapCryptorState(state, local: local);
      if (mapped == null || _states.isClosed) return;
      if (state == rtc.FrameCryptorState.FrameCryptorStateKeyRatcheted) {
        developer.log('e2ee: followed a ratchet for $participantId',
            name: 'swalvo_rtc');
      }
      _states.add((participantId: participantId, local: local, state: mapped));
    };
  }

  /// Drops [participantId]'s receive cryptors (they left).
  Future<void> participantLeft(String participantId) async {
    final cryptors = _receiverCryptors.remove(participantId) ?? const [];
    for (final cryptor in cryptors) {
      _cryptors.remove(cryptor);
      await cryptor.dispose();
    }
  }

  /// Every cryptor belonged to the peer connection a reconnect discarded.
  Future<void> resetConnection() async {
    final cryptors = List.of(_cryptors);
    _cryptors.clear();
    _senderCryptors.clear();
    _receiverCryptors.clear();
    for (final cryptor in cryptors) {
      await cryptor.dispose();
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    provider.removeListener(this);
    await resetConnection();
    await _native?.dispose();
    await _states.close();
  }
}

/// libwebrtc's cryptor states → the cross-platform ones.
SwalvoE2EEState? mapCryptorState(rtc.FrameCryptorState state,
    {required bool local}) {
  switch (state) {
    case rtc.FrameCryptorState.FrameCryptorStateOk:
    case rtc.FrameCryptorState.FrameCryptorStateKeyRatcheted:
      return SwalvoE2EEState.ok;
    case rtc.FrameCryptorState.FrameCryptorStateMissingKey:
      return SwalvoE2EEState.missingKey;
    case rtc.FrameCryptorState.FrameCryptorStateDecryptionFailed:
      return SwalvoE2EEState.decryptFailed;
    case rtc.FrameCryptorState.FrameCryptorStateEncryptionFailed:
      return SwalvoE2EEState.encryptFailed;
    case rtc.FrameCryptorState.FrameCryptorStateInternalError:
      return local
          ? SwalvoE2EEState.encryptFailed
          : SwalvoE2EEState.decryptFailed;
    case rtc.FrameCryptorState.FrameCryptorStateNew:
      return null;
  }
}
