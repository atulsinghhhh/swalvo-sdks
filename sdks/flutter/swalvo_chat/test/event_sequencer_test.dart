import 'package:flutter_test/flutter_test.dart';
import 'package:swalvo_chat/swalvo_chat.dart';
import 'package:swalvo_chat/src/event_sequencer.dart';

/// The sequencer on its own: ordering, de-duplication and backfill are
/// pure bookkeeping, testable without a socket.
void main() {
  late List<String> applied;
  late List<String> fetchedAfter;
  late List<EventPage Function()> pages;
  late List<String> expired;
  late bool connected;

  EventSequencer make() => EventSequencer(
        fetchEvents: (room, after, limit) async {
          fetchedAfter.add(after);
          if (pages.isEmpty) return const EventPage([]);
          return pages.removeAt(0)();
        },
        apply: (frame) => applied.add('${frame['eventSeq']}'),
        onExpired: (room) async => expired.add(room),
        isConnected: () => connected,
        gapFillDelay: const Duration(milliseconds: 10),
        retryDelay: (_) => Duration.zero,
      );

  Map<String, dynamic> frame(int seq) =>
      {'type': 'reaction.added', 'eventSeq': '$seq'};
  Map<String, dynamic> record(int seq) => {
        'eventSeq': '$seq',
        'type': 'reaction.added',
        'payload': <String, dynamic>{}
      };

  setUp(() {
    applied = [];
    fetchedAfter = [];
    pages = [];
    expired = [];
    connected = true;
  });

  test('applies in-order frames immediately', () {
    final sequencer = make();
    for (final seq in [5, 6, 7]) {
      sequencer.ingest('conv_1', frame(seq));
    }
    expect(applied, ['5', '6', '7']);
    expect(sequencer.lastEventSeq('conv_1'), '7');
  });

  test('drops a frame it has already applied', () {
    final sequencer = make()
      ..ingest('conv_1', frame(1))
      ..ingest('conv_1', frame(2))
      ..ingest('conv_1', frame(2))
      ..ingest('conv_1', frame(1));
    expect(applied, ['1', '2']);
    expect(sequencer.lastEventSeq('conv_1'), '2');
  });

  test('a reordered pair closes its own gap without a fetch', () async {
    make()
      ..ingest('conv_1', frame(1))
      ..ingest('conv_1', frame(3))
      ..ingest('conv_1', frame(2));
    expect(applied, ['1', '2', '3']);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(fetchedAfter, isEmpty);
  });

  test('a gap that stays open is backfilled from the event log, in order',
      () async {
    pages.add(() => EventPage([record(2)]));
    make()
      ..ingest('conv_1', frame(1))
      ..ingest('conv_1', frame(3));
    expect(applied, ['1'], reason: '3 is held behind the hole');

    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(fetchedAfter, ['1']);
    expect(applied, ['1', '2', '3']);
  });

  test('a hole the log cannot fill (a blocked user) is stepped over', () async {
    final sequencer = make()
      ..ingest('conv_1', frame(1))
      ..ingest('conv_1', frame(3));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(applied, ['1', '3']);
    expect(sequencer.lastEventSeq('conv_1'), '3');
  });

  test('catch-up pages until hasMore is false and holds live frames meanwhile',
      () async {
    final sequencer = make()..ingest('conv_1', frame(10));
    pages
      ..add(() => EventPage([record(11), record(12)], hasMore: true))
      ..add(() => EventPage([record(13)]));
    sequencer.beginSync(['conv_1']);
    // Arrives during the rejoin: must not overtake 11..13.
    sequencer.ingest('conv_1', frame(14));
    expect(applied, ['10']);

    final result = await sequencer.catchUp('conv_1');
    expect(result.applied, 3);
    expect(fetchedAfter, ['10', '12']);
    expect(applied, ['10', '11', '12', '13', '14']);
  });

  test('EVENTS_EXPIRED hands over to a history resync', () async {
    final sequencer = make()..ingest('conv_1', frame(3));
    pages.add(() => throw const SwalvoChatException(
        SwalvoChatErrorCode.eventsExpired, 'gone'));

    final result = await sequencer.catchUp('conv_1');
    expect(result.expired, isTrue);
    expect(expired, ['conv_1']);
    // The resume point is useless now; the next live frame starts afresh.
    expect(sequencer.lastEventSeq('conv_1'), isNull);
  });

  test('a room with no resume point has nothing to catch up', () async {
    final result = await make().catchUp('conv_new');
    expect(result.applied, 0);
    expect(fetchedAfter, isEmpty);
  });

  test('frames without an eventSeq go straight through', () {
    make().ingest('conv_1', {'type': 'message'});
    expect(applied, ['null']);
  });

  test('compareSeq orders numerically, not lexically', () {
    expect(compareSeq('10', '9'), greaterThan(0));
    expect(compareSeq('9007199254740993', '9007199254740992'), greaterThan(0));
    expect(compareSeq(null, '1'), lessThan(0));
    expect(compareSeq('5', '5'), 0);
  });
}
