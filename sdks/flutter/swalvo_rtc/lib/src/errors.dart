/// Stable, typed error codes this SDK can raise.
///
/// These are the same codes `@swalvo/rtc` uses on the web, by design: a
/// team shipping both a web app and a Flutter app should be reading the
/// same vocabulary in both places, and a support conversation shouldn't
/// depend on which platform the user was on.
enum SwalvoErrorCode {
  invalidToken,
  tokenExpired,
  roomNotFound,
  connectionFailed,
  permissionDenied,
  cameraPermissionDenied,
  microphonePermissionDenied,
  deviceNotFound,
  networkError,
  signalingError,
  mediaError,
  timeout,

  /// The room is end-to-end encrypted and this client has no
  /// `Swalvo(e2ee: ...)`, so publishing was refused rather than sending
  /// plaintext into it. The web SDK's `E2EE_REQUIRED`.
  e2eeRequired,

  /// End-to-end encryption is needed but this platform cannot do it
  /// (Flutter Web). The web SDK's `E2EE_NOT_SUPPORTED`.
  e2eeNotSupported,

  /// An argument broke a documented limit: a data topic or destination
  /// list too long, a payload too big, metadata or attributes over their
  /// size limits. Nothing was sent.
  invalidArgument,
}

/// The one error type this SDK throws.
///
/// Never a raw `flutter_webrtc` error, never a `PlatformException` from
/// the native layer. Those leak implementation details a developer using
/// Swalvo has no way to act on, and would tie application error handling
/// to whichever WebRTC implementation Swalvo happens to use.
class SwalvoException implements Exception {
  const SwalvoException(this.code, this.message, [this.cause]);

  final SwalvoErrorCode code;
  final String message;

  /// The underlying failure, kept for logging. Never surfaced in
  /// [message], which is written for a developer rather than assembled
  /// from a native stack trace.
  final Object? cause;

  @override
  String toString() => 'SwalvoException(${code.name}): $message';
}

/// Thrown when the operating system refuses camera or microphone access.
///
/// Mobile's one genuinely new failure mode compared to the web. It's a
/// subclass instead of a separate type so `on SwalvoException` still
/// catches it, while `on SwalvoPermissionException` can offer the "open
/// Settings" path that a plain denial doesn't need.
class SwalvoPermissionException extends SwalvoException {
  const SwalvoPermissionException(
    this.permission, {
    required this.permanentlyDenied,
    Object? cause,
  }) : super(
          permission == SwalvoPermission.camera
              ? SwalvoErrorCode.cameraPermissionDenied
              : SwalvoErrorCode.microphonePermissionDenied,
          permanentlyDenied
              ? 'Access was permanently denied. The user must enable it in system settings — prompting again will not show a dialog.'
              : 'Access was denied.',
          cause,
        );

  final SwalvoPermission permission;

  /// True when re-prompting does nothing and only the system settings
  /// screen will help. The two cases need different UI, so the SDK
  /// reports which one happened, not making the app guess.
  final bool permanentlyDenied;
}

enum SwalvoPermission { camera, microphone }
