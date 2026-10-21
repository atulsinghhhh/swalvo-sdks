'use client';

import type { ConnectionQuality, Participant } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { useConnectionQuality } from '../hooks';

const BARS: Record<ConnectionQuality, number> = { excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 };

export const CONNECTION_QUALITY_LABELS: Record<ConnectionQuality, string> = {
  excellent: 'Excellent connection',
  good: 'Good connection',
  poor: 'Poor connection',
  lost: 'Connection lost',
  unknown: 'Connection quality unknown',
};

export interface ConnectionQualityIndicatorProps {
  participant: Participant | undefined;
  /** Show the label text next to the bars. Off by default (it is always the accessible name). */
  showLabel?: boolean;
  /** Render nothing while the score is `'unknown'`. Default false. */
  hideWhenUnknown?: boolean;
  className?: string;
}

/**
 * Three signal bars for a participant's SFU-measured connection quality.
 * `data-quality` carries the score and each bar has `data-active`, so the
 * stylesheet (or yours) colors them.
 */
export function ConnectionQualityIndicator({
  participant,
  showLabel = false,
  hideWhenUnknown = false,
  className,
}: ConnectionQualityIndicatorProps) {
  const quality = useConnectionQuality(participant);
  if (hideWhenUnknown && quality === 'unknown') return null;
  const active = BARS[quality] ?? 0;
  const label = CONNECTION_QUALITY_LABELS[quality] ?? quality;
  return (
    <span
      className={cx('swalvo-connection-quality', className)}
      data-quality={quality}
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="swalvo-connection-quality__bars" aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span key={bar} className="swalvo-connection-quality__bar" data-active={bar <= active || undefined} />
        ))}
      </span>
      {showLabel && <span className="swalvo-connection-quality__label">{label}</span>}
    </span>
  );
}
