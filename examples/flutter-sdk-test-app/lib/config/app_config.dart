import 'package:flutter/foundation.dart';

/// Which dev-helper backend the app is pointed at. This is purely a label
/// for the UI — both values are "a backend you run yourself"; the only
/// difference is whether it's on your LAN or already deployed somewhere.
enum SwalvoEnvironment { local, deployed }

/// App-wide, in-memory configuration.
///
/// Deliberately not persisted to disk: the backend URL is harmless to keep
/// around, but this object also briefly holds the developer's Swalvo API
/// key on its way to the dev-helper backend's `/api/configure`, and the
/// simplest way to guarantee that key never leaks into shared_preferences,
/// a crash log, or a backup is to never let it enter durable storage in
/// the first place. Re-enter it (or set `--dart-define=SWALVO_BACKEND_URL`)
/// each run.
class AppConfig extends ChangeNotifier {
  AppConfig()
      : backendUrl = const String.fromEnvironment(
          'SWALVO_BACKEND_URL',
          defaultValue: 'http://localhost:8792',
        );

  String backendUrl;
  SwalvoEnvironment environment = SwalvoEnvironment.local;

  /// Set once the dev-helper backend has confirmed it holds a working
  /// Swalvo API key (see ConnectionStatus.connected in backend_client.dart).
  bool isConfigured = false;

  void setBackendUrl(String url) {
    backendUrl = url;
    notifyListeners();
  }

  void setEnvironment(SwalvoEnvironment value) {
    environment = value;
    notifyListeners();
  }

  void setConfigured(bool value) {
    isConfigured = value;
    notifyListeners();
  }
}
