import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_live/swalvo_live.dart';

void main() {
  group('swalvoLiveStreamRoleFromJson', () {
    test('parses every known role', () {
      expect(
          SwalvoLiveStreamCredentials.fromJson(_credentials(role: 'HOST')).role,
          SwalvoLiveStreamRole.host);
      expect(
          SwalvoLiveStreamCredentials.fromJson(_credentials(role: 'CO_HOST'))
              .role,
          SwalvoLiveStreamRole.coHost);
      expect(
          SwalvoLiveStreamCredentials.fromJson(_credentials(role: 'VIEWER'))
              .role,
          SwalvoLiveStreamRole.viewer);
    });

    test('throws on an unrecognised role rather than defaulting silently', () {
      expect(
        () => SwalvoLiveStreamCredentials.fromJson(_credentials(role: 'ADMIN')),
        throwsArgumentError,
      );
    });
  });

  group('SwalvoLiveStreamRoleX.isHost', () {
    test('is true for host and co-host, false for viewer', () {
      expect(SwalvoLiveStreamRole.host.isHost, isTrue);
      expect(SwalvoLiveStreamRole.coHost.isHost, isTrue);
      expect(SwalvoLiveStreamRole.viewer.isHost, isFalse);
    });
  });

  group('SwalvoLiveStreamCredentials.fromJson', () {
    test('parses RTC-only credentials with no chat attached', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'rtc': {'token': 'rtc-token', 'endpoint': 'wss://rtc.example.com'},
      });

      expect(credentials.streamId, 'stream_abc');
      expect(credentials.rtc!.token, 'rtc-token');
      expect(credentials.rtc!.endpoint, 'wss://rtc.example.com');
      expect(credentials.rtc!.iceServers, isNull);
      expect(credentials.chat, isNull);
      expect(credentials.chatRootMessageId, isNull);
    });

    test('parses ICE servers when present', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'HOST',
        'rtc': {
          'token': 'rtc-token',
          'endpoint': 'wss://rtc.example.com',
          'iceServers': [
            {'urls': 'stun:stun.example.com:19302'},
            {
              'urls': 'turn:turn.example.com:3478',
              'username': 'u',
              'credential': 'c',
            },
          ],
        },
      });

      expect(credentials.rtc!.iceServers, hasLength(2));
      expect(credentials.rtc!.iceServers!.last.username, 'u');
      expect(credentials.rtc!.iceServers!.last.credential, 'c');
    });

    test('parses chat credentials and chatRootMessageId when attached', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'HOST',
        'rtc': {'token': 'rtc-token', 'endpoint': 'wss://rtc.example.com'},
        'chat': {
          'token': 'chat-token',
          'apiUrl': 'https://api.example.com',
          'conversations': ['conv_1'],
        },
        'chatRootMessageId': 'msg_root',
      });

      expect(credentials.chat, isNotNull);
      expect(credentials.chat!.token, 'chat-token');
      expect(credentials.chat!.apiUrl, 'https://api.example.com');
      expect(credentials.chat!.conversations, ['conv_1']);
      expect(credentials.chatRootMessageId, 'msg_root');
    });

    test('defaults conversations to an empty list rather than throwing', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'rtc': {'token': 'rtc-token', 'endpoint': 'wss://rtc.example.com'},
        'chat': {'token': 'chat-token', 'apiUrl': 'https://api.example.com'},
      });

      expect(credentials.chat!.conversations, isEmpty);
    });
  });

  group('Live Streaming v2 fields', () {
    test('parses rtcRoom and identity for a cascaded viewer', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'identity': 'dave',
        'rtcRoom': 'stream_abc__e2',
        'rtc': {'token': 't', 'endpoint': 'wss://api/v1/rtc'},
      });
      expect(credentials.rtcRoom, 'stream_abc__e2');
      expect(credentials.identity, 'dave');
    });

    test('parses a BROADCAST playback credential with no rtc', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'playback': {
          'url': 'https://cdn/stream_abc/master.m3u8',
          'status': 'STARTING'
        },
      });
      expect(credentials.rtc, isNull);
      expect(credentials.playback!.url, 'https://cdn/stream_abc/master.m3u8');
      expect(credentials.playback!.status, 'STARTING');
    });

    test('parses the low-latency playback URL when present', () {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'playback': {
          'url': 'https://cdn/stream_abc/master.m3u8',
          'llhlsUrl': 'https://egress-1/llhls/stream_abc/master.m3u8',
          'status': 'READY',
          'beacon': {
            'url': 'https://api/v1/live-streams/playback/heartbeat',
            'token': 'tok',
            'intervalSec': 30
          },
        },
      });
      expect(credentials.playback!.llhlsUrl,
          'https://egress-1/llhls/stream_abc/master.m3u8');
      expect(credentials.playback!.beacon!.token, 'tok');
      expect(credentials.playback!.beacon!.intervalSec, 30);
    });

    test('refuses to join with neither rtc nor a playback url', () async {
      final credentials = SwalvoLiveStreamCredentials.fromJson({
        'streamId': 'stream_abc',
        'role': 'VIEWER',
        'playback': {'url': null, 'status': 'NOT_STARTED'},
      });
      expect(() => SwalvoLiveStream.join(credentials), throwsArgumentError);
    });
  });
}

Map<String, dynamic> _credentials({required String role}) => {
      'streamId': 'stream_abc',
      'role': role,
      'rtc': {'token': 'rtc-token', 'endpoint': 'wss://rtc.example.com'},
    };
