import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/src/backoff.dart';

/// A Random that always returns the low end, so growth can be asserted
/// without jitter making the result non-deterministic.
class _FloorRandom implements Random {
  @override
  int nextInt(int max) => 0;
  @override
  bool nextBool() => false;
  @override
  double nextDouble() => 0;
}

class _CeilingRandom implements Random {
  @override
  int nextInt(int max) => max - 1;
  @override
  bool nextBool() => true;
  @override
  double nextDouble() => 1;
}

void main() {
  group('backoffDelay', () {
    test('grows with each attempt', () {
      final random = _FloorRandom();
      final delays = [1, 2, 3, 4]
          .map(
              (attempt) => backoffDelay(attempt, random: random).inMilliseconds)
          .toList();

      for (var i = 1; i < delays.length; i++) {
        expect(delays[i], greaterThan(delays[i - 1]));
      }
    });

    test('never exceeds the cap, however many attempts have failed', () {
      const cap = Duration(seconds: 5);
      for (var attempt = 1; attempt <= 50; attempt++) {
        final delay = backoffDelay(attempt, maxDelay: cap);
        expect(delay.inMilliseconds, lessThanOrEqualTo(cap.inMilliseconds));
      }
    });

    test('does not overflow at absurd attempt counts', () {
      // A long-lived connection can reconnect many times; the exponent is
      // clamped so this stays a duration instead of becoming negative.
      final delay = backoffDelay(1000);
      expect(delay.inMilliseconds, greaterThan(0));
    });

    test('jitters inside a bounded window', () {
      final low = backoffDelay(5, random: _FloorRandom()).inMilliseconds;
      final high = backoffDelay(5, random: _CeilingRandom()).inMilliseconds;

      expect(low, lessThan(high));
      // Floored at a quarter of the target: a jittered delay must not
      // collapse to zero and burn an attempt instantly.
      expect(low, greaterThan(0));
    });

    test('spreads clients out — the whole point of jitter', () {
      // When a gateway restarts, every client wakes at once. Identical
      // delays would recreate the thundering herd on every attempt.
      final delays = List.generate(50, (_) => backoffDelay(4).inMilliseconds);
      expect(delays.toSet().length, greaterThan(1));
    });
  });
}
