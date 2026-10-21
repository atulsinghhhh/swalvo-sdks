import type { WebSocketLike } from '../../src/internal/socket-transport';

/**
 * A controllable stand-in for the browser's WebSocket.
 *
 * Lets tests drive open, close and message deterministically rather than
 * standing up a real server. It's what makes the reconnect and timeout
 * paths testable at all.
 */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  sent: Record<string, unknown>[] = [];
  closedWith?: { code?: number; reason?: string };

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  static get latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3; // CLOSED
  }

  /** Pretends the server accepted the upgrade. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Pretends a frame arrived from the server. */
  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Pretends the connection dropped. */
  serverClose(code = 1006, reason = 'abnormal'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The `connected` hello the real gateway sends first. */
  hello(overrides: Record<string, unknown> = {}): void {
    this.emit({
      type: 'connected',
      connectionId: 'ccn_test',
      userId: 'alice',
      scopes: ['chat:read', 'chat:send'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ...overrides,
    });
  }

  /** Acks the last frame that carried a correlation id. */
  ackLast(data: unknown = {}): void {
    const last = [...this.sent].reverse().find((frame) => typeof frame.id === 'string');
    this.emit({ type: 'ack', id: last?.id, ok: true, data });
  }

  lastFrameOfType(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((frame) => frame.type === type);
  }
}
