import { RTCError } from '../../errors';
import type { DeviceInfo, DeviceKind } from '../sfu/types';

/**
 * Lists available media devices.
 *
 * Labels come back empty until permission has been granted at least once.
 * That's a privacy measure in every browser and not something the SDK can
 * route around. A label-less device still has a usable `deviceId`, so you
 * can select it. There's just nothing worth showing a user until they've
 * allowed access once.
 */
export async function listDevices(kind?: DeviceKind): Promise<DeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    throw new RTCError(
      'NOT_SUPPORTED',
      'Device enumeration is not available in this environment (no navigator.mediaDevices)',
    );
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => !kind || device.kind === kind)
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: device.kind as DeviceKind,
    }));
}
