import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpClient, ContentType;

import 'package:flutter/foundation.dart' show kIsWeb;

import 'package:flutter/widgets.dart';
import 'package:video_player/video_player.dart';

import 'types.dart';

/// Plays a BROADCAST stream's HLS for a viewer whose [SwalvoLiveStream]
/// has `delivery == 'hls'` (live-streaming-v2.md §3.5).
///
/// ```dart
/// SwalvoLivePlayer(url: stream.playbackUrl!)
/// ```
///
/// While the stream is still starting the manifest may not exist yet, so
/// a failed initialise is retried every [retryEvery] until it plays. The
/// platform player (AVPlayer, ExoPlayer) handles ABR and the live edge.
class SwalvoLivePlayer extends StatefulWidget {
  const SwalvoLivePlayer({
    super.key,
    required this.url,
    this.lowLatencyUrl,
    this.beacon,
    this.retryEvery = const Duration(seconds: 2),
    this.placeholder,
  });

  final String url;

  /// LL-HLS, played first when given (AVPlayer and ExoPlayer support it
  /// natively). On any failure the player switches to [url] for good.
  final String? lowLatencyUrl;

  /// Watch-time heartbeat for viewer-minute billing
  /// (`stream.playbackBeacon`): sent every `intervalSec` while playing.
  final SwalvoPlaybackBeacon? beacon;
  final Duration retryEvery;

  /// Shown until the first frame (defaults to an empty box).
  final Widget? placeholder;

  @override
  State<SwalvoLivePlayer> createState() => _SwalvoLivePlayerState();
}

class _SwalvoLivePlayerState extends State<SwalvoLivePlayer> {
  VideoPlayerController? _controller;
  Timer? _retry;
  bool _disposed = false;
  bool _lowLatency = false;
  Timer? _beaconTimer;

  void _startBeacon() {
    _beaconTimer?.cancel();
    final beacon = widget.beacon;
    if (beacon == null || kIsWeb) return;
    final every =
        Duration(seconds: beacon.intervalSec < 5 ? 5 : beacon.intervalSec);
    _beaconTimer = Timer.periodic(every, (_) async {
      final controller = _controller;
      if (_disposed || controller == null || !controller.value.isPlaying) {
        return;
      }
      try {
        final client = HttpClient();
        final request = await client.postUrl(Uri.parse(beacon.url));
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode({'token': beacon.token}));
        await (await request.close()).drain<void>();
        client.close();
      } catch (_) {
        // Best-effort: a dropped beat never affects playback.
      }
    });
  }

  String get _currentUrl => _lowLatency && widget.lowLatencyUrl != null
      ? widget.lowLatencyUrl!
      : widget.url;

  @override
  void initState() {
    super.initState();
    _lowLatency = widget.lowLatencyUrl != null;
    _open();
    _startBeacon();
  }

  @override
  void didUpdateWidget(SwalvoLivePlayer old) {
    super.didUpdateWidget(old);
    if (old.beacon?.token != widget.beacon?.token) _startBeacon();
    if (old.url != widget.url || old.lowLatencyUrl != widget.lowLatencyUrl) {
      _lowLatency = widget.lowLatencyUrl != null;
      _open();
    }
  }

  Future<void> _open() async {
    _retry?.cancel();
    final previous = _controller;
    final controller = VideoPlayerController.networkUrl(
      Uri.parse(_currentUrl),
      formatHint: VideoFormat.hls,
    );
    _controller = controller;
    await previous?.dispose();
    try {
      await controller.initialize();
      if (_disposed || _controller != controller) return;
      await controller.play();
      setState(() {});
    } catch (_) {
      if (_disposed || _controller != controller) return;
      if (_lowLatency) {
        // The low-latency origin lives on the egress worker; use the CDN copy.
        _lowLatency = false;
        _open();
        return;
      }
      _retry = Timer(widget.retryEvery, _open);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _beaconTimer?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null || !controller.value.isInitialized) {
      return widget.placeholder ?? const SizedBox.shrink();
    }
    return AspectRatio(
      aspectRatio: controller.value.aspectRatio == 0
          ? 16 / 9
          : controller.value.aspectRatio,
      child: VideoPlayer(controller),
    );
  }
}
