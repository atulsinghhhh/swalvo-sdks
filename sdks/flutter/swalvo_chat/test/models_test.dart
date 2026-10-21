import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';

void main() {
  group('SwalvoMessage.fromJson', () {
    test('parses a full message', () {
      final message = SwalvoMessage.fromJson({
        'id': 'msg_abc',
        'roomId': 'conv_1',
        'senderId': 'alice',
        'type': 'text',
        'text': 'Hello everyone!',
        'replyTo': 'msg_parent',
        'threadRootId': 'msg_root',
        'clientMessageId': 'client_1',
        'edited': true,
        'deleted': false,
        'createdAt': '2026-08-18T12:00:00.000Z',
        'editedAt': '2026-08-18T12:05:00.000Z',
        'reactions': [
          {
            'emoji': '👍',
            'count': 2,
            'userIds': ['bob', 'carol']
          },
        ],
      });

      expect(message.id, 'msg_abc');
      expect(message.senderId, 'alice');
      expect(message.type, SwalvoMessageType.text);
      expect(message.text, 'Hello everyone!');
      expect(message.replyTo, 'msg_parent');
      expect(message.threadRootId, 'msg_root');
      expect(message.edited, isTrue);
      expect(message.editedAt, isNotNull);
      expect(message.reactions.single.count, 2);
      expect(message.reactions.single.userIds, ['bob', 'carol']);
    });

    test('keeps a deleted message as a tombstone with no body', () {
      // The server withholds the body, not sending it with a flag,
      // so a client cannot recover deleted content from the payload.
      final message = SwalvoMessage.fromJson({
        'id': 'msg_gone',
        'senderId': 'alice',
        'type': 'text',
        'text': null,
        'deleted': true,
        'createdAt': '2026-08-18T12:00:00.000Z',
        'deletedAt': '2026-08-18T12:10:00.000Z',
      });

      expect(message.deleted, isTrue);
      expect(message.text, isNull);
      expect(message.deletedAt, isNotNull);
    });

    test('maps an unrecognised type to unknown rather than throwing', () {
      // A server that starts sending a new message type must not break an
      // app the developer never changed.
      final message = SwalvoMessage.fromJson({
        'id': 'msg_future',
        'senderId': 'system',
        'type': 'poll',
        'createdAt': '2026-08-18T12:00:00.000Z',
      });

      expect(message.type, SwalvoMessageType.unknown);
    });

    test('tolerates absent optional fields', () {
      final message = SwalvoMessage.fromJson({
        'id': 'msg_bare',
        'senderId': 'alice',
        'type': 'text',
        'createdAt': '2026-08-18T12:00:00.000Z',
      });

      expect(message.reactions, isEmpty);
      expect(message.replyTo, isNull);
      expect(message.attachment, isNull);
      expect(message.edited, isFalse);
    });

    test('compares by id, so a re-fetched copy is the same message', () {
      Map<String, dynamic> json(String text) => {
            'id': 'msg_same',
            'senderId': 'alice',
            'type': 'text',
            'text': text,
            'createdAt': '2026-08-18T12:00:00.000Z',
          };

      expect(SwalvoMessage.fromJson(json('a')),
          equals(SwalvoMessage.fromJson(json('b'))));
    });
  });

  group('copyWith', () {
    test('folds an edit in without rebuilding the message', () {
      final original = SwalvoMessage.fromJson({
        'id': 'msg_1',
        'senderId': 'alice',
        'type': 'text',
        'text': 'Original',
        'createdAt': '2026-08-18T12:00:00.000Z',
      });

      final edited = original.copyWith(text: 'Updated', edited: true);

      expect(edited.text, 'Updated');
      expect(edited.edited, isTrue);
      // Identity and ordering must survive an edit, or the message jumps
      // position in the list.
      expect(edited.id, original.id);
      expect(edited.createdAt, original.createdAt);
    });
  });

  group('SwalvoMessagePage', () {
    test('parses cursors so pagination can continue', () {
      final page = SwalvoMessagePage.fromJson({
        'data': [
          {
            'id': 'msg_1',
            'senderId': 'alice',
            'type': 'text',
            'createdAt': '2026-08-18T12:00:00.000Z',
          },
        ],
        'nextCursor': 'CURSOR_BACK',
        'previousCursor': 'CURSOR_FORWARD',
        'hasMore': true,
      });

      expect(page.messages, hasLength(1));
      expect(page.nextCursor, 'CURSOR_BACK');
      expect(page.previousCursor, 'CURSOR_FORWARD');
      expect(page.hasMore, isTrue);
    });

    test('handles an empty page at the end of history', () {
      final page = SwalvoMessagePage.fromJson({'data': <dynamic>[]});

      expect(page.messages, isEmpty);
      expect(page.nextCursor, isNull);
      expect(page.hasMore, isFalse);
    });
  });

  group('SwalvoPresence', () {
    test('parses known statuses', () {
      expect(
        SwalvoPresence.fromJson({'userId': 'bob', 'status': 'online'}).status,
        SwalvoPresenceStatus.online,
      );
      expect(
        SwalvoPresence.fromJson({'userId': 'bob', 'status': 'away'}).status,
        SwalvoPresenceStatus.away,
      );
    });

    test('falls back to offline for anything it does not recognise', () {
      expect(
        SwalvoPresence.fromJson({'userId': 'bob', 'status': 'astral'}).status,
        SwalvoPresenceStatus.offline,
      );
    });
  });
}
