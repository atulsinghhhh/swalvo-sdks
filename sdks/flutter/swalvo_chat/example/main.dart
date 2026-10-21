// Connect to a conversation, listen for messages and send one.
//
// The chat token is minted by your backend and is a separate credential from
// an RTC token. SwalvoChat extends ChangeNotifier, so a widget can also
// rebuild from it directly.
import 'package:swalvo_chat/swalvo_chat.dart';

Future<SwalvoChat> openChat({
  required String token,
  required String apiUrl,
  required String roomId,
}) async {
  final chat = SwalvoChat(token: token, apiUrl: apiUrl);

  await chat.connect(roomId);

  chat.messages.listen((message) {
    // ignore: avoid_print
    print('new message: $message');
  });

  await chat.send('Hello everyone!');
  return chat;
}

void main() {
  // ignore: avoid_print
  print('Call openChat() with a chat token minted by your backend.');
}
