import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'signaling_client.dart';

/// The real socket, over `package:web_socket_channel`.
///
/// That package rather than `dart:io`'s `WebSocket` because Flutter Web is
/// a supported target and `dart:io` is unavailable there. The
/// [SwalvoSocket] interface exists so the reconnect logic in
/// `signaling_client.dart` can be tested without any of this.
class ChannelSocket implements SwalvoSocket {
  ChannelSocket._(this._channel) {
    // `stream` is single-subscription, and the signaling client listens
    // once, but the close future below also needs to know when it ends,
    // so completion is driven from that one listener instead of a second
    // subscription (which would throw).
    _messages =
        _channel.stream.map((event) => event).handleError((Object error) {
      if (!_closed.isCompleted) {
        _closed.complete(_channel.closeCode);
      }
      throw error;
    }).asBroadcastStream(
      onCancel: (_) {
        if (!_closed.isCompleted) {
          _closed.complete(_channel.closeCode);
        }
      },
    );

    unawaited(_channel.sink.done.then((_) {
      if (!_closed.isCompleted) {
        _closed.complete(_channel.closeCode);
      }
    }).catchError((Object _) {
      if (!_closed.isCompleted) {
        _closed.complete(_channel.closeCode);
      }
    }));
  }

  /// Connects, completing once the handshake succeeds.
  ///
  /// `ready` is what distinguishes "the server accepted the upgrade" from
  /// "the socket object exists": without awaiting it, a rejected
  /// credential surfaces later as a close, not as a failed connect,
  /// and the join times out instead of reporting the real reason.
  static Future<SwalvoSocket> connect(String url) async {
    final channel = WebSocketChannel.connect(Uri.parse(url));
    await channel.ready;
    return ChannelSocket._(channel);
  }

  final WebSocketChannel _channel;
  final _closed = Completer<int?>();
  late final Stream<dynamic> _messages;

  @override
  Stream<dynamic> get messages => _messages;

  @override
  Future<int?> get closed => _closed.future;

  @override
  void send(String data) => _channel.sink.add(data);

  @override
  Future<void> close([int? code, String? reason]) async {
    await _channel.sink.close(code, reason);
    if (!_closed.isCompleted) {
      _closed.complete(code);
    }
  }
}
