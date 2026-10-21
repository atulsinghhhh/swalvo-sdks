import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';

/// Covers test scenarios 1-4 from the spec: SDK/backend initialization
/// with valid and invalid configuration, surfaced through the dev-helper
/// backend's own health check (the Flutter SDKs themselves have no
/// separate "initialize" step beyond constructing `Swalvo`/`SwalvoChat`,
/// which happens per-room in the RTC/Chat/Live tabs).
class ConnectionTab extends StatefulWidget {
  const ConnectionTab({super.key, required this.config, required this.backendClient, required this.diagnostics});

  final AppConfig config;
  final BackendClient backendClient;
  final DiagnosticLog diagnostics;

  @override
  State<ConnectionTab> createState() => _ConnectionTabState();
}

class _ConnectionTabState extends State<ConnectionTab> {
  BackendHealth? _health;
  String? _error;
  DateTime? _errorAt;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final health = await widget.backendClient.health();
      widget.diagnostics.log(DiagnosticCategory.connection, 'Health check: configured=${health.configured}');
      if (!mounted) return;
      setState(() => _health = health);
    } catch (error) {
      final message = error is BackendException ? error.message : error.toString();
      widget.diagnostics.log(DiagnosticCategory.error, 'Health check failed: $message');
      if (!mounted) return;
      setState(() {
        _error = message;
        _errorAt = DateTime.now();
      });
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Environment: ${widget.config.environment.name}'),
          Text('Backend URL: ${widget.config.backendUrl}'),
          const SizedBox(height: 16),
          if (_checking) const LinearProgressIndicator(key: Key('connectionChecking')),
          if (_health != null) ...[
            const Text('Backend reachable: yes', style: TextStyle(color: Colors.greenAccent)),
            Text('Swalvo API key configured: ${_health!.configured}'),
            Text('Swalvo base URL: ${_health!.baseUrl ?? '(default)'}'),
          ],
          if (_error != null)
            Text(
              'Error${_errorAt != null ? ' at ${_errorAt!.toIso8601String()}' : ''}: $_error',
              style: const TextStyle(color: Colors.redAccent),
            ),
          const SizedBox(height: 16),
          OutlinedButton(onPressed: _checking ? null : _check, child: const Text('Re-check connection')),
        ],
      );
}
