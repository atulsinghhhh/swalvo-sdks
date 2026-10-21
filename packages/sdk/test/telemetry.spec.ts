import { createLogger } from '../src/logger';
import { generateConnectionId } from '../src/internal/telemetry/connection-id';
import { detectPlatform } from '../src/internal/telemetry/platform';
import { createTelemetryClient } from '../src/internal/telemetry/telemetry-client';

const logger = createLogger('silent');

describe('generateConnectionId', () => {
  it('always starts with the conn_ prefix', () => {
    expect(generateConnectionId()).toMatch(/^conn_[a-f0-9]+$/i);
  });

  it('is different on every call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateConnectionId()));
    expect(ids.size).toBe(20);
  });
});

describe('detectPlatform', () => {
  it('never throws and returns a value even without a recognizable user agent', () => {
    expect(() => detectPlatform()).not.toThrow();
    const { platform, browser } = detectPlatform();
    expect(typeof platform).toBe('string');
    expect(typeof browser).toBe('string');
  });

  it('recognizes Chrome on desktop from its user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      configurable: true,
    });

    expect(detectPlatform()).toEqual({ platform: 'web', browser: 'chrome' });
  });

  it('recognizes Firefox on Android as a distinct platform/browser pair', () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Android 13; Mobile) Firefox/121.0',
      configurable: true,
    });

    expect(detectPlatform()).toEqual({ platform: 'android', browser: 'firefox' });
  });
});

describe('createTelemetryClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('always returns a real, stable connectionId — even when telemetry is disabled', () => {
    const client = createTelemetryClient({ enabled: false, token: 't', sdkVersion: '0.1.0', logger });
    expect(client.connectionId).toMatch(/^conn_/);
  });

  it('never calls fetch when telemetry is disabled', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = createTelemetryClient({
      enabled: false,
      telemetryUrl: 'http://api.test',
      token: 't',
      sdkVersion: '0.1.0',
      logger,
    });
    client.send('connection_started');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never calls fetch when no telemetryUrl is configured, even if enabled', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = createTelemetryClient({ enabled: true, token: 't', sdkVersion: '0.1.0', logger });
    client.send('connection_started');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to <telemetryUrl>/v1/telemetry/events with a bearer token and the event body', () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = createTelemetryClient({
      enabled: true,
      telemetryUrl: 'http://api.test',
      token: 'rtc-jwt',
      sdkVersion: '0.1.0',
      logger,
    });
    client.send('connected', { foo: 'bar' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/v1/telemetry/events');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer rtc-jwt');
    expect(options.keepalive).toBe(true);

    const body = JSON.parse(options.body);
    expect(body.connectionId).toBe(client.connectionId);
    expect(body.type).toBe('connected');
    expect(body.data.foo).toBe('bar');
    expect(body.data.sdkVersion).toBe('0.1.0');
  });

  it('never throws, and never returns a rejected promise the caller must handle, when fetch rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const client = createTelemetryClient({
      enabled: true,
      telemetryUrl: 'http://api.test',
      token: 't',
      sdkVersion: '0.1.0',
      logger,
    });

    expect(() => client.send('connection_started')).not.toThrow();
    // Let the swallowed microtask run without ever surfacing.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('never throws even if fetch itself throws synchronously', () => {
    global.fetch = jest.fn(() => {
      throw new Error('synchronous network failure');
    }) as unknown as typeof fetch;

    const client = createTelemetryClient({
      enabled: true,
      telemetryUrl: 'http://api.test',
      token: 't',
      sdkVersion: '0.1.0',
      logger,
    });

    expect(() => client.send('connection_started')).not.toThrow();
  });
});
