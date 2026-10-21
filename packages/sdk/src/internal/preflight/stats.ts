/**
 * Reading a pre-call test's numbers out of `RTCStatsReport`s.
 *
 * Pure functions over plain report entries, so the arithmetic is tested
 * without a browser. Same rule as the rest of the SDK's stats (spec §19):
 * a figure the reports do not contain stays `undefined`. "No loss
 * measured" and "0 % loss" are different answers, and only one of them
 * is ever true.
 */

/** How the media connection actually reached the server. */
export interface ConnectionRoute {
  /**
   * The local candidate type of the selected pair: `host` (direct),
   * `srflx`/`prflx` (through NAT), or `relay` (through TURN).
   */
  candidateType?: 'host' | 'srflx' | 'prflx' | 'relay';
  /** True when media goes through a TURN relay. */
  usedRelay?: boolean;
  /** Transport between this device and the first hop (the SFU, or the TURN server). */
  protocol?: 'udp' | 'tcp';
  /** With a relay: how this device reaches the TURN server. `tls` is TURN over TLS (`turns:`). */
  relayProtocol?: 'udp' | 'tcp' | 'tls';
}

/** One sample of the numbers a pre-call test reports. */
export interface StatsSample {
  at: number;
  route: ConnectionRoute;
  /** Selected pair's current round-trip time, ms. */
  rttMs?: number;
  /** Worst jitter the server reported on what we send, ms. */
  jitterMs?: number;
  /** Totals, for deltas between samples. */
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
}

type Entry = Record<string, unknown> & { type?: string; id?: string };

function entriesOf(report: RTCStatsReport | Map<string, unknown>): Entry[] {
  const entries: Entry[] = [];
  (report as Map<string, unknown>).forEach((value) => {
    if (value && typeof value === 'object') entries.push(value as Entry);
  });
  return entries;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * The candidate pair the connection is using. The transport's
 * `selectedCandidatePairId` where the engine reports it (Chrome, Safari),
 * otherwise the nominated, succeeded pair (Firefox).
 */
function selectedPair(entries: Entry[]): Entry | undefined {
  const byId = new Map(entries.filter((entry) => typeof entry.id === 'string').map((entry) => [entry.id!, entry]));
  for (const entry of entries) {
    if (entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string') {
      const pair = byId.get(entry.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  return entries.find(
    (entry) =>
      entry.type === 'candidate-pair' &&
      entry.state === 'succeeded' &&
      (entry.nominated === true || entry.selected === true),
  );
}

export function routeFromReport(report: RTCStatsReport | Map<string, unknown>): ConnectionRoute {
  const entries = entriesOf(report);
  const pair = selectedPair(entries);
  if (!pair) return {};
  const local = entries.find((entry) => entry.id === pair.localCandidateId);
  if (!local) return {};

  const type = local.candidateType;
  const candidateType = type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay' ? type : undefined;
  const protocol = local.protocol === 'udp' || local.protocol === 'tcp' ? local.protocol : undefined;
  const relay = local.relayProtocol;
  const relayProtocol = relay === 'udp' || relay === 'tcp' || relay === 'tls' ? relay : undefined;

  return {
    candidateType,
    usedRelay: candidateType === undefined ? undefined : candidateType === 'relay',
    protocol,
    relayProtocol: candidateType === 'relay' ? relayProtocol : undefined,
  };
}

export function sampleFromReport(report: RTCStatsReport | Map<string, unknown>, at: number): StatsSample {
  const entries = entriesOf(report);
  const pair = selectedPair(entries);
  const rtt = num(pair?.currentRoundTripTime);

  let bytesSent: number | undefined;
  let packetsSent: number | undefined;
  for (const entry of entries) {
    if (entry.type !== 'outbound-rtp') continue;
    const bytes = num(entry.bytesSent);
    const packets = num(entry.packetsSent);
    if (bytes !== undefined) bytesSent = (bytesSent ?? 0) + bytes;
    if (packets !== undefined) packetsSent = (packetsSent ?? 0) + packets;
  }

  let jitter: number | undefined;
  let packetsLost: number | undefined;
  for (const entry of entries) {
    if (entry.type !== 'remote-inbound-rtp') continue;
    const j = num(entry.jitter);
    if (j !== undefined) jitter = Math.max(jitter ?? 0, j);
    const lost = num(entry.packetsLost);
    if (lost !== undefined) packetsLost = (packetsLost ?? 0) + Math.max(0, lost);
  }

  return {
    at,
    route: routeFromReport(report),
    rttMs: rtt === undefined ? undefined : rtt * 1000,
    jitterMs: jitter === undefined ? undefined : jitter * 1000,
    bytesSent,
    packetsSent,
    packetsLost,
  };
}

/** What a pre-call test reports about the network, from its samples. */
export interface NetworkSummary {
  /** Mean round-trip time to the first hop over the test, ms. */
  rttMs?: number;
  /** Worst jitter the server reported on what this device sent, ms. */
  jitterMs?: number;
  /** Packets the server reported lost, as a percentage of those sent during the test. */
  packetLossPercent?: number;
  /** Mean send rate over the test, kbit/s. Undefined when nothing was published. */
  upstreamKbps?: number;
}

export function summarize(samples: StatsSample[]): NetworkSummary {
  const rtts = samples.map((sample) => sample.rttMs).filter((value): value is number => value !== undefined);
  const jitters = samples.map((sample) => sample.jitterMs).filter((value): value is number => value !== undefined);

  const first = samples.find((sample) => sample.bytesSent !== undefined);
  const last = [...samples].reverse().find((sample) => sample.bytesSent !== undefined);
  let upstreamKbps: number | undefined;
  if (first && last && last.at > first.at) {
    upstreamKbps = ((last.bytesSent! - first.bytesSent!) * 8) / (last.at - first.at);
  }

  let packetLossPercent: number | undefined;
  const lossFirst = samples.find((sample) => sample.packetsSent !== undefined && sample.packetsLost !== undefined);
  const lossLast = [...samples]
    .reverse()
    .find((sample) => sample.packetsSent !== undefined && sample.packetsLost !== undefined);
  if (lossFirst && lossLast && lossLast !== lossFirst) {
    const sent = lossLast.packetsSent! - lossFirst.packetsSent!;
    const lost = lossLast.packetsLost! - lossFirst.packetsLost!;
    // `packetsSent` counts every packet put on the wire, lost ones included.
    if (sent > 0) packetLossPercent = Math.max(0, Math.min(100, (lost / sent) * 100));
  }

  return {
    rttMs: rtts.length > 0 ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : undefined,
    jitterMs: jitters.length > 0 ? Math.max(...jitters) : undefined,
    packetLossPercent,
    upstreamKbps,
  };
}

/** TURN URL families a pre-call test probes separately. */
export type TurnTransport = 'udp' | 'tcp' | 'tls';

/**
 * Groups the TURN URLs in an ICE server list by how they reach the TURN
 * server, keeping each URL's credentials. STUN URLs are dropped: they say
 * nothing about whether a relay works.
 */
export function turnServersByTransport(iceServers: RTCIceServer[]): Map<TurnTransport, RTCIceServer[]> {
  const groups = new Map<TurnTransport, RTCIceServer[]>();
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (typeof url !== 'string') continue;
      const lower = url.toLowerCase();
      let transport: TurnTransport | undefined;
      if (lower.startsWith('turns:')) transport = 'tls';
      else if (lower.startsWith('turn:')) transport = /[?&]transport=tcp\b/.test(lower) ? 'tcp' : 'udp';
      if (!transport) continue;
      const list = groups.get(transport) ?? [];
      list.push({ urls: url, username: server.username, credential: server.credential });
      groups.set(transport, list);
    }
  }
  return groups;
}
