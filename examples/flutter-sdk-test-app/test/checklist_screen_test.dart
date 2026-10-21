import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_sdk_test_app/screens/checklist_screen.dart';

void main() {
  testWidgets('lists all 14 scenarios', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: ChecklistScreen())));

    expect(scenarios.length, 14);
    expect(find.textContaining(scenarios.first.title), findsOneWidget);

    // ListView.separated only builds on-screen items; scroll to the end to
    // confirm the last scenario is really in the list, not just the data.
    await tester.dragUntilVisible(
      find.textContaining(scenarios.last.title),
      find.byType(ListView),
      const Offset(0, -200),
    );
    expect(find.textContaining(scenarios.last.title), findsOneWidget);
  });

  testWidgets('changing a scenario result updates its dropdown', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: ChecklistScreen())));

    final dropdownFinder = find.byKey(const Key('scenarioResult_0'));
    expect(find.descendant(of: dropdownFinder, matching: find.text('Untested')), findsOneWidget);

    await tester.tap(dropdownFinder);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pass').last);
    await tester.pumpAndSettle();

    expect(find.descendant(of: dropdownFinder, matching: find.text('Pass')), findsOneWidget);
  });
}
