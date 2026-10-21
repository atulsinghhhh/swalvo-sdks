package io.swalvo.rtc.internal.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every message in docs/rtc/signaling.md, as JSON fixtures, round-tripped
 * through the @Serializable model. Client messages must re-encode to the
 * exact fixture (that is what goes on the wire); server messages must decode
 * to the right type and survive encode → decode unchanged.
 */
class ProtocolSerializationTest {

    private fun fixtures(dir: String): Map<String, String> {
        val root = File(javaClass.classLoader!!.getResource("fixtures/$dir")!!.toURI())
        return root.listFiles()!!.filter { it.name.endsWith(".json") }.associate { it.nameWithoutExtension to it.readText() }
    }

    private fun parse(text: String) = Json.parseToJsonElement(text)

    @Test
    fun clientFixturesRoundTripExactly() {
        val all = fixtures("client")
        assertEquals(15, all.size)
        for ((name, text) in all) {
            val message = ProtocolJson.decodeClient(text)
            val reencoded = ProtocolJson.encode(message)
            assertEquals("fixture $name", parse(text), parse(reencoded))
            val type = (parse(text) as JsonObject)["type"]!!.jsonPrimitive.content
            assertEquals("type of $name", type, (parse(reencoded) as JsonObject)["type"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun clientMessagesBuiltInCodeMatchTheFixtures() {
        val all = fixtures("client")
        fun check(name: String, message: ClientMessage) = assertEquals(name, parse(all.getValue(name)), parse(ProtocolJson.encode(message)))
        check("room.join", ClientMessage.RoomJoin(roomId = "room_123", region = "asia-south"))
        check("room.join.resume", ClientMessage.RoomJoin(roomId = "room_123", resume = ResumeRequest("rt_abc")))
        check("room.join.no-autosubscribe", ClientMessage.RoomJoin(roomId = "room_123", autoSubscribe = false))
        check("room.leave", ClientMessage.RoomLeave)
        check("ping", ClientMessage.Ping)
        check("track.publish", ClientMessage.TrackPublish("abc-123", "screenShare"))
        check("track.mute", ClientMessage.TrackMute("abc-123", true))
        check("subscription.update.off", ClientMessage.SubscriptionUpdate("bob", "bob-cam", "off"))
        check("ice.candidate.minimal", ClientMessage.IceCandidate("candidate:1 1 udp 2130706431 10.0.0.1 54321 typ host"))
        check("token.refresh", ClientMessage.TokenRefresh("eyJ.new.tok"))
        check("participant.update", ClientMessage.ParticipantUpdate(attributes = mapOf("hand" to "raised")))
    }

    @Test
    fun absentOptionalFieldsAreOmittedNotNull() {
        val json = ProtocolJson.encode(ClientMessage.RoomJoin(roomId = "r"))
        assertEquals("""{"type":"room.join","roomId":"r"}""", json)
    }

    @Test
    fun serverFixturesDecodeToTheirTypesAndRoundTrip() {
        val all = fixtures("server")
        assertEquals(29, all.size)
        for ((name, text) in all) {
            val message = ProtocolJson.decodeServer(text)
            assertTrue("fixture $name decoded as $message", message != null && message !is ServerMessage.Unknown)
            val again = ProtocolJson.decodeServer(ProtocolJson.encodeServer(message!!))
            assertEquals("fixture $name", message, again)
        }
    }

    @Test
    fun serverFieldsAreRead() {
        val all = fixtures("server")
        val joined = ProtocolJson.decodeServer(all.getValue("room.joined")) as ServerMessage.RoomJoined
        assertEquals("room_123", joined.roomId)
        assertEquals("sfu-asia-02", joined.rtcServer)
        assertEquals("rt_1", joined.resumeToken)
        assertNull(joined.resumed)
        assertEquals(listOf("low", "medium", "high"), joined.participants.single().tracks!!.single().layers)

        val resumed = ProtocolJson.decodeServer(all.getValue("room.joined.resumed")) as ServerMessage.RoomJoined
        assertEquals(true, resumed.resumed)

        val e2ee = ProtocolJson.decodeServer(all.getValue("room.joined.e2ee")) as ServerMessage.RoomJoined
        assertEquals(true, e2ee.e2ee)
        assertEquals("ap-south", e2ee.clientRegion)

        val muted = ProtocolJson.decodeServer(all.getValue("track.muted.byserver")) as ServerMessage.TrackMuted
        assertEquals(true, muted.byServer)

        val layers = ProtocolJson.decodeServer(all.getValue("publisher.layers")) as ServerMessage.PublisherLayers
        assertEquals(listOf("q" to true, "h" to false, "f" to false), layers.layers.map { it.rid to it.active })

        val perms = ProtocolJson.decodeServer(all.getValue("participant.permissions_updated")) as ServerMessage.PermissionsUpdated
        assertTrue(perms.permissions.subscribe)
        assertFalse(perms.permissions.publish)

        val left = ProtocolJson.decodeServer(all.getValue("room.left.client")) as ServerMessage.RoomLeft
        assertNull(left.reason)

        // phase7
        val caps = ProtocolJson.decodeServer(all.getValue("room.joined.capabilities")) as ServerMessage.RoomJoined
        assertEquals(listOf("data.v2"), caps.capabilities)
        assertEquals("bob's metadata", caps.participants.single().metadata)
        assertEquals(mapOf("team" to "blue"), caps.participants.single().attributes)
        assertNull(joined.capabilities)
        val updated = ProtocolJson.decodeServer(all.getValue("participant.updated")) as ServerMessage.ParticipantUpdated
        assertEquals("bob", updated.participantId)
        assertEquals("{\"role\":\"host\"}", updated.metadata!!.jsonPrimitive.content)
        val throttled = ProtocolJson.decodeServer(all.getValue("data.throttled")) as ServerMessage.DataThrottled
        assertEquals("lossy", throttled.channel)
        assertNull(perms.permissions.updateOwnMetadata)
    }

    @Test
    fun unknownTypesAndFieldsAreIgnoredNotErrors() {
        val unknown = ProtocolJson.decodeServer("""{"type":"room.someday","x":1}""")
        assertTrue(unknown is ServerMessage.Unknown)
        assertEquals("room.someday", (unknown as ServerMessage.Unknown).type)

        val extra = ProtocolJson.decodeServer("""{"type":"track.muted","participantId":"bob","trackId":"t","futureField":{"a":[1,2]}}""")
        assertEquals(ServerMessage.TrackMuted("bob", "t"), extra)

        // A known type missing a required field must not throw either.
        assertTrue(ProtocolJson.decodeServer("""{"type":"track.muted"}""") is ServerMessage.Unknown)
        // Not JSON at all, or not an object: dropped.
        assertNull(ProtocolJson.decodeServer("not json"))
        assertNull(ProtocolJson.decodeServer("[1,2]"))
    }

    @Test
    fun participantUpdatedKeepsAbsentApartFromNull() {
        val absent = ProtocolJson.decodeServer("""{"type":"participant.updated","participantId":"a","attributes":{"k":"v"}}""") as ServerMessage.ParticipantUpdated
        assertNull(absent.metadata)
        val cleared = ProtocolJson.decodeServer("""{"type":"participant.updated","participantId":"a","metadata":null}""") as ServerMessage.ParticipantUpdated
        assertEquals(kotlinx.serialization.json.JsonNull, cleared.metadata)
        assertNull(cleared.attributes)
        assertTrue(ProtocolJson.decodeServer("""{"type":"participant.updated"}""") is ServerMessage.Unknown)
    }

    @Test
    fun participantUpdateOmitsAbsentFields() {
        assertEquals("""{"type":"participant.update","metadata":"m"}""", ProtocolJson.encode(ClientMessage.ParticipantUpdate(metadata = "m")))
    }

    @Test
    fun unknownQualityAndStateStringsStillDecode() {
        val q = ProtocolJson.decodeServer("""{"type":"quality.changed","updates":[{"participantId":"a","quality":"stellar"}]}""")
        assertEquals("stellar", (q as ServerMessage.QualityChanged).updates.single().quality)
    }
}
