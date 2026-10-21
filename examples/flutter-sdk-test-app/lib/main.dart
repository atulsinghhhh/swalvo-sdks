import 'package:flutter/material.dart';

import 'config/app_config.dart';
import 'screens/config_screen.dart';
import 'screens/dashboard_screen.dart';
import 'services/backend_client.dart';
import 'services/diagnostic_log.dart';

void main() => runApp(const SwalvoSdkTestApp());

class SwalvoSdkTestApp extends StatelessWidget {
  const SwalvoSdkTestApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Swalvo SDK Test App',
        theme: ThemeData.dark(useMaterial3: true),
        home: const RootScreen(),
      );
}

/// Switches between the Config screen and the test dashboard based on
/// whether the dev-helper backend has confirmed it holds a working Swalvo
/// API key. [AppConfig] and [DiagnosticLog] are owned here and live for
/// the app's whole run — see their class docs for why neither persists.
class RootScreen extends StatefulWidget {
  const RootScreen({super.key});

  @override
  State<RootScreen> createState() => _RootScreenState();
}

class _RootScreenState extends State<RootScreen> {
  final AppConfig _config = AppConfig();
  final DiagnosticLog _diagnostics = DiagnosticLog();
  BackendClient? _backendClient;

  void _onConnected(BackendClient client) {
    _backendClient?.dispose();
    setState(() {
      _backendClient = client;
      _config.setConfigured(true);
    });
  }

  void _onReconfigure() {
    setState(() => _config.setConfigured(false));
  }

  @override
  void dispose() {
    _backendClient?.dispose();
    _config.dispose();
    _diagnostics.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final client = _backendClient;
    if (!_config.isConfigured || client == null) {
      return ConfigScreen(config: _config, diagnostics: _diagnostics, onConnected: _onConnected);
    }
    return DashboardScreen(
      config: _config,
      diagnostics: _diagnostics,
      backendClient: client,
      onReconfigure: _onReconfigure,
    );
  }
}
