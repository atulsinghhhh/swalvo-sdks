import type { RemoteTrack } from '@swalvo/rtc';

/**
 * Adaptive streaming's visibility, for React Native.
 *
 * On web the SDK watches the `<video>` element a track is attached to
 * (IntersectionObserver, page visibility, size, detachment) and pauses a
 * video nobody can see. React Native has none of those: video is a native
 * surface the JavaScript side cannot observe. So each `SwalvoVideoView`
 * reports instead — its `visible` prop and whether its layout has a size —
 * and this aggregates the reports per track into the one flag the core
 * takes, `RemoteTrack.setVisible()`.
 *
 * A track is visible while any view showing it is. When the last view
 * showing it unmounts, it counts as hidden, the same as a web track
 * detached from its last element; the core then pauses it at the SFU after
 * its debounce, and the next view to mount resumes it at once. A track no
 * `SwalvoVideoView` ever showed is never touched, so an application
 * rendering its own `RTCView` keeps today's behaviour.
 */
const views = new WeakMap<RemoteTrack, Map<object, boolean>>();

type VisibleTrack = Pick<RemoteTrack, 'setVisible'>;

function supportsVisibility(track: unknown): track is VisibleTrack & RemoteTrack {
  return typeof (track as Partial<VisibleTrack> | undefined)?.setVisible === 'function';
}

/** Records one view's visibility for `track` and pushes the aggregate to the core. */
export function reportViewVisibility(track: unknown, view: object, visible: boolean): void {
  if (!supportsVisibility(track)) return;
  let byView = views.get(track);
  if (!byView) {
    byView = new Map();
    views.set(track, byView);
  }
  byView.set(view, visible);
  track.setVisible(anyVisible(byView));
}

/** Forgets a view (unmounted, or now showing another track). */
export function withdrawView(track: unknown, view: object): void {
  if (!supportsVisibility(track)) return;
  const byView = views.get(track);
  if (!byView || !byView.delete(view)) return;
  track.setVisible(anyVisible(byView));
}

function anyVisible(byView: Map<object, boolean>): boolean {
  for (const visible of byView.values()) {
    if (visible) return true;
  }
  return false;
}
