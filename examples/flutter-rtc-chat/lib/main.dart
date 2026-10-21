import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:swalvo_chat/swalvo_chat.dart';
import 'package:swalvo_rtc/swalvo_rtc.dart';

/// A Swalvo video call with a chat panel, in Flutter.
///
/// Everything is real: WebRTC media through Swalvo's SFU, messages through
/// Swalvo Chat into Postgres. No mock participants, no fake message list
/// (spec §11).
///
/// Devices on the same Wi-Fi should point this at the host machine's LAN
/// IP: `localhost` on a phone means the phone.
const String backendUrl = String.fromEnvironment(
  'RAVEN_BACKEND_URL',
  defaultValue: 'http://localhost:8791',
);

void main() => runApp(const SwalvoExampleApp());

class SwalvoExampleApp extends StatelessWidget {
  const SwalvoExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Swalvo',
        theme: ThemeData.dark(useMaterial3: true),
        home: const JoinScreen(),
      );
}

/// What the backend hands back: two independent short-lived tokens.
class Session {
  const Session({
    required this.identity,
    required this.rtcToken,
    required this.endpoint,
    required this.roomName,
    required this.chatToken,
    required this.chatApiUrl,
    required this.chatRoomId,
    required this.iceServers,
  });

  factory Session.fromJson(String identity, Map<String, dynamic> json) {
    final rtc = json['rtc'] as Map<String, dynamic>;
    final chat = json['chat'] as Map<String, dynamic>;

    return Session(
      identity: identity,
      rtcToken: rtc['token'] as String,
      endpoint: rtc['endpoint'] as String,
      roomName: rtc['roomName'] as String,
      chatToken: chat['token'] as String,
      chatApiUrl: chat['apiUrl'] as String,
      chatRoomId: chat['roomId'] as String,
      iceServers: (rtc['iceServers'] as List<dynamic>? ?? const [])
          .map((value) =>
              SwalvoIceServer.fromJson(value as Map<String, dynamic>))
          .toList(growable: false),
    );
  }

  final String identity;
  final String rtcToken;
  final String endpoint;
  final String roomName;
  final String chatToken;
  final String chatApiUrl;
  final String chatRoomId;
  final List<SwalvoIceServer> iceServers;
}

class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key});

  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> {
  final _identity = TextEditingController(text: 'alice');
  final _room = TextEditingController(text: 'standup');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _identity.dispose();
    _room.dispose();
    super.dispose();
  }

  Future<void> _join() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      // The app authenticates against its OWN backend. A Swalvo API key
      // never exists on the device (spec §15).
      final response = await http.post(
        Uri.parse('$backendUrl/api/session'),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'identity': _identity.text.trim(),
          'room': _room.text.trim(),
        }),
      );

      final body = jsonDecode(response.body) as Map<String, dynamic>;
      if (response.statusCode >= 400) {
        throw Exception(body['error'] ?? 'Could not start the session');
      }

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              CallScreen(session: Session.fromJson(_identity.text.trim(), body)),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Swalvo', style: TextStyle(fontSize: 32)),
                const SizedBox(height: 8),
                const Text('Video and chat, on the same screen.'),
                const SizedBox(height: 24),
                TextField(
                  controller: _identity,
                  decoration: const InputDecoration(labelText: 'Your identity'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _room,
                  decoration: const InputDecoration(labelText: 'Room'),
                ),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _busy ? null : _join,
                  child: Text(_busy ? 'Joining…' : 'Join'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                ],
              ],
            ),
          ),
        ),
      );
}

class CallScreen extends StatefulWidget {
  const CallScreen({super.key, required this.session});

  final Session session;

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  Swalvo? _swalvo;
  SwalvoRoom? _room;
  SwalvoChat? _chat;

  final _messages = <SwalvoMessage>[];
  final _composer = TextEditingController();
  final _typingUsers = <String>{};

  bool _chatOpen = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_connect());
  }

  @override
  void dispose() {
    _composer.dispose();
    // Order matters: leave the room, then tear down chat. Both hold
    // native resources that outlive the widget if not released.
    final swalvo = _swalvo;
    if (swalvo != null) unawaited(swalvo.leave());
    _chat?.dispose();
    _room?.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final session = widget.session;

    try {
      // Prompt before joining. Discovering a refused camera mid-call is a
      // worse experience than being asked up front.
      await SwalvoPermissions.request();

      final swalvo = Swalvo(
        token: session.rtcToken,
        endpoint: session.endpoint,
        iceServers: session.iceServers,
      );
      final room = await swalvo.join(session.roomName);

      final chat = SwalvoChat(
        token: session.chatToken,
        apiUrl: session.chatApiUrl,
      );
      await chat.connect(session.chatRoomId);

      // History first, so the panel opens with context rather than empty.
      final history = await chat.history(limit: 50);

      chat.messages.listen((message) {
        if (!mounted) return;
        setState(() {
          if (!_messages.any((existing) => existing.id == message.id)) {
            _messages.add(message);
          }
        });
      });

      chat.typing.listen((event) {
        if (!mounted || event.userId == session.identity) return;
        setState(() {
          if (event.isTyping) {
            _typingUsers.add(event.userId);
          } else {
            _typingUsers.remove(event.userId);
          }
        });
      });

      if (!mounted) {
        // The screen went away while connecting. Release everything
        // instead of leaving a call running behind a dismissed route.
        await swalvo.leave();
        chat.dispose();
        return;
      }

      setState(() {
        _swalvo = swalvo;
        _room = room;
        _chat = chat;
        _messages
          ..clear()
          ..addAll(history.messages.reversed);
      });
    } on SwalvoException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } on SwalvoChatException catch (error) {
      // Chat failing must not take the call down with it.
      debugPrint('[example] chat unavailable: ${error.message}');
    }
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    final chat = _chat;
    if (text.isEmpty || chat == null) return;

    _composer.clear();
    await chat.stopTyping();
    // Completes once Swalvo has durably stored it; the message itself
    // arrives through the normal stream.
    await chat.send(text);
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Back'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final room = _room;
    if (room == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    // ListenableBuilder is the idiomatic way to follow a ChangeNotifier;
    // the room rebuilds this subtree as participants and tracks change.
    return ListenableBuilder(
      listenable: room,
      builder: (context, _) {
        final remotes = room.remoteParticipants;
        final featured = remotes.isEmpty ? null : remotes.first;

        return Scaffold(
          body: Column(
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
                                ? 'Waiting for someone to join…'
                                : '${featured.identity} has their camera off',
                          ),
                        ),
                      ),
                    ),
                    Positioned(
                      right: 16,
                      top: 16,
                      width: 96,
                      height: 140,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SwalvoVideoView(
                          participant: room.localParticipant,
                          room: room,
                        ),
                      ),
                    ),
                    Positioned(
                      left: 16,
                      top: 16,
                      child: _StatusChip(
                        text:
                            '${widget.session.roomName} · ${room.connectionState.name}',
                      ),
                    ),
                  ],
                ),
              ),
              if (_chatOpen) _buildChatPanel(),
              _buildControls(room),
            ],
          ),
        );
      },
    );
  }

  Widget _buildChatPanel() => SizedBox(
        height: 280,
        child: Column(
          children: [
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                itemCount: _messages.length,
                itemBuilder: (context, index) {
                  final message = _messages[index];
                  if (message.deleted) {
                    return const Padding(
                      padding: EdgeInsets.symmetric(vertical: 3),
                      child: Text('message deleted',
                          style: TextStyle(fontStyle: FontStyle.italic)),
                    );
                  }
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: RichText(
                      text: TextSpan(
                        style: DefaultTextStyle.of(context).style,
                        children: [
                          TextSpan(
                            text: '${message.senderId}: ',
                            style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF8EA2FF)),
                          ),
                          TextSpan(text: message.text ?? ''),
                          if (message.edited)
                            const TextSpan(
                              text: ' (edited)',
                              style: TextStyle(color: Colors.grey, fontSize: 12),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            SizedBox(
              height: 18,
              child: Text(
                _typingUsers.isEmpty
                    ? ''
                    : '${_typingUsers.join(', ')} typing…',
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _composer,
                      decoration:
                          const InputDecoration(hintText: 'Message…'),
                      // Safe per keystroke: the server only broadcasts on
                      // the transition into typing.
                      onChanged: (_) {
                        final chat = _chat;
                        if (chat != null) unawaited(chat.startTyping());
                      },
                      onSubmitted: (_) => unawaited(_send()),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: () => unawaited(_send()),
                    child: const Text('Send'),
                  ),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _buildControls(SwalvoRoom room) {
    final local = room.localParticipant;

    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _ControlButton(
            label: local.isCameraEnabled ? 'Camera off' : 'Camera on',
            onPressed: () => unawaited(
              local.isCameraEnabled ? room.disableCamera() : room.enableCamera(),
            ),
          ),
          _ControlButton(
            label: local.isMicrophoneEnabled ? 'Mute' : 'Unmute',
            onPressed: () => unawaited(
              local.isMicrophoneEnabled
                  ? room.disableMicrophone()
                  : room.enableMicrophone(),
            ),
          ),
          _ControlButton(
            label: 'Flip',
            onPressed: () => unawaited(room.switchCamera()),
          ),
          _ControlButton(
            label: _chatOpen ? 'Hide chat' : 'Chat',
            onPressed: () => setState(() => _chatOpen = !_chatOpen),
          ),
          _ControlButton(
            label: 'Leave',
            destructive: true,
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _ControlButton extends StatelessWidget {
  const _ControlButton({
    required this.label,
    required this.onPressed,
    this.destructive = false,
  });

  final String label;
  final VoidCallback onPressed;
  final bool destructive;

  @override
  Widget build(BuildContext context) => FilledButton.tonal(
        onPressed: onPressed,
        style: destructive
            ? FilledButton.styleFrom(backgroundColor: const Color(0xFF5B1F26))
            : null,
        child: Text(label, style: const TextStyle(fontSize: 12)),
      );
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.black54,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(text, style: const TextStyle(fontSize: 12)),
      );
}
