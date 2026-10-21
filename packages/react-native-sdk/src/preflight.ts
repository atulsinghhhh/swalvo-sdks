import {
  runConnectionTest as runCoreConnectionTest,
  type ConnectionTestOptions,
  type ConnectionTestReport,
} from '@swalvo/rtc';
import { bootstrapSwalvoNative } from './internal/bootstrap';

/**
 * The pre-call test, for React Native. Exactly `@swalvo/rtc`'s
 * `runConnectionTest()` — same options, same report — with the WebRTC
 * globals put in place first, so it works on a pre-join screen before any
 * `Swalvo` instance exists. See the web SDK's docs for what it checks and
 * why the token should name a throwaway room.
 *
 * Ask for camera and microphone permission (`permissions.request()`)
 * before calling it on Android; otherwise the device checks report the
 * denial rather than prompting.
 */
export async function runConnectionTest(options: ConnectionTestOptions): Promise<ConnectionTestReport> {
  bootstrapSwalvoNative();
  return runCoreConnectionTest(options);
}
