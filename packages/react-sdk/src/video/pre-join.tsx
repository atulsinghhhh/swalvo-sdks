'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  runConnectionTest,
  type CheckStatus,
  type ConnectionTestOptions,
  type ConnectionTestReport,
  type ConnectionTestStage,
  type DeviceInfo,
} from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from './icons';
import { initialsOf, type LocalUserChoices } from './types';
import { useAudioLevel, useDeviceList } from './video-hooks';

// legacy: kept so choices saved before the Swalvo rename are still found.
const STORAGE_KEY = 'raven-user-choices';

const DEFAULT_CHOICES: LocalUserChoices = {
  username: '',
  videoEnabled: true,
  audioEnabled: true,
};

function loadChoices(): Partial<LocalUserChoices> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<LocalUserChoices>) : {};
  } catch {
    return {};
  }
}

function saveChoices(choices: LocalUserChoices): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Private mode or storage disabled: remembering is a convenience only.
  }
}

function mediaErrorMessage(error: unknown, device: 'camera' | 'microphone'): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Permission to use the ${device} was denied`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${device} found`;
  if (name === 'NotReadableError') return `The ${device} is in use by another app`;
  return (error as Error)?.message || `Couldn't start the ${device}`;
}

/**
 * A preview track for `<PreJoin>`, straight from `getUserMedia`: there is
 * no room yet. Stopped whenever it is turned off, switched, or unmounted.
 */
function usePreviewTrack(kind: 'video' | 'audio', enabled: boolean, deviceId: string | undefined) {
  const [state, setState] = useState<{ track?: MediaStreamTrack; error?: unknown }>({});

  useEffect(() => {
    if (!enabled) {
      setState({});
      return undefined;
    }
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      setState({ error: new Error('This browser has no media devices') });
      return undefined;
    }
    let cancelled = false;
    let acquired: MediaStream | undefined;
    const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
    md.getUserMedia(kind === 'video' ? { video: constraint } : { audio: constraint }).then(
      (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = stream;
        setState({ track: stream.getTracks()[0] });
      },
      (error: unknown) => {
        if (!cancelled) setState({ error });
      },
    );
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((t) => t.stop());
    };
  }, [kind, enabled, deviceId]);

  return state;
}

export interface PreJoinProps {
  /** Initial choices. Overridden by remembered ones when `persistUserChoices` is on. */
  defaults?: Partial<LocalUserChoices>;
  /** Called with the user's choices when they press Join. Preview tracks are already stopped. */
  onSubmit: (choices: LocalUserChoices) => void;
  /** Extra validation; return false to keep Join disabled. Default: a non-empty name when the name field is shown. */
  onValidate?: (choices: LocalUserChoices) => boolean;
  onError?: (error: unknown) => void;
  /** Show the name field. Default true. */
  showUsername?: boolean;
  /** Remember choices in localStorage for next time. Default false. */
  persistUserChoices?: boolean;
  /**
   * Enables the "Test connection" button. Pass the options for
   * `runConnectionTest()` (a token for a throwaway room — never the call's
   * own), or a function that fetches them when the user clicks.
   */
  connectionTest?: ConnectionTestOptions | (() => Promise<ConnectionTestOptions>);
  joinLabel?: ReactNode;
  usernameLabel?: string;
  className?: string;
}

/**
 * The lobby before a call: camera preview, a live microphone level, device
 * pickers, a name field, and an optional network test. Works outside
 * `<SwalvoRoom>` — it needs no room, only the browser's media devices.
 *
 * ```tsx
 * const [choices, setChoices] = useState<LocalUserChoices>();
 * return choices
 *   ? <SwalvoRoom {...grant}><VideoConference userChoices={choices} /></SwalvoRoom>
 *   : <PreJoin onSubmit={setChoices} />;
 * ```
 */
export function PreJoin({
  defaults,
  onSubmit,
  onValidate,
  onError,
  showUsername = true,
  persistUserChoices = false,
  connectionTest,
  joinLabel = 'Join',
  usernameLabel = 'Your name',
  className,
}: PreJoinProps) {
  const [choices, setChoices] = useState<LocalUserChoices>(() => ({
    ...DEFAULT_CHOICES,
    ...defaults,
    ...(persistUserChoices ? loadChoices() : {}),
  }));
  const update = (patch: Partial<LocalUserChoices>) => setChoices((c) => ({ ...c, ...patch }));

  const video = usePreviewTrack('video', choices.videoEnabled, choices.videoDeviceId);
  const audio = usePreviewTrack('audio', choices.audioEnabled, choices.audioDeviceId);
  const cameras = useDeviceList('videoinput');
  const microphones = useDeviceList('audioinput');
  const level = useAudioLevel(audio.track);
  const ids = { name: useId(), camera: useId(), mic: useId() };

  // A grant fills in device labels; re-read the lists once we have one.
  const refreshCameras = cameras.refresh;
  const refreshMicrophones = microphones.refresh;
  useEffect(() => {
    if (video.track) void refreshCameras();
  }, [video.track, refreshCameras]);
  useEffect(() => {
    if (audio.track) void refreshMicrophones();
  }, [audio.track, refreshMicrophones]);

  useEffect(() => {
    if (video.error) onError?.(video.error);
  }, [video.error, onError]);
  useEffect(() => {
    if (audio.error) onError?.(audio.error);
  }, [audio.error, onError]);

  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = video.track && typeof MediaStream !== 'undefined' ? new MediaStream([video.track]) : null;
  }, [video.track]);

  const valid = onValidate ? onValidate(choices) : !showUsername || choices.username.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    video.track?.stop();
    audio.track?.stop();
    const final: LocalUserChoices = {
      ...choices,
      username: choices.username.trim(),
      videoDeviceId: choices.videoDeviceId ?? settingsDeviceId(video.track),
      audioDeviceId: choices.audioDeviceId ?? settingsDeviceId(audio.track),
    };
    if (persistUserChoices) saveChoices(final);
    onSubmit(final);
  };

  const activeCamera = choices.videoDeviceId ?? settingsDeviceId(video.track) ?? '';
  const activeMic = choices.audioDeviceId ?? settingsDeviceId(audio.track) ?? '';
  const meter = Math.round(level * 100);

  return (
    <form className={cx('swalvo-video', 'swalvo-prejoin', className)} onSubmit={submit} aria-label="Join call">
      <div className="swalvo-prejoin__preview" data-video-muted={!video.track || undefined}>
        {video.track ? (
          <video
            ref={videoRef}
            className="swalvo-prejoin__video"
            autoPlay
            playsInline
            muted
            style={{ transform: 'scaleX(-1)' }}
          />
        ) : (
          <div className="swalvo-participant-tile__placeholder" aria-hidden="true">
            <span className="swalvo-avatar">{initialsOf(choices.username || '?')}</span>
          </div>
        )}
        {video.error ? (
          <p className="swalvo-prejoin__error" role="alert">
            {mediaErrorMessage(video.error, 'camera')}
          </p>
        ) : null}
      </div>

      <div className="swalvo-prejoin__controls">
        <div className="swalvo-prejoin__row">
          <button
            type="button"
            className="swalvo-button swalvo-track-toggle"
            data-source="microphone"
            data-enabled={choices.audioEnabled || undefined}
            aria-pressed={choices.audioEnabled}
            onClick={() => update({ audioEnabled: !choices.audioEnabled })}
          >
            {choices.audioEnabled ? <MicIcon /> : <MicOffIcon />}
            <span className="swalvo-button__label">Microphone</span>
          </button>
          <DeviceSelect
            id={ids.mic}
            label="Microphone"
            devices={microphones.devices}
            value={activeMic}
            onChange={(id) => update({ audioDeviceId: id })}
          />
        </div>
        <div
          className="swalvo-audio-meter"
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={meter}
          data-active={(choices.audioEnabled && !!audio.track) || undefined}
        >
          <span className="swalvo-audio-meter__fill" style={{ transform: `scaleX(${level})` }} />
        </div>
        {audio.error ? (
          <p className="swalvo-prejoin__error" role="alert">
            {mediaErrorMessage(audio.error, 'microphone')}
          </p>
        ) : null}

        <div className="swalvo-prejoin__row">
          <button
            type="button"
            className="swalvo-button swalvo-track-toggle"
            data-source="camera"
            data-enabled={choices.videoEnabled || undefined}
            aria-pressed={choices.videoEnabled}
            onClick={() => update({ videoEnabled: !choices.videoEnabled })}
          >
            {choices.videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
            <span className="swalvo-button__label">Camera</span>
          </button>
          <DeviceSelect
            id={ids.camera}
            label="Camera"
            devices={cameras.devices}
            value={activeCamera}
            onChange={(id) => update({ videoDeviceId: id })}
          />
        </div>

        {showUsername && (
          <div className="swalvo-prejoin__field">
            <label htmlFor={ids.name} className="swalvo-label">
              {usernameLabel}
            </label>
            <input
              id={ids.name}
              className="swalvo-input"
              value={choices.username}
              autoComplete="name"
              onChange={(e) => update({ username: e.target.value })}
            />
          </div>
        )}

        <button type="submit" className="swalvo-button swalvo-prejoin__join" data-variant="primary" disabled={!valid}>
          {joinLabel}
        </button>

        {connectionTest && <ConnectionTest options={connectionTest} />}
      </div>
    </form>
  );
}

function settingsDeviceId(track: MediaStreamTrack | undefined): string | undefined {
  try {
    return track?.getSettings?.().deviceId || undefined;
  } catch {
    return undefined;
  }
}

function DeviceSelect({
  id,
  label,
  devices,
  value,
  onChange,
}: {
  id: string;
  label: string;
  devices: DeviceInfo[];
  value: string;
  onChange: (deviceId: string) => void;
}) {
  return (
    <div className="swalvo-prejoin__field" data-inline>
      <label htmlFor={id} className="swalvo-label swalvo-visually-hidden">
        {label} device
      </label>
      <select
        id={id}
        className="swalvo-select"
        value={devices.some((d) => d.deviceId === value) ? value : ''}
        disabled={devices.length === 0}
        onChange={(e) => onChange(e.target.value)}
      >
        {!devices.some((d) => d.deviceId === value) && (
          <option value="">{devices.length ? 'Default' : `No ${label.toLowerCase()} found`}</option>
        )}
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

const STAGE_LABELS: Record<ConnectionTestStage, string> = {
  devices: 'Checking camera and microphone…',
  turn: 'Checking relay servers…',
  signaling: 'Connecting to the server…',
  media: 'Connecting media…',
  measuring: 'Measuring network quality…',
  done: 'Finishing…',
};

const STATUS_LABELS: Record<CheckStatus, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped' };

function Status({ status }: { status: CheckStatus }) {
  return (
    <span className="swalvo-status" data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function routeLabel(report: ConnectionTestReport): string {
  const route = report.route;
  if (!route.candidateType) return 'Not connected';
  if (route.usedRelay) return `Relayed (TURN over ${(route.relayProtocol ?? route.protocol ?? 'udp').toUpperCase()})`;
  const how = route.candidateType === 'host' ? 'Direct' : 'Through NAT';
  return route.protocol ? `${how} (${route.protocol.toUpperCase()})` : how;
}

function fmt(value: number | undefined, unit: string, digits = 0): string {
  return value === undefined ? '—' : `${value.toFixed(digits)} ${unit}`;
}

function ConnectionTest({ options }: { options: NonNullable<PreJoinProps['connectionTest']> }) {
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<ConnectionTestStage>();
  const [report, setReport] = useState<ConnectionTestReport>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    setRunning(true);
    setReport(undefined);
    setError(undefined);
    setStage(undefined);
    try {
      const resolved = typeof options === 'function' ? await options() : options;
      const result = await runConnectionTest({
        ...resolved,
        onProgress: (next) => {
          resolved.onProgress?.(next);
          if (mounted.current) setStage(next);
        },
      });
      if (mounted.current) setReport(result);
    } catch (err) {
      if (mounted.current) setError((err as Error)?.message ?? String(err));
    } finally {
      if (mounted.current) setRunning(false);
    }
  };

  return (
    <section className="swalvo-connection-test" aria-label="Connection test">
      <button
        type="button"
        className="swalvo-button swalvo-connection-test__run"
        aria-busy={running || undefined}
        data-pending={running || undefined}
        onClick={() => {
          if (!running) void run();
        }}
      >
        {running ? 'Testing…' : report ? 'Test again' : 'Test connection'}
      </button>
      <div aria-live="polite" className="swalvo-connection-test__live">
        {running && (
          <p className="swalvo-connection-test__stage">
            <span className="swalvo-spinner" aria-hidden="true" /> {stage ? STAGE_LABELS[stage] : 'Starting…'}
          </p>
        )}
        {error && (
          <p className="swalvo-prejoin__error" role="alert">
            Connection test failed: {error}
          </p>
        )}
        {report && (
          <div className="swalvo-connection-test__results" data-ok={report.ok || undefined}>
            <p className="swalvo-connection-test__summary">
              {report.ok ? 'Your device can join calls.' : "Your device can't connect to calls right now."}
            </p>
            <dl className="swalvo-connection-test__checks">
              <dt>Camera</dt>
              <dd>
                <Status status={report.camera.status} />
                {report.camera.message && (
                  <span className="swalvo-connection-test__detail"> {report.camera.message}</span>
                )}
              </dd>
              <dt>Microphone</dt>
              <dd>
                <Status status={report.microphone.status} />
                {report.microphone.message && (
                  <span className="swalvo-connection-test__detail"> {report.microphone.message}</span>
                )}
              </dd>
              <dt>Server</dt>
              <dd>
                <Status status={report.signaling.status} />
                {report.signaling.durationMs !== undefined && (
                  <span className="swalvo-connection-test__detail"> {Math.round(report.signaling.durationMs)} ms</span>
                )}
              </dd>
              <dt>Media</dt>
              <dd>
                <Status status={report.media.status} />
              </dd>
              <dt>Route</dt>
              <dd>{routeLabel(report)}</dd>
              <dt>Relay (UDP / TCP / TLS)</dt>
              <dd className="swalvo-connection-test__turn">
                <Status status={report.turn.udp} /> <Status status={report.turn.tcp} />{' '}
                <Status status={report.turn.tls} />
              </dd>
              <dt>Round trip</dt>
              <dd>{fmt(report.network.rttMs, 'ms')}</dd>
              <dt>Jitter</dt>
              <dd>{fmt(report.network.jitterMs, 'ms')}</dd>
              <dt>Packet loss</dt>
              <dd>{fmt(report.network.packetLossPercent, '%', 1)}</dd>
              <dt>Upload</dt>
              <dd>{fmt(report.network.upstreamKbps, 'kbps')}</dd>
            </dl>
            {report.issues.length > 0 && (
              <ul className="swalvo-connection-test__issues">
                {report.issues.map((issue) => (
                  <li key={issue.code} data-severity={issue.severity}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
