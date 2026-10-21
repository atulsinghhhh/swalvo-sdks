// Join a live stream as host or co-host, or as a viewer.
//
// Host, co-host and viewer credentials are minted per stream, per role, by
// your backend; pass them in as SwalvoLiveStreamCredentials.
import 'package:swalvo_live/swalvo_live.dart';

Future<SwalvoLiveStream> goLive(SwalvoLiveStreamCredentials credentials) async {
  final stream = await SwalvoLiveStream.join(credentials);

  if (stream.isHost) {
    await stream.room.enableCamera();
    await stream.room.enableMicrophone();
  }
  return stream;
}

void main() {
  // ignore: avoid_print
  print('Call goLive() with credentials minted by your backend.');
}
