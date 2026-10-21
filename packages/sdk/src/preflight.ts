import { RTCError, type RTCErrorCode } from './errors';
import { createLogger, type LogLevel, type Logger } from './logger';
import { createCameraTrack, createMicrophoneTrack } from './internal/media/capture';
import { listDevices } from './internal/devices/enumerate';
import { SwalvoAdapter } from './internal/sfu/swalvo-adapter';
import type { SdkConnectionState } from './internal/sfu/types';
import {
  sampleFromReport,
  summarize,
  turnServersByTransport,
  type ConnectionRoute,
  type NetworkSummary,
  type StatsSample,
  type TurnTransport,
} from './internal/preflight/stats';
import type { LocalTrack } from './track';

export type { ConnectionRoute, NetworkSummary } from './internal/preflight/stats';

/**
 * A pre-call ("can this device hold a call?") test.
 *
 * Kept in its own module, imported by nothing else in the SDK, so an
 * application that never runs one ships none of it: the package is
 * side-effect free and bundlers drop the unused export.
 *
 * # What it does to the room
 *
 * It really joins the room the token names and really publishes the
 * camera and microphone, because a real connection to the real SFU is the
 * only honest test of one. So mint the token for a throwaway room — a
 * fresh name per test, such as `preflight-<uuid>` — never for the room the
 * user is about to enter, or everyone already in it sees a participant
 * appear for a few seconds. Video subscriptions are paused for the whole
 * test (`autoSubscribe: false`), so it downloads nothing it does not need.
 */
export interface ConnectionTestOptions {
  /** An RTC token from your backend, for a throwaway room. See the module doc. */
  token: string;
  /** The `endpoint` from the same mint response. */
  endpoint: string;
  /**
   * The `iceServers` from the same mint response. Without TURN entries the
   * per-transport TURN checks are reported `skipped`.
   */
  iceServers?: RTCIceServer[];
  /** How long to measure once connected. Defaults to 5000 ms. */
  durationMs?: number;
  /** Capture and publish the camera. Defaults to true. */
  camera?: boolean;
  /** Capture and publish the microphone. Defaults to true. */
  microphone?: boolean;
  /** Ceiling for each connection step (signaling, then media). Defaults to 15000 ms. */
  timeoutMs?: number;
  logLevel?: LogLevel;
  /** Called as each stage starts, for a progress UI. */
  onProgress?: (stage: ConnectionTestStage) => void;
}

export type ConnectionTestStage = 'devices' | 'turn' | 'signaling' | 'media' | 'measuring' | 'done';

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface DeviceCheck {
  /** `passed`: captured. `failed`: see `error`. `skipped`: not asked for. */
  status: CheckStatus;
  /** Devices of this kind the browser lists. Labels need a permission grant first; the count does not. */
  devices: number;
  /** `CAMERA_PERMISSION_DENIED`, `DEVICE_NOT_FOUND`, `MEDIA_ERROR` (device busy), … */
  error?: RTCErrorCode;
  message?: string;
}

export interface StepCheck {
  status: CheckStatus;
  /** Time the step took, ms. */
  durationMs?: number;
  error?: RTCErrorCode;
  message?: string;
}

/**
 * A finding worth showing someone, in the order they matter. The codes are
 * stable; the messages are written for an end user's support screen.
 */
export interface ConnectionTestIssue {
  code:
    | 'CAMERA_UNAVAILABLE'
    | 'MICROPHONE_UNAVAILABLE'
    | 'CONNECT_FAILED'
    | 'MEDIA_FAILED'
    | 'RELAY_REQUIRED'
    | 'UDP_BLOCKED'
    | 'RELAY_UNREACHABLE'
    | 'HIGH_LATENCY'
    | 'HIGH_JITTER'
    | 'PACKET_LOSS'
    | 'LOW_UPSTREAM';
  severity: 'error' | 'warning';
  message: string;
}

export interface ConnectionTestReport {
  /** Signaling and media both connected: this device can hold a call. Warnings may still apply. */
  ok: boolean;
  startedAt: string;
  durationMs: number;
  camera: DeviceCheck;
  microphone: DeviceCheck;
  /** The WebSocket to the API, through the room join. */
  signaling: StepCheck;
  /** ICE + DTLS to the SFU: media can actually flow. */
  media: StepCheck;
  /** How media reached the SFU. Empty when media never connected. */
  route: ConnectionRoute;
  /**
   * Whether a TURN relay can be allocated over each transport, probed
   * independently of the call: `udp` (`turn:…?transport=udp`), `tcp`
   * (`turn:…?transport=tcp`) and `tls` (`turns:`). `skipped` means the ICE
   * server list has no URL of that kind. A network that blocks UDP still
   * holds a call when `tcp` or `tls` passes.
   */
  turn: Record<TurnTransport, CheckStatus>;
  network: NetworkSummary;
  issues: ConnectionTestIssue[];
}

/** Thresholds behind the warnings. Roughly where a call starts to feel it. */
const HIGH_RTT_MS = 300;
const HIGH_JITTER_MS = 30;
const PACKET_LOSS_PERCENT = 3;
/** Below this, with a camera published, the low simulcast layer is about all that fits. */
const LOW_UPSTREAM_KBPS = 300;
const TURN_PROBE_TIMEOUT_MS = 5_000;
const SAMPLE_INTERVAL_MS = 1_000;

/**
 * The seams a test needs. Not part of the public API.
 * @internal
 */
export interface ConnectionTestDeps {
  createAdapter(
    logger: Logger,
  ): Pick<
    SwalvoAdapter,
    'connect' | 'disconnect' | 'publish' | 'ensureDataChannel' | 'getStatsReport' | 'connectionState' | 'on' | 'off'
  >;
  probeTurn(servers: RTCIceServer[], timeoutMs: number): Promise<boolean>;
  captureCamera(): Promise<LocalTrack>;
  captureMicrophone(): Promise<LocalTrack>;
  countDevices(kind: 'videoinput' | 'audioinput'): Promise<number>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultDeps: ConnectionTestDeps = {
  createAdapter: (logger) => new SwalvoAdapter(logger, false, { adaptiveStream: false, autoSubscribe: false }),
  probeTurn,
  captureCamera: () => createCameraTrack(),
  captureMicrophone: () => createMicrophoneTrack(),
  countDevices: async (kind) => {
    try {
      return (await listDevices(kind)).length;
    } catch {
      return 0;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs a pre-call test and resolves to a report. Never rejects for a
 * failed check — a failure is a result, recorded in the report — only for
 * invalid options.
 *
 * ```ts
 * const grant = await fetch('/api/preflight-token').then((r) => r.json());
 * const report = await runConnectionTest({ ...grant, durationMs: 5000 });
 * if (!report.ok) showTroubleshooting(report.issues);
 * ```
 *
 * Takes about `durationMs` plus connection time: typically 6–8 seconds.
 */
export async function runConnectionTest(
  options: ConnectionTestOptions,
  deps: Partial<ConnectionTestDeps> = {},
): Promise<ConnectionTestReport> {
  if (!options || typeof options.token !== 'string' || !options.token) {
    throw new RTCError('INVALID_TOKEN', 'runConnectionTest() needs the RTC token from your backend');
  }
  if (typeof options.endpoint !== 'string' || !options.endpoint) {
    throw new RTCError('INVALID_TOKEN', 'runConnectionTest() needs the endpoint from the same mint response');
  }

  const d: ConnectionTestDeps = { ...defaultDeps, ...deps };
  const logger = createLogger(options.logLevel ?? 'silent');
  const progress = (stage: ConnectionTestStage) => {
    try {
      options.onProgress?.(stage);
    } catch {
      // A progress callback that throws must not fail the test it reports on.
    }
  };
  const started = d.now();
  const durationMs = Math.max(0, options.durationMs ?? 5_000);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  const iceServers = options.iceServers ?? [];

  // --- Devices ---------------------------------------------------------
  progress('devices');
  const tracks: LocalTrack[] = [];
  const camera = await checkDevice(options.camera !== false, 'videoinput', d.captureCamera, d, tracks);
  const microphone = await checkDevice(options.microphone !== false, 'audioinput', d.captureMicrophone, d, tracks);

  // --- TURN, per transport, alongside the call -------------------------
  progress('turn');
  const turnGroups = turnServersByTransport(iceServers);
  const turnProbe = Promise.all(
    (['udp', 'tcp', 'tls'] as const).map(async (transport): Promise<[TurnTransport, CheckStatus]> => {
      const servers = turnGroups.get(transport);
      if (!servers || servers.length === 0) return [transport, 'skipped'];
      try {
        return [transport, (await d.probeTurn(servers, TURN_PROBE_TIMEOUT_MS)) ? 'passed' : 'failed'];
      } catch {
        return [transport, 'failed'];
      }
    }),
  );

  // --- Signaling and media ---------------------------------------------
  const adapter = d.createAdapter(logger);
  const signaling: StepCheck = { status: 'skipped' };
  const media: StepCheck = { status: 'skipped' };
  let route: ConnectionRoute = {};
  const samples: StatsSample[] = [];
  let published = false;

  try {
    progress('signaling');
    const signalingStart = d.now();
    try {
      await withTimeout(adapter.connect(options.endpoint, options.token, iceServers), timeoutMs, 'the room join');
      signaling.status = 'passed';
      signaling.durationMs = d.now() - signalingStart;
    } catch (error) {
      Object.assign(signaling, failure(error), { durationMs: d.now() - signalingStart });
    }

    if (signaling.status === 'passed') {
      progress('media');
      const mediaStart = d.now();
      const connected = waitForConnected(adapter, timeoutMs);
      for (const track of tracks) {
        try {
          await adapter.publish(track);
          published = true;
        } catch (error) {
          logger.warn('preflight could not publish a track', (error as Error).message);
        }
      }
      // Nothing to publish still has to prove media can connect: a data
      // channel needs the same ICE and DTLS.
      if (!published) adapter.ensureDataChannel();

      try {
        await connected;
        media.status = 'passed';
        media.durationMs = d.now() - mediaStart;
      } catch (error) {
        Object.assign(media, failure(error), { durationMs: d.now() - mediaStart });
      }
    }

    if (media.status === 'passed') {
      progress('measuring');
      const end = d.now() + durationMs;
      for (;;) {
        const report = await adapter.getStatsReport().catch(() => undefined);
        if (report) samples.push(sampleFromReport(report, d.now()));
        if (d.now() >= end) break;
        await d.sleep(Math.min(SAMPLE_INTERVAL_MS, Math.max(0, end - d.now())));
      }
      route = [...samples].reverse().find((sample) => sample.route.candidateType)?.route ?? {};
    }
  } finally {
    await adapter.disconnect().catch(() => undefined);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // Already stopped by the disconnect.
      }
    }
  }

  const turn = Object.fromEntries(await turnProbe) as Record<TurnTransport, CheckStatus>;
  const network = summarize(samples);
  progress('done');

  return {
    ok: signaling.status === 'passed' && media.status === 'passed',
    startedAt: new Date(started).toISOString(),
    durationMs: d.now() - started,
    camera,
    microphone,
    signaling,
    media,
    route,
    turn,
    network,
    issues: findIssues({
      camera,
      microphone,
      signaling,
      media,
      route,
      turn,
      network,
      published: camera.status === 'passed' && published,
    }),
  };
}

async function checkDevice(
  wanted: boolean,
  kind: 'videoinput' | 'audioinput',
  capture: () => Promise<LocalTrack>,
  d: ConnectionTestDeps,
  tracks: LocalTrack[],
): Promise<DeviceCheck> {
  if (!wanted) return { status: 'skipped', devices: await d.countDevices(kind) };
  try {
    const track = await capture();
    tracks.push(track);
    // Counted after capture: before a grant some browsers list no devices at all.
    return { status: 'passed', devices: await d.countDevices(kind) };
  } catch (error) {
    const { error: code, message } = failure(error);
    return { status: 'failed', devices: await d.countDevices(kind), error: code, message };
  }
}

function failure(error: unknown): { status: 'failed'; error: RTCErrorCode; message: string } {
  if (error instanceof RTCError) return { status: 'failed', error: error.code, message: error.message };
  return {
    status: 'failed',
    error: 'CONNECTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RTCError('TIMEOUT', `Timed out after ${ms}ms waiting for ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForConnected(adapter: ReturnType<ConnectionTestDeps['createAdapter']>, ms: number): Promise<void> {
  if (adapter.connectionState === 'connected') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onState = (state: SdkConnectionState) => {
      if (state === 'connected') settle(resolve);
      else if (state === 'failed' || state === 'disconnected') {
        settle(() =>
          reject(new RTCError('CONNECTION_FAILED', 'The media connection did not establish (ICE or DTLS failed)')),
        );
      }
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new RTCError(
              'TIMEOUT',
              `The media connection did not establish within ${ms}ms; UDP and TURN may both be blocked`,
            ),
          ),
        ),
      ms,
    );
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      adapter.off('connectionStateChanged', onState);
      fn();
    };
    adapter.on('connectionStateChanged', onState);
  });
}

/**
 * Whether a TURN relay can be allocated through these servers: gathers
 * candidates on a throwaway connection restricted to relays, and passes on
 * the first relay candidate. Touches nothing but the TURN server.
 */
async function probeTurn(servers: RTCIceServer[], timeoutMs: number): Promise<boolean> {
  if (typeof RTCPeerConnection === 'undefined') return false;
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const done = (result: boolean) => {
        clearTimeout(timer);
        resolve(result);
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          done(false);
          return;
        }
        if (event.candidate.type === 'relay' || / typ relay /.test(event.candidate.candidate)) done(true);
      };
      pc.createDataChannel('raven-preflight');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => done(false));
    });
  } finally {
    pc.onicecandidate = null;
    pc.close();
  }
}

function findIssues(input: {
  camera: DeviceCheck;
  microphone: DeviceCheck;
  signaling: StepCheck;
  media: StepCheck;
  route: ConnectionRoute;
  turn: Record<TurnTransport, CheckStatus>;
  network: NetworkSummary;
  published: boolean;
}): ConnectionTestIssue[] {
  const issues: ConnectionTestIssue[] = [];
  const { camera, microphone, signaling, media, route, turn, network } = input;

  if (signaling.status === 'failed') {
    issues.push({
      code: 'CONNECT_FAILED',
      severity: 'error',
      message: `Could not reach the service: ${signaling.message ?? 'unknown error'}. A firewall or proxy may be blocking secure WebSockets.`,
    });
  }
  if (media.status === 'failed') {
    issues.push({
      code: 'MEDIA_FAILED',
      severity: 'error',
      message:
        'Connected to the service, but audio and video could not get through. Your network may block the ports calls need.',
    });
  }
  if (camera.status === 'failed') {
    issues.push({
      code: 'CAMERA_UNAVAILABLE',
      severity: 'warning',
      message: camera.message ?? 'The camera could not be used.',
    });
  }
  if (microphone.status === 'failed') {
    issues.push({
      code: 'MICROPHONE_UNAVAILABLE',
      severity: 'warning',
      message: microphone.message ?? 'The microphone could not be used.',
    });
  }
  const anyTurn = turn.udp !== 'skipped' || turn.tcp !== 'skipped' || turn.tls !== 'skipped';
  if (anyTurn && turn.udp !== 'passed' && turn.tcp !== 'passed' && turn.tls !== 'passed') {
    issues.push({
      code: 'RELAY_UNREACHABLE',
      severity: 'warning',
      message: 'No relay server could be reached. Calls will fail on networks that block direct connections.',
    });
  }
  if (route.usedRelay) {
    issues.push({
      code: 'RELAY_REQUIRED',
      severity: 'warning',
      message: `Media had to go through a relay${route.relayProtocol ? ` over ${route.relayProtocol.toUpperCase()}` : ''}, which adds latency.`,
    });
  }
  const tcpFallbackOnly = route.protocol === 'tcp' || (route.usedRelay && route.relayProtocol !== 'udp');
  if (turn.udp === 'failed' || (media.status === 'passed' && tcpFallbackOnly)) {
    issues.push({
      code: 'UDP_BLOCKED',
      severity: 'warning',
      message: 'UDP appears to be blocked, so media falls back to TCP. Expect more delay and choppier video.',
    });
  }
  if (network.rttMs !== undefined && network.rttMs > HIGH_RTT_MS) {
    issues.push({
      code: 'HIGH_LATENCY',
      severity: 'warning',
      message: `High latency (${Math.round(network.rttMs)} ms round trip).`,
    });
  }
  if (network.jitterMs !== undefined && network.jitterMs > HIGH_JITTER_MS) {
    issues.push({
      code: 'HIGH_JITTER',
      severity: 'warning',
      message: `Unstable connection (${Math.round(network.jitterMs)} ms jitter).`,
    });
  }
  if (network.packetLossPercent !== undefined && network.packetLossPercent > PACKET_LOSS_PERCENT) {
    issues.push({
      code: 'PACKET_LOSS',
      severity: 'warning',
      message: `${network.packetLossPercent.toFixed(1)}% of packets were lost on the way out.`,
    });
  }
  if (input.published && network.upstreamKbps !== undefined && network.upstreamKbps < LOW_UPSTREAM_KBPS) {
    issues.push({
      code: 'LOW_UPSTREAM',
      severity: 'warning',
      message: `Low upload bandwidth (${Math.round(network.upstreamKbps)} kbit/s). Others may see your video at low quality.`,
    });
  }
  return issues;
}
