import 'dart:async';

import 'package:flutter/material.dart';
import 'package:swalvo_chat/swalvo_chat.dart';

import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';

/// Covers scenarios 8-10: real message delivery to a second client, and an
/// idempotent retry that must not create a duplicate durable message.
class ChatTab extends StatefulWidget {
  const ChatTab({super.key, required this.backendClient, required this.diagnostics});

  final BackendClient backendClient;
  final DiagnosticLog diagnostics;

  @override
  State<ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends State<ChatTab> {
  final _identity = TextEditingController(text: 'tester');
  final _room = TextEditingController(text: 'sdk-test-room');
  final _composer = TextEditingController();

  SwalvoChat? _chat;
  StreamSubscription<SwalvoMessage>? _messagesSub;
  StreamSubscription<SwalvoChatConnectionState>? _connSub;
  final _messages = <SwalvoMessage>[];
  String? _lastClientMessageId;
  String? _lastText;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _identity.dispose();
    _room.dispose();
    _composer.dispose();
    unawaited(_disconnect());
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final session = await widget.backendClient.createSession(
        room: _room.text.trim(),
        identity: _identity.text.trim(),
      );
      final chat = SwalvoChat(token: session.chatToken, apiUrl: session.chatApiUrl);
      await chat.connect(session.chatRoomId);

      final history = await chat.history(limit: 50);

      _connSub = chat.connectionStateChanges.listen((state) {
        widget.diagnostics.log(DiagnosticCategory.chat, 'Chat connection state: ${state.name}');
      });
      _messagesSub = chat.messages.listen((message) {
        widget.diagnostics.log(DiagnosticCategory.chat, 'Message received: ${message.id}');
        if (!mounted) return;
        setState(() {
          if (!_messages.any((existing) => existing.id == message.id)) {
            _messages.add(message);
          }
        });
      });

      if (!mounted) {
        chat.dispose();
        return;
      }

      setState(() {
        _chat = chat;
        _messages
          ..clear()
          ..addAll(history.messages.reversed);
      });
    } on SwalvoChatException catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'Chat connect failed: ${error.message}');
      if (mounted) setState(() => _error = error.message);
    } catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'Chat connect failed: $error');
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disconnect() async {
    final chat = _chat;
    _chat = null;
    await _messagesSub?.cancel();
    await _connSub?.cancel();
    _messagesSub = null;
    _connSub = null;
    chat?.dispose();
    if (mounted) setState(() => _messages.clear());
  }

  Future<void> _send() async {
    final chat = _chat;
    final text = _composer.text.trim();
    if (chat == null || text.isEmpty) return;
    _composer.clear();
    try {
      final message = await chat.send(text);
      if (mounted) {
        setState(() {
          _lastClientMessageId = message.clientMessageId;
          _lastText = text;
        });
      }
      widget.diagnostics.log(
        DiagnosticCategory.chat,
        'Sent message ${message.id} (clientMessageId=${message.clientMessageId}).',
      );
    } on SwalvoChatException catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'Send failed: ${error.message}');
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _retryLast() async {
    final chat = _chat;
    final clientMessageId = _lastClientMessageId;
    final text = _lastText;
    if (chat == null || clientMessageId == null || text == null) return;
    try {
      // Same clientMessageId as the original send proves the dedupe path
      // documented on SwalvoChat.send (chat_client.dart): the same key
      // must return the original message, not create a duplicate.
      final message = await chat.send(text, clientMessageId: clientMessageId);
      widget.diagnostics.log(
        DiagnosticCategory.chat,
        'Retry with the same clientMessageId returned message ${message.id} — '
        'compare against the id logged on the original send.',
      );
    } on SwalvoChatException catch (error) {
      widget.diagnostics.log(DiagnosticCategory.error, 'Retry failed: ${error.message}');
      if (mounted) setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final chat = _chat;
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
                  onPressed: _busy || chat != null ? null : _connect,
                  child: Text(_busy ? 'Connecting…' : 'Connect'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: chat == null ? null : () => unawaited(_disconnect()),
                  child: const Text('Disconnect'),
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          ],
          const SizedBox(height: 8),
          const Text(
            'Run a second instance of this app with a different identity, same room, '
            'to verify a message sent here actually arrives there.',
            style: TextStyle(fontSize: 11, color: Colors.grey),
          ),
          const SizedBox(height: 8),
          if (chat != null) ...[
            Expanded(
              child: ListView.builder(
                itemCount: _messages.length,
                itemBuilder: (context, index) {
                  final message = _messages[index];
                  return ListTile(
                    dense: true,
                    title: Text(message.deleted ? '(deleted)' : (message.text ?? '')),
                    subtitle: Text(
                      '${message.senderId} · ${message.id} · ${message.createdAt.toIso8601String()}'
                      '${message.edited ? ' · edited' : ''}',
                    ),
                  );
                },
              ),
            ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _composer,
                    decoration: const InputDecoration(hintText: 'Message…'),
                    onSubmitted: (_) => unawaited(_send()),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: () => unawaited(_send()), child: const Text('Send')),
              ],
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _lastClientMessageId == null ? null : () => unawaited(_retryLast()),
              child: const Text('Retry last send (same clientMessageId)'),
            ),
          ],
        ],
      ),
    );
  }
}
