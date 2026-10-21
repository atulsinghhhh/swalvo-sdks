/// Picking a simulcast layer from the size a video is actually rendered at.
///
/// Kept apart from the widget so the rule is a pure function of (width,
/// current layer) and can be tested as one. The thresholds are shared with
/// the web SDK (`packages/sdk/src/internal/media/adaptive-stream.ts`) —
/// two SDKs against the same SFU disagreeing about what "small" means would
/// show up as the same call looking different on a phone and a laptop for
/// no reason a user could discover.
library;

import '../types.dart';

/// Below this many logical pixels wide, a tile is served by the `low` layer.
///
/// Logical (CSS) pixels, not device pixels. That is the unit the documented
/// behaviour is written in — a 180px grid tile takes `low`, a 480px tile
/// takes `medium` — and it is the unit a web page measures an element in
/// natively, so both SDKs classify a tile the same way without one of them
/// having to guess at a pixel ratio.
///
/// `low` is a quarter of the publisher's width, so a 1280-wide capture
/// gives a 320-wide layer: ample for anything under this threshold.
const adaptiveLowThreshold = 240.0;

/// Above this many logical pixels wide, a tile is served by the `high`
/// layer. `medium` is half the publisher's width — 640 of a 1280 capture —
/// which covers everything below this.
const adaptiveHighThreshold = 640.0;

/// How much a tile must overshoot a threshold before it climbs.
///
/// Climbing costs a real layer switch: the SFU waits for a keyframe on the
/// new layer and asks the publisher for one, and the tile visibly stutters
/// while that happens. Falling is cheap by comparison, and the penalty for
/// falling too eagerly is a moment of softness. So the margin is applied
/// upwards only — a tile has to genuinely grow to ask for more, but drops
/// as soon as it is really smaller.
///
/// Without it, a grid that lands every tile exactly on a boundary — which
/// is precisely what an evenly divided layout does — flips every tile
/// between two layers on each small nudge.
const adaptiveHysteresis = 1.2;

/// The layer that should serve a tile [logicalPixels] wide.
///
/// [current] is the layer already in use, which is what makes this sticky
/// rather than a plain threshold lookup. Pass null on first measurement.
///
/// [logicalPixels] is the tile's rendered width in logical (CSS) pixels —
/// Flutter's `BoxConstraints.maxWidth`, the web's `clientWidth`. Both SDKs
/// use the same unit and the same thresholds on purpose: the same call
/// looking different on a phone and a laptop, for a reason no user could
/// discover, is worse than either choice of unit.
SwalvoVideoLayer adaptiveLayerFor({
  required double logicalPixels,
  SwalvoVideoLayer? current,
}) {
  SwalvoVideoLayer plain() {
    if (logicalPixels < adaptiveLowThreshold) return SwalvoVideoLayer.low;
    if (logicalPixels < adaptiveHighThreshold) return SwalvoVideoLayer.medium;
    return SwalvoVideoLayer.high;
  }

  return switch (current) {
    // Climbing out of low: clear the boundary by the margin, and only jump
    // straight to high if it clears that boundary by the margin too.
    SwalvoVideoLayer.low =>
      logicalPixels >= adaptiveLowThreshold * adaptiveHysteresis
          ? (logicalPixels >= adaptiveHighThreshold * adaptiveHysteresis
              ? SwalvoVideoLayer.high
              : SwalvoVideoLayer.medium)
          : SwalvoVideoLayer.low,

    // In the middle: climbing needs the margin, falling does not.
    SwalvoVideoLayer.medium =>
      logicalPixels >= adaptiveHighThreshold * adaptiveHysteresis
          ? SwalvoVideoLayer.high
          : (logicalPixels < adaptiveLowThreshold
              ? SwalvoVideoLayer.low
              : SwalvoVideoLayer.medium),

    // Falling from high: drops as soon as it is genuinely below.
    SwalvoVideoLayer.high => logicalPixels < adaptiveLowThreshold
        ? SwalvoVideoLayer.low
        : (logicalPixels < adaptiveHighThreshold
            ? SwalvoVideoLayer.medium
            : SwalvoVideoLayer.high),

    // `auto` is not a size, and null is the first measurement. Neither has
    // a previous layer to be sticky about.
    _ => plain(),
  };
}
