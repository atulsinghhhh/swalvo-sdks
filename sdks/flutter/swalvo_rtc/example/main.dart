// Join a room, publish camera and microphone, and react to participants.
//
// The token, endpoint and ICE servers come from your own backend (see the
// server SDKs) — never mint them in the app. In a widget tree, render each
// remote participant with `SwalvoVideoView(participant: participant)`.
import 'package:swalvo_rtc/swalvo_rtc.dart';

Future<SwalvoRoom> joinCall({
  required String token,
  required String endpoint,
  required String roomId,
  List<SwalvoIceServer>? iceServers,
}) async {
  final swalvo = Swalvo(
    token: token,
    endpoint: endpoint,
    iceServers: iceServers,
  );

  final room = await swalvo.join(roomId);

  // SwalvoRoom is a ChangeNotifier: a ListenableBuilder rebuilds from it.
  room.addListener(() {
    // ignore: avoid_print
    print('room changed');
  });

  await room.enableCamera();
  await room.enableMicrophone();
  return room;
}

void main() {
  // ignore: avoid_print
  print('Call joinCall() with a grant minted by your backend.');
}
