import 'package:flutter/material.dart';

enum ScenarioResult { untested, pass, fail, skip }

class Scenario {
  const Scenario({required this.title, required this.howToRun});

  final String title;
  final String howToRun;
}

/// The 14 test scenarios from the SDK test-app spec, with a note on how
/// each is actually exercised in this app versus what needs a second
/// device, camera/mic, or a live backend. Checking these off is manual —
/// there is no automated oracle for "did the video actually render," which
/// is exactly why this app exists instead of a unit test suite alone.
const scenarios = <Scenario>[
  Scenario(title: '1. SDK initialization succeeds with valid configuration', howToRun: 'Connection tab, with a real API key configured.'),
  Scenario(title: '2. Invalid configuration produces a clear error', howToRun: 'Config screen, with a backend URL that is unreachable.'),
  Scenario(title: '3. API authentication succeeds with a valid credential', howToRun: 'Config screen, with a real, authorized Swalvo API key.'),
  Scenario(title: '4. Invalid or unauthorized credentials fail safely', howToRun: 'Config screen, with a revoked or malformed API key.'),
  Scenario(title: '5. RTC room join and leave work', howToRun: 'RTC tab: Join, then Leave.'),
  Scenario(title: '6. Local media publishing works on supported devices', howToRun: 'RTC tab on a physical device: confirm the local preview renders.'),
  Scenario(title: '7. Two clients can exchange real audio/video', howToRun: 'RTC tab, two devices/identities, same room — requires a real backend.'),
  Scenario(title: '8. Chat messages reach a second client', howToRun: 'Chat tab, two instances, same room — requires a real backend.'),
  Scenario(title: '9. Chat retries do not create duplicate durable messages', howToRun: 'Chat tab: Send, then "Retry last send (same clientMessageId)".'),
  Scenario(title: '10. Disconnect and reconnect work', howToRun: 'RTC or Chat tab: toggle airplane mode mid-session, observe reconnection events in Diagnostics.'),
  Scenario(title: '11. Camera/microphone permissions are handled correctly', howToRun: 'RTC tab on a physical device: deny, then grant, permissions.'),
  Scenario(title: '12. Live-stream host/viewer flows work where supported', howToRun: 'Live tab, two devices (host + viewer) — requires a real backend.'),
  Scenario(title: '13. Repeated joins/leaves do not leak resources or leave stale participants', howToRun: 'RTC tab: Join/Leave several times, watch the participant list in Diagnostics.'),
  Scenario(title: '14. Backend or network failure produces a recoverable error', howToRun: 'Stop the dev-helper backend mid-session; confirm the app surfaces an error instead of hanging.'),
];

class ChecklistScreen extends StatefulWidget {
  const ChecklistScreen({super.key});

  @override
  State<ChecklistScreen> createState() => _ChecklistScreenState();
}

class _ChecklistScreenState extends State<ChecklistScreen> {
  final Map<int, ScenarioResult> _results = {};

  ScenarioResult _resultFor(int index) => _results[index] ?? ScenarioResult.untested;

  @override
  Widget build(BuildContext context) => ListView.separated(
        padding: const EdgeInsets.all(8),
        itemCount: scenarios.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final scenario = scenarios[index];
          final result = _resultFor(index);
          return ListTile(
            title: Text(scenario.title),
            subtitle: Text(scenario.howToRun, style: const TextStyle(fontSize: 12, color: Colors.grey)),
            trailing: DropdownButton<ScenarioResult>(
              key: Key('scenarioResult_$index'),
              value: result,
              items: const [
                DropdownMenuItem(value: ScenarioResult.untested, child: Text('Untested')),
                DropdownMenuItem(value: ScenarioResult.pass, child: Text('Pass')),
                DropdownMenuItem(value: ScenarioResult.fail, child: Text('Fail')),
                DropdownMenuItem(value: ScenarioResult.skip, child: Text('Skip')),
              ],
              onChanged: (value) {
                if (value == null) return;
                setState(() => _results[index] = value);
              },
            ),
          );
        },
      );
}
