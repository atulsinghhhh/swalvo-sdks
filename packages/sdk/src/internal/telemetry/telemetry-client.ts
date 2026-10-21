import type { Logger } from '../../logger';
import { generateConnectionId } from './connection-id';
import { detectPlatform } from './platform';

export interface TelemetryClient {
  readonly connectionId: string;
  /**
   * Fire and forget. Never hands back a promise anyone is meant to await,
   * never throws. See docs/telemetry.md#reliability and Phase 9 spec §11:
   * "RTC must continue working even if telemetry fails."
   */
  send(type: string, data?: Record<string, unknown>): void;
}

export interface TelemetryClientOptions {
  enabled: boolean;
  telemetryUrl?: string;
  token: string;
  sdkVersion: string;
  logger: Logger;
}

/**
 * Builds a real HTTP telemetry client when telemetry is on and a
 * `telemetryUrl` was supplied, and a no-op one otherwise. Callers never
 * have to branch on whether telemetry is active; they just call `send()`
 * and get on with it.
 *
 * `connectionId` is real and stable either way, since it doubles as the
 * SDK's public `room.connectionId` whether telemetry is enabled or not.
 */
export function createTelemetryClient(options: TelemetryClientOptions): TelemetryClient {
  const connectionId = generateConnectionId();

  if (!options.enabled || !options.telemetryUrl) {
    return { connectionId, send: () => {} };
  }

  return new HttpTelemetryClient(connectionId, options);
}

class HttpTelemetryClient implements TelemetryClient {
  constructor(
    readonly connectionId: string,
    private readonly options: TelemetryClientOptions,
  ) {}

  send(type: string, data: Record<string, unknown> = {}): void {
    const body = {
      connectionId: this.connectionId,
      type,
      data: { sdkVersion: this.options.sdkVersion, ...detectPlatform(), ...data },
    };

    try {
      // Nobody awaits this, on purpose, and every failure mode gets
      // swallowed right here: network error, non-2xx, telemetryUrl
      // unreachable, the lot. A telemetry outage must never show up as an
      // RTC error.
      //
      // `keepalive: true` gives it a fighting chance of completing through
      // a page unload or tab close, which is where that final
      // "disconnected" event lands. Same problem `navigator.sendBeacon`
      // solves, except beacon is no use to us: it can't carry the
      // Authorization header this endpoint wants.
      fetch(`${this.options.telemetryUrl}/v1/telemetry/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify(body),
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) {
            this.options.logger.debug('telemetry event rejected', type, res.status);
          }
        })
        .catch((error) => {
          this.options.logger.debug('telemetry event failed', type, (error as Error).message);
        });
    } catch (error) {
      this.options.logger.debug('telemetry send threw synchronously', type, (error as Error).message);
    }
  }
}
