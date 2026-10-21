import { RTCError } from '@swalvo/rtc';
import { createDefaultAudioAdapter, type NativeAudioAdapter } from './internal/native-audio';

/** Where call audio is playing. */
export type SwalvoAudioOutput = 'speaker' | 'earpiece' | 'headset' | 'bluetooth';

/**
 * Call audio routing. A mobile-only concern with no web equivalent.
 *
 * On a phone, "which speaker is this coming out of" is a real question
 * with a wrong answer. A video call playing through the earpiece at arm's
 * length sounds broken, and one blaring out of the loudspeaker while the
 * user has AirPods in is worse. The OS also reroutes underneath you when a
 * headset gets plugged in, a call comes through, or Bluetooth connects.
 *
 * `Swalvo` starts and stops the audio session around a room for you, so the
 * default behaviour is right without any of this being called. This module
 * is for when the app wants to override it, a speakerphone button being
 * the obvious case.
 *
 * # What's actually behind this
 *
 * Swalvo doesn't bundle an audio-session implementation any more. The
 * default adapter goes through `react-native-incall-manager`, an optional
 * peer dependency, and `setAdapter()` swaps it out. Two methods,
 * `getOutputs()` and `showRoutePicker()`, have no upstream implementation
 * at all and report `NOT_SUPPORTED` unless an adapter supplies them.
 * docs/sdk/react-native.md#audio-routing covers why, and what to do if you
 * need them.
 */

let adapter: NativeAudioAdapter | undefined;
let adapterResolved = false;

function resolveAdapter(): NativeAudioAdapter | undefined {
  if (!adapterResolved) {
    adapterResolved = true;
    adapter = createDefaultAudioAdapter();
  }
  return adapter;
}

/**
 * Demands an adapter, and says which of the two problems you've got.
 *
 * "You haven't installed the native module" and "this platform can't do
 * that" want different fixes. Collapse them into one message and somebody
 * spends an afternoon chasing the wrong one.
 */
function requireAdapter(): NativeAudioAdapter {
  const resolved = resolveAdapter();
  if (!resolved) {
    throw new RTCError(
      'NOT_SUPPORTED',
      'Call audio routing needs a native module. Install react-native-incall-manager, ' +
        'or supply your own with audio.setAdapter(). See docs/sdk/react-native.md#audio-routing.',
    );
  }
  return resolved;
}

export const audio = {
  /**
   * Swaps out the audio-routing implementation.
   *
   * For apps that already hold an audio session, or that need the two
   * capabilities the default adapter doesn't have. Call it before you join
   * a room.
   */
  setAdapter(custom: NativeAudioAdapter | undefined): void {
    adapter = custom;
    adapterResolved = true;
  },

  /**
   * Sends call audio to the loudspeaker, or back to the default route:
   * earpiece, or whatever happens to be plugged in.
   *
   * Use this rather than `setOutput()` for a speakerphone toggle. Passing
   * `false` hands control back to the platform, which then respects a
   * connected headset or Bluetooth device instead of overriding the output
   * the user obviously wanted.
   */
  async setSpeakerphone(enabled: boolean): Promise<void> {
    // `null` when turning it off, not `false`. On some platforms `false`
    // means "force the earpiece", which would override a connected
    // headset. `null` hands the decision back.
    await requireAdapter().setForceSpeakerphone(enabled ? true : null);
  },

  /**
   * Picks a specific output.
   *
   * Android only, in the default adapter. iOS gives an app no way to force
   * any route but the speaker; the OS owns that decision. So on iOS
   * anything other than `'speaker'` reports `NOT_SUPPORTED` instead of
   * quietly doing nothing. Use `setSpeakerphone()` there, or
   * `showRoutePicker()` with an adapter that implements it.
   */
  async setOutput(output: SwalvoAudioOutput): Promise<void> {
    const resolved = requireAdapter();

    if (resolved.selectOutput) {
      await resolved.selectOutput(output);
      return;
    }

    // Falling back to the speaker toggle covers the two cases every
    // platform can express, and refuses the rest instead of pretending.
    if (output === 'speaker') {
      await resolved.setForceSpeakerphone(true);
      return;
    }
    if (output === 'earpiece') {
      await resolved.setForceSpeakerphone(false);
      return;
    }

    throw new RTCError(
      'NOT_SUPPORTED',
      `Selecting the "${output}" output is not supported on this platform. ` +
        'Use audio.setSpeakerphone(), or supply an adapter with audio.setAdapter().',
    );
  },

  /**
   * What's available to route to right now. The list shifts as headsets and
   * Bluetooth devices come and go, so read it when you render the picker.
   * Don't cache it.
   *
   * Reports `NOT_SUPPORTED` unless the adapter can enumerate, and the
   * default one can't. Handing back a guessed list would fill a picker with
   * outputs that do nothing when selected.
   */
  async getOutputs(): Promise<SwalvoAudioOutput[]> {
    const resolved = requireAdapter();
    if (!resolved.availableOutputs) {
      throw new RTCError(
        'NOT_SUPPORTED',
        'Enumerating audio outputs is not supported by the current audio adapter. ' +
          'Supply one that implements availableOutputs() with audio.setAdapter().',
      );
    }
    return resolved.availableOutputs();
  },

  /**
   * Shows the system route picker, iOS's AirPlay-style sheet.
   *
   * Reports `NOT_SUPPORTED` unless the adapter implements it, and no
   * upstream React Native module does. Where you can get it, it beats a
   * custom list on iOS: it's the control users already recognise.
   */
  async showRoutePicker(): Promise<void> {
    const resolved = requireAdapter();
    if (!resolved.showRoutePicker) {
      throw new RTCError(
        'NOT_SUPPORTED',
        'The system audio route picker is not supported by the current audio adapter. ' +
          'Supply one that bridges AVRoutePickerView with audio.setAdapter().',
      );
    }
    await resolved.showRoutePicker();
  },

  /**
   * @internal Called by `Swalvo` when a room is joined. Exposed for apps
   * that manage the session themselves, say one already holding an audio
   * session for its own playback.
   *
   * Best-effort. A missing audio module mustn't stop a call connecting.
   * Video still works and audio routing falls back to whatever the OS
   * picked: degraded, not broken.
   */
  async start(): Promise<void> {
    await resolveAdapter()?.startSession();
  },

  /** @internal Counterpart to `start()`, called when the room is left. */
  async stop(): Promise<void> {
    await resolveAdapter()?.stopSession();
  },

  /** @internal Test-only. Forces the default adapter to be looked up again. */
  __resetForTests(): void {
    adapter = undefined;
    adapterResolved = false;
  },
};

export type { NativeAudioAdapter } from './internal/native-audio';
