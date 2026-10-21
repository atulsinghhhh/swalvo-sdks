import 'package:flutter/foundation.dart';

enum DiagnosticCategory { connection, room, track, chat, live, error }

class DiagnosticEvent {
  DiagnosticEvent({required this.category, required this.message, DateTime? at})
      : at = at ?? DateTime.now();

  final DiagnosticCategory category;
  final String message;
  final DateTime at;
}

/// Strips anything that looks like a secret before it reaches the on-screen
/// log, a widget test's expectations, or (hypothetically) a crash report.
///
/// This is a best-effort pattern match, not a cryptographic guarantee —
/// the actual guarantee is architectural (see app_config.dart): the app
/// never holds a long-lived API key to begin with. This redaction exists
/// as defense in depth for tokens that *do* legitimately pass through the
/// app (RTC/chat tokens), and for anything accidentally interpolated into
/// an error message.
String redactSecrets(String input) {
  var out = input;
  out = out.replaceAll(
    RegExp(r'Bearer\s+[A-Za-z0-9\-_.=]+', caseSensitive: false),
    'Bearer [REDACTED]',
  );
  out = out.replaceAll(
    RegExp(r'\b(?:rvk|sk|pk)_[A-Za-z0-9._-]+'),
    '[REDACTED_KEY]',
  );
  out = out.replaceAllMapped(
    RegExp(
      r'("?(?:token|apiKey|api_key|secret|password|credential)"?\s*[:=]\s*")([^"]+)(")',
      caseSensitive: false,
    ),
    (match) => '${match[1]}[REDACTED]${match[3]}',
  );
  return out;
}

/// A bounded, in-memory ring buffer of diagnostic events for the
/// Diagnostics tab. Never persisted — this is a scratchpad for the current
/// run, cleared with [clear] or on app restart.
class DiagnosticLog extends ChangeNotifier {
  static const int maxEvents = 200;

  final List<DiagnosticEvent> _events = [];

  /// Newest first.
  List<DiagnosticEvent> get events => List.unmodifiable(_events.reversed);

  void log(DiagnosticCategory category, String message) {
    _events.add(DiagnosticEvent(category: category, message: redactSecrets(message)));
    if (_events.length > maxEvents) {
      _events.removeAt(0);
    }
    notifyListeners();
  }

  void clear() {
    _events.clear();
    notifyListeners();
  }
}
