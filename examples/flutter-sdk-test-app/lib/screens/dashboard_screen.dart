import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../services/backend_client.dart';
import '../services/diagnostic_log.dart';
import 'chat_tab.dart';
import 'checklist_screen.dart';
import 'connection_tab.dart';
import 'diagnostics_tab.dart';
import 'live_tab.dart';
import 'rtc_tab.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.config,
    required this.diagnostics,
    required this.backendClient,
    required this.onReconfigure,
  });

  final AppConfig config;
  final DiagnosticLog diagnostics;
  final BackendClient backendClient;
  final VoidCallback onReconfigure;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  int _index = 0;

  static const _titles = ['Connection', 'RTC', 'Chat', 'Live Streaming', 'Diagnostics', 'Checklist'];

  // Built once, not per-frame: an IndexedStack only keeps its children's
  // state across switches if the same widget instances occupy the same
  // slots every build. Rebuilding this list inside build() previously
  // handed Flutter new ConnectionTab/RtcTab/ChatTab/etc. instances on
  // every tab switch — indistinguishable at the swapped-in body's single
  // slot from "mount a different page" — so leaving the Chat tab (e.g. to
  // check Diagnostics) silently dropped its live connection. A real dev
  // testing a live RTC/chat session while checking another tab is exactly
  // this app's job, so losing session state on navigation isn't
  // acceptable collateral damage from a plain Widget-swap body.
  late final List<Widget> _pages = [
    ConnectionTab(config: widget.config, backendClient: widget.backendClient, diagnostics: widget.diagnostics),
    RtcTab(backendClient: widget.backendClient, diagnostics: widget.diagnostics),
    ChatTab(backendClient: widget.backendClient, diagnostics: widget.diagnostics),
    LiveTab(backendClient: widget.backendClient, diagnostics: widget.diagnostics),
    DiagnosticsTab(diagnostics: widget.diagnostics),
    const ChecklistScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_index]),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings_backup_restore),
            tooltip: 'Reconfigure backend',
            onPressed: widget.onReconfigure,
          ),
        ],
      ),
      drawer: Drawer(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            const DrawerHeader(child: Text('Swalvo SDK Test App')),
            for (var i = 0; i < _titles.length; i++)
              ListTile(
                title: Text(_titles[i]),
                selected: _index == i,
                onTap: () {
                  setState(() => _index = i);
                  Navigator.of(context).pop();
                },
              ),
          ],
        ),
      ),
      body: IndexedStack(index: _index, children: _pages),
    );
  }
}
