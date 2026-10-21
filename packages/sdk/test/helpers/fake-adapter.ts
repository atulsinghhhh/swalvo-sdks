import { TypedEventEmitter } from '../../src/events';
import type {
  ConnectionQuality,
  DeviceInfo,
  DeviceKind,
  SFUAdapter,
  SFUAdapterEventMap,
  SdkConnectionState,
} from '../../src/internal/sfu/types';
import type { TrackKind } from '../../src/track';
import { LocalParticipant, RemoteParticipant } from '../../src/participant';
import type { LocalTrack, RemoteTrack } from '../../src/track';

/** In-memory SFUAdapter double, so Room/Client tests run with no browser or WebRTC stack. */
export class FakeAdapter extends TypedEventEmitter<SFUAdapterEventMap> implements SFUAdapter {
  connectionState: SdkConnectionState = 'disconnected';
  readonly localParticipant = new LocalParticipant('local-identity');
  readonly remoteParticipants = new Map<string, RemoteParticipant>();
  /** Test-only knob. Set it directly to drive `getConnectionQuality()`. */
  connectionQuality: ConnectionQuality = 'unknown';

  readonly connectCalls: Array<{ endpoint: string; token: string; iceServers?: RTCIceServer[] }> = [];
  disconnectCalls = 0;
  readonly enableCameraCalls: boolean[] = [];
  readonly enableMicrophoneCalls: boolean[] = [];
  readonly enableScreenShareCalls: boolean[] = [];
  readonly publishCalls: LocalTrack[] = [];
  readonly unpublishCalls: LocalTrack[] = [];
  readonly sendDataCalls: Uint8Array[] = [];
  readonly setDeviceCalls: Array<{ kind: string; deviceId: string }> = [];

  async connect(endpoint: string, token: string, iceServers?: RTCIceServer[]): Promise<void> {
    this.connectCalls.push({ endpoint, token, iceServers });
    this.setState('connected');
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.setState('disconnected');
  }

  /** Test-only: drives connectionStateChanged transitions directly. */
  setState(state: SdkConnectionState): void {
    this.connectionState = state;
    this.emit('connectionStateChanged', state);
  }

  /** Test-only: fakes a remote participant joining. */
  addRemoteParticipant(identity: string, metadata?: string): RemoteParticipant {
    const participant = new RemoteParticipant(identity, metadata);
    this.remoteParticipants.set(identity, participant);
    this.emit('participantJoined', participant);
    return participant;
  }

  /** Test-only: fakes a remote participant leaving. */
  removeRemoteParticipant(participant: RemoteParticipant): void {
    this.remoteParticipants.delete(participant.identity);
    this.emit('participantLeft', participant);
  }

  /** Test-only: fakes a track subscription. */
  /** Fires any adapter event, for events with no dedicated driver above. */
  fire<E extends keyof SFUAdapterEventMap>(event: E, ...args: Parameters<SFUAdapterEventMap[E]>): void {
    this.emit(event, ...args);
  }

  emitTrackSubscribed(track: RemoteTrack, participant: RemoteParticipant): void {
    this.emit('trackSubscribed', track, participant);
  }

  /** Test-only: fakes a remote participant muting or unmuting a track. */
  emitTrackMuted(kind: TrackKind, participant: RemoteParticipant): void {
    this.emit('trackMuted', kind, participant);
  }

  emitTrackUnmuted(kind: TrackKind, participant: RemoteParticipant): void {
    this.emit('trackUnmuted', kind, participant);
  }

  async enableCamera(enabled: boolean): Promise<LocalTrack | undefined> {
    this.enableCameraCalls.push(enabled);
    return undefined;
  }

  async enableMicrophone(enabled: boolean): Promise<LocalTrack | undefined> {
    this.enableMicrophoneCalls.push(enabled);
    return undefined;
  }

  async enableScreenShare(enabled: boolean): Promise<LocalTrack | undefined> {
    this.enableScreenShareCalls.push(enabled);
    return undefined;
  }

  async publish(track: LocalTrack): Promise<void> {
    this.publishCalls.push(track);
  }

  async unpublish(track: LocalTrack): Promise<void> {
    this.unpublishCalls.push(track);
  }

  async sendData(payload: Uint8Array): Promise<void> {
    this.sendDataCalls.push(payload);
  }

  ensureDataChannelCalls = 0;

  ensureDataChannel(): void {
    this.ensureDataChannelCalls++;
  }

  async getDevices(_kind?: DeviceKind): Promise<DeviceInfo[]> {
    return [];
  }

  async setDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    this.setDeviceCalls.push({ kind, deviceId });
  }

  getConnectionQuality(): ConnectionQuality {
    return this.connectionQuality;
  }
}
