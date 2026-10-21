import { normalizeTrackStats, pickBestLayer, type RawTrackStats } from '../src/internal/telemetry/track-stats';

function raw(overrides: Partial<RawTrackStats> = {}): RawTrackStats {
  return { timestamp: 1000, ...overrides };
}

describe('normalizeTrackStats', () => {
  describe('unit conversion', () => {
    it('converts jitter from seconds to milliseconds', () => {
      const stats = normalizeTrackStats(raw({ jitter: 0.012 }), undefined, 'microphone', 'send');

      expect(stats.jitterMs).toBeCloseTo(12);
    });

    it('converts round trip time from seconds to milliseconds', () => {
      const stats = normalizeTrackStats(raw({ roundTripTime: 0.084 }), undefined, 'microphone', 'send');

      expect(stats.roundTripTimeMs).toBeCloseTo(84);
    });

    it('omits fields the raw sample never reported, rather than defaulting to 0', () => {
      // A 0ms RTT and "we don't know" are different facts. An absent field
      // means the second one.
      const stats = normalizeTrackStats(raw(), undefined, 'microphone', 'send');

      expect(stats.jitterMs).toBeUndefined();
      expect(stats.roundTripTimeMs).toBeUndefined();
      expect(stats.codec).toBeUndefined();
    });

    it('carries codec through only from mimeType', () => {
      const stats = normalizeTrackStats(raw({ mimeType: 'video/VP8' }), undefined, 'camera', 'receive');

      expect(stats.codec).toBe('video/VP8');
    });

    it('carries resolution and framerate through untouched', () => {
      const stats = normalizeTrackStats(
        raw({ frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }),
        undefined,
        'camera',
        'send',
      );

      expect(stats).toMatchObject({ frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 });
    });
  });

  describe('packet loss', () => {
    it('computes a percentage for the send direction from packetsSent', () => {
      const stats = normalizeTrackStats(raw({ packetsLost: 5, packetsSent: 95 }), undefined, 'microphone', 'send');

      expect(stats.packetsLost).toBe(5);
      expect(stats.packetLossPercent).toBeCloseTo(5); // 5 / (95 + 5) * 100
    });

    it('computes a percentage for the receive direction from packetsReceived', () => {
      const stats = normalizeTrackStats(raw({ packetsLost: 10, packetsReceived: 90 }), undefined, 'camera', 'receive');

      expect(stats.packetLossPercent).toBeCloseTo(10);
    });

    it('does not divide by zero when nothing has been sent yet', () => {
      const stats = normalizeTrackStats(raw({ packetsLost: 0, packetsSent: 0 }), undefined, 'microphone', 'send');

      expect(stats.packetLossPercent).toBeUndefined();
    });

    it('reports the raw count even when a percentage cannot be computed', () => {
      // No packetsSent here, which happens with an SFU that doesn't report
      // it. packetsLost is still a real, useful number by itself.
      const stats = normalizeTrackStats(raw({ packetsLost: 3 }), undefined, 'microphone', 'send');

      expect(stats.packetsLost).toBe(3);
      expect(stats.packetLossPercent).toBeUndefined();
    });
  });

  describe('bitrate', () => {
    it('is absent on the first sample — there is nothing yet to take a delta against', () => {
      const stats = normalizeTrackStats(raw({ bytesSent: 10_000 }), undefined, 'microphone', 'send');

      expect(stats.bitrateBps).toBeUndefined();
    });

    it('computes bits/sec from the byte delta between two send-direction samples', () => {
      const previous = raw({ timestamp: 0, bytesSent: 0 });
      const current = raw({ timestamp: 1000, bytesSent: 12_500 });

      const stats = normalizeTrackStats(current, previous, 'microphone', 'send');

      // 12,500 bytes * 8 bits / 1 second = 100,000 bps.
      expect(stats.bitrateBps).toBeCloseTo(100_000);
    });

    it('uses bytesReceived, not bytesSent, for the receive direction', () => {
      const previous = raw({ timestamp: 0, bytesSent: 999_999, bytesReceived: 0 });
      const current = raw({ timestamp: 1000, bytesSent: 999_999, bytesReceived: 5_000 });

      const stats = normalizeTrackStats(current, previous, 'camera', 'receive');

      expect(stats.bitrateBps).toBeCloseTo(40_000);
    });

    it('skips the computation when the samples carry the same timestamp', () => {
      // Poll faster than the underlying stats refresh and you'd otherwise
      // divide by zero.
      const previous = raw({ timestamp: 1000, bytesSent: 0 });
      const current = raw({ timestamp: 1000, bytesSent: 5000 });

      const stats = normalizeTrackStats(current, previous, 'microphone', 'send');

      expect(stats.bitrateBps).toBeUndefined();
    });

    it('skips the computation when time or the counter moved backwards', () => {
      // Out-of-order samples, or a counter reset, mustn't produce a
      // negative or wildly wrong rate.
      const previous = raw({ timestamp: 1000, bytesSent: 10_000 });
      const current = raw({ timestamp: 500, bytesSent: 5_000 });

      const stats = normalizeTrackStats(current, previous, 'microphone', 'send');

      expect(stats.bitrateBps).toBeUndefined();
    });
  });

  describe('kind and direction', () => {
    it('always sets kind and direction from its own arguments, not the raw sample', () => {
      const stats = normalizeTrackStats(raw({ type: 'audio' }), undefined, 'screenShare', 'receive');

      expect(stats.kind).toBe('screenShare');
      expect(stats.direction).toBe('receive');
    });
  });
});

describe('pickBestLayer', () => {
  it('picks the widest simulcast layer as the representative one', () => {
    const layers: RawTrackStats[] = [raw({ frameWidth: 320 }), raw({ frameWidth: 1280 }), raw({ frameWidth: 640 })];

    expect(pickBestLayer(layers)?.frameWidth).toBe(1280);
  });

  it('returns undefined for an empty layer list', () => {
    expect(pickBestLayer([])).toBeUndefined();
  });

  it('treats a missing frameWidth as lower than any reported width', () => {
    const layers: RawTrackStats[] = [raw({}), raw({ frameWidth: 180 })];

    expect(pickBestLayer(layers)?.frameWidth).toBe(180);
  });
});
