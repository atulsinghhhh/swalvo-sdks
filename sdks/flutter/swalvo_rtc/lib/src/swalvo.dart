import 'package:flutter/foundation.dart' show kIsWeb;

import 'e2ee.dart';
import 'errors.dart';
import 'internal/e2ee_controller.dart';
import 'internal/engine.dart';
import 'internal/protocol.dart';
import 'internal/signaling_client.dart';
import 'internal/web_socket.dart';
import 'room.dart';
import 'types.dart';

/// Swalvo on Flutter.
///
/// The mental model is identical to Swalvo Web and Swalvo React Native, and
/// only the syntax follows the language:
///
/// ```dart
/// final swalvo = Swalvo(token: token, endpoint: endpoint);
/// final room = await swalvo.join('room_123');
///
/// await room.enableCamera();
/// await room.enableMicrophone();
/// ```
///
/// Everything a developer needs comes from their own backend's
/// token-mint response. Nothing here is hand-constructed, and no Swalvo
/// API key ever reaches the device.
///
/// # What changed underneath
///
/// This package used to wrap `livekit_client`. It now speaks Swalvo's own
/// signaling protocol to Swalvo's own SFU, over `flutter_webrtc`. The
/// public API above is unchanged; see docs/migration/from-livekit.md for
/// the two options whose meaning shifted ([adaptiveStream] and
/// [dynacast]).
class Swalvo {
  Swalvo({
    required this.token,
    required this.endpoint,
    this.iceServers,
    this.autoReconnect = true,
    this.adaptiveStream = true,
    this.dynacast = true,
    this.region,
    this.refreshToken,
    this.autoSubscribe = true,
    this.e2ee,
    this.audioRed = true,
    this.videoCodec,
  });

  /// End-to-end encryption (docs/rtc/e2ee). Media is encrypted on this
  /// device by flutter_webrtc's native frame cryptor with keys from
  /// [SwalvoE2EEOptions.keyProvider]; the media server only forwards
  /// ciphertext. Takes effect in rooms created with `e2ee: true`, where a
  /// client without it cannot publish ([SwalvoErrorCode.e2eeRequired]).
  /// iOS, Android, macOS, Windows and Linux; not Flutter Web
  /// ([SwalvoErrorCode.e2eeNotSupported]).
  final SwalvoE2EEOptions? e2ee;

  /// Defaults to true: offer Opus with RED redundancy (RFC 2198) first, so
  /// a lost audio packet is recovered from the next one. Off automatically
  /// while [e2ee] is configured, as on the web.
  final bool audioRed;

  /// The camera codec. Null keeps the platform's default (VP8 simulcast).
  /// [SwalvoVideoCodec.vp9] and [SwalvoVideoCodec.av1] publish SVC.
  final SwalvoVideoCodec? videoCodec;

  /// The RTC token your backend minted. Never mint this in the app.
  final String token;

  /// The `endpoint` field from the same mint response.
  ///
  /// This is Swalvo's signaling address, not a media server's. Clients
  /// never learn which SFU serves their room: that is what allows the
  /// media plane to change without an SDK release.
  final String endpoint;

  /// The `iceServers` array from the same response: forward it as-is.
  /// Omitting it means the connection has no STUN or TURN, which fails
  /// for most clients behind a NAT.
  final List<SwalvoIceServer>? iceServers;

  /// Defaults to true. Set false to handle reconnection yourself.
  final bool autoReconnect;

  /// Defaults to true, unlike the web SDK.
  ///
  /// Adaptive streaming asks the server for only the resolution a view is
  /// actually showing. On a phone that is the difference between decoding
  /// a 1080p stream into a thumbnail and decoding a thumbnail: a direct
  /// saving in CPU, battery and mobile data. It works here because
  /// [SwalvoVideoView] reports its size; the web SDK leaves it off because
  /// a browser tab has neither the battery constraint nor the metering.
  ///
  /// Implemented against Swalvo's own SFU by requesting a simulcast layer
  /// per view (`subscription.update`), rather than by a client library's
  /// built-in mechanism.
  final bool adaptiveStream;

  /// Defaults to true. Lets the SFU switch off simulcast layers of your
  /// camera that nobody is receiving, so this device stops spending CPU,
  /// battery and uplink encoding them (`publisher.layers`,
  /// docs/architecture/phase2-media-contracts.md §5).
  ///
  /// The SFU decides which layers are wanted; this device applies that by
  /// setting each encoding's `active` flag on its sender. With `false` the
  /// message is ignored and every layer is always sent, which is also what
  /// happens against a server that predates dynacast.
  final bool dynacast;

  /// Defaults to true. Set false to join with every remote *video* paused
  /// until something asks for it (audio is always forwarded): a
  /// [SwalvoVideoView] being laid out, [SwalvoRoom.requestLayer], or
  /// [SwalvoRoom.setVideoEnabled] with `true`. Useful for a large room where
  /// most participants are never on screen at once
  /// (docs/architecture/phase2-media-contracts.md §4).
  final bool autoSubscribe;

  /// Preferred region for the RTC server. A preference, not a constraint:
  /// the allocator falls back to another region instead of failing a call
  /// that could otherwise happen.
  final String? region;

  /// Supplies a fresh token when the current one is rejected or a
  /// reconnect begins. Without it, a long call outlives its token and
  /// dies at the next reconnect (spec §21).
  final Future<String> Function()? refreshToken;

  SwalvoRoom? _room;

  /// The room currently joined, if any.
  SwalvoRoom? get room => _room;

  /// Joins a room.
  ///
  /// [roomId] is optional, because the token already names its room in the
  /// `rid`/`rnm` claims — matches the web SDK's `client.join()` exactly.
  /// Pass one explicitly and it still has to match; a mismatch is
  /// [SwalvoErrorCode.roomNotFound] before any connection is attempted. A
  /// cascaded live-stream viewer relies on the no-argument form: its
  /// credential never names the edge room it actually lands on, only the
  /// token does.
  ///
  /// Completes once signaling has confirmed the join. Camera and
  /// microphone are **not** started automatically: a user should see
  /// their own preview and decide, and enabling them here would light up
  /// the camera before any UI explained why.
  Future<SwalvoRoom> join([String? roomId]) async {
    if (_room != null) {
      throw const SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'Already connected to a room. Call leave() before joining another.',
      );
    }

    final claims = decodeTokenClaims(token);
    final tokenRoomId = claims?['rid'] as String?;
    final tokenRoomName = claims?['rnm'] as String?;
    final requestedRoomId = roomId ?? tokenRoomName ?? tokenRoomId;
    // Matches the web SDK's assertTokenMatchesRoom exactly: a token names
    // its room by *both* an internal id (`rid`) and a human name (`rnm`)
    // where it carries either, and a caller may reasonably know either
    // one — a room created via `POST /v1/rooms {name:}` by its chosen
    // name, a live stream by its public id, which is what the room's own
    // `name` was set to and is never its internal id. Checking `rid`
    // alone rejected the second case outright: every live stream,
    // always, since a stream's public id is never its underlying room's
    // internal id.
    if ((tokenRoomId != null || tokenRoomName != null) &&
        tokenRoomId != requestedRoomId &&
        tokenRoomName != requestedRoomId) {
      // Fails before opening a socket: clearer than letting the server
      // reject it, and it costs nothing to check.
      throw SwalvoException(
        SwalvoErrorCode.roomNotFound,
        'This token was minted for room "${tokenRoomName ?? tokenRoomId}", not "$requestedRoomId".',
      );
    }

    // The wire-level room id is always the token's own `rid` claim, never
    // the [roomId] argument above — that argument exists only for the
    // sanity check just done, matching the web SDK's roomIdFromToken().
    // The server's own join check names the room by `rid` alone (spec's
    // signaling layer), so sending anything else — this SDK's previous
    // behavior, which sent [roomId] verbatim — got a room that passed
    // the client-side check but failed server-side for every caller who,
    // like a live stream, legitimately knows the room by its name rather
    // than its internal id.
    final wireRoomId = tokenRoomId;
    if (wireRoomId == null) {
      throw const SwalvoException(
        SwalvoErrorCode.invalidToken,
        'RTC token does not name a room.',
      );
    }

    final signaling = SignalingClient(
      endpoint: endpoint,
      token: token,
      roomId: wireRoomId,
      region: region,
      autoReconnect: autoReconnect,
      refreshToken: refreshToken,
      socketFactory: ChannelSocket.connect,
      autoSubscribe: autoSubscribe,
    );

    final e2eeOptions = e2ee;
    final engine = SwalvoEngine(
      e2ee: e2eeOptions != null && !kIsWeb
          ? E2EEController(e2eeOptions.keyProvider)
          : null,
      e2eeUnsupported: e2eeOptions != null && kIsWeb,
      roomId: wireRoomId,
      roomRequiresE2EE: claims?['e2ee'] == true,
      audioRed: audioRed,
      videoCodec: videoCodec?.name,
      signaling: signaling,
      iceServers: (iceServers ?? const [])
          .map((server) => server.toJson())
          .toList(growable: false),
      adaptiveStream: adaptiveStream,
      autoSubscribe: autoSubscribe,
      dynacast: dynacast,
      localIdentity: claims?['sub'] as String? ?? '',
      initialGrants: claims?['perms'] is Map<String, dynamic>
          ? SwalvoGrants.fromJson(claims!['perms'] as Map<String, dynamic>)
          : null,
    );

    // Wired up — and the engine listening — before signaling ever opens a
    // socket. `room.joined` and whatever the SFU sends right after it
    // (typically `sdp.offer`) race the moment `connect()` resolves, and
    // both stream sideways off `signaling`'s broadcast controllers with
    // no replay. A subscriber has to already be there when a message
    // arrives, or it is simply gone; attaching the room only after
    // `connect()` returned used to be exactly that gap. See
    // [SwalvoRoom.attach].
    final room = SwalvoRoom.attach(
      signaling: signaling,
      engine: engine,
      roomId: wireRoomId,
      localIdentity: claims?['sub'] as String? ?? '',
      // Initial metadata and attributes ride in the token (phase7 §2).
      localMetadata: claims?['md'] is String ? claims!['md'] as String : null,
      localAttributes: parseAttributes(claims?['attrs']),
    );

    final JoinedPayload joined;
    try {
      joined = await signaling.connect();
    } catch (error) {
      // Disposing the room tears down the engine and the signaling
      // client with it. A half-open signaling client still holds a
      // socket and a reconnect timer, and leaking one per failed join is
      // how a retry loop exhausts a device.
      room.dispose();
      throw error is SwalvoException
          ? error
          : SwalvoException(
              SwalvoErrorCode.connectionFailed,
              'Could not join the room.',
              error,
            );
    }

    room.applyInitialJoin(joined);
    _room = room;
    return room;
  }

  /// Leaves the current room and releases everything it held.
  ///
  /// Safe to call when not in a room.
  Future<void> leave() async {
    final room = _room;
    _room = null;
    if (room == null) return;

    await room.leave();
    room.dispose();
  }
}

/// A STUN or TURN server, as returned by your backend alongside the token.
///
/// A plain data class, not a WebRTC type, so an application can
/// forward the mint response without importing `flutter_webrtc`.
class SwalvoIceServer {
  const SwalvoIceServer({
    required this.urls,
    this.username,
    this.credential,
  });

  /// Builds one from the JSON your backend returned.
  factory SwalvoIceServer.fromJson(Map<String, dynamic> json) =>
      SwalvoIceServer(
        urls: json['urls'] as String,
        username: json['username'] as String?,
        credential: json['credential'] as String?,
      );

  final String urls;
  final String? username;
  final String? credential;

  /// @internal The shape `flutter_webrtc`'s configuration expects.
  Map<String, dynamic> toJson() => {
        'urls': urls,
        if (username != null) 'username': username,
        if (credential != null) 'credential': credential,
      };
}
