import 'dart:math';

/// Exponential backoff with full jitter, hard-capped.
///
/// Identical policy to `@swalvo/chat`'s on the web, and for the same
/// reasons. The cap and the attempt limit together are what keep this
/// from becoming an infinite reconnect loop: a client that can never
/// reconnect should stop and report failure, not hammer a server that is
/// already having a bad day.
///
/// Jitter is not decoration. When a gateway restarts, every client it was
/// holding wakes at the same instant; without jitter they retry in
/// lockstep and recreate the thundering herd on every attempt. Full
/// jitter, a uniform pick inside the window, spreads them out.
///
/// This matters more on mobile than on the web: a cell handover or a lift
/// disconnects thousands of clients simultaneously in a way a browser tab
/// rarely does.
Duration backoffDelay(
  int attempt, {
  Duration initialDelay = const Duration(milliseconds: 500),
  Duration maxDelay = const Duration(seconds: 30),
  Random? random,
}) {
  final rng = random ?? _shared;

  // Clamped before the shift so a long-lived connection that has
  // reconnected many times can't overflow the exponent.
  final growth = pow(2, (attempt - 1).clamp(0, 30)).toInt();
  final target =
      min(initialDelay.inMilliseconds * growth, maxDelay.inMilliseconds);

  // Floored at a quarter of the target so a jittered delay can't collapse
  // to near-zero and burn an attempt instantly.
  final floor = target ~/ 4;
  final window = max(target - floor, 1);

  return Duration(milliseconds: floor + rng.nextInt(window));
}

final Random _shared = Random();
