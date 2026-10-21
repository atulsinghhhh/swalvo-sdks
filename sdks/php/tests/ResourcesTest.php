<?php

declare(strict_types=1);

namespace Swalvo\Tests;

use Swalvo\Client;
use Swalvo\Http\Response;
use Swalvo\SwalvoException;
use Swalvo\Model\ChatMessagePage;
use Swalvo\Model\ConnectionDetail;
use Swalvo\Model\ErrorDetail;
use Swalvo\Model\IngressWithKey;
use Swalvo\Model\IssuedStreamCredential;
use Swalvo\Model\IssuedToken;
use Swalvo\Model\LiveStream;
use Swalvo\Model\LiveStreamDeliveryView;
use Swalvo\Model\ParticipantPermissions;
use Swalvo\Model\RestreamView;
use Swalvo\Model\Room;
use Swalvo\Tests\Support\StubTransport;
use PHPUnit\Framework\TestCase;

/** Every resource method: verb, path, query and JSON body on the wire, and the typed object that comes back. */
final class ResourcesTest extends TestCase
{
    private StubTransport $transport;
    private Client $client;

    protected function setUp(): void
    {
        $this->transport = new StubTransport();
        $this->client = new Client(apiKey: 'k', baseUrl: 'https://api.example.test', transport: $this->transport);
    }

    /** @param array<mixed>|null $payload */
    private function respond(?array $payload, int $status = 200): void
    {
        $this->transport->push($status === 204 ? new Response(204) : Response::json($status, $payload));
    }

    private function assertSent(string $method, string $target, mixed $body = null): void
    {
        self::assertSame($method, $this->transport->last()->method);
        self::assertSame($target, $this->transport->lastTarget());
        self::assertSame($body, $this->transport->lastJson());
    }

    // -- projects / rooms / tokens -------------------------------------------------------------

    public function testProjectsGet(): void
    {
        $this->respond(['id' => 'proj_1', 'name' => 'Acme', 'description' => null, 'status' => 'ACTIVE', 'ownerId' => 'u1', 'createdAt' => 'c', 'updatedAt' => 'u']);

        $project = $this->client->projects->get();

        $this->assertSent('GET', '/v1/project');
        self::assertSame('Acme', $project->name);
        self::assertNull($project->description);
    }

    public function testRoomsListGetCreateDelete(): void
    {
        $room = ['id' => 'room_1', 'projectId' => 'p', 'name' => 'standup', 'status' => 'ACTIVE', 'e2ee' => true, 'createdAt' => 'c', 'updatedAt' => 'u'];

        $this->respond([$room]);
        $list = $this->client->rooms->list();
        $this->assertSent('GET', '/v1/rooms');
        self::assertContainsOnlyInstancesOf(Room::class, $list);
        self::assertTrue($list[0]->e2ee);

        $this->respond($room);
        self::assertSame('standup', $this->client->rooms->get('room_1')->name);
        $this->assertSent('GET', '/v1/rooms/room_1');

        $this->respond($room);
        $this->client->rooms->create(['name' => 'standup', 'getOrCreate' => true, 'e2ee' => true]);
        $this->assertSent('POST', '/v1/rooms', ['name' => 'standup', 'getOrCreate' => true, 'e2ee' => true]);

        $this->respond(null, 204);
        $this->client->rooms->delete('room_1');
        $this->assertSent('DELETE', '/v1/rooms/room_1');
    }

    public function testRoomParticipants(): void
    {
        $alice = ['identity' => 'alice', 'joinedAt' => 'j', 'tracks' => [['sid' => 'TR_1', 'kind' => 'audio', 'name' => 'mic', 'muted' => false]]];

        $this->respond([$alice, ['identity' => 'bob', 'joinedAt' => 'j', 'tracks' => []]]);
        $list = $this->client->rooms->participants->list('room_1');
        $this->assertSent('GET', '/v1/rooms/room_1/participants');
        self::assertCount(2, $list ?? []);
        self::assertSame('audio', $list[0]->tracks[0]->kind);

        $this->respond([$alice]);
        self::assertSame('alice', $this->client->rooms->participants->get('room_1', 'alice')?->identity);
        $this->respond([$alice]);
        self::assertNull($this->client->rooms->participants->get('room_1', 'carol'));

        // null means "SFU unreachable", never collapsed into an empty list.
        $this->transport->push(new Response(200, [], 'null'));
        self::assertNull($this->client->rooms->participants->list('room_1'));
        $this->transport->push(new Response(200, [], 'null'));
        self::assertNull($this->client->rooms->participants->get('room_1', 'alice'));
    }

    private const NOT_CONNECTED = ['code' => 'RAVEN_PARTICIPANT_NOT_CONNECTED', 'message' => 'Participant is not connected', 'statusCode' => 404];

    private function assertRawBody(string $json): void
    {
        self::assertSame($json, $this->transport->last()->body);
    }

    public function testRoomParticipantsRemove(): void
    {
        $this->respond(null, 204);
        $this->client->rooms->participants->remove('standup', 'a b/c');
        $this->assertSent('POST', '/v1/rooms/standup/participants/a%20b%2Fc/remove', []);
        $this->assertRawBody('{}');

        $this->respond(self::NOT_CONNECTED, 404);
        try {
            $this->client->rooms->participants->remove('standup', 'ghost');
            self::fail('expected RAVEN_PARTICIPANT_NOT_CONNECTED');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_PARTICIPANT_NOT_CONNECTED', $e->errorCode);
            self::assertSame(404, $e->statusCode);
        }
    }

    public function testRoomParticipantsMute(): void
    {
        $this->respond(null, 204);
        $this->client->rooms->participants->mute('room_1', 'a b/c', ['kind' => 'audio', 'muted' => false]);
        $this->assertSent('POST', '/v1/rooms/room_1/participants/a%20b%2Fc/mute', ['kind' => 'audio', 'muted' => false]);
        $this->assertRawBody('{"kind":"audio","muted":false}');

        $this->respond(null, 204);
        $this->client->rooms->participants->mute('room_1', 'bob', ['trackId' => 'TR_1', 'muted' => true]);
        $this->assertRawBody('{"trackId":"TR_1","muted":true}');

        $this->respond(['code' => 'RAVEN_TRACK_NOT_FOUND', 'message' => 'Track not found', 'statusCode' => 404], 404);
        try {
            $this->client->rooms->participants->mute('room_1', 'bob', ['trackId' => 'TR_x', 'muted' => true]);
            self::fail('expected RAVEN_TRACK_NOT_FOUND');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_TRACK_NOT_FOUND', $e->errorCode);
            self::assertSame(404, $e->statusCode);
        }
    }

    public function testRoomParticipantsModerationValidatesBeforeSendingAnything(): void
    {
        $invalid = [
            fn () => $this->client->rooms->participants->mute('room_1', 'bob', ['trackId' => 'TR_1', 'kind' => 'video', 'muted' => true]),
            fn () => $this->client->rooms->participants->mute('room_1', 'bob', ['muted' => true]),
            fn () => $this->client->rooms->participants->mute('room_1', 'bob', ['kind' => 'screen', 'muted' => true]),
            fn () => $this->client->rooms->participants->mute('room_1', 'bob', ['kind' => 'audio']),
            fn () => $this->client->rooms->participants->updatePermissions('room_1', 'bob', []),
            fn () => $this->client->rooms->participants->updatePermissions('room_1', 'bob', ['publish' => 'no']),
        ];
        foreach ($invalid as $i => $call) {
            try {
                $call();
                self::fail("case {$i}: expected VALIDATION_ERROR");
            } catch (SwalvoException $e) {
                self::assertSame('VALIDATION_ERROR', $e->errorCode, "case {$i}");
            }
        }
        self::assertSame([], $this->transport->requests);
    }

    public function testRoomParticipantsUpdatePermissions(): void
    {
        $this->respond(['subscribe' => true, 'publish' => false, 'publishAudio' => false, 'publishVideo' => true, 'publishData' => true]);
        $perms = $this->client->rooms->participants->updatePermissions('room_1', 'a b/c', ['publish' => false, 'publishData' => true]);
        $this->assertSent('PATCH', '/v1/rooms/room_1/participants/a%20b%2Fc/permissions', ['publish' => false, 'publishData' => true]);
        $this->assertRawBody('{"publish":false,"publishData":true}');
        self::assertInstanceOf(ParticipantPermissions::class, $perms);
        self::assertTrue($perms->subscribe);
        self::assertFalse($perms->publish);
        self::assertFalse($perms->publishAudio);
        self::assertTrue($perms->publishVideo);
        self::assertTrue($perms->publishData);

        $this->respond(self::NOT_CONNECTED, 404);
        try {
            $this->client->rooms->participants->updatePermissions('room_1', 'ghost', ['subscribe' => true]);
            self::fail('expected RAVEN_PARTICIPANT_NOT_CONNECTED');
        } catch (SwalvoException $e) {
            self::assertSame('RAVEN_PARTICIPANT_NOT_CONNECTED', $e->errorCode);
        }
    }

    public function testTokensCreateMapsToTheWireVocabulary(): void
    {
        $this->respond([
            'id' => 'tok_1', 'token' => 'eyJ...', 'endpoint' => 'wss://sfu.example.test', 'roomId' => 'room_1', 'roomName' => 'standup',
            'participantIdentity' => 'user-42', 'permissions' => ['publish' => false, 'subscribe' => true],
            'iceServers' => [['urls' => 'turn:turn.example.test', 'username' => 'u', 'credential' => 'c']],
            'telemetryUrl' => 'https://t', 'expiresAt' => 'e', 'createdAt' => 'c',
        ]);

        $token = $this->client->tokens->create([
            'room' => 'room_1',
            'identity' => 'user-42',
            'permissions' => ['publish' => false, 'subscribe' => true],
            'expiresIn' => 600,
            'metadata' => '{"role":"viewer"}',
        ]);

        $this->assertSent('POST', '/v1/rooms/room_1/rtc-tokens', [
            'participantIdentity' => 'user-42',
            'permissions' => ['publish' => false, 'subscribe' => true],
            'ttlSeconds' => 600,
            'metadata' => '{"role":"viewer"}',
        ]);
        self::assertInstanceOf(IssuedToken::class, $token);
        self::assertFalse($token->permissions->publish);
        self::assertNull($token->permissions->join);
        self::assertSame('turn:turn.example.test', $token->iceServers[0]->urls);
        // json_encode forwards the exact wire payload to a frontend.
        self::assertSame('eyJ...', json_decode((string) json_encode($token), true)['token']);
    }

    public function testTokensCreateOmitsUnsetOptionalFields(): void
    {
        $this->respond(['token' => 't']);

        $this->client->tokens->create(['room' => 'room_1', 'identity' => 'u']);

        $this->assertSent('POST', '/v1/rooms/room_1/rtc-tokens', ['participantIdentity' => 'u']);
    }

    public function testTokensCreateRequiresRoomAndIdentityBeforeSendingAnything(): void
    {
        try {
            $this->client->tokens->create(['identity' => 'u']);
            self::fail('expected VALIDATION_ERROR');
        } catch (SwalvoException $e) {
            self::assertSame('VALIDATION_ERROR', $e->errorCode);
        }
        self::assertSame([], $this->transport->requests);
    }

    public function testPathSegmentsArePercentEncodedAndEmptyIdsRefused(): void
    {
        $this->respond(['id' => 'x']);
        $this->client->rooms->get('a/b c');
        $this->assertSent('GET', '/v1/rooms/a%2Fb%20c');

        $this->expectException(SwalvoException::class);
        $this->client->rooms->get('');
    }

    // -- connections / errors / metrics / diagnostics ------------------------------------------

    public function testConnections(): void
    {
        $this->respond([['id' => 'c1', 'state' => 'CONNECTED', 'reconnectCount' => 2]]);
        $list = $this->client->connections->list(['roomId' => 'room-1', 'limit' => 10]);
        $this->assertSent('GET', '/v1/connections?roomId=room-1&limit=10');
        self::assertSame(2, $list[0]->reconnectCount);

        $this->respond(['id' => 'conn_1', 'state' => 'FAILED', 'events' => [['id' => 'e1', 'type' => 'ice', 'data' => null, 'timestamp' => 't']], 'errors' => [['id' => 'err_1', 'category' => 'ICE_ERROR']]]);
        $detail = $this->client->connections->get('conn_1');
        $this->assertSent('GET', '/v1/connections/conn_1');
        self::assertInstanceOf(ConnectionDetail::class, $detail);
        self::assertSame('FAILED', $detail->state);
        self::assertSame('ice', $detail->events[0]->type);
        self::assertSame('ICE_ERROR', $detail->errors[0]->category);
    }

    public function testErrors(): void
    {
        $this->respond([]);
        $this->client->errors->list(['category' => 'ICE_ERROR', 'connectionId' => 'conn_1', 'limit' => 5]);
        $this->assertSent('GET', '/v1/errors?category=ICE_ERROR&connectionId=conn_1&limit=5');

        $this->respond(['id' => 'err_1', 'category' => 'TURN_ERROR', 'message' => 'm', 'connection' => ['id' => 'conn_1', 'state' => 'FAILED']]);
        $detail = $this->client->errors->get('err_1');
        $this->assertSent('GET', '/v1/errors/err_1');
        self::assertInstanceOf(ErrorDetail::class, $detail);
        self::assertSame('conn_1', $detail->connection?->id);
    }

    public function testMetricsAndDiagnostics(): void
    {
        $this->respond(['range' => '24h', 'activeRooms' => 3, 'activeParticipants' => 7, 'connections' => 10, 'connectionSuccessRate' => 0.9, 'reconnectionRate' => null, 'averageConnectionDurationMs' => 1200, 'errors' => 1]);
        $metrics = $this->client->metrics->get('24h');
        $this->assertSent('GET', '/v1/metrics?range=24h');
        self::assertSame(0.9, $metrics->connectionSuccessRate);
        self::assertNull($metrics->reconnectionRate);
        self::assertSame(1200.0, $metrics->averageConnectionDurationMs);

        $this->respond([]);
        $this->client->metrics->get();
        $this->assertSent('GET', '/v1/metrics');

        $this->respond(['project' => ['id' => 'p', 'name' => 'Acme'], 'api' => 'up', 'authentication' => 'ok', 'dependencies' => ['signaling' => 'up', 'sfu' => 'down', 'turn' => 'up'], 'connections' => ['active' => 4]]);
        $diag = $this->client->diagnostics->get();
        $this->assertSent('GET', '/v1/diagnostics');
        self::assertSame('down', $diag->dependencies['sfu'] ?? null);
        self::assertSame(4, $diag->connections['active'] ?? null);
    }

    // -- chat ------------------------------------------------------------------------------------

    public function testChatCreateTokenMapsExpiresInToTtlSeconds(): void
    {
        $this->respond(['token' => 'ct', 'tokenId' => 'ctk_1', 'userId' => 'u1', 'projectId' => 'p', 'scopes' => ['chat:read', 'chat:send'], 'conversations' => ['conv_1'], 'chatUrl' => 'wss://chat', 'apiUrl' => 'https://api', 'expiresAt' => 'e']);

        $token = $this->client->chat->createToken(['userId' => 'u1', 'conversations' => ['conv_1'], 'scopes' => ['chat:read', 'chat:send'], 'expiresIn' => 900]);

        $this->assertSent('POST', '/v1/chat/tokens', ['userId' => 'u1', 'conversations' => ['conv_1'], 'scopes' => ['chat:read', 'chat:send'], 'ttlSeconds' => 900]);
        self::assertSame(['chat:read', 'chat:send'], $token->scopes);
        self::assertSame('wss://chat', $token->chatUrl);
    }

    public function testChatConversations(): void
    {
        $conv = ['id' => 'conv_1', 'name' => 'general', 'type' => 'CHANNEL', 'status' => 'ACTIVE', 'retentionDays' => 30, 'metadata' => ['topic' => 'x']];

        $this->respond($conv);
        $created = $this->client->chat->createConversation(['name' => 'general', 'type' => 'CHANNEL', 'members' => [['userId' => 'u1', 'role' => 'ADMIN']], 'metadata' => [], 'getOrCreate' => true]);
        self::assertSame('POST', $this->transport->last()->method);
        self::assertSame('{"name":"general","type":"CHANNEL","members":[{"userId":"u1","role":"ADMIN"}],"metadata":{},"getOrCreate":true}', $this->transport->last()->body);
        self::assertSame(30, $created->retentionDays);
        self::assertSame(['topic' => 'x'], $created->metadata);

        $this->respond([$conv]);
        $this->client->chat->listConversations(['userId' => 'u1', 'includeArchived' => true]);
        $this->assertSent('GET', '/v1/chat/conversations?userId=u1&includeArchived=true');

        $this->respond([]);
        $this->client->chat->listConversations();
        $this->assertSent('GET', '/v1/chat/conversations');

        $this->respond($conv);
        $this->client->chat->getConversation('room #1');
        $this->assertSent('GET', '/v1/chat/conversations/room%20%231');
    }

    public function testChatMembers(): void
    {
        $this->respond(['id' => 'm1', 'userId' => 'u2', 'role' => 'MODERATOR', 'status' => 'ACTIVE', 'leftAt' => null]);
        $member = $this->client->chat->addMember('conv_1', ['userId' => 'u2', 'role' => 'MODERATOR']);
        $this->assertSent('POST', '/v1/chat/conversations/conv_1/members', ['userId' => 'u2', 'role' => 'MODERATOR']);
        self::assertSame('MODERATOR', $member->role);

        $this->respond([['id' => 'm1', 'userId' => 'u2']]);
        self::assertSame('u2', $this->client->chat->listMembers('conv_1')[0]->userId);
        $this->assertSent('GET', '/v1/chat/conversations/conv_1/members');

        $this->respond(null, 204);
        $this->client->chat->removeMember('conv_1', 'u2');
        $this->assertSent('DELETE', '/v1/chat/conversations/conv_1/members/u2');
    }

    public function testChatMessages(): void
    {
        $message = ['id' => 'msg_1', 'senderId' => 'system', 'type' => 'system', 'text' => 'Welcome', 'reactions' => [['emoji' => '👍', 'count' => 2, 'userIds' => ['a', 'b']]], 'edited' => false, 'deleted' => false];

        $this->respond($message);
        $sent = $this->client->chat->sendMessage('conv_1', ['senderId' => 'system', 'type' => 'system', 'text' => 'Welcome', 'clientMessageId' => 'idem-1']);
        $this->assertSent('POST', '/v1/chat/conversations/conv_1/messages', ['senderId' => 'system', 'type' => 'system', 'text' => 'Welcome', 'clientMessageId' => 'idem-1']);
        self::assertSame(2, $sent->reactions[0]['count']);

        $this->respond(['data' => [$message], 'nextCursor' => 'cur_2', 'previousCursor' => null, 'hasMore' => true]);
        $page = $this->client->chat->listMessages('conv_1', ['limit' => 50, 'before' => 'cur_1', 'senderId' => 'u1', 'includeDeleted' => true]);
        $this->assertSent('GET', '/v1/chat/conversations/conv_1/messages?limit=50&before=cur_1&senderId=u1&includeDeleted=true');
        self::assertInstanceOf(ChatMessagePage::class, $page);
        self::assertTrue($page->hasMore);
        self::assertSame('cur_2', $page->nextCursor);
        self::assertSame('Welcome', $page->data[0]->text);

        // includeDeleted: false and empty cursors are left out, exactly like the TS SDK.
        $this->respond(['data' => [], 'nextCursor' => null, 'previousCursor' => null, 'hasMore' => false]);
        $this->client->chat->listMessages('conv_1', ['before' => '', 'includeDeleted' => false]);
        $this->assertSent('GET', '/v1/chat/conversations/conv_1/messages');

        $this->respond($message + ['deletedAt' => '2026-10-03T00:00:00Z']);
        $deleted = $this->client->chat->deleteMessage('msg_1');
        $this->assertSent('DELETE', '/v1/chat/messages/msg_1');
        self::assertSame('2026-10-03T00:00:00Z', $deleted->deletedAt);
    }

    // -- live streams ----------------------------------------------------------------------------

    /** @return array<string, mixed> */
    private static function stream(array $overrides = []): array
    {
        return $overrides + [
            'id' => 'stream_1', 'title' => 'Launch', 'description' => null, 'thumbnailUrl' => null, 'category' => null,
            'tags' => ['launch'], 'language' => 'en', 'visibility' => 'PUBLIC', 'metadata' => null, 'status' => 'CREATED',
            'hosts' => [['identity' => 'alice', 'role' => 'HOST', 'invitedAt' => 'i']], 'viewerCount' => null, 'peakViewerCount' => 0,
            'delivery' => ['mode' => 'BROADCAST', 'status' => 'READY', 'playbackUrl' => 'https://cdn/x.m3u8', 'llhlsPlaybackUrl' => 'https://edge/ll.m3u8', 'recordingUrl' => null, 'recordingDurationSec' => null],
            'conversationId' => 'conv_1', 'chatRootMessageId' => 'msg_root', 'scheduledAt' => null, 'startedAt' => null, 'endedAt' => null,
            'createdAt' => 'c', 'updatedAt' => 'u',
        ];
    }

    public function testLiveStreamsLifecycle(): void
    {
        $this->respond(self::stream());
        $stream = $this->client->liveStreams->create(['title' => 'Launch', 'hostIdentity' => 'alice', 'tags' => ['launch'], 'deliveryMode' => 'BROADCAST', 'edgeScaling' => true]);
        $this->assertSent('POST', '/v1/live-streams', ['title' => 'Launch', 'hostIdentity' => 'alice', 'tags' => ['launch'], 'deliveryMode' => 'BROADCAST', 'edgeScaling' => true]);
        self::assertInstanceOf(LiveStream::class, $stream);
        self::assertNull($stream->viewerCount);
        self::assertSame('HOST', $stream->hosts[0]->role);
        self::assertSame('https://edge/ll.m3u8', $stream->delivery?->llhlsPlaybackUrl);
        self::assertSame('READY', $stream->delivery?->status);

        $this->respond([self::stream()]);
        $this->client->liveStreams->list();
        $this->assertSent('GET', '/v1/live-streams');

        $this->respond([self::stream(['status' => 'LIVE'])]);
        self::assertSame('LIVE', $this->client->liveStreams->list(['status' => 'LIVE'])[0]->status);
        $this->assertSent('GET', '/v1/live-streams?status=LIVE');

        $this->respond(self::stream(['viewerCount' => 12]));
        self::assertSame(12, $this->client->liveStreams->get('stream_1')->viewerCount);
        $this->assertSent('GET', '/v1/live-streams/stream_1');

        $this->respond(self::stream(['title' => 'New']));
        $this->client->liveStreams->update('stream_1', ['title' => 'New', 'metadata' => ['k' => 'v']]);
        $this->assertSent('PATCH', '/v1/live-streams/stream_1', ['title' => 'New', 'metadata' => ['k' => 'v']]);

        $this->respond(self::stream(['status' => 'LIVE']));
        $this->client->liveStreams->start('stream_1');
        $this->assertSent('POST', '/v1/live-streams/stream_1/start');

        $this->respond(self::stream(['status' => 'ENDED']));
        self::assertSame('ENDED', $this->client->live->end('stream_1')->status);
        $this->assertSent('POST', '/v1/live-streams/stream_1/end');
    }

    public function testLiveStreamHostsAndLeave(): void
    {
        $this->respond(['streamId' => 'stream_1', 'identity' => 'bob', 'role' => 'CO_HOST', 'rtc' => ['token' => 'rtc-t', 'permissions' => ['publish' => true]], 'chat' => ['token' => 'chat-t'], 'chatRootMessageId' => 'msg_root', 'rtcRoom' => 'stream_1']);
        $cred = $this->client->liveStreams->addHost('stream_1', ['identity' => 'bob', 'role' => 'CO_HOST']);
        $this->assertSent('POST', '/v1/live-streams/stream_1/hosts', ['identity' => 'bob', 'role' => 'CO_HOST']);
        self::assertTrue($cred->rtc?->permissions->publish);
        self::assertSame('stream_1', $cred->rtcRoom);
        self::assertNull($cred->playback);

        $this->respond(null, 204);
        $this->client->liveStreams->removeHost('stream_1', 'bob');
        $this->assertSent('DELETE', '/v1/live-streams/stream_1/hosts/bob');

        $this->respond(null, 204);
        $this->client->liveStreams->leave('stream_1', 'viewer-9');
        $this->assertSent('POST', '/v1/live-streams/stream_1/leave', ['identity' => 'viewer-9']);
    }

    public function testViewerTokenNeverSendsARoleAndOnlyAsksForPlaybackWhenTold(): void
    {
        $this->respond(['streamId' => 'stream_1', 'identity' => 'v1', 'role' => 'VIEWER', 'rtc' => ['token' => 't'], 'rtcRoom' => 'stream_1__e1']);
        $cred = $this->client->liveStreams->createViewerToken('stream_1', 'v1');
        $this->assertSent('POST', '/v1/live-streams/stream_1/viewer-tokens', ['identity' => 'v1']);
        self::assertSame('stream_1__e1', $cred->rtcRoom);

        $this->respond(['streamId' => 'stream_1', 'identity' => 'v1', 'role' => 'VIEWER', 'chat' => ['token' => 'c'], 'chatRootMessageId' => null, 'playback' => ['url' => 'https://cdn/x.m3u8', 'llhlsUrl' => 'https://edge/ll.m3u8', 'status' => 'STARTING']]);
        $cred = $this->client->liveStreams->createViewerToken('stream_1', 'v1', ['acceptPlayback' => true]);
        $this->assertSent('POST', '/v1/live-streams/stream_1/viewer-tokens', ['identity' => 'v1', 'acceptPlayback' => true]);
        self::assertInstanceOf(IssuedStreamCredential::class, $cred);
        self::assertNull($cred->rtc);
        self::assertNull($cred->rtcRoom);
        self::assertSame('https://cdn/x.m3u8', $cred->playback?->url);
        self::assertSame('https://edge/ll.m3u8', $cred->playback?->llhlsUrl);
        self::assertSame('STARTING', $cred->playback?->status);

        $this->respond(['role' => 'VIEWER']);
        $this->client->liveStreams->createViewerToken('stream_1', 'v1', ['acceptPlayback' => false]);
        $this->assertSent('POST', '/v1/live-streams/stream_1/viewer-tokens', ['identity' => 'v1']);
    }

    public function testStage(): void
    {
        $this->respond(null, 204);
        $this->client->liveStreams->stage->invite('stream_1', 'v1');
        $this->assertSent('POST', '/v1/live-streams/stream_1/stage/invites', ['identity' => 'v1']);

        $this->respond(['streamId' => 'stream_1', 'identity' => 'v1', 'role' => 'CO_HOST', 'rtc' => ['token' => 't']]);
        $cred = $this->client->liveStreams->stage->promote('stream_1', 'v1', ['role' => 'CO_HOST']);
        $this->assertSent('POST', '/v1/live-streams/stream_1/stage/promote', ['identity' => 'v1', 'role' => 'CO_HOST']);
        self::assertSame('CO_HOST', $cred->role);

        $this->respond(['role' => 'CO_HOST']);
        $this->client->liveStreams->stage->promote('stream_1', 'v1');
        $this->assertSent('POST', '/v1/live-streams/stream_1/stage/promote', ['identity' => 'v1']);

        $this->respond(null, 204);
        $this->client->liveStreams->stage->demote('stream_1', 'v1');
        $this->assertSent('POST', '/v1/live-streams/stream_1/stage/demote', ['identity' => 'v1']);
    }

    public function testPlayback(): void
    {
        $this->respond(['mode' => 'BROADCAST', 'status' => 'READY', 'playbackUrl' => 'https://cdn/x.m3u8', 'llhlsPlaybackUrl' => 'https://edge/ll.m3u8', 'recordingUrl' => null, 'recordingDurationSec' => null]);

        $delivery = $this->client->liveStreams->getPlayback('stream_1');

        $this->assertSent('GET', '/v1/live-streams/stream_1/playback');
        self::assertInstanceOf(LiveStreamDeliveryView::class, $delivery);
        self::assertSame('https://edge/ll.m3u8', $delivery->llhlsPlaybackUrl);
        self::assertSame('https://cdn/x.m3u8', $delivery->playbackUrl);
    }

    public function testRestreams(): void
    {
        $view = ['id' => 'rst_1', 'label' => 'YouTube', 'url' => 'rtmps://a.rtmp.youtube.com/live2', 'keyLast4' => 'abcd', 'enabled' => true, 'status' => 'IDLE', 'lastError' => null, 'attempts' => 0, 'connectedAt' => null, 'createdAt' => 'c', 'updatedAt' => 'u'];

        $this->respond($view);
        $created = $this->client->liveStreams->restreams->create('stream_1', ['url' => 'rtmps://a.rtmp.youtube.com/live2', 'streamKey' => 'xxxx-abcd', 'label' => 'YouTube']);
        $this->assertSent('POST', '/v1/live-streams/stream_1/restreams', ['url' => 'rtmps://a.rtmp.youtube.com/live2', 'streamKey' => 'xxxx-abcd', 'label' => 'YouTube']);
        self::assertInstanceOf(RestreamView::class, $created);
        self::assertSame('abcd', $created->keyLast4);

        $this->respond([$view]);
        self::assertCount(1, $this->client->liveStreams->restreams->list('stream_1'));
        $this->assertSent('GET', '/v1/live-streams/stream_1/restreams');

        $this->respond(['enabled' => false] + $view);
        self::assertFalse($this->client->liveStreams->restreams->update('stream_1', 'rst_1', ['enabled' => false])->enabled);
        $this->assertSent('PATCH', '/v1/live-streams/stream_1/restreams/rst_1', ['enabled' => false]);

        $this->respond(null, 204);
        $this->client->liveStreams->restreams->delete('stream 1', 'rst/1');
        $this->assertSent('DELETE', '/v1/live-streams/stream%201/restreams/rst%2F1');
    }

    public function testIngress(): void
    {
        $view = ['id' => 'ing_1', 'protocol' => 'RTMP', 'identity' => 'alice', 'keyPrefix' => 'sk_ab', 'autoStart' => true, 'status' => 'PUBLISHING', 'reconnectWindowSec' => 60, 'lastError' => null,
            'inputVideo' => ['codec' => 'h264', 'width' => 1920, 'height' => 1080, 'fps' => 30], 'inputAudio' => ['codec' => 'aac', 'sampleRate' => 48000, 'channels' => 2],
            'whipUrl' => 'https://w', 'rtmpUrl' => 'rtmp://r', 'rtmpsUrl' => 'rtmps://r', 'connectedAt' => null, 'disconnectedAt' => null, 'createdAt' => 'c', 'updatedAt' => 'u'];

        $this->respond($view + ['streamKey' => 'sk_abcdef']);
        $created = $this->client->liveStreams->ingress->create('stream_1', ['protocol' => 'WHIP', 'autoStart' => false, 'reconnectWindowSec' => 30]);
        $this->assertSent('POST', '/v1/live-streams/stream_1/ingress', ['protocol' => 'WHIP', 'autoStart' => false, 'reconnectWindowSec' => 30]);
        self::assertInstanceOf(IngressWithKey::class, $created);
        self::assertSame('sk_abcdef', $created->streamKey);
        self::assertSame(1920, $created->inputVideo?->width);
        self::assertSame(30.0, $created->inputVideo?->fps);
        self::assertSame(2, $created->inputAudio?->channels);

        $this->respond($view + ['streamKey' => 'sk_new']);
        $this->client->liveStreams->ingress->create('stream_1');
        self::assertSame('{}', $this->transport->last()->body, 'an empty params array goes out as {}, not []');

        $this->respond($view);
        self::assertSame('PUBLISHING', $this->client->liveStreams->ingress->get('stream_1')->status);
        $this->assertSent('GET', '/v1/live-streams/stream_1/ingress');

        $this->respond($view + ['streamKey' => 'sk_rotated']);
        self::assertSame('sk_rotated', $this->client->liveStreams->ingress->reset('stream_1')->streamKey);
        $this->assertSent('POST', '/v1/live-streams/stream_1/ingress/reset');

        $this->respond(null, 204);
        $this->client->liveStreams->ingress->delete('stream_1');
        $this->assertSent('DELETE', '/v1/live-streams/stream_1/ingress');
    }

    public function testModelsKeepUnknownFieldsAndTolerateMissingOnes(): void
    {
        $this->respond(['id' => 'room_1', 'brandNewField' => 42]);

        $room = $this->client->rooms->get('room_1');

        self::assertSame('room_1', $room->id);
        self::assertSame('', $room->name);
        self::assertNull($room->e2ee);
        self::assertSame(42, $room->toArray()['brandNewField']);
        self::assertSame('{"id":"room_1","brandNewField":42}', json_encode($room));
    }
}
