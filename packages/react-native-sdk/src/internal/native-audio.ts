import { Platform } from 'react-native';
import type { SwalvoAudioOutput } from '../audio';

/**
 * The platform capabilities call-audio routing depends on.
 *
 * # Why this is an interface and not a direct dependency
 *
 * Swalvo used to get audio routing from `@livekit/react-native`'s
 * `AudioSession`, which crammed session management, output selection,
 * device enumeration and the iOS route picker into one native module. No
 * single upstream package does all of that. `react-native-incall-manager`
 * handles session management and output selection well, does device
 * enumeration on Android only, and doesn't implement the iOS route picker
 * at all.
 *
 * So rather than pretend otherwise: the pieces the platform genuinely
 * can't do are `undefined` here, `audio.ts` reports them as
 * `NOT_SUPPORTED`, and an app needing full fidelity supplies its own
 * adapter through `audio.setAdapter`, wrapping whatever native module it
 * already has (an `AVRoutePickerView` bridge, say). A real limitation,
 * stated out loud instead of hidden. See
 * docs/sdk/react-native.md#audio-routing.
 */
export interface NativeAudioAdapter {
  /** Claims the audio session for a call, setting the category and mode so earpiece and speaker behave. */
  startSession(): Promise<void>;
  stopSession(): Promise<void>;

  /**
   * Forces the loudspeaker on or off.
   *
   * `null` means "go back to the platform's own choice", which is what
   * respects a connected headset or Bluetooth device instead of overriding
   * the output the user obviously wanted.
   */
  setForceSpeakerphone(enabled: boolean | null): Promise<void>;

  /**
   * Selects a specific output. Optional, because iOS gives an app no way to
   * force any route but the speaker, so it's Android-only in the default
   * adapter.
   */
  selectOutput?(output: SwalvoAudioOutput): Promise<void>;

  /**
   * Outputs available right now. Optional for the same reason: enumeration
   * comes off an Android-only device-change event.
   */
  availableOutputs?(): Promise<SwalvoAudioOutput[]>;

  /** The system route picker. Optional, iOS-only, and no upstream module provides it. */
  showRoutePicker?(): Promise<void>;
}

/**
 * As much of `react-native-incall-manager`'s surface as gets used here.
 *
 * Declared locally instead of imported, so this package doesn't need the
 * module's types at build time. It's an optional peer, and a project that
 * only uses Swalvo Chat shouldn't have to install a call-audio native module
 * just to typecheck.
 */
interface InCallManagerModule {
  start(options?: { media?: 'audio' | 'video'; auto?: boolean; ringback?: string }): void;
  stop(options?: { busytone?: string }): void;
  setForceSpeakerphoneOn(enabled: boolean | null): void;
  chooseAudioRoute?(route: string): Promise<unknown>;
}

/** Android's route names, which don't match Swalvo's vocabulary. */
const ANDROID_ROUTES: Record<SwalvoAudioOutput, string> = {
  speaker: 'SPEAKER_PHONE',
  earpiece: 'EARPIECE',
  headset: 'WIRED_HEADSET',
  bluetooth: 'BLUETOOTH',
};

/**
 * Loads `react-native-incall-manager`, if the app happens to have it.
 *
 * `require`, not a static import, and failures swallowed, because
 * the module is an optional peer dependency. An app using Swalvo for chat
 * only, or one supplying its own adapter, must not fail to start over a
 * missing call-audio native module. If routing does then get used,
 * `audio.ts` reports a clear error.
 */
function loadInCallManager(): InCallManagerModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('react-native-incall-manager') as InCallManagerModule | { default: InCallManagerModule };
    return 'default' in loaded ? loaded.default : loaded;
  } catch {
    return undefined;
  }
}

/**
 * The default adapter, over `react-native-incall-manager`.
 *
 * Returns `undefined` when the module is not installed, so `audio.ts` can
 * tell "not configured" apart from "the platform can't do this". Two
 * problems, two different fixes.
 */
export function createDefaultAudioAdapter(): NativeAudioAdapter | undefined {
  const inCallManager = loadInCallManager();
  if (!inCallManager) {
    return undefined;
  }

  const adapter: NativeAudioAdapter = {
    async startSession() {
      // `media: 'video'` even for a voice call, not `'audio'`. It's what
      // stops the proximity sensor blanking the screen, and a voice call in
      // a video app still has a UI somebody is looking at.
      //
      // `auto: true` lets the module follow headset and Bluetooth changes
      // by itself, which is the right default.
      inCallManager.start({ media: 'video', auto: true });
    },

    async stopSession() {
      inCallManager.stop();
    },

    async setForceSpeakerphone(enabled: boolean | null) {
      inCallManager.setForceSpeakerphoneOn(enabled);
    },
  };

  // Only advertised where it genuinely works. `chooseAudioRoute` isn't
  // implemented on iOS, and claiming support there would leave audio
  // somewhere nobody asked for while cheerfully reporting success.
  if (Platform.OS === 'android' && typeof inCallManager.chooseAudioRoute === 'function') {
    adapter.selectOutput = async (output: SwalvoAudioOutput) => {
      await inCallManager.chooseAudioRoute!(ANDROID_ROUTES[output]);
    };
  }

  return adapter;
}
