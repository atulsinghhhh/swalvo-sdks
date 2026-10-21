import 'dart:async';
import 'dart:convert';
import 'dart:math';

import '../errors.dart';
import '../types.dart';
import 'protocol.dart';

/// How long to wait for the socket to open, and for `room.joined` after.
///
/// Separate because they fail for different reasons: the first is "cannot
/// reach the API", the second is "the API cannot reach an RTC server". One
/// combined timeout would report both as the same thing.
const _openTimeout = Duration(seconds: 10);
const _joinTimeout = Duration(seconds: 15);

const _reconnectBase = Duration(milliseconds: 300);
const _reconnectMax = Duration(seconds: 10);
const _maxReconnectAttempts = 12;

/// Upper bound of the random delay before reconnecting after a graceful
/// API restart (close 1012, phase1-contracts §1.3): short because the
/// media is still up on the SFU, random because every client on that
/// instance was closed at the same moment.
const _serviceRestartJitter = Duration(seconds: 2);

/// How old a resume token may be and still be offered. The server signs
/// it for 120 s and rotates it every 60 s (§1.2).
const _resumeTokenMaxAge = Duration(seconds: 110);

/// A token this close to expiry is refreshed before reconnecting with it.
const _tokenRefreshSkew = Duration(seconds: 30);

/// Opens a WebSocket. Injectable so tests can drive the protocol without a
/// server, and so the platform-specific implementation stays out of this
/// file.
typedef SocketFactory = Future<SwalvoSocket> Function(String url);

/// The slice of a WebSocket this client needs.
///
/// An interface, not `dart:io`'s or `dart:html`'s type: Flutter
/// runs on both, `package:web_socket_channel` abstracts them, and the
/// reconnect logic is worth testing without any of that.
abstract class SwalvoSocket {
  Stream<dynamic> get messages;
  void send(String data);
  Future<void> close([int? code, String? reason]);

  /// Resolves with the close code once the socket closes.
  Future<int?> get closed;
}

/// Supplies a fresh RTC token when the current one is rejected or a
/// reconnect is starting (spec §21).
typedef TokenRefresher = Future<String> Function();

/// The SDK's signaling connection.
///
/// Owns the socket, the join handshake, and reconnection, and nothing
/// else. It does not know what a peer connection is: every message is
/// handed to a listener, which decides what to negotiate. Keeping that
/// line clean is what makes reconnection testable without a WebRTC stack.
///
/// # Reconnection
///
/// A reconnect re-runs the join. When the server handed out a resume
/// token (phase1-contracts §1.2) that is still fresh, the join carries it
/// and the server re-binds the old SFU session: media never stopped, and
/// the payload reports `resumed: true` so the peer connection is kept.
/// Otherwise the server allocates a fresh session, `resumed` is false, and
/// the peer connection is rebuilt — the path a client needs anyway for an
/// outage longer than the resume window (spec §20).
///
/// Close codes steer it ([CloseCode]): 1012 reconnects within two seconds,
/// 4003 never reconnects, and 4001 reconnects only after a token refresh.
class SignalingClient {
  SignalingClient({
    required this.endpoint,
    required String token,
    required this.roomId,
    required this.autoReconnect,
    required SocketFactory socketFactory,
    this.region,
    this.refreshToken,
    this.autoSubscribe = true,
  })  : _token = token,
        _socketFactory = socketFactory;

  final String endpoint;
  final String roomId;
  final String? region;
  final bool autoReconnect;

  /// Sent as `"autoSubscribe": false` on every join, including a
  /// reconnect's, when false (phase2-media-contracts §4). Omitted otherwise,
  /// so the default join is byte-for-byte what it was before the field
  /// existed.
  final bool autoSubscribe;
  final TokenRefresher? refreshToken;

  final SocketFactory _socketFactory;
  String _token;

  SwalvoSocket? _socket;
  StreamSubscription<dynamic>? _subscription;
  int _reconnectAttempts = 0;
  Timer? _reconnectTimer;
  bool _closedByCaller = false;
  bool _joined = false;

  /// The latest resume token and when it arrived (§1.2).
  String? _resumeToken;
  DateTime? _resumeReceivedAt;

  /// Set when the server said the session is over for a reason a
  /// reconnect cannot fix, so the close that follows is not retried.
  SwalvoDisconnectReason? _endedReason;

  /// The server said the token expired and [refreshToken] exists, so the
  /// 4001 that follows means "refresh and reconnect".
  bool _expiredAwaitingRefresh = false;

  /// A `token.refresh` sent and not yet confirmed.
  String? _pendingRefreshToken;
  bool _liveRefreshInFlight = false;

  /// Why the last join attempt failed, for the reconnect decision.
  String? _lastJoinServerCode;
  int? _lastJoinCloseCode;

  /// The attempt [_reconnectTimer] will run, so [reconnectNow] can run it
  /// early.
  void Function()? _pendingAttempt;

  /// True from the moment `room.join` is dispatched on the current socket,
  /// well before `room.joined` confirms it. See [send]'s doc comment for
  /// why `send` gates on this instead of [_joined].
  bool _joinSent = false;

  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  final _joins = StreamController<JoinedPayload>.broadcast();
  final _states = StreamController<SignalingLifecycle>.broadcast();
  final _warnings = StreamController<SwalvoWarning>.broadcast();

  /// Non-fatal conditions: a token expiring with no refresher, or a
  /// refresh that failed.
  Stream<SwalvoWarning> get warnings => _warnings.stream;

  /// Every server message, already parsed.
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  /// Fires on the first join and again after every successful reconnect.
  Stream<JoinedPayload> get joins => _joins.stream;

  /// Transport-level lifecycle, distinct from the media connection's.
  Stream<SignalingLifecycle> get lifecycle => _states.stream;

  bool get isJoined => _joined;

  /// True while a reconnect is scheduled or in progress.
  bool get isReconnecting =>
      !_closedByCaller && !_joined && _reconnectAttempts > 0;

  /// Opens the socket and joins the room.
  ///
  /// Completes once `room.joined` arrives: not merely once the socket
  /// opens. A caller handed a completed future on socket-open would then
  /// have to await an event to know whether it was actually in the room,
  /// which is the same waiting with an extra step.
  ///
  /// A failure here is the caller's to handle and is never retried in the
  /// background: a first join that fails has no session to recover.
  Future<JoinedPayload> connect() async {
    _closedByCaller = false;
    _endedReason = null;
    try {
      return await _openAndJoin(isReconnect: false);
    } catch (_) {
      _closedByCaller = true;
      rethrow;
    }
  }

  Future<JoinedPayload> _openAndJoin({required bool isReconnect}) async {
    final socket = await _open();
    // `close()`/`dispose()` can run while `_open()`'s own network round
    // trip is still in flight — an ordinary "leave during a reconnect
    // attempt" race, not a contrived one. Every other resumption point in
    // the reconnect chain already re-checks `_closedByCaller` for exactly
    // this reason (see `_scheduleReconnect`'s comment); this was the one
    // gap. Without it, a socket that only finishes connecting after the
    // caller already left got wired up anyway: assigned to `_socket`,
    // subscribed to, and joined into the room — a leaked socket nobody
    // will ever close, a stale server-side participant nobody asked for,
    // and (if the join then succeeds) a `room.joined` payload written to
    // `_joins`/`_states` after `dispose()` may have already closed them.
    if (_closedByCaller) {
      unawaited(socket.close());
      throw const SwalvoException(
        SwalvoErrorCode.connectionFailed,
        'The signaling client was closed while reconnecting.',
      );
    }
    _socket = socket;
    return _join(socket, isReconnect: isReconnect);
  }

  Future<SwalvoSocket> _open() async {
    try {
      return await _socketFactory(_url()).timeout(_openTimeout);
    } on TimeoutException catch (error) {
      throw SwalvoException(
        SwalvoErrorCode.timeout,
        'Timed out opening a signaling connection to $endpoint.',
        error,
      );
    } catch (error) {
      throw SwalvoException(
        SwalvoErrorCode.networkError,
        'Could not reach the Swalvo signaling endpoint at $endpoint.',
        error,
      );
    }
  }

  Future<JoinedPayload> _join(SwalvoSocket socket,
      {required bool isReconnect}) {
    final completer = Completer<JoinedPayload>();
    final resume = isReconnect ? _usableResumeToken() : null;
    _lastJoinServerCode = null;
    _lastJoinCloseCode = null;
    // Only a socket that completed its join reaches [_onClosed]. One that
    // failed mid-handshake is decided by whoever awaited the join (the
    // caller of [connect], or the reconnect loop): letting its close
    // schedule a reconnect too is how one failure became two concurrent
    // retry chains.
    var joinedOnThisSocket = false;

    _subscription = socket.messages.listen(
      (raw) {
        final message = _parse(raw);
        if (message == null) return;

        final type = message['type'];

        if (!completer.isCompleted) {
          if (type == ServerMessageType.roomJoined) {
            final payload =
                JoinedPayload.fromJson(message, askedToResume: resume != null);
            joinedOnThisSocket = true;
            _storeResumeToken(payload.resumeToken);
            _joined = true;
            _reconnectAttempts = 0;
            completer.complete(payload);
            _joins.add(payload);
            return;
          }
          if (type == ServerMessageType.error) {
            _lastJoinServerCode = message['code'] as String?;
            completer.completeError(_toException(message));
            unawaited(socket.close());
            return;
          }
        }

        _handle(message);
      },
      onError: (Object error) {
        if (!completer.isCompleted) {
          completer.completeError(SwalvoException(
            SwalvoErrorCode.signalingError,
            'The signaling connection failed.',
            error,
          ));
        }
      },
      cancelOnError: false,
    );

    // Watching `closed` rather than the stream's onDone: a close carries
    // the code, and 4001 (credential rejected) has to be told apart from
    // an ordinary drop so the token can be refreshed before retrying.
    unawaited(socket.closed.then((code) {
      if (!joinedOnThisSocket) {
        if (!completer.isCompleted) {
          _lastJoinCloseCode = code;
          completer.completeError(SwalvoException(
            SwalvoErrorCode.signalingError,
            'The signaling connection closed before the room was joined '
            '(code ${code ?? 'unknown'}).',
          ));
        }
        return;
      }
      // A socket already replaced by a reconnect: its close is history.
      if (!identical(socket, _socket)) return;
      _joined = false;
      _joinSent = false;
      _onClosed(code);
    }));

    send({
      'type': ClientMessageType.roomJoin,
      'roomId': roomId,
      if (region != null) 'region': region,
      if (!autoSubscribe) 'autoSubscribe': false,
      if (resume != null) 'resume': {'token': resume},
    });

    return completer.future.timeout(
      _joinTimeout,
      onTimeout: () => throw const SwalvoException(
        SwalvoErrorCode.timeout,
        'The server did not confirm the room join.',
      ),
    );
  }

  void _handle(Map<String, dynamic> message) {
    switch (message['type']) {
      case ServerMessageType.error:
        if (_handleErrorFrame(message)) return;
      case ServerMessageType.roomResumeToken:
        _storeResumeToken(message['resumeToken'] as String?);
        return;
      case ServerMessageType.tokenExpiring:
        unawaited(_refreshLiveToken(message['expiresAt'] as String?));
        return;
      case ServerMessageType.tokenRefreshed:
        final pending = _pendingRefreshToken;
        if (pending != null) {
          // Adopted only now, so a reconnect never presents a token the
          // server has not accepted for this session.
          _token = pending;
          _pendingRefreshToken = null;
        }
        return;
      case ServerMessageType.roomLeft:
        _handleRoomLeft(message['reason'] as String?);
    }
    _messages.add(message);
  }

  /// True when the frame was fully handled here.
  bool _handleErrorFrame(Map<String, dynamic> message) {
    final code = message['code'] as String? ?? '';
    final text = message['message'] as String? ?? 'Signaling error.';

    if (code == SignalingErrorCode.tokenInvalid) {
      // §1.1: a refused refresh is non-fatal; the old token stands.
      _pendingRefreshToken = null;
      _warn(SwalvoWarning(SwalvoWarningCode.tokenRefreshFailed, text));
      return true;
    }
    if (code == SignalingErrorCode.roomClosed) {
      _endedReason = SwalvoDisconnectReason.roomClosed;
      return true;
    }
    if (code == SignalingErrorCode.tokenExpired &&
        refreshToken != null &&
        autoReconnect) {
      // Expiry enforced mid-session: the 4001 close that follows is a
      // reconnect with a fresh token, not the end of the call.
      _expiredAwaitingRefresh = true;
      return true;
    }
    if (SignalingErrorCode.fatal.contains(code)) {
      // Nothing a reconnect can fix. Close on purpose so the
      // reconnect path is not entered, and report it.
      _closedByCaller = true;
      _clearResume();
      _states.add(SignalingLifecycle.failed(
        _toException(message),
        code == SignalingErrorCode.tokenExpired
            ? SwalvoDisconnectReason.tokenExpired
            : SwalvoDisconnectReason.connectionFailed,
      ));
      unawaited(_socket?.close());
      return true;
    }
    return false;
  }

  void _handleRoomLeft(String? reason) {
    if (reason == null) return; // the acknowledgement of our own leave
    if (reason == 'TOKEN_EXPIRED' && refreshToken != null && autoReconnect) {
      _expiredAwaitingRefresh = true;
      return;
    }
    _endedReason = switch (reason) {
      'ROOM_CLOSED' => SwalvoDisconnectReason.roomClosed,
      'TOKEN_EXPIRED' => SwalvoDisconnectReason.tokenExpired,
      _ => SwalvoDisconnectReason.removed,
    };
    _clearResume();
    // The server closes with 4003 next; not depending on it arriving.
    unawaited(_socket?.close(1000, 'session ended by server'));
  }

  void _onClosed(int? code) {
    if (_closedByCaller) {
      _states.add(const SignalingLifecycle.closed());
      return;
    }

    // Final whatever autoReconnect says: reconnecting after a removal
    // would put a kicked participant straight back in the room (§1.5).
    final ended = _endedReason ??
        (code == CloseCode.removed ? SwalvoDisconnectReason.removed : null);
    if (ended != null) {
      _endedReason = null;
      _closedByCaller = true;
      _clearResume();
      _states.add(SignalingLifecycle.ended(ended));
      return;
    }

    final authFailed = code == CloseCode.authFailed || _expiredAwaitingRefresh;
    if (authFailed) _clearResume();

    if (!autoReconnect) {
      _closedByCaller = true;
      _states.add(SignalingLifecycle.failed(
        authFailed
            ? const SwalvoException(SwalvoErrorCode.tokenExpired,
                'The signaling connection was closed because the RTC token expired.')
            : SwalvoException(
                SwalvoErrorCode.networkError,
                'The signaling connection closed (code ${code ?? 'unknown'}).',
              ),
        authFailed
            ? SwalvoDisconnectReason.tokenExpired
            : SwalvoDisconnectReason.connectionFailed,
      ));
      return;
    }

    if (authFailed) {
      _expiredAwaitingRefresh = false;
      if (refreshToken == null) {
        _closedByCaller = true;
        _states.add(SignalingLifecycle.failed(
          const SwalvoException(
            SwalvoErrorCode.tokenExpired,
            'The RTC token expired. Pass refreshToken to Swalvo to keep long '
            'sessions alive.',
          ),
          SwalvoDisconnectReason.tokenExpired,
        ));
        return;
      }
      unawaited(_scheduleReconnect(refreshFirst: true));
      return;
    }

    unawaited(_scheduleReconnect(
      refreshFirst: false,
      serviceRestart: code == CloseCode.serviceRestart,
    ));
  }

  Future<void> _scheduleReconnect({
    required bool refreshFirst,
    bool serviceRestart = false,
  }) async {
    // `close()`/`dispose()` may run while this chain is suspended between
    // attempts (awaiting a token refresh, or waiting out the backoff
    // timer). Re-checked at every resumption point below, because a stale
    // attempt landing after `dispose()` would otherwise add to a
    // `StreamController` that has already been closed.
    if (_closedByCaller) return;

    if (_reconnectAttempts >= _maxReconnectAttempts) {
      _closedByCaller = true;
      _states.add(SignalingLifecycle.failed(
        const SwalvoException(
          SwalvoErrorCode.connectionFailed,
          'Could not re-establish signaling after $_maxReconnectAttempts attempts.',
        ),
        SwalvoDisconnectReason.connectionFailed,
      ));
      return;
    }

    _reconnectAttempts++;
    _states.add(SignalingLifecycle.reconnecting(
        resuming: _usableResumeToken() != null));

    // Refreshed only when needed: after a rejected credential, or when the
    // token is about to run out (a reconnect after a long outage very
    // often carries an expired one). Not on every blip, which would be a
    // call to the application's backend per network hiccup.
    if (refreshFirst || _tokenExpiresSoon()) {
      await _tryRefreshToken();
    }

    if (_closedByCaller) return;

    final Duration delay;
    if (serviceRestart) {
      delay = Duration(
          milliseconds:
              Random().nextInt(_serviceRestartJitter.inMilliseconds + 1));
    } else {
      final backoffMs = min(
        _reconnectBase.inMilliseconds * pow(2, _reconnectAttempts - 1).toInt(),
        _reconnectMax.inMilliseconds,
      );
      // Full jitter: every client picks somewhere in [0, backoff), so a
      // fleet that all dropped at once does not all retry at once.
      delay = Duration(milliseconds: Random().nextInt(backoffMs + 1));
    }

    void attempt() {
      _reconnectTimer = null;
      _pendingAttempt = null;
      if (_closedByCaller) return;
      _openAndJoin(isReconnect: true).then((_) {
        if (_closedByCaller) unawaited(_socket?.close(1000, 'client left'));
      }, onError: (Object _) => _handleReconnectFailure());
    }

    _reconnectTimer?.cancel();
    _pendingAttempt = attempt;
    _reconnectTimer = Timer(delay, attempt);
  }

  void _handleReconnectFailure() {
    if (_closedByCaller) return;
    final serverCode = _lastJoinServerCode;
    if (serverCode == SignalingErrorCode.tokenExpired && refreshToken != null) {
      unawaited(_scheduleReconnect(refreshFirst: true));
      return;
    }
    if (serverCode != null && SignalingErrorCode.fatal.contains(serverCode)) {
      _closedByCaller = true;
      _states.add(SignalingLifecycle.failed(
        _toException({'code': serverCode, 'message': 'Reconnect refused.'}),
        serverCode == SignalingErrorCode.tokenExpired
            ? SwalvoDisconnectReason.tokenExpired
            : SwalvoDisconnectReason.connectionFailed,
      ));
      return;
    }
    if (_lastJoinCloseCode == CloseCode.removed ||
        serverCode == SignalingErrorCode.roomClosed) {
      _closedByCaller = true;
      _states.add(SignalingLifecycle.ended(
          serverCode == SignalingErrorCode.roomClosed
              ? SwalvoDisconnectReason.roomClosed
              : SwalvoDisconnectReason.removed));
      return;
    }
    // The reconnect loop owns recovery; a failed attempt is not surfaced
    // on its own.
    unawaited(_scheduleReconnect(refreshFirst: false));
  }

  /// Runs a scheduled reconnect now instead of waiting out its backoff,
  /// for when the platform has seen the network come back.
  void reconnectNow() {
    final attempt = _pendingAttempt;
    if (attempt == null || _reconnectTimer == null) return;
    _reconnectTimer?.cancel();
    attempt();
  }

  /// Abandons the session and joins afresh: a new SFU session and so a new
  /// peer connection. For a dead media connection under a live socket,
  /// where resuming would only re-bind the dead session.
  void rejoin() {
    if (_closedByCaller) return;
    _clearResume();
    if (_joined) {
      // Our own close runs the ordinary reconnect path, which is a fresh
      // join now that there is no resume token to offer.
      unawaited(_socket?.close(1000, 'client rejoin'));
    }
  }

  Future<void> _refreshLiveToken(String? expiresAt) async {
    final refresher = refreshToken;
    if (refresher == null) {
      _warn(SwalvoWarning(
        SwalvoWarningCode.tokenExpiring,
        'The RTC token expires at $expiresAt and no refreshToken is configured.',
        expiresAt: expiresAt,
      ));
      return;
    }
    if (_liveRefreshInFlight) return;
    _liveRefreshInFlight = true;
    try {
      final token = await refresher();
      _pendingRefreshToken = token;
      send({'type': ClientMessageType.tokenRefresh, 'token': token});
    } catch (error) {
      _warn(SwalvoWarning(
        SwalvoWarningCode.tokenRefreshFailed,
        'refreshToken() failed.',
        expiresAt: expiresAt,
        cause: error,
      ));
    } finally {
      _liveRefreshInFlight = false;
    }
  }

  Future<void> _tryRefreshToken() async {
    final refresher = refreshToken;
    if (refresher == null) return;
    try {
      _token = await refresher();
      _pendingRefreshToken = null;
    } catch (error) {
      // Not fatal on its own: the existing token may still be valid, and
      // failing here would turn a recoverable blip into a dropped call.
      _warn(SwalvoWarning(
        SwalvoWarningCode.tokenRefreshFailed,
        'refreshToken() failed.',
        cause: error,
      ));
    }
  }

  bool _tokenExpiresSoon() {
    final exp = decodeTokenClaims(_token)?['exp'];
    if (exp is! num) return false;
    final expiresAt = DateTime.fromMillisecondsSinceEpoch((exp * 1000).toInt());
    return expiresAt.difference(DateTime.now()) < _tokenRefreshSkew;
  }

  void _storeResumeToken(String? token) {
    if (token == null || token.isEmpty) return;
    _resumeToken = token;
    _resumeReceivedAt = DateTime.now();
  }

  String? _usableResumeToken() {
    final token = _resumeToken;
    final receivedAt = _resumeReceivedAt;
    if (token == null || receivedAt == null) return null;
    if (DateTime.now().difference(receivedAt) > _resumeTokenMaxAge) {
      return null;
    }
    return token;
  }

  void _clearResume() {
    _resumeToken = null;
    _resumeReceivedAt = null;
  }

  void _warn(SwalvoWarning warning) {
    if (!_warnings.isClosed) _warnings.add(warning);
  }

  /// Replaces the token used by future reconnects (spec §21).
  void setToken(String token) => _token = token;

  /// Sends a message on the current socket, or drops it.
  ///
  /// Gated on [_joinSent], not [_joined]. The SFU's join-time offer reaches
  /// the client over a path that has no ordering relationship with the
  /// API's own `room.joined` reply to this client's `room.join` request:
  /// the offer travels node-link → gateway → socket, entirely independent
  /// of the join handler's response. When the SFU (which creates and sends
  /// its offer synchronously, with no I/O in between) wins that race,
  /// this client's answer to it is a message this method has to be willing
  /// to send *before* `room.joined` has arrived — gating on [_joined]
  /// silently dropped that answer, and every message behind it, leaving the
  /// SFU's offer permanently unanswered until it gave up after
  /// `answerTimeout`. [_joinSent] flips the instant `room.join` is
  /// dispatched, which is exactly the point after which any message this
  /// socket produces is a legitimate consequence of that join, confirmed or
  /// not.
  void send(Map<String, dynamic> message) {
    final socket = _socket;
    if (socket == null ||
        !_joinSent && message['type'] != ClientMessageType.roomJoin) {
      // Dropped instead of queued. Every message here describes a moment
      // in a negotiation, and replaying a stale answer after a reconnect
      // would be worse than never sending it: the reconnect re-joins and
      // negotiates afresh.
      return;
    }
    if (message['type'] == ClientMessageType.roomJoin) {
      _joinSent = true;
    }
    try {
      socket.send(jsonEncode(message));
    } catch (_) {
      // The socket closed between the check and the write. The close
      // handler drives recovery.
    }
  }

  /// Leaves the room and closes the socket. Suppresses reconnection.
  Future<void> close() async {
    _closedByCaller = true;
    _clearResume();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _pendingAttempt = null;

    if (_socket != null && _joined) {
      send({'type': ClientMessageType.roomLeave});
    }
    _joined = false;
    _joinSent = false;

    await _subscription?.cancel();
    _subscription = null;
    await _socket?.close(1000, 'client left');
    _socket = null;
  }

  Future<void> dispose() async {
    await close();
    await _messages.close();
    await _joins.close();
    await _states.close();
    await _warnings.close();
  }

  String _url() {
    final base = endpoint.endsWith('/')
        ? endpoint.substring(0, endpoint.length - 1)
        : endpoint;
    // The token goes in a query parameter because a WebSocket handshake
    // cannot carry custom headers in a browser, and Flutter Web is a
    // supported target. It is short-lived by design for exactly this
    // reason, and the connection must be wss:// in production, which the
    // server's own configuration validation enforces.
    return '$base?token=${Uri.encodeQueryComponent(_token)}';
  }

  Map<String, dynamic>? _parse(dynamic raw) {
    if (raw is! String) {
      // Swalvo's signaling is text-only. A binary frame means something
      // else is on this socket, and guessing at it would be worse than
      // ignoring it.
      return null;
    }
    try {
      final parsed = jsonDecode(raw);
      return parsed is Map<String, dynamic> ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  SwalvoException _toException(Map<String, dynamic> message) {
    final code = message['code'] as String? ?? '';
    final text = message['message'] as String? ?? 'Signaling error.';

    return switch (code) {
      SignalingErrorCode.invalidToken =>
        SwalvoException(SwalvoErrorCode.invalidToken, text),
      SignalingErrorCode.tokenExpired =>
        SwalvoException(SwalvoErrorCode.tokenExpired, text),
      SignalingErrorCode.roomNotFound =>
        SwalvoException(SwalvoErrorCode.roomNotFound, text),
      SignalingErrorCode.unauthorized ||
      SignalingErrorCode.permissionDenied =>
        SwalvoException(SwalvoErrorCode.permissionDenied, text),
      SignalingErrorCode.roomFull ||
      SignalingErrorCode.noRtcCapacity ||
      SignalingErrorCode.rtcServerUnreachable =>
        SwalvoException(SwalvoErrorCode.connectionFailed, text),
      SignalingErrorCode.rateLimited =>
        SwalvoException(SwalvoErrorCode.networkError, text),
      _ => SwalvoException(SwalvoErrorCode.signalingError, text),
    };
  }
}

/// Transport lifecycle, separate from the media connection's state.
///
/// Two sealed variants, not an enum with a nullable error: a
/// failure without its cause is not actionable, and the type makes it
/// impossible to report one without the other.
sealed class SignalingLifecycle {
  const SignalingLifecycle();

  const factory SignalingLifecycle.reconnecting({bool resuming}) =
      SignalingReconnecting;
  const factory SignalingLifecycle.closed() = SignalingClosed;
  const factory SignalingLifecycle.failed(SwalvoException error,
      [SwalvoDisconnectReason reason]) = SignalingFailed;
  const factory SignalingLifecycle.ended(SwalvoDisconnectReason reason) =
      SignalingEnded;
}

class SignalingReconnecting extends SignalingLifecycle {
  const SignalingReconnecting({this.resuming = false});

  /// Whether the next attempt will offer a resume token. When it will, the
  /// peer connection may still be live and should be kept until the join
  /// says whether the session was resumed.
  final bool resuming;
}

class SignalingClosed extends SignalingLifecycle {
  const SignalingClosed();
}

class SignalingFailed extends SignalingLifecycle {
  const SignalingFailed(this.error,
      [this.reason = SwalvoDisconnectReason.connectionFailed]);
  final SwalvoException error;
  final SwalvoDisconnectReason reason;
}

/// The server ended the session on purpose (removed, or the room closed).
/// Not an error, and never followed by a reconnect.
class SignalingEnded extends SignalingLifecycle {
  const SignalingEnded(this.reason);
  final SwalvoDisconnectReason reason;
}
