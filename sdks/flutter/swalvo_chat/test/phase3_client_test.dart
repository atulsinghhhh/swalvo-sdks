import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:swalvo_chat/swalvo_chat.dart';

import 'helpers/harness.dart';

/// Phase 3 behaviour of [SwalvoChat] against a fake socket and a fake REST
/// API: recovery, the outbox, the inbox, moderation, push and the rest.
void main() {
  late Harness h;

  tearDown(() => h.dispose());

  group('catch-up recovery after a reconnect', () {
    test('replays a missed message exactly once, from the resume point',
        () async {
      h = Harness();
      await h.connect();
      final seen = <String>[];
      h.chat.messages.listen((message) => seen.add(message.id));

      h.socket.receive({'type': 'message', 'message': messageJson(1)});
      await pump();
      expect(seen, ['msg_0001']);

      h.api.json('GET /v1/chat/conversations/conv_1/messages', {
        'data': [messageJson(2)],
        'previousCursor': 'cur_2',
        'hasMore': false,
      });
      final summary = h.chat.recovered.first;
      await h.reconnect();
      final result = await summary;

      expect(result.recovered, 1);
      expect(seen, ['msg_0001', 'msg_0002']);
      final request = h.api
          .matching('GET', '/v1/chat/conversations/conv_1/messages')
          .single;
      expect(request.url.queryParameters['after'], 'cur_1');

      // The same message arriving live afterwards is not delivered again.
      h.socket.receive({'type': 'message', 'message': messageJson(2)});
      await pump();
      expect(seen, hasLength(2));
    });

    test('catches up edits, deletes and reactions from the event log',
        () async {
      h = Harness();
      await h.connect();
      final reactions = <String>[];
      final deletions = <String>[];
      h.chat.reactions.listen((event) => reactions.add(event.emoji));
      h.chat.messageDeletions.listen(deletions.add);

      h.socket.receive({
        'type': 'reaction.added',
        'eventSeq': '7',
        'roomId': 'conv_1',
        'messageId': 'msg_1',
        'userId': 'bob',
        'emoji': '👍',
      });
      await pump();

      h.api.json('GET /v1/chat/conversations/conv_1/events', {
        'events': [
          {
            'eventSeq': '8',
            'type': 'message.deleted',
            'payload': {'roomId': 'conv_1', 'messageId': 'msg_1'},
          },
          {
            'eventSeq': '9',
            'type': 'reaction.added',
            'payload': {
              'roomId': 'conv_1',
              'messageId': 'msg_2',
              'userId': 'carol',
              'emoji': '🎉',
            },
          },
        ],
        'hasMore': false,
      });
      final summary = h.chat.recovered.first;
      await h.reconnect();
      final result = await summary;

      expect(result.events, 2);
      expect(deletions, ['msg_1']);
      expect(reactions, ['👍', '🎉']);
      expect(
        h.api
            .matching('GET', '/v1/chat/conversations/conv_1/events')
            .single
            .url
            .queryParameters['afterEventSeq'],
        '7',
      );
    });

    test('EVENTS_EXPIRED re-reads history and emits a resync', () async {
      h = Harness();
      await h.connect();
      h.socket.receive({
        'type': 'message',
        'eventSeq': '3',
        'message': messageJson(3),
      });
      await pump();

      h.api.json(
        'GET /v1/chat/conversations/conv_1/events',
        {
          'code': 'RAVEN_EVENTS_EXPIRED',
          'legacyCode': 'EVENTS_EXPIRED',
          'message': 'gone'
        },
        status: 410,
      );
      h.api.json('GET /v1/chat/conversations/conv_1/messages', {
        'data': [messageJson(3)],
        'hasMore': false,
      });
      final resync = h.chat.resyncs.first;
      final summary = h.chat.recovered.first;
      await h.reconnect();

      final event = await resync;
      expect(event.roomId, 'conv_1');
      expect(event.page.messages.single.id, 'msg_0003');
      final result = await summary;
      expect(result.resynced, ['conv_1']);
      expect(result.gap, isTrue);
    });

    test('a live gap is backfilled without waiting for a reconnect', () async {
      h = Harness();
      await h.connect();
      final emojis = <String>[];
      h.chat.reactions.listen((event) => emojis.add(event.emoji));
      Map<String, dynamic> reaction(int seq, String emoji) => {
            'type': 'reaction.added',
            'eventSeq': '$seq',
            'roomId': 'conv_1',
            'messageId': 'msg_1',
            'userId': 'bob',
            'emoji': emoji,
          };
      h.api.json('GET /v1/chat/conversations/conv_1/events', {
        'events': [
          {
            'eventSeq': '2',
            'type': 'reaction.added',
            'payload': reaction(2, 'b')
          },
        ],
        'hasMore': false,
      });

      h.socket.receive(reaction(1, 'a'));
      h.socket.receive(reaction(3, 'c'));
      await pump();
      expect(emojis, ['a']);

      await waitFor(() => emojis.length == 3);
      expect(emojis, ['a', 'b', 'c']);
    });
  });

  group('outbox', () {
    test(
        'a send the connection drops is re-sent on reconnect with the same key',
        () async {
      h = Harness();
      await h.connect();

      final sending = h.chat.send('hello');
      final key = h.socket.ofType('message.send').single['clientMessageId'];
      h.socket.drop(1006);

      await expectLater(
        sending,
        throwsA(isA<SwalvoChatException>()
            .having((e) => e.queued, 'queued', isTrue)
            .having((e) => e.clientMessageId, 'clientMessageId', key)),
      );
      expect(h.chat.outbox.entries().single.status, SwalvoOutboxStatus.pending);

      await waitFor(() =>
          h.sockets.length == 2 && h.socket.ofType('room.join').isNotEmpty);
      h.ackJoins(h.socket);
      await waitFor(() => h.socket.ofType('message.send').isNotEmpty);
      expect(h.socket.ofType('message.send').single['clientMessageId'], key);

      h.ack('message.send', {
        'message':
            messageJson(1, sender: 'alice', clientMessageId: key as String),
        'deduplicated': true,
      });
      await waitFor(() => h.chat.outbox.entries().isEmpty);
    });

    test('a send made offline is queued and flushed on the next connect',
        () async {
      h = Harness();
      await h.connect();
      await h.chat.disconnect();
      h.api.offline = true;

      await expectLater(
        h.chat.send('typed offline', room: 'conv_1'),
        throwsA(isA<SwalvoChatException>()
            .having((e) => e.queued, 'queued', isTrue)),
      );
      expect(h.chat.outbox.entries(), hasLength(1));

      h.api.offline = false;
      final connecting = h.chat.connect('conv_1');
      await waitFor(() =>
          h.sockets.length == 2 && h.socket.ofType('room.join').isNotEmpty);
      h.ackJoins(h.socket);
      await connecting;
      await waitFor(() => h.socket.ofType('message.send').isNotEmpty);
      expect(h.socket.ofType('message.send').single['text'], 'typed offline');
    });

    test('a refused send is failed, not retried, until retry() is called',
        () async {
      h = Harness();
      await h.connect();

      final sending = h.chat.send('spam');
      h.reject('message.send', 'MUTED');
      await expectLater(
        sending,
        throwsA(isA<SwalvoChatException>()
            .having((e) => e.code, 'code', SwalvoChatErrorCode.muted)
            .having((e) => e.queued, 'queued', isFalse)),
      );
      final entry = h.chat.outbox.entries().single;
      expect(entry.status, SwalvoOutboxStatus.failed);
      expect(entry.errorCode, 'MUTED');
      expect(h.chat.myModerationState('conv_1').muted, isTrue);

      final retrying = h.chat.outbox.retry(entry.clientMessageId);
      await pump();
      final frames = h.socket.ofType('message.send').toList();
      expect(frames, hasLength(2));
      expect(frames.last['clientMessageId'], entry.clientMessageId);
      h.ack('message.send', {'message': messageJson(5, sender: 'alice')});
      expect((await retrying).id, 'msg_0005');
      expect(h.chat.outbox.entries(), isEmpty);
    });

    test('cancel() drops a failed entry so it never goes out', () async {
      h = Harness();
      await h.connect();
      final sending = h.chat.send('x');
      h.reject('message.send', 'SLOW_MODE', extra: {'retryAfterSeconds': 9});
      await expectLater(
        sending,
        throwsA(isA<SwalvoChatException>()
            .having((e) => e.code, 'code', SwalvoChatErrorCode.slowMode)
            .having((e) => e.retryAfterSeconds, 'retryAfter', 9)),
      );
      final id = h.chat.outbox.entries().single.clientMessageId;
      expect(await h.chat.outbox.cancel(id), isTrue);
      expect(h.chat.outbox.entries(), isEmpty);
      expect(await h.chat.outbox.cancel(id), isFalse);
    });

    test('persists through a storage adapter and resumes in a new session',
        () async {
      final storage = _RecordingStorage();
      h = Harness(storage: storage);
      await h.connect();
      await h.chat.disconnect();
      h.api.offline = true;
      await expectLater(h.chat.send('survives', room: 'conv_1'),
          throwsA(isA<SwalvoChatException>()));
      await h.chat.outbox.ready();
      await pump();
      expect(storage.saved.single.text, 'survives');
      expect(jsonEncode(storage.saved.single.toJson()),
          contains('"status":"pending"'));
      h.dispose();

      // A fresh client on the same storage: the entry comes back and goes
      // out on connect.
      h = Harness(storage: storage);
      await h.connect();
      await waitFor(() => h.socket.ofType('message.send').isNotEmpty);
      expect(h.socket.ofType('message.send').single['text'], 'survives');
    });
  });

  group('inbox', () {
    void routeInbox(Harness harness) {
      harness.api.json('GET /v1/chat/me/conversations', {
        'conversations': [
          {
            'id': 'conv_1',
            'name': 'General',
            'type': 'CHANNEL',
            'role': 'MEMBER',
            'muted': false,
            'lastMessage': {
              'id': 'msg_0041',
              'seq': '41',
              'senderId': 'bob',
              'content': 'm41',
              'type': 'TEXT',
              'createdAt': '2026-01-01T00:00:00.041Z',
            },
            'unreadCount': 3,
            'lastReadSeq': '38',
            'updatedAt': '2026-01-01T00:00:00.041Z',
          },
          {
            'id': 'conv_2',
            'type': 'DIRECT',
            'unreadCount': 1,
            'updatedAt': '2025-12-31T00:00:00.000Z',
          },
        ],
        'nextCursor': null,
      });
    }

    test('counts live messages once, and own messages clear the count',
        () async {
      h = Harness();
      routeInbox(h);
      await h.connect();
      await h.chat.inbox.load(watch: false);
      expect(h.chat.inbox.totalUnread, 4);

      // Already counted by the server (seq 41): no change.
      h.socket.receive({'type': 'message', 'message': messageJson(41)});
      await pump();
      expect(h.chat.inbox.conversations.first.unreadCount, 3);

      h.socket.receive({
        'type': 'message',
        'message': messageJson(42, mentions: ['alice']),
      });
      await pump();
      final row = h.chat.inbox.conversations.first;
      expect(row.unreadCount, 4);
      expect(row.unreadMentions, 1);
      expect(row.lastMessage!.seq, '42');

      h.socket.receive(
          {'type': 'message', 'message': messageJson(43, sender: 'alice')});
      await pump();
      expect(h.chat.inbox.conversations.first.unreadCount, 0);
    });

    test('a read mark from this user clears the row', () async {
      h = Harness();
      routeInbox(h);
      await h.connect();
      await h.chat.inbox.load(watch: false);
      h.socket.receive({
        'type': 'read',
        'roomId': 'conv_1',
        'userId': 'alice',
        'messageId': 'msg_0041',
      });
      await pump();
      expect(h.chat.inbox.conversations.first.unreadCount, 0);
    });

    test('muting a conversation updates the row and the badge', () async {
      h = Harness();
      routeInbox(h);
      h.api.json('PATCH /v1/chat/me/conversations/conv_1', {'muted': true});
      await h.connect();
      await h.chat.inbox.load(watch: false);

      final prefs = await h.chat.muteConversation('conv_1');
      expect(prefs.muted, isTrue);
      expect(prefs.notifications, SwalvoNotificationLevel.none);
      expect(h.chat.inbox.totalUnread, 1);
      final body = jsonDecode(h.api
          .matching('PATCH', '/v1/chat/me/conversations/conv_1')
          .single
          .body);
      expect(body, {'muted': true});
    });

    test('watching joins the listed conversations', () async {
      h = Harness();
      routeInbox(h);
      await h.connect();
      final loading = h.chat.inbox.load(watchLimit: 5);
      await waitFor(() => h.socket
          .ofType('room.join')
          .any((frame) => frame['room'] == 'conv_2'));
      h.ackJoins(h.socket);
      await loading;
      // conv_1 was already joined by connect(), so only conv_2 was added.
      expect(h.socket.ofType('room.join').where((f) => f['room'] == 'conv_1'),
          hasLength(1));
      expect(h.chat.rooms, containsAll(['conv_1', 'conv_2']));
    });
  });

  group('moderation', () {
    test('member.* events surface and track this user\'s own state', () async {
      h = Harness();
      await h.connect();
      final events = <SwalvoMemberModerationEvent>[];
      h.chat.memberModeration.listen(events.add);

      h.socket.receive({
        'type': 'member.muted',
        'room': 'conv_1',
        'userId': 'alice',
        'by': 'mod',
        'expiresAt':
            DateTime.now().add(const Duration(hours: 1)).toIso8601String(),
      });
      await pump();
      expect(events.single.kind, SwalvoModerationKind.muted);
      expect(events.single.by, 'mod');
      expect(h.chat.myModerationState('conv_1').muted, isTrue);

      h.socket.receive(
          {'type': 'member.unmuted', 'room': 'conv_1', 'userId': 'alice'});
      await pump();
      expect(h.chat.myModerationState('conv_1').muted, isFalse);
    });

    test('an unsolicited room.left BANNED removes the room for good', () async {
      h = Harness();
      await h.connect();
      final removed = h.chat.removedFromRoom.first;
      h.socket
          .receive({'type': 'room.left', 'room': 'conv_1', 'reason': 'BANNED'});
      final event = await removed;
      expect(event.reason, 'BANNED');
      expect(h.chat.rooms, isEmpty);
      expect(h.chat.myModerationState('conv_1').banned, isTrue);
    });

    test('an uncorrelated NOT_A_MEMBER naming the room is a removal', () async {
      h = Harness();
      await h.connect();
      final removed = h.chat.removedFromRoom.first;
      h.socket.receive({
        'type': 'error',
        'code': 'NOT_A_MEMBER',
        'message': 'removed',
        'room': 'conv_1',
      });
      expect((await removed).reason, 'REMOVED');
    });

    test('moderator actions go over the socket and await the ack', () async {
      h = Harness();
      await h.connect();
      final banning =
          h.chat.ban('bob', duration: const Duration(hours: 1), reason: 'spam');
      final frame = h.socket.ofType('moderation.ban').single;
      expect(frame, containsPair('userId', 'bob'));
      expect(frame, containsPair('room', 'conv_1'));
      expect(frame, containsPair('durationSeconds', 3600));
      expect(frame, containsPair('reason', 'spam'));
      h.ack('moderation.ban');
      await banning;

      final muting = h.chat.mute('bob');
      expect(
          h.socket
              .ofType('moderation.mute')
              .single
              .containsKey('durationSeconds'),
          isFalse);
      h.ack('moderation.mute');
      await muting;
    });

    test('blocks and flags use the client routes', () async {
      h = Harness();
      h.api.routes['POST /v1/chat/me/blocks/bob'] =
          (_) => http.Response('', 204);
      h.api.json('GET /v1/chat/me/blocks', {
        'blocks': [
          {'userId': 'bob', 'createdAt': '2026-01-01T00:00:00.000Z'}
        ]
      });
      h.api.json('POST /v1/chat/messages/msg_1/flags',
          {'id': 'flag_1', 'status': 'OPEN'});

      await h.chat.block('bob');
      expect((await h.chat.listBlocks()).single.userId, 'bob');
      await h.chat.flagMessage('msg_1', SwalvoFlagReason.spam, note: 'ads');
      final body = jsonDecode(
          h.api.matching('POST', '/v1/chat/messages/msg_1/flags').single.body);
      expect(body, {'reason': 'spam', 'note': 'ads'});
    });

    test('REST errors map by the chat code, not the canonical one', () {
      final error = SwalvoChatException.fromServer({
        'code': 'RAVEN_RATE_LIMITED',
        'legacyCode': 'RATE_LIMITED',
        'message': 'slow',
        'scope': 'conversation',
      });
      expect(error.code, SwalvoChatErrorCode.rateLimited);
      expect(error.scope, 'conversation');

      final blocked = SwalvoChatException.fromServer(
          {'code': 'MESSAGE_BLOCKED', 'message': 'no', 'reason': 'profanity'});
      expect(blocked.code, SwalvoChatErrorCode.messageBlocked);
      expect(blocked.reason, 'profanity');

      expect(SwalvoChatException.fromServer({'code': 'RAVEN_BANNED'}).code,
          SwalvoChatErrorCode.banned);
    });
  });

  group('push', () {
    test('register, list and unregister devices', () async {
      h = Harness();
      h.api.json('POST /v1/chat/me/devices', {
        'provider': 'apns',
        'token': 'tok',
        'platform': 'ios',
        'appBundleId': 'com.example',
      });
      h.api.json('GET /v1/chat/me/devices', [
        {'provider': 'fcm', 'token': 'tok2', 'platform': 'android'}
      ]);
      h.api.routes['DELETE /v1/chat/me/devices/tok'] =
          (_) => http.Response('', 204);

      final device = await h.chat.registerDevice(
        provider: SwalvoPushProvider.apns,
        token: 'tok',
        platform: SwalvoDevicePlatform.ios,
        appBundleId: 'com.example',
      );
      expect(device.platform, SwalvoDevicePlatform.ios);
      expect(
        jsonDecode(h.api.matching('POST', '/v1/chat/me/devices').single.body),
        {
          'provider': 'apns',
          'token': 'tok',
          'platform': 'ios',
          'appBundleId': 'com.example'
        },
      );
      expect(
          (await h.chat.listDevices()).single.provider, SwalvoPushProvider.fcm);
      await h.chat.unregisterDevice('tok');
      expect(h.api.matching('DELETE', '/v1/chat/me/devices/tok'), hasLength(1));
    });

    test('notification level is a PATCH on the membership', () async {
      h = Harness();
      h.api.json('PATCH /v1/chat/me/conversations/conv_1',
          {'roomId': 'conv_1', 'notifications': 'mentions', 'muted': false});
      final prefs = await h.chat
          .setNotificationLevel('conv_1', SwalvoNotificationLevel.mentions);
      expect(prefs.notifications, SwalvoNotificationLevel.mentions);
      expect(
          jsonDecode(h.api
              .matching('PATCH', '/v1/chat/me/conversations/conv_1')
              .single
              .body),
          {'notifications': 'mentions'});
    });
  });

  group('messages: mentions, pins, search, threads, link previews', () {
    test('mentions ride the send frame, and more than 50 is refused', () async {
      h = Harness();
      await h.connect();
      unawaited(h.chat.send('hi @bob', mentions: ['bob']).catchError(
          (Object _) => SwalvoMessage.fromJson(messageJson(0))));
      expect(h.socket.ofType('message.send').single['mentions'], ['bob']);

      await expectLater(
        h.chat.send('too many', mentions: List.generate(51, (i) => 'u$i')),
        throwsA(isA<SwalvoChatException>()
            .having((e) => e.code, 'code', SwalvoChatErrorCode.invalidMessage)),
      );
    });

    test('pins: routes and live events', () async {
      h = Harness();
      h.api.routes['POST /v1/chat/messages/msg_1/pin'] =
          (_) => http.Response('', 204);
      h.api.json('GET /v1/chat/conversations/conv_1/pins', {
        'data': [
          {'message': messageJson(1), 'pinnedBy': 'mod'}
        ]
      });
      await h.connect();

      await h.chat.pin('msg_1');
      expect((await h.chat.listPins()).single.id, 'msg_0001');

      final pinned = h.chat.pins.first;
      h.socket.receive({
        'type': 'message.pinned',
        'roomId': 'conv_1',
        'messageId': 'msg_1',
        'by': 'mod',
      });
      final event = await pinned;
      expect(event.pinned, isTrue);
      expect(event.by, 'mod');
    });

    test('search passes q and returns a cursor page', () async {
      h = Harness();
      h.api.json('GET /v1/chat/conversations/conv_1/search', {
        'data': [messageJson(9)],
        'nextCursor': 'next'
      });
      final page = await h.chat.search('deploy', room: 'conv_1', limit: 10);
      expect(page.items.single.id, 'msg_0009');
      expect(page.nextCursor, 'next');
      expect(page.hasMore, isTrue);
      final url = h.api.requests.single.url;
      expect(url.queryParameters['q'], 'deploy');
      expect(url.queryParameters['limit'], '10');
    });

    test('threads are paginated, and a bare array still works', () async {
      h = Harness();
      h.api.json('GET /v1/chat/messages/msg_root/thread', {
        'data': [messageJson(1), messageJson(2)],
        'nextCursor': 'c2'
      });
      final page = await h.chat.threadPage('msg_root', limit: 2);
      expect(page.items, hasLength(2));
      expect(page.nextCursor, 'c2');

      h.api.json('GET /v1/chat/messages/msg_old/thread', [messageJson(3)]);
      expect((await h.chat.thread('msg_old')).single.id, 'msg_0003');
    });

    test('link previews and replyCount are surfaced on the message', () async {
      h = Harness();
      await h.connect();
      final update = h.chat.messageUpdateEvents.first;
      h.socket.receive({
        'type': 'message.updated',
        'reason': 'link_preview',
        'message': {
          ...messageJson(1, metadata: {
            'linkPreview': {'url': 'https://x.test', 'title': 'X'}
          }),
          'replyCount': 4,
          'lastReplyAt': '2026-01-02T00:00:00.000Z',
        },
      });
      final event = await update;
      expect(event.reason, 'link_preview');
      expect(event.message.linkPreview!.title, 'X');
      expect(event.message.replyCount, 4);
      expect(event.message.lastReplyAt, isNotNull);
      expect(event.message.seq, '1');
    });
  });

  group('large rooms and audience viewers', () {
    test('presence.count and a paginated roster', () async {
      h = Harness();
      h.api.json('GET /v1/chat/conversations/conv_1/presence', {
        'data': [
          {'userId': 'bob', 'status': 'online'}
        ],
        'nextCursor': 'p2',
      });
      await h.connect();
      final count = h.chat.presenceCounts.first;
      h.socket
          .receive({'type': 'presence.count', 'room': 'conv_1', 'online': 812});
      expect((await count).online, 812);

      final page = await h.chat.listPresence(limit: 1);
      expect(page.presence.single.userId, 'bob');
      expect(page.nextCursor, 'p2');
      expect((await h.chat.getPresence()).single.userId, 'bob');
    });

    test('an audience token joins its room and refuses member-only calls',
        () async {
      h = Harness(
          token: fakeJwt(
              {'sub': 'viewer_1', 'aud_room': 'conv_live', 'role': 'VIEWER'}));
      expect(h.chat.isAudienceViewer, isTrue);
      expect(h.chat.userId, 'viewer_1');

      final connecting = h.chat.connect();
      await waitFor(() =>
          h.sockets.isNotEmpty && h.socket.ofType('room.join').isNotEmpty);
      expect(h.socket.ofType('room.join').single['room'], 'conv_live');
      h.ackJoins(h.socket);
      await connecting;

      await expectLater(
          h.chat.markAsRead('msg_1'),
          throwsA(isA<SwalvoChatException>()
              .having((e) => e.code, 'code', SwalvoChatErrorCode.notAMember)));
      await expectLater(
          h.chat.queryMyConversations(), throwsA(isA<SwalvoChatException>()));
    });

    test('an ordinary token is not a viewer', () {
      h = Harness();
      expect(h.chat.isAudienceViewer, isFalse);
    });
  });

  group('attachments', () {
    test('ticket, PUT to storage, confirm', () async {
      h = Harness();
      h.api.json('POST /v1/chat/conversations/conv_1/attachments', {
        'id': 'att_1',
        'filename': 'a.png',
        'mimeType': 'image/png',
        'size': 3,
        'status': 'pending',
        'uploadUrl': 'https://storage.example.test/bucket/key',
        'uploadMethod': 'PUT',
        'uploadHeaders': {'content-type': 'image/png'},
      });
      h.api.routes['PUT /bucket/key'] = (_) => http.Response('', 200);
      h.api.json('POST /v1/chat/attachments/att_1/complete',
          {'id': 'att_1', 'status': 'uploaded'});

      final ticket = await h.chat.uploadAttachment(
        Uint8List.fromList([1, 2, 3]),
        filename: 'a.png',
        mimeType: 'image/png',
        room: 'conv_1',
      );
      expect(ticket.status, 'uploaded');
      final put = h.api.matching('PUT', '/bucket/key').single;
      expect(put.bodyBytes, [1, 2, 3]);
      expect(put.headers['authorization'], isNull,
          reason: 'the chat token must never reach a storage host');
      expect(h.api.matching('POST', '/v1/chat/attachments/att_1/complete'),
          hasLength(1));
    });

    test('a rejected PUT is never confirmed', () async {
      h = Harness();
      h.api.json('POST /v1/chat/conversations/conv_1/attachments', {
        'id': 'att_2',
        'uploadUrl': 'https://storage.example.test/bucket/bad',
      });
      h.api.routes['PUT /bucket/bad'] = (_) => http.Response('', 403);
      await expectLater(
        h.chat.uploadAttachment(Uint8List(1),
            filename: 'f', mimeType: 'x/y', room: 'conv_1'),
        throwsA(isA<SwalvoChatException>()),
      );
      expect(h.api.matching('POST', '/v1/chat/attachments/att_2/complete'),
          isEmpty);
    });
  });
}

class _RecordingStorage implements SwalvoOutboxStorage {
  List<SwalvoOutboxEntry> saved = [];

  @override
  Future<List<SwalvoOutboxEntry>> load() async =>
      saved.map((entry) => SwalvoOutboxEntry.fromJson(entry.toJson())).toList();

  @override
  Future<void> save(List<SwalvoOutboxEntry> entries) async {
    saved = entries;
  }
}
