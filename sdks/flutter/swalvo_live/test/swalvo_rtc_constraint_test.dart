import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Guards the one thing that decides whether a live-stream viewer ever
/// sees the stream they joined: which `swalvo_rtc` this package resolves.
///
/// `swalvo_rtc` before 0.2.0 renders nothing for a remote publisher whose
/// track arrives after the tile was built — which is every live stream,
/// since a viewer's tile is built before the host's media reaches them.
/// The connection underneath is healthy the whole time (it decodes real
/// RTP), so nothing short of looking at the rendered surface catches it,
/// and no test inside this package can: the defect and its fix both live
/// in `swalvo_rtc`. What this package *can* get wrong, silently, is
/// declaring a constraint that excludes the fix.
///
/// It nearly did. `^0.1.8` reads like "0.1.8 or newer" and means
/// `>=0.1.8 <0.2.0` to pub, so publishing the fix as `swalvo_rtc` 0.2.0
/// would have left every `swalvo_live` application resolving a version
/// that cannot show a viewer anything.
void main() {
  test(
      'the declared swalvo_rtc constraint admits the version that renders '
      'a remote publisher', () {
    final constraint = _dependencyConstraint('swalvo_rtc');
    expect(constraint, isNotNull,
        reason: 'swalvo_live must declare a swalvo_rtc dependency');

    expect(
      _admits(constraint!, _rendersRemoteTracksFrom),
      isTrue,
      reason: 'swalvo_rtc $constraint excludes $_rendersRemoteTracksFrom, the '
          'first version whose SwalvoVideoView renders a track that arrives '
          'after the tile was built. A live-stream viewer resolving anything '
          'older shows a placeholder for the whole stream.',
    );
  });
}

/// The first `swalvo_rtc` whose `SwalvoVideoView` re-resolves its track from
/// the room rather than from the snapshot it was handed.
const _rendersRemoteTracksFrom = _Version(0, 2, 0);

/// The version constraint declared for [package] under `dependencies:`.
///
/// Read straight out of the pubspec text rather than through a YAML
/// parser: this is the only thing the file is inspected for, and the
/// alternative is a dependency carried solely to test a dependency.
/// `dependency_overrides:` is deliberately not consulted — it is what
/// makes development in this repo resolve against the sibling working
/// tree, and it is ignored entirely when the package is published, so
/// asserting on it would assert on the one thing no user ever gets.
String? _dependencyConstraint(String package) {
  final lines = File('pubspec.yaml').readAsLinesSync();
  var inDependencies = false;
  for (final line in lines) {
    if (!line.startsWith(' ') && line.trim().isNotEmpty) {
      inDependencies = line.startsWith('dependencies:');
      continue;
    }
    if (!inDependencies) continue;
    final match =
        RegExp('^  $package:\\s*(.+?)\\s*\$').firstMatch(line.split('#').first);
    if (match != null) return _unquote(match.group(1)!);
  }
  return null;
}

String _unquote(String value) =>
    value.replaceAll("'", '').replaceAll('"', '').trim();

/// Whether [constraint] includes [version].
///
/// Covers the two forms a pubspec realistically carries — a caret, and an
/// explicit `>=lower <upper` range — and treats anything else as not
/// proven, so an unrecognised constraint fails loudly rather than passing
/// by accident.
bool _admits(String constraint, _Version version) {
  final caret = RegExp(r'^\^(\d+)\.(\d+)\.(\d+)').firstMatch(constraint);
  if (caret != null) {
    final lower = _Version.fromMatch(caret);
    // Dart's caret is major-stable above 1.0.0 and *minor*-stable below
    // it: `^0.1.8` stops at 0.2.0, which is the whole trap this guards.
    final upper = lower.major > 0
        ? _Version(lower.major + 1, 0, 0)
        : _Version(0, lower.minor + 1, 0);
    return !version.isBefore(lower) && version.isBefore(upper);
  }

  final range = RegExp(r'^>=\s*(\d+)\.(\d+)\.(\d+)\s+<\s*(\d+)\.(\d+)\.(\d+)$')
      .firstMatch(constraint);
  if (range != null) {
    final lower = _Version.fromMatch(range);
    final upper = _Version(
      int.parse(range.group(4)!),
      int.parse(range.group(5)!),
      int.parse(range.group(6)!),
    );
    return !version.isBefore(lower) && version.isBefore(upper);
  }

  return false;
}

class _Version {
  const _Version(this.major, this.minor, this.patch);

  factory _Version.fromMatch(RegExpMatch match) => _Version(
        int.parse(match.group(1)!),
        int.parse(match.group(2)!),
        int.parse(match.group(3)!),
      );

  final int major;
  final int minor;
  final int patch;

  bool isBefore(_Version other) {
    if (major != other.major) return major < other.major;
    if (minor != other.minor) return minor < other.minor;
    return patch < other.patch;
  }

  @override
  String toString() => '$major.$minor.$patch';
}
