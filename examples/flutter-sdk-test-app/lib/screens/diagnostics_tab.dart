import 'package:flutter/material.dart';

import '../services/diagnostic_log.dart';

class DiagnosticsTab extends StatefulWidget {
  const DiagnosticsTab({super.key, required this.diagnostics});

  final DiagnosticLog diagnostics;

  @override
  State<DiagnosticsTab> createState() => _DiagnosticsTabState();
}

class _DiagnosticsTabState extends State<DiagnosticsTab> {
  DiagnosticCategory? _filter;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: widget.diagnostics,
        builder: (context, _) {
          final events = widget.diagnostics.events
              .where((event) => _filter == null || event.category == _filter)
              .toList(growable: false);

          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(8),
                child: Wrap(
                  spacing: 8,
                  children: [
                    ChoiceChip(label: const Text('All'), selected: _filter == null, onSelected: (_) => setState(() => _filter = null)),
                    for (final category in DiagnosticCategory.values)
                      ChoiceChip(
                        label: Text(category.name),
                        selected: _filter == category,
                        onSelected: (_) => setState(() => _filter = category),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('${events.length} event(s)'),
                    TextButton.icon(
                      onPressed: widget.diagnostics.clear,
                      icon: const Icon(Icons.delete_outline),
                      label: const Text('Clear'),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView.builder(
                  itemCount: events.length,
                  itemBuilder: (context, index) {
                    final event = events[index];
                    return ListTile(
                      dense: true,
                      leading: _CategoryBadge(category: event.category),
                      title: Text(event.message),
                      subtitle: Text(event.at.toIso8601String()),
                    );
                  },
                ),
              ),
            ],
          );
        },
      );
}

class _CategoryBadge extends StatelessWidget {
  const _CategoryBadge({required this.category});

  final DiagnosticCategory category;

  @override
  Widget build(BuildContext context) {
    final color = switch (category) {
      DiagnosticCategory.connection => Colors.blueAccent,
      DiagnosticCategory.room => Colors.purpleAccent,
      DiagnosticCategory.track => Colors.tealAccent,
      DiagnosticCategory.chat => Colors.amberAccent,
      DiagnosticCategory.live => Colors.pinkAccent,
      DiagnosticCategory.error => Colors.redAccent,
    };
    return CircleAvatar(radius: 6, backgroundColor: color);
  }
}
