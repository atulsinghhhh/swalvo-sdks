import { permissions } from '../src/permissions';
import { SwalvoPermissionError, isSwalvoPermissionError, toPermissionError } from '../src/errors';
import { PermissionsAndroid, __setPlatform } from './mocks/react-native';

/** Installs a fake getUserMedia so the iOS probe path can be exercised. */
function stubGetUserMedia(impl: () => Promise<unknown>) {
  const stopped: string[] = [];
  (globalThis as Record<string, unknown>).navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        const result = await impl();
        return result ?? { getTracks: () => [{ stop: () => stopped.push('stopped') }] };
      },
    },
  };
  return stopped;
}

function clearNavigator() {
  delete (globalThis as Record<string, unknown>).navigator;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearNavigator();
});

describe('android', () => {
  beforeEach(() => __setPlatform('android'));

  it('reports granted without prompting when already granted', async () => {
    PermissionsAndroid.check.mockResolvedValue(true as never);

    await expect(permissions.check()).resolves.toEqual({
      camera: 'granted',
      microphone: 'granted',
    });
    // check() must never prompt. That's the whole difference from request().
    expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  });

  it('maps a plain denial and a permanent one to different statuses', async () => {
    PermissionsAndroid.requestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'denied',
      'android.permission.RECORD_AUDIO': 'never_ask_again',
    } as never);

    const result = await permissions.request();

    // The distinction is the point. 'denied' can be re-prompted; 'blocked'
    // can only be fixed in Settings.
    expect(result.camera).toBe('denied');
    expect(result.microphone).toBe('blocked');
  });

  it('requests only what was asked for', async () => {
    PermissionsAndroid.requestMultiple.mockResolvedValue({
      'android.permission.RECORD_AUDIO': 'granted',
    } as never);

    await permissions.request(['microphone']);

    expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith(['android.permission.RECORD_AUDIO']);
  });

  it('require() throws a permission error carrying the settings hint', async () => {
    PermissionsAndroid.requestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'never_ask_again',
    } as never);

    await expect(permissions.require(['camera'])).rejects.toBeInstanceOf(SwalvoPermissionError);

    // `require()` resolves to void on success, so narrow through the error
    // type instead of casting a union that includes it.
    let captured: SwalvoPermissionError | undefined;
    try {
      await permissions.require(['camera']);
    } catch (error) {
      captured = error as SwalvoPermissionError;
    }

    expect(captured).toBeDefined();
    expect(captured!.permission).toBe('camera');
    expect(captured!.requiresSettings).toBe(true);
    // Still an RTCError, so existing web error handling keeps working.
    expect(captured!.code).toBe('CAMERA_PERMISSION_DENIED');
  });

  it('require() resolves when everything is granted', async () => {
    PermissionsAndroid.requestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'granted',
      'android.permission.RECORD_AUDIO': 'granted',
    } as never);

    await expect(permissions.require()).resolves.toBeUndefined();
  });
});

describe('ios', () => {
  beforeEach(() => __setPlatform('ios'));

  it('reports undetermined from check() rather than guessing', async () => {
    // iOS exposes no authorization status to JS. Claim 'granted' and a
    // developer skips request() and hits a silent black frame.
    await expect(permissions.check()).resolves.toEqual({
      camera: 'undetermined',
      microphone: 'undetermined',
    });
  });

  it('grants when the probe succeeds, and releases the probe stream', async () => {
    const stopped = stubGetUserMedia(async () => undefined);

    await expect(permissions.request(['camera'])).resolves.toEqual(expect.objectContaining({ camera: 'granted' }));
    // Leave the probe stream open and the camera light stays on.
    expect(stopped).toEqual(['stopped']);
  });

  it('treats a refusal as blocked, because iOS never re-prompts', async () => {
    stubGetUserMedia(async () => {
      const error = new Error('Permission denied');
      error.name = 'NotAllowedError';
      throw error;
    });

    await expect(permissions.request(['microphone'])).resolves.toEqual(
      expect.objectContaining({ microphone: 'blocked' }),
    );
  });

  it('reports unavailable; not denied; when the globals were never registered', async () => {
    clearNavigator();

    // Misreport this as a permission problem and the developer goes
    // hunting through Info.plist for what's really a missing bootstrap
    // call.
    await expect(permissions.request(['camera'])).resolves.toEqual(expect.objectContaining({ camera: 'unavailable' }));
  });

  it('require() ignores unavailable rather than throwing', async () => {
    clearNavigator();
    await expect(permissions.require(['camera'])).resolves.toBeUndefined();
  });
});

describe('unsupported platforms', () => {
  it('reports unavailable rather than pretending', async () => {
    __setPlatform('web');
    await expect(permissions.check()).resolves.toEqual({
      camera: 'unavailable',
      microphone: 'unavailable',
    });
  });
});

describe('toPermissionError', () => {
  it('recognises the DOMException names browsers use for a denial', () => {
    const notAllowed = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    expect(toPermissionError('camera', notAllowed)).toBeInstanceOf(SwalvoPermissionError);

    const security = Object.assign(new Error('blocked'), { name: 'SecurityError' });
    expect(toPermissionError('microphone', security)).toBeInstanceOf(SwalvoPermissionError);
  });

  it('leaves unrelated failures alone', () => {
    // A camera that's physically busy isn't a permission problem, and
    // reporting it as one sends the user to Settings for nothing.
    const busy = Object.assign(new Error('Device in use'), { name: 'NotReadableError' });
    expect(toPermissionError('camera', busy)).toBeUndefined();
  });

  it('is recognised by the type guard', () => {
    expect(isSwalvoPermissionError(new SwalvoPermissionError('camera', 'denied'))).toBe(true);
    expect(isSwalvoPermissionError(new Error('plain'))).toBe(false);
  });
});
