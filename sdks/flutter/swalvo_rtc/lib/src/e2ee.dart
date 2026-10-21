import 'dart:typed_data';

import 'errors.dart';
import 'internal/e2ee_crypto.dart' as crypto;
import 'types.dart';

/// End-to-end encryption state for one participant, as reported by
/// [SwalvoRoom.e2eeStateChanges]. Same states as the web SDK's
/// `e2eeStateChanged`.
enum SwalvoE2EEState {
  /// Frames are being encrypted (you) or decrypted (a remote participant).
  ok,

  /// No key for this participant at the frame's key index: their media
  /// is dropped until one is set.
  missingKey,

  /// A frame failed with the key and every ratchet in the window, so it
  /// was dropped. Usually a wrong passphrase.
  decryptFailed,

  /// The platform refused to encrypt a frame; it was dropped.
  encryptFailed,
}

/// One change of [SwalvoE2EEState].
class SwalvoE2EEStateUpdate {
  const SwalvoE2EEStateUpdate(this.participant, this.state);

  /// The local participant for what you send, a remote one for what you receive.
  final SwalvoParticipant participant;
  final SwalvoE2EEState state;

  @override
  String toString() =>
      'SwalvoE2EEStateUpdate(${participant.identity}, ${state.name})';
}

/// Holds the keys for end-to-end encryption. Keys never leave the device.
///
/// ```dart
/// final swalvo = Swalvo(
///   token: token,
///   endpoint: endpoint,
///   e2ee: SwalvoE2EEOptions(SwalvoKeyProvider.sharedPassphrase(passphrase)),
/// );
/// ```
///
/// The frame format and key schedule are the ones every Swalvo SDK uses
/// (docs/architecture/phase5-contracts.md §3), so a Flutter participant
/// and a browser participant with the same passphrase hear each other.
class SwalvoKeyProvider {
  /// Everyone in the room configures the same [passphrase]. The key is
  /// derived on device with PBKDF2-SHA256 (100k iterations, salt
  /// `"LivqenoE2EE:" + roomId`), so the same passphrase gives different
  /// keys in different rooms.
  SwalvoKeyProvider.sharedPassphrase(String passphrase,
      {this.ratchetWindow = crypto.defaultRatchetWindow})
      : isShared = true,
        _passphrase = passphrase {
    if (passphrase.isEmpty) {
      throw const SwalvoException(SwalvoErrorCode.e2eeRequired,
          'A shared-passphrase key provider needs a non-empty passphrase.');
    }
  }

  /// You distribute keys over your own channel and call [setKey] for
  /// yourself and for everyone you receive from.
  SwalvoKeyProvider.perParticipant(
      {this.ratchetWindow = crypto.defaultRatchetWindow})
      : isShared = false,
        _passphrase = null;

  /// One key for the whole room ([SwalvoKeyProvider.sharedPassphrase]).
  final bool isShared;

  /// How many forward ratchets a receiver tries on a frame that fails to
  /// decrypt before dropping it. Defaults to 8.
  final int ratchetWindow;

  final String? _passphrase;

  /// Explicit keys, by participant (`null` = the shared key), then key index.
  final Map<String?, Map<int, Uint8List>> _keys = {};
  final Map<String?, int> _currentIndex = {};
  final Set<SwalvoKeyProviderListener> _listeners = {};

  /// Sets raw key material (at least 16 random bytes) for [participantId]
  /// at [keyIndex] and makes that index current. In shared mode the
  /// participant id is ignored and the key replaces the passphrase key.
  Future<void> setKey(String participantId, List<int> key,
      {int keyIndex = 0}) async {
    _checkIndex(keyIndex);
    final id = isShared ? null : participantId;
    final material = Uint8List.fromList(key);
    (_keys[id] ??= {})[keyIndex] = material;
    _currentIndex[id] = keyIndex;
    for (final listener in _listeners.toList()) {
      await listener.onKeySet(id, material, keyIndex);
    }
  }

  /// Advances a key one ratchet step (HKDF-SHA256, salt `LivqenoRatchet`).
  /// Ratchet your own key after someone leaves; receivers follow
  /// automatically within [ratchetWindow] steps.
  Future<void> ratchetKey({String? participantId, int? keyIndex}) async {
    final id = isShared ? null : participantId;
    final index = keyIndex ?? _currentIndex[id] ?? 0;
    _checkIndex(index);
    if (_listeners.isNotEmpty) {
      Uint8List? material;
      for (final listener in _listeners.toList()) {
        material = await listener.onRatchet(id, index) ?? material;
      }
      if (material != null) (_keys[id] ??= {})[index] = material;
      return;
    }
    final current = _keys[id]?[index];
    if (current == null) {
      throw const SwalvoException(SwalvoErrorCode.e2eeRequired,
          'There is no key to ratchet for this participant yet.');
    }
    _keys[id]![index] = crypto.ratchetMaterial(current);
  }

  void _checkIndex(int keyIndex) {
    if (keyIndex < 0 || keyIndex > 255) {
      throw const SwalvoException(SwalvoErrorCode.e2eeRequired,
          'An E2EE key index must be from 0 to 255.');
    }
  }

  /// @internal The key index [participantId] (null: shared) encrypts with.
  int currentKeyIndex(String? participantId) =>
      _currentIndex[isShared ? null : participantId] ?? 0;

  /// @internal The passphrase, for the engine's derivation.
  String? get passphrase => _passphrase;

  /// @internal Every key held, current index last per participant.
  List<({String? participantId, Uint8List material, int keyIndex})>
      get explicitKeys {
    final out = <({String? participantId, Uint8List material, int keyIndex})>[];
    for (final entry in _keys.entries) {
      final current = _currentIndex[entry.key];
      for (final key in entry.value.entries) {
        if (key.key != current) {
          out.add((
            participantId: entry.key,
            material: key.value,
            keyIndex: key.key
          ));
        }
      }
      final currentMaterial = current == null ? null : entry.value[current];
      if (currentMaterial != null) {
        out.add((
          participantId: entry.key,
          material: currentMaterial,
          keyIndex: current!
        ));
      }
    }
    return out;
  }

  /// @internal Whether a shared key was set explicitly (it then replaces the passphrase).
  bool get hasExplicitSharedKey => _keys[null]?.containsKey(0) ?? false;

  /// @internal
  void addListener(SwalvoKeyProviderListener listener) =>
      _listeners.add(listener);

  /// @internal
  void removeListener(SwalvoKeyProviderListener listener) =>
      _listeners.remove(listener);

  /// @internal Mirrors a ratchet the native side did on receive.
  void storeRatcheted(String? participantId, int keyIndex, Uint8List material) {
    (_keys[isShared ? null : participantId] ??= {})[keyIndex] = material;
  }
}

/// @internal What a live connection registers on a [SwalvoKeyProvider].
abstract class SwalvoKeyProviderListener {
  Future<void> onKeySet(
      String? participantId, Uint8List material, int keyIndex);
  Future<Uint8List?> onRatchet(String? participantId, int keyIndex);
}

/// End-to-end encryption settings for [Swalvo]. Takes effect in rooms
/// created with `e2ee: true`; in such a room a client without it cannot
/// publish ([SwalvoErrorCode.e2eeRequired]).
class SwalvoE2EEOptions {
  const SwalvoE2EEOptions(this.keyProvider);

  final SwalvoKeyProvider keyProvider;
}
