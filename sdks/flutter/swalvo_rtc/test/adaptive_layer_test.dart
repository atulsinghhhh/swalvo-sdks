import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_rtc/src/internal/adaptive_layer.dart';
import 'package:swalvo_rtc/src/types.dart';

/// The size-to-layer rule behind `adaptiveStream`.
///
/// Worth testing on its own rather than only through the widget, because
/// the interesting behaviour is not "which layer for which width" — that is
/// a lookup — but what happens at the boundaries, where a naive threshold
/// oscillates. Every flip costs a real layer switch at the SFU: it waits
/// for a keyframe on the new layer and asks the publisher for one, and the
/// tile visibly stutters while that happens.
void main() {
  group('layer for a size, from a standing start', () {
    test('a 180px grid thumbnail asks for low', () {
      expect(adaptiveLayerFor(logicalPixels: 180), SwalvoVideoLayer.low);
    });

    test('a 480px tile asks for medium', () {
      expect(adaptiveLayerFor(logicalPixels: 480), SwalvoVideoLayer.medium);
    });

    test('a fullscreen view asks for high', () {
      expect(
        adaptiveLayerFor(logicalPixels: 1280),
        SwalvoVideoLayer.high,
      );
    });

    test('exactly on a threshold takes the cheaper layer', () {
      // Ties go downwards. The cost of being one layer too low for a moment
      // is a little softness; the cost of being too high is bitrate every
      // participant pays for.
      expect(
        adaptiveLayerFor(logicalPixels: adaptiveLowThreshold - 1),
        SwalvoVideoLayer.low,
      );
      expect(
        adaptiveLayerFor(logicalPixels: adaptiveHighThreshold - 1),
        SwalvoVideoLayer.medium,
      );
    });
  });

  group('hysteresis', () {
    test('a tile sitting just past a boundary does not climb', () {
      // The case that makes an evenly divided grid flap: every tile lands
      // on the same width, a few pixels either side of a threshold.
      const justOver = adaptiveLowThreshold + 8;

      expect(
        adaptiveLayerFor(
            logicalPixels: justOver, current: SwalvoVideoLayer.low),
        SwalvoVideoLayer.low,
        reason: 'clearing a boundary by 8px is not growth',
      );
    });

    test('a tile that genuinely grows does climb', () {
      const wellOver = adaptiveLowThreshold * adaptiveHysteresis + 1;

      expect(
        adaptiveLayerFor(
            logicalPixels: wellOver, current: SwalvoVideoLayer.low),
        SwalvoVideoLayer.medium,
      );
    });

    test('falling needs no margin', () {
      // Asymmetric on purpose: dropping is cheap and immediately correct,
      // climbing costs a keyframe and a stutter.
      expect(
        adaptiveLayerFor(
          logicalPixels: adaptiveLowThreshold - 1,
          current: SwalvoVideoLayer.high,
        ),
        SwalvoVideoLayer.low,
      );
      expect(
        adaptiveLayerFor(
          logicalPixels: adaptiveHighThreshold - 1,
          current: SwalvoVideoLayer.high,
        ),
        SwalvoVideoLayer.medium,
      );
    });

    test(
        'a tile nudged repeatedly around a boundary settles instead of flapping',
        () {
      // Directly the oscillation this exists to stop. Without hysteresis
      // this sequence produces low, medium, low, medium, ... and each pair
      // is two layer switches.
      var layer = adaptiveLayerFor(logicalPixels: 220);
      expect(layer, SwalvoVideoLayer.low);

      for (final width in [238.0, 242.0, 236.0, 245.0, 239.0, 250.0]) {
        layer = adaptiveLayerFor(logicalPixels: width, current: layer);
        expect(layer, SwalvoVideoLayer.low,
            reason: 'a $width px tile is not a meaningfully bigger tile');
      }
    });

    test('a genuine jump from thumbnail to fullscreen goes straight to high',
        () {
      // Someone tapping a tile to expand it should not have to pass through
      // medium on the way.
      expect(
        adaptiveLayerFor(logicalPixels: 1920, current: SwalvoVideoLayer.low),
        SwalvoVideoLayer.high,
      );
    });
  });

  group('parity with the web SDK', () {
    test('the documented sizes map to the documented layers', () {
      // These three are the behaviour both SDKs promise, in the same unit.
      // packages/sdk/test/adaptive-stream.spec.ts asserts the identical
      // triple; if one moves without the other, the same call renders at
      // different quality on a phone and a laptop for no visible reason.
      expect(adaptiveLayerFor(logicalPixels: 180), SwalvoVideoLayer.low);
      expect(adaptiveLayerFor(logicalPixels: 480), SwalvoVideoLayer.medium);
      expect(adaptiveLayerFor(logicalPixels: 1920), SwalvoVideoLayer.high);
    });
  });
}
