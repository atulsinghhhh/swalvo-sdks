import 'dart:async';

import 'package:meta/meta.dart' show visibleForTesting;
import 'package:swalvo_chat/swalvo_chat.dart'
    show SwalvoChat, SwalvoChatErrorCode, SwalvoChatException, SwalvoMessage;
import 'package:swalvo_rtc/swalvo_rtc.dart' show Swalvo, SwalvoRoom;

import 'types.dart';

/// A minimal view of whatever room needs leaving and disposing if a
/// stream's chat fails to connect, narrowed to exactly the two calls that
/// cleanup needs. `null` when there is no room at all (a BROADCAST/HLS
/// viewer has no [SwalvoRoom]).
///
/// Exists so [SwalvoLiveStream.connectChatOrCleanUp] — the exact logic
/// behind the fix for a chat connection that fails after its room already
/// joined (or fails on its own for a room-less HLS viewer) — is
/// deterministically testable without a network: `swalvo_rtc` has no
/// supported way to construct a working [SwalvoRoom] outside a real
/// signaling round trip (its constructor is private to that package), so
/// a test cannot hand this logic a real one. A test instead supplies a
/// lightweight fake implementing exactly this interface; [join] always
/// wraps the real room in a trivial pass-through
/// ([_RealRoomCleanup]), never alternate behavior — the two `leave()`/
/// `dispose()` calls a reviewer sees here are the only two calls this
/// abstraction can ever make.
@visibleForTesting
abstract class LiveStreamRoomCleanup {
  Future<void> leave();
  void dispose();
}

class _RealRoomCleanup implements LiveStreamRoomCleanup {
  _RealRoomCleanup(this._room);
  final SwalvoRoom _room;
  @override
  Future<void> leave() => _room.leave();
  @override
  void dispose() => _room.dispose();
}

/// Swalvo Live Streaming on Flutter.
///
/// ```dart
/// final stream = await SwalvoLiveStream.join(credentials);
///
/// if (stream.isHost) {
///   await stream.room.enableCamera();
///   await stream.room.enableMicrophone();
/// }
///
/// await stream.react('❤️');
/// await stream.leave();
/// ```
///
/// A thin composition, not a parallel implementation: [room] *is* a
/// `swalvo_rtc` [SwalvoRoom] and [chat] *is* a `swalvo_chat` [SwalvoChat].
/// Every method and stream documented for those packages: participant
/// changes, camera/microphone, messages, reactions, typing, presence;
/// works unchanged on what this class hands back. Host vs. viewer publish
/// permission is enforced entirely server-side by the RTC token grant;
/// this class never sends a role, only reflects one it was given.
class SwalvoLiveStream {
  SwalvoLiveStream._(this.credentials, this._swalvo, this._chat, this._room) {
    final chat = _chat;
    if (chat != null) {
      _chatSub = chat.messages.listen(_onChatMessage);
    }
  }

  /// Joins a stream and connects its chat, if it has one.
  ///
  /// A BROADCAST viewer's credentials carry [SwalvoLiveStreamCredentials.playback]
  /// instead of `rtc`: the stream then has no [room]; play it with
  /// [SwalvoLivePlayer] (live-streaming-v2.md §3.5).
  static Future<SwalvoLiveStream> join(
    SwalvoLiveStreamCredentials credentials,
  ) async {
    final rtc = credentials.rtc;
    if (rtc == null) {
      if (credentials.playback?.url == null) {
        throw ArgumentError(
          'These credentials have neither rtc nor a playback url. For a BROADCAST '
          'stream, mint the viewer token with acceptPlayback: true once it has started.',
        );
      }
      final chat = await _connectChat(credentials);
      return SwalvoLiveStream._(credentials, null, chat, null);
    }
    final swalvo = Swalvo(
      token: rtc.token,
      endpoint: rtc.endpoint,
      iceServers: rtc.iceServers,
    );

    SwalvoChat? chat;
    final chatCredentials = credentials.chat;
    if (chatCredentials != null) {
      chat = SwalvoChat(
        token: chatCredentials.token,
        apiUrl: chatCredentials.apiUrl,
        chatUrl: chatCredentials.chatUrl,
      );
    }

    // No roomId argument: `swalvo.join()` defaults to whatever room the
    // token itself names, which is correct whether this is a normal join
    // or a cascaded viewer seated on an edge room (§3.1) — the server
    // never names that edge room in `credentials.rtcRoom`.
    final room = await swalvo.join();

    if (chat != null && chatCredentials != null) {
      final conversation = chatCredentials.conversations.isNotEmpty
          ? chatCredentials.conversations.first
          : credentials.streamId;
      await connectChatOrCleanUp(
        chat: chat,
        conversation: conversation,
        room: _RealRoomCleanup(room),
      );
    }

    return SwalvoLiveStream._(credentials, swalvo, chat, room);
  }

  static Future<SwalvoChat?> _connectChat(
      SwalvoLiveStreamCredentials credentials) async {
    final chatCredentials = credentials.chat;
    if (chatCredentials == null) return null;
    final chat = SwalvoChat(
      token: chatCredentials.token,
      apiUrl: chatCredentials.apiUrl,
      chatUrl: chatCredentials.chatUrl,
    );
    // No room to strand here (this is the pure-HLS-viewer-with-chat path —
    // there is no SwalvoRoom at all): `room: null` below.
    await connectChatOrCleanUp(
      chat: chat,
      conversation: chatCredentials.conversations.isNotEmpty
          ? chatCredentials.conversations.first
          : credentials.streamId,
      room: null,
    );
    return chat;
  }

  /// Connects [chat] to [conversation]; on failure, leaves and disposes
  /// [room] (if there is one — a BROADCAST/HLS viewer has none) and always
  /// disposes [chat] itself before rethrowing.
  ///
  /// The single implementation [join] uses for both of its chat-attach
  /// sites (RTC+chat, and the room-less HLS-viewer-with-chat path) — not
  /// duplicated, so there is exactly one place this can regress. Public
  /// and `@visibleForTesting` rather than private specifically so a test
  /// can exercise the real failure-and-cleanup path without a network: see
  /// [LiveStreamRoomCleanup]'s doc for why that type exists instead of a
  /// real [SwalvoRoom].
  @visibleForTesting
  static Future<void> connectChatOrCleanUp({
    required SwalvoChat chat,
    required String conversation,
    required LiveStreamRoomCleanup? room,
  }) async {
    try {
      await chat.connect(conversation);
    } catch (error) {
      // A joined room isn't stranded just because chat failed. A caller
      // that genuinely needs chat will see `stream.chat` connect state
      // reflect the failure via its own connectionStateChanges stream.
      if (room != null) {
        await room.leave();
        room.dispose();
      }
      // `chat` is otherwise dropped right here on the floor, still
      // holding its own REST client and any timer `connect()` armed
      // before failing — nothing else will ever reach this instance to
      // dispose it once this function rethrows.
      chat.dispose();
      rethrow;
    }
  }

  final SwalvoLiveStreamCredentials credentials;
  final Swalvo? _swalvo;
  final SwalvoChat? _chat;
  final SwalvoRoom? _room;
  StreamSubscription<SwalvoMessage>? _chatSub;
  final StreamController<SwalvoLiveStageEvent> _stage =
      StreamController<SwalvoLiveStageEvent>.broadcast();

  /// `rtc` (in the room) or `hls` (a BROADCAST viewer; use [SwalvoLivePlayer]).
  String get delivery => _room == null ? 'hls' : 'rtc';

  /// The HLS manifest for a BROADCAST viewer; `null` for an RTC participant.
  String? get playbackUrl => credentials.playback?.url;

  /// LL-HLS for a BROADCAST viewer, when served: pass as
  /// [SwalvoLivePlayer.lowLatencyUrl].
  String? get lowLatencyPlaybackUrl => credentials.playback?.llhlsUrl;

  /// Watch-time heartbeat: pass as [SwalvoLivePlayer.beacon].
  SwalvoPlaybackBeacon? get playbackBeacon => credentials.playback?.beacon;

  /// Stage signals from the stream's chat. Invites, promotions and
  /// demotions are only accepted from the server (`senderId == 'system'`),
  /// so a viewer can't forge one.
  Stream<SwalvoLiveStageEvent> get stageEvents => _stage.stream;

  void _onChatMessage(SwalvoMessage message) {
    final meta = message.metadata;
    // legacy: 'livqeno' is the metadata key the server writes; wire contract.
    if (meta == null || meta['livqeno'] != 'stage') return;
    final action = meta['action'];
    if (action is! String) return;
    const serverOnly = {'invited', 'promoted', 'demoted'};
    const fromViewers = {'raise_hand', 'lower_hand'};
    final me = credentials.identity;
    if (serverOnly.contains(action)) {
      if (message.senderId != 'system') return;
      final identity = '${meta['identity'] ?? ''}';
      _stage.add(SwalvoLiveStageEvent(
        action: action,
        identity: identity,
        role: meta['role'] as String?,
        forMe: me != null && identity == me,
      ));
    } else if (fromViewers.contains(action)) {
      _stage.add(SwalvoLiveStageEvent(
        action: action,
        identity: message.senderId,
        forMe: message.senderId == me,
      ));
    }
  }

  /// Which stream this is.
  String get streamId => credentials.streamId;

  /// This identity's role: never something inferred, only ever what the
  /// credentials said.
  SwalvoLiveStreamRole get role => credentials.role;

  /// `true` for [SwalvoLiveStreamRole.host] and [SwalvoLiveStreamRole.coHost].
  bool get isHost => role.isHost;

  /// The stream's room. Every `swalvo_rtc` API works on it unchanged.
  /// Throws for an HLS viewer, who has no room ([delivery] is `hls`).
  SwalvoRoom get room {
    final room = _room;
    if (room == null) {
      throw StateError(
          'This viewer watches over HLS and has no RTC room; use SwalvoLivePlayer.');
    }
    return room;
  }

  /// The stream's chat, if it has one attached. Every `swalvo_chat` API
  /// works on it unchanged.
  SwalvoChat? get chat => _chat;

  /// Reacts to the stream: the same reaction model web, CLI, and the
  /// server SDKs use, attached to the chat message every viewer's
  /// reaction lands on.
  ///
  /// Throws a [SwalvoChatException] with
  /// [SwalvoChatErrorCode.notInRoom] if this stream has no chat
  /// conversation attached.
  Future<void> react(String emoji) async {
    final chat = _chat;
    final rootMessageId = credentials.chatRootMessageId;
    if (chat == null || rootMessageId == null) {
      throw const SwalvoChatException(
        SwalvoChatErrorCode.notInRoom,
        'This stream has no chat conversation attached, so reactions are unavailable.',
      );
    }
    await chat.addReaction(rootMessageId, emoji);
  }

  /// Leaves the room and disposes the chat connection. Ending the stream
  /// itself (`LIVE` -> `ENDED`) is a separate, server-side call: see
  /// `@swalvo/server`'s/`swalvo` (Python)'s `end_stream()`.
  Future<void> leave() async {
    await _swalvo?.leave();
    await _chatSub?.cancel();
    await _stage.close();
    _chat?.dispose();
  }
}
