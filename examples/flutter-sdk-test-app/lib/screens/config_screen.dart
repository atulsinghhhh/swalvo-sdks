import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';

enum ConnectionStatus { notConfigured, checking, connected, error }

/// Where a developer points the app at their own dev-helper backend and,
/// optionally, hands it a Swalvo API key to hold for this session.
///
/// The API key field exists to satisfy "configure the API key in the app"
/// — but the key is relayed once to the backend's `/api/configure` and
/// never kept in this screen's state beyond that call. See
/// `config/app_config.dart` and `server.mjs` for the full rationale.
class ConfigScreen extends StatefulWidget {
  ConfigScreen({
    super.key,
    required this.config,
    required this.diagnostics,
    required this.onConnected,
    BackendClient Function(String baseUrl)? clientFactory,
  }) : clientFactory = clientFactory ?? ((baseUrl) => BackendClient(baseUrl: baseUrl));

  final AppConfig config;
  final DiagnosticLog diagnostics;
  final ValueChanged<BackendClient> onConnected;
  final BackendClient Function(String baseUrl) clientFactory;

  @override
  State<ConfigScreen> createState() => _ConfigScreenState();
}

class _ConfigScreenState extends State<ConfigScreen> {
  final _apiKey = TextEditingController();
  // http://localhost:4100 is apps/api's own default dev port (and
  // @swalvo/server's default baseUrl for local development) — there is no
  // hosted Swalvo Cloud for this repo to point at instead.
  final _swalvoBaseUrl = TextEditingController(text: 'http://localhost:4100');
  late final TextEditingController _backendUrl = TextEditingController(text: widget.config.backendUrl);

  ConnectionStatus _status = ConnectionStatus.notConfigured;
  String? _error;
  DateTime? _errorAt;

  @override
  void dispose() {
    _apiKey.dispose();
    _swalvoBaseUrl.dispose();
    _backendUrl.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _status = ConnectionStatus.checking;
      _error = null;
    });

    widget.config.setBackendUrl(_backendUrl.text.trim());
    final client = widget.clientFactory(widget.config.backendUrl);

    try {
      final apiKey = _apiKey.text.trim();
      if (apiKey.isNotEmpty) {
        final swalvoBaseUrl = _swalvoBaseUrl.text.trim();
        await client.configure(apiKey: apiKey, swalvoBaseUrl: swalvoBaseUrl.isEmpty ? null : swalvoBaseUrl);
        widget.diagnostics.log(
          DiagnosticCategory.connection,
          'Relayed API key to dev-helper backend at ${widget.config.backendUrl}.',
        );
        // The key has done its one job; don't keep it around any longer
        // than it takes to send it.
        _apiKey.clear();
      }

      final health = await client.health();
      if (!health.configured) {
        throw BackendException(
          'Backend is reachable but has no API key yet. Enter one above, or set '
          'SWALVO_API_KEY on the backend and restart it.',
        );
      }

      widget.diagnostics.log(
        DiagnosticCategory.connection,
        'Connected to dev-helper backend (Swalvo base URL: ${health.baseUrl ?? 'default'}).',
      );

      if (!mounted) return;
      setState(() => _status = ConnectionStatus.connected);
      widget.onConnected(client);
    } catch (error) {
      client.dispose();
      final message = error is BackendException ? error.message : error.toString();
      widget.diagnostics.log(DiagnosticCategory.error, 'Connection failed: $message');
      if (!mounted) return;
      setState(() {
        _status = ConnectionStatus.error;
        _error = message;
        _errorAt = DateTime.now();
      });
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Swalvo SDK Test App')),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'This app never ships a Swalvo API key. The key below is sent once, '
                "directly from this device to the dev-helper backend you run yourself "
                "(server.mjs), which holds it in memory and mints short-lived tokens. "
                'A key embedded in a distributed app binary is extractable — a '
                'production app must use its own backend and the secure token-grant '
                'flow, never ship a privileged key like this.',
                style: TextStyle(color: Colors.orangeAccent, fontSize: 13),
              ),
              const SizedBox(height: 24),
              SegmentedButton<SwalvoEnvironment>(
                segments: const [
                  ButtonSegment(value: SwalvoEnvironment.local, label: Text('Local backend')),
                  ButtonSegment(value: SwalvoEnvironment.deployed, label: Text('Deployed backend')),
                ],
                selected: {widget.config.environment},
                onSelectionChanged: (selection) {
                  final env = selection.first;
                  setState(() {
                    widget.config.setEnvironment(env);
                    if (env == SwalvoEnvironment.local) {
                      _backendUrl.text = 'http://localhost:8792';
                    }
                  });
                },
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('backendUrlField'),
                controller: _backendUrl,
                decoration: const InputDecoration(
                  labelText: 'Dev-helper backend URL',
                  helperText: 'On a physical device, localhost means the device — use your LAN IP.',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('apiKeyField'),
                controller: _apiKey,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Swalvo API key (dev only — never persisted)'),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('swalvoBaseUrlField'),
                controller: _swalvoBaseUrl,
                decoration: const InputDecoration(
                  labelText: 'Swalvo API base URL',
                  helperText: "Your own running apps/api — there is no hosted Swalvo Cloud.",
                ),
              ),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('saveAndConnectButton'),
                onPressed: _status == ConnectionStatus.checking ? null : _connect,
                child: Text(_status == ConnectionStatus.checking ? 'Connecting…' : 'Save & Connect'),
              ),
              const SizedBox(height: 16),
              _StatusBanner(status: _status, error: _error, errorAt: _errorAt, onRetry: _connect),
            ],
          ),
        ),
      );
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.status, required this.error, required this.errorAt, required this.onRetry});

  final ConnectionStatus status;
  final String? error;
  final DateTime? errorAt;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    switch (status) {
      case ConnectionStatus.notConfigured:
        return const Text('Not configured.', key: Key('statusText'), style: TextStyle(color: Colors.grey));
      case ConnectionStatus.checking:
        return const Text('Checking connection…', key: Key('statusText'));
      case ConnectionStatus.connected:
        return const Text('Connected.', key: Key('statusText'), style: TextStyle(color: Colors.greenAccent));
      case ConnectionStatus.error:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Error${errorAt != null ? ' at ${errorAt!.toIso8601String()}' : ''}: ${error ?? 'Unknown error'}',
              key: const Key('statusText'),
              style: const TextStyle(color: Colors.redAccent),
            ),
            const SizedBox(height: 8),
            OutlinedButton(key: const Key('retryButton'), onPressed: onRetry, child: const Text('Retry')),
          ],
        );
    }
  }
}
