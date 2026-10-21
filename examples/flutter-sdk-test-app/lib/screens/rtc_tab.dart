import 'dart:async';

import 'package:flutter/material.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart';

import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';

/// Covers scenarios 5-7 and 11 from the spec: room join/leave, local media
/// publishing, two-client audio/video exchange (run this tab on a second
/// device/identity to verify), and permission handling.
class RtcTab extends StatefulWidget {
  const RtcTab({super.key, required this.backendClient, required this.diagnostics});

  final BackendClient backendClient;
  final DiagnosticLog diagnostics;

  @override
  State<RtcTab> createState() => _RtcTabState();
}

class _RtcTabState extends State<RtcTab> {
  final _identity = TextEditingController(text: 'tester');
  final _room = TextEditingController(text: 'sdk-test-room');

  Swalvo? _swalvo;
  SwalvoRoom? _activeRoom;
  StreamSubscription<SwalvoConnectionState>? _connSub;
  StreamSubscription<SwalvoMediaState>? _mediaSub;
  StreamSubscription<List<SwalvoParticipant>>? _participantSub;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _identity.dispose();
    _room.dispose();
    unawaited(_leave());
    super.dispose();
  }

  Future<void> _join() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final permissions = await SwalvoPermissions.request();
      widget.diagnostics.log(DiagnosticCategory.room, 'Permissions requested: $permissions');

      final session = await widget.backendClient.createSession(
        room: _room.text.trim(),
        identity: _identity.text.trim(),
      );

      final swalvo = Swalvo(token: session.rtcToken, endpoint: session.endpoint, iceServers: session.iceServers);
      final room = await swalvo.join(session.roomName);

      _connSub = room.connectionStateChanges.listen((state) {
        widget.diagnostics.log(DiagnosticCategory.connection, 'RTC connection state: ${state.name}');
      });
      _mediaSub = room.mediaStateChanges.listen((state) {
        widget.diagnostics.log(DiagnosticCategory.track, 'RTC media state: ${state.name}');
      });
      _participantSub = room.participantChanges.listen((participants) {
        widget.diagnostics.log(
          DiagnosticCategory.room,
          'Participants: ${participants.map((p) => p.identity).join(', ')}',
        );
      });

      if (!mounted) {
        await swalvo.leave();
        return;
      }

      setState(() {
        _swalvo = swalvo;
        _activeRoom = room;
      });
    } on SwalvoException catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'RTC join failed: ${error.message}');
      if (mounted) setState(() => _error = error.message);
    } catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'RTC join failed: $error');
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _leave() async {
    final swalvo = _swalvo;
    final room = _activeRoom;
    _swalvo = null;
    _activeRoom = null;
    await _connSub?.cancel();
    await _mediaSub?.cancel();
    await _participantSub?.cancel();
    _connSub = null;
    _mediaSub = null;
    _participantSub = null;
    if (swalvo != null) {
      await swalvo.leave();
      widget.diagnostics.log(DiagnosticCategory.room, 'Left RTC room.');
    }
    room?.dispose();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final room = _activeRoom;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(controller: _identity, decoration: const InputDecoration(labelText: 'Identity')),
          const SizedBox(height: 8),
          TextField(controller: _room, decoration: const InputDecoration(labelText: 'Room')),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _busy || room != null ? null : _join,
                  child: Text(_busy ? 'Joining…' : 'Join'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: room == null ? null : () => unawaited(_leave()),
                  child: const Text('Leave'),
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          ],
          const SizedBox(height: 16),
          if (room != null) Expanded(child: _RoomView(room: room)),
        ],
      ),
    );
  }
}

class _RoomView extends StatelessWidget {
  const _RoomView({required this.room});

  final SwalvoRoom room;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: room,
        builder: (context, _) {
          final local = room.localParticipant;
          final remotes = room.remoteParticipants;
          final featured = remotes.isEmpty ? null : remotes.first;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: SwalvoVideoView(
                        participant: featured,
                        room: room,
                        placeholder: Center(
                          child: Text(
                            featured == null
                                ? 'Waiting for a remote participant…'
                                : '${featured.identity} has their camera off',
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 8,
                      top: 8,
                      width: 90,
                      height: 130,
                      child: SwalvoVideoView(participant: local, room: room),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Connection: ${room.connectionState.name} · Media: ${room.mediaState.name} · '
                'Quality: ${room.connectionQuality.name}',
              ),
              const Text(
                'Not exposed by this SDK: raw bitrate/packet-loss counters. Connection '
                'quality and media state above are the real signals it provides — this '
                'app does not fabricate a stats panel beyond them.',
                style: TextStyle(fontSize: 11, color: Colors.grey),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.tonal(
                    onPressed: () => unawaited(
                      local.isCameraEnabled ? room.disableCamera() : room.enableCamera(),
                    ),
                    child: Text('Camera: ${local.isCameraEnabled ? 'On' : 'Off'}'),
                  ),
                  FilledButton.tonal(
                    onPressed: () => unawaited(
                      local.isMicrophoneEnabled ? room.disableMicrophone() : room.enableMicrophone(),
                    ),
                    child: Text('Mic: ${local.isMicrophoneEnabled ? 'On' : 'Off'}'),
                  ),
                  OutlinedButton(
                    onPressed: () => unawaited(room.switchCamera()),
                    child: const Text('Switch camera'),
                  ),
                ],
              ),
            ],
          );
        },
      );
}
