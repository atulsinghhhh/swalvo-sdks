'use client';

import {
  Fragment,
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Room } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import { ParticipantTile, type ParticipantTileProps } from './participant-tile';
import { trackReferenceKey, type TrackReference } from './types';
import { gridColumns, useGridLayout, usePagination, useTracks } from './video-hooks';

type TileRenderer = (trackRef: TrackReference) => ReactNode;

function renderTileFor(
  ref: TrackReference,
  renderTile: TileRenderer | undefined,
  tileProps: Partial<ParticipantTileProps> | undefined,
  room?: Room,
) {
  return (
    <Fragment key={trackReferenceKey(ref)}>
      {renderTile ? renderTile(ref) : <ParticipantTile trackRef={ref} room={room} {...tileProps} />}
    </Fragment>
  );
}

type VisibilityTrack = { setVisible?: (visible: boolean) => void };

/**
 * Tells adaptive streaming which remote videos are on the current page.
 *
 * A tile on another page is unmounted, so its `<video>` is gone, and the
 * SDK reads "attached once, attached to nothing now" as hidden on its own.
 * But a track that was never on screen (someone on page 3 since you
 * joined) was never attached, which the SDK has to treat as visible. So
 * the grid reports every off-page track as hidden explicitly: the SFU
 * stops forwarding it, and the bandwidth goes to the tiles you can see.
 */
function useOffPagePausing(all: readonly TrackReference[], onPage: readonly TrackReference[]): void {
  const touched = useRef(new Set<VisibilityTrack>());
  useEffect(() => {
    const visible = new Set(onPage.map((ref) => ref.track));
    for (const ref of all) {
      const track = ref.track as VisibilityTrack | undefined;
      if (ref.isLocal || !track || typeof track.setVisible !== 'function') continue;
      track.setVisible(visible.has(ref.track));
      touched.current.add(track);
    }
  }, [all, onPage]);
  useEffect(() => {
    const tracks = touched.current;
    return () => {
      // Hand visibility back to the SDK's own element observation.
      for (const track of tracks) track.setVisible?.(true);
      tracks.clear();
    };
  }, []);
}

export interface GridLayoutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The tiles to lay out. Default: `useTracks()` (everyone's camera, plus screen shares). */
  tracks?: TrackReference[];
  /** Tiles per page before paginating. Default: by width — 4 on a phone, 9 mid-size, 16 wide. */
  maxTilesPerPage?: number;
  /** Replace the default `<ParticipantTile>`. */
  renderTile?: TileRenderer;
  /** Props for every default tile. */
  tileProps?: Partial<ParticipantTileProps>;
  room?: Room;
}

/**
 * A responsive grid of tiles that paginates past `maxTilesPerPage`.
 * Off-page videos are paused at the SFU (adaptive stream visibility), so a
 * 50-person call costs one page of video. PageUp/PageDown, or the
 * previous/next buttons, change page.
 *
 * Exposes `--swalvo-grid-columns` and `--swalvo-grid-rows` as inline custom
 * properties for the stylesheet.
 */
export function GridLayout({
  tracks,
  maxTilesPerPage,
  renderTile,
  tileProps,
  room,
  className,
  style,
  onKeyDown,
  ...rest
}: GridLayoutProps) {
  const defaultTracks = useTracks(undefined, { room });
  const list = tracks ?? defaultTracks;
  const containerRef = useRef<HTMLDivElement>(null);
  const layout = useGridLayout(containerRef, maxTilesPerPage);
  const pagination = usePagination(list, layout.maxTilesPerPage);
  useOffPagePausing(list, pagination.pageItems);

  const count = pagination.pageItems.length;
  const columns = gridColumns(count, layout.narrow);
  const rows = Math.max(1, Math.ceil(count / columns));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'PageDown' && pagination.hasNext) {
      event.preventDefault();
      pagination.next();
    } else if (event.key === 'PageUp' && pagination.hasPrev) {
      event.preventDefault();
      pagination.prev();
    }
  };

  return (
    <div
      {...rest}
      ref={containerRef}
      className={cx('swalvo-grid-layout', className)}
      data-tiles={count}
      data-paginated={pagination.totalPages > 1 || undefined}
      style={{ ...style, '--swalvo-grid-columns': columns, '--swalvo-grid-rows': rows } as CSSProperties}
      onKeyDown={handleKeyDown}
    >
      <div className="swalvo-grid-layout__tiles">
        {pagination.pageItems.map((ref) => renderTileFor(ref, renderTile, tileProps, room))}
      </div>
      {pagination.totalPages > 1 && (
        <nav className="swalvo-pagination" aria-label="Participant pages">
          <button
            type="button"
            className="swalvo-button swalvo-pagination__prev"
            data-variant="ghost"
            aria-label="Previous page"
            disabled={!pagination.hasPrev}
            onClick={pagination.prev}
          >
            <ChevronLeftIcon />
          </button>
          <span className="swalvo-pagination__status" aria-live="polite">
            Page {pagination.page + 1} of {pagination.totalPages}
          </span>
          <button
            type="button"
            className="swalvo-button swalvo-pagination__next"
            data-variant="ghost"
            aria-label="Next page"
            disabled={!pagination.hasNext}
            onClick={pagination.next}
          >
            <ChevronRightIcon />
          </button>
        </nav>
      )}
    </div>
  );
}

export interface FocusLayoutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The tile shown large: a pinned participant or a screen share. */
  trackRef: TrackReference;
  /** Everyone else, in a scrollable strip. Tiles scrolled out of view pause on their own. */
  others?: TrackReference[];
  renderTile?: TileRenderer;
  tileProps?: Partial<ParticipantTileProps>;
  room?: Room;
}

/**
 * One large tile plus a carousel of the rest. The carousel's videos are
 * ordinary attached `<video>` elements, so the SDK's own visibility
 * observation pauses those scrolled out of view.
 */
export function FocusLayout({
  trackRef,
  others = [],
  renderTile,
  tileProps,
  room,
  className,
  ...rest
}: FocusLayoutProps) {
  const render = (ref: TrackReference) => renderTileFor(ref, renderTile, tileProps, room);
  return (
    <div {...rest} className={cx('swalvo-focus-layout', className)} data-has-carousel={others.length > 0 || undefined}>
      <div className="swalvo-focus-layout__main">{render(trackRef)}</div>
      {others.length > 0 && (
        <div className="swalvo-carousel" role="region" aria-label="Other participants" tabIndex={0}>
          {others.map(render)}
        </div>
      )}
    </div>
  );
}
