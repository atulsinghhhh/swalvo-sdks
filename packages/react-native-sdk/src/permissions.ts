import { PermissionsAndroid, Platform } from 'react-native';
import {
  SwalvoPermissionError,
  toPermissionError,
  type SwalvoPermissionKind,
  type SwalvoPermissionStatus,
} from './errors';

export interface PermissionResult {
  camera: SwalvoPermissionStatus;
  microphone: SwalvoPermissionStatus;
}

const ANDROID_PERMISSION: Record<
  SwalvoPermissionKind,
  'android.permission.CAMERA' | 'android.permission.RECORD_AUDIO'
> = {
  camera: 'android.permission.CAMERA',
  microphone: 'android.permission.RECORD_AUDIO',
};

/**
 * Camera and microphone permissions, normalised across iOS and Android.
 *
 * The two platforms really are different here, and this module exists to
 * paper over that difference honestly rather than pretend it isn't there.
 *
 * **Android** has a proper permissions API in React Native core
 * (`PermissionsAndroid`), so we can check state without prompting, prompt
 * explicitly, and tell "denied" apart from "never ask again".
 *
 * **iOS** has nothing of the sort without a native module.
 * `AVCaptureDevice` authorization status isn't reachable from JavaScript,
 * and shipping a native module purely to read one enum, which every
 * developer would then have to link, isn't a trade worth making. So we
 * prompt the only way iOS allows from JS, by asking for the device, and
 * read the outcome. Which means `check()` on iOS reports `undetermined`
 * instead of guessing, and `request()` does the real work.
 *
 * Either way a denial is always an error you can branch on. Nothing here
 * fails silently (spec §3).
 */
export const permissions = {
  /**
   * Reports current status without prompting, where the platform lets us.
   * On iOS you get `undetermined`; see the note above, and use `request()`
   * there instead.
   */
  async check(): Promise<PermissionResult> {
    if (Platform.OS === 'android') {
      const [camera, microphone] = await Promise.all([
        PermissionsAndroid.check(ANDROID_PERMISSION.camera),
        PermissionsAndroid.check(ANDROID_PERMISSION.microphone),
      ]);
      return {
        camera: camera ? 'granted' : 'undetermined',
        microphone: microphone ? 'granted' : 'undetermined',
      };
    }

    if (Platform.OS === 'ios') {
      // Honest instead of optimistic. We can't read iOS authorization
      // status from JS, and claiming 'granted' here would have a developer
      // skip the request and hit a silent black frame instead.
      return { camera: 'undetermined', microphone: 'undetermined' };
    }

    return { camera: 'unavailable', microphone: 'unavailable' };
  },

  /**
   * Prompts for whichever of camera and microphone you ask for, and returns
   * a status per permission. Doesn't throw: inspect the result, or use
   * `require()` if you'd rather have an exception.
   *
   * Call it as often as you like. Both platforms no-op once granted.
   */
  async request(kinds: SwalvoPermissionKind[] = ['camera', 'microphone']): Promise<PermissionResult> {
    const result: PermissionResult = { camera: 'unavailable', microphone: 'unavailable' };

    if (Platform.OS === 'android') {
      const requested = kinds.map((kind) => ANDROID_PERMISSION[kind]);
      const granted = await PermissionsAndroid.requestMultiple(requested);

      for (const kind of kinds) {
        result[kind] = mapAndroidResult(granted[ANDROID_PERMISSION[kind]]);
      }
      return result;
    }

    if (Platform.OS === 'ios') {
      // Asking for the device is the only way to trigger the iOS prompt
      // from JavaScript. We release the stream immediately: this is a
      // permission probe, not a capture session, and hanging on to it
      // leaves the camera light burning.
      for (const kind of kinds) {
        result[kind] = await probeIosPermission(kind);
      }
      return result;
    }

    return result;
  },

  /**
   * Like `request()`, but throws `SwalvoPermissionError` on anything short
   * of a grant. That includes `blocked`, which carries `requiresSettings`
   * so your UI can send the user to Settings instead of prompting again to
   * no effect.
   */
  async require(kinds: SwalvoPermissionKind[] = ['camera', 'microphone']): Promise<void> {
    const result = await permissions.request(kinds);

    for (const kind of kinds) {
      const status = result[kind];
      if (status !== 'granted' && status !== 'unavailable') {
        throw new SwalvoPermissionError(kind, status);
      }
    }
  },
};

function mapAndroidResult(value: string | undefined): SwalvoPermissionStatus {
  switch (value) {
    case PermissionsAndroid.RESULTS.GRANTED:
      return 'granted';
    case PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN:
      return 'blocked';
    case PermissionsAndroid.RESULTS.DENIED:
      return 'denied';
    default:
      return 'undetermined';
  }
}

async function probeIosPermission(kind: SwalvoPermissionKind): Promise<SwalvoPermissionStatus> {
  const mediaDevices = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    // bootstrapSwalvoNative() hasn't run. That's not a permission problem,
    // and reporting one sends the developer down entirely the wrong path.
    return 'unavailable';
  }

  let stream: MediaStream | undefined;
  try {
    stream = await mediaDevices.getUserMedia(kind === 'camera' ? { video: true } : { audio: true });
    return 'granted';
  } catch (error) {
    // iOS never re-prompts after a refusal, so any denial is effectively
    // permanent until the user goes to Settings.
    return toPermissionError(kind, error) ? 'blocked' : 'denied';
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
