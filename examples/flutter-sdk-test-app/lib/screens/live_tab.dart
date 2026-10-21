import 'dart:async';

import 'package:flutter/material.dart';
import 'package:swalvo_live/swalvo_live.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart' show SwalvoVideoView;

import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';

enum _Role { host, viewer }

/// Covers scenario 12, to the extent the Flutter SDK actually implements
/// it. It does not cover native RTMP/WHIP publish — the SDK has none;
/// "hosting" here means joining the stream's RTC room, same as a call.
class LiveTab extends StatefulWidget {
  const LiveTab({super.key, required this.backendClient, required this.diagnostics});

  final BackendClient backendClient;
  final DiagnosticLog diagnostics;

  @override
  State<LiveTab> createState() => _LiveTabState();
}

class _LiveTabState extends State<LiveTab> {
  _Role _role = _Role.host;
  final _identity = TextEditingController(text: 'tester');
  final _title = TextEditingController(text: 'SDK test stream');
  final _streamId = TextEditingController();
  bool _acceptPlayback = false;

  SwalvoLiveStream? _stream;
  bool _busy = false;
  String? _error;
  LiveStatus? _status;

  @override
  void dispose() {
    _identity.dispose();
    _title.dispose();
    _streamId.dispose();
    unawaited(_leave());
    super.dispose();
  }

  Future<void> _joinAsHost() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final json = await widget.backendClient.createLiveHost(
        streamId: _streamId.text.trim().isEmpty ? null : _streamId.text.trim(),
        title: _title.text.trim(),
        identity: _identity.text.trim(),
      );
      final credentials = SwalvoLiveStreamCredentials.fromJson(json);
      final stream = await SwalvoLiveStream.join(credentials);
      widget.diagnostics.log(
        DiagnosticCategory.live,
        'Joined as host: stream ${stream.streamId}, delivery=${stream.delivery}.',
      );
      if (!mounted) {
        await stream.leave();
        return;
      }
      setState(() {
        _streamId.text = stream.streamId;
        _stream = stream;
      });
    } catch (error) {
      _reportError('Host join failed', error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _joinAsViewer() async {
    final streamId = _streamId.text.trim();
    if (streamId.isEmpty) {
      setState(() => _error = 'Stream id is required to join as a viewer.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final json = await widget.backendClient.createLiveViewer(
        streamId: streamId,
        identity: _identity.text.trim(),
        acceptPlayback: _acceptPlayback,
      );
      final credentials = SwalvoLiveStreamCredentials.fromJson(json);
      final stream = await SwalvoLiveStream.join(credentials);
      widget.diagnostics.log(
        DiagnosticCategory.live,
        'Joined as viewer: stream ${stream.streamId}, delivery=${stream.delivery}.',
      );
      if (!mounted) {
        await stream.leave();
        return;
      }
      setState(() => _stream = stream);
    } catch (error) {
      _reportError('Viewer join failed', error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _reportError(String context, Object error) {
    final message = '$context: $error';
    widget.diagnostics.log(DiagnosticCategory.error, message);
    if (mounted) setState(() => _error = message);
  }

  Future<void> _leave() async {
    final stream = _stream;
    _stream = null;
    _status = null;
    if (stream != null) {
      await stream.leave();
      widget.diagnostics.log(DiagnosticCategory.live, 'Left stream.');
    }
    if (mounted) setState(() {});
  }

  Future<void> _refreshStatus() async {
    final streamId = _streamId.text.trim();
    if (streamId.isEmpty) return;
    try {
      final status = await widget.backendClient.liveStatus(streamId);
      widget.diagnostics.log(
        DiagnosticCategory.live,
        'Status: ${status.status}, viewers=${status.viewerCount}.',
      );
      if (mounted) setState(() => _status = status);
    } on BackendException catch (error) {
      _reportError('Status check failed', error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final stream = _stream;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'No native RTMP/WHIP publish in this SDK — hosting means joining the '
            "stream's RTC room, same as a normal call.",
            style: TextStyle(fontSize: 11, color: Colors.grey),
          ),
          const SizedBox(height: 8),
          if (stream == null) ...[
            SegmentedButton<_Role>(
              segments: const [
                ButtonSegment(value: _Role.host, label: Text('Host')),
                ButtonSegment(value: _Role.viewer, label: Text('Viewer')),
              ],
              selected: {_role},
              onSelectionChanged: (selection) => setState(() => _role = selection.first),
            ),
            const SizedBox(height: 12),
            TextField(controller: _identity, decoration: const InputDecoration(labelText: 'Identity')),
            const SizedBox(height: 8),
            TextField(
              controller: _streamId,
              decoration: InputDecoration(
                labelText: _role == _Role.host ? 'Stream id (blank to create a new stream)' : 'Stream id',
              ),
            ),
            if (_role == _Role.host) ...[
              const SizedBox(height: 8),
              TextField(controller: _title, decoration: const InputDecoration(labelText: 'Title (for a new stream)')),
            ],
            if (_role == _Role.viewer)
              SwitchListTile(
                title: const Text('Accept HLS playback (BROADCAST-mode streams)'),
                value: _acceptPlayback,
                onChanged: (value) => setState(() => _acceptPlayback = value),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy ? null : (_role == _Role.host ? _joinAsHost : _joinAsViewer),
              child: Text(_busy ? 'Joining…' : 'Join'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            ],
          ] else
            Expanded(
              child: _LiveStreamView(
                stream: stream,
                status: _status,
                onLeave: () => unawaited(_leave()),
                onRefreshStatus: _refreshStatus,
              ),
            ),
        ],
      ),
    );
  }
}

class _LiveStreamView extends StatelessWidget {
  const _LiveStreamView({
    required this.stream,
    required this.status,
    required this.onLeave,
    required this.onRefreshStatus,
  });

  final SwalvoLiveStream stream;
  final LiveStatus? status;
  final VoidCallback onLeave;
  final Future<void> Function() onRefreshStatus;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Stream ${stream.streamId} · role: ${stream.role.name} · delivery: ${stream.delivery}'),
          if (status != null)
            Text(
              'Status: ${status!.status} · viewers: ${status!.viewerCount ?? 'n/a'} · '
              'peak: ${status!.peakViewerCount ?? 'n/a'}',
            ),
          const SizedBox(height: 8),
          Expanded(
            child: stream.delivery == 'hls' ? _buildHlsView() : _buildRtcView(),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(onPressed: () => unawaited(onRefreshStatus()), child: const Text('Refresh status')),
              ),
              const SizedBox(width: 8),
              Expanded(child: FilledButton.tonal(onPressed: onLeave, child: const Text('Leave'))),
            ],
          ),
        ],
      );

  Widget _buildHlsView() {
    final url = stream.playbackUrl;
    if (url == null) {
      return const Center(child: Text('Stream has not started publishing an HLS manifest yet.'));
    }
    return SwalvoLivePlayer(url: url, lowLatencyUrl: stream.lowLatencyPlaybackUrl, beacon: stream.playbackBeacon);
  }

  Widget _buildRtcView() => ListenableBuilder(
        listenable: stream.room,
        builder: (context, _) {
          final room = stream.room;
          final remotes = room.remoteParticipants;
          final featured = remotes.isEmpty ? null : remotes.first;
          return Stack(
            children: [
              Positioned.fill(
                child: SwalvoVideoView(
                  participant: featured,
                  room: room,
                  placeholder: const Center(child: Text('Waiting for video…')),
                ),
              ),
              if (stream.isHost)
                Positioned(
                  right: 8,
                  top: 8,
                  width: 90,
                  height: 130,
                  child: SwalvoVideoView(participant: room.localParticipant, room: room),
                ),
            ],
          );
        },
      );
}
