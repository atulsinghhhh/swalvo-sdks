// ignore_for_file: deprecated_member_use, deprecated_member_use_from_same_package
import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_live/swalvo_live.dart';

/// The pre-rename `Raven*` names (raven_live) must stay usable, and must be
/// the very same types, until they are removed in 1.0.
void main() {
  test('every deprecated Raven* alias is the same type as its Swalvo* name',
      () {
    expect(
        identical(RavenLivePlayer, SwalvoLivePlayer) ||
            RavenLivePlayer == SwalvoLivePlayer,
        isTrue);
    expect(
        identical(RavenLiveStageEvent, SwalvoLiveStageEvent) ||
            RavenLiveStageEvent == SwalvoLiveStageEvent,
        isTrue);
    expect(
        identical(RavenLiveStream, SwalvoLiveStream) ||
            RavenLiveStream == SwalvoLiveStream,
        isTrue);
    expect(
        identical(RavenLiveStreamChatCredentials,
                SwalvoLiveStreamChatCredentials) ||
            RavenLiveStreamChatCredentials == SwalvoLiveStreamChatCredentials,
        isTrue);
    expect(
        identical(RavenLiveStreamCredentials, SwalvoLiveStreamCredentials) ||
            RavenLiveStreamCredentials == SwalvoLiveStreamCredentials,
        isTrue);
    expect(
        identical(RavenLiveStreamPlayback, SwalvoLiveStreamPlayback) ||
            RavenLiveStreamPlayback == SwalvoLiveStreamPlayback,
        isTrue);
    expect(
        identical(RavenLiveStreamRole, SwalvoLiveStreamRole) ||
            RavenLiveStreamRole == SwalvoLiveStreamRole,
        isTrue);
    expect(
        identical(RavenLiveStreamRtcCredentials,
                SwalvoLiveStreamRtcCredentials) ||
            RavenLiveStreamRtcCredentials == SwalvoLiveStreamRtcCredentials,
        isTrue);
    // Re-exported from swalvo_rtc/swalvo_chat, not redeclared.
    expect(RavenRoom, SwalvoRoom);
    expect(RavenChat, SwalvoChat);
  });
}
