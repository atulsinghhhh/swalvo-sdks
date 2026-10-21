package io.swalvo.rtc.internal.engine

import io.swalvo.rtc.VideoLayer

/** Pure helpers shared by the engine and the room, kept free of libwebrtc so they unit-test on the JVM. */
internal object SdpUtils {
    /**
     * The `a=msid:<stream> <track>` track id of the m-section whose `a=mid`
     * is [mid]. The SFU forwards each subscription with the *publisher's*
     * track id there, so this is how an arriving track is attributed (the
     * local `MediaStreamTrack.id()` is minted by the receiver and means nothing).
     */
    fun msidTrackIdForMid(sdp: String, mid: String): String? {
        val sections = sdp.split(Regex("\r?\nm=")).drop(1)
        for (section in sections) {
            val lines = section.split(Regex("\r?\n"))
            if (lines.none { it.trim() == "a=mid:$mid" }) continue
            val msid = lines.firstOrNull { it.startsWith("a=msid:") } ?: return null
            val parts = msid.removePrefix("a=msid:").trim().split(Regex("\\s+"))
            return parts.getOrNull(1)?.takeIf { it.isNotEmpty() }
        }
        return null
    }

    /** Whether an SDP negotiates simulcast send with all three of our RIDs. */
    fun negotiatesSimulcast(sdp: String): Boolean {
        val lines = sdp.split(Regex("\r?\n"))
        val rids = lines.filter { it.startsWith("a=rid:") }.map { it.removePrefix("a=rid:").split(' ')[0] }.toSet()
        return lines.any { it.startsWith("a=simulcast:send") } && Simulcast.LAYERS.all { it.rid in rids }
    }
}

internal object Simulcast {
    data class Layer(val rid: String, val scaleResolutionDownBy: Double, val maxBitrateBps: Int, val maxFramerate: Int)

    /** Same ladder as the web SDK (packages/sdk/src/internal/sfu/simulcast.ts). */
    val LAYERS: List<Layer> = listOf(
        Layer("low", 4.0, 150_000, 15),
        Layer("medium", 2.0, 500_000, 30),
        Layer("high", 1.0, 1_500_000, 30),
    )

    private val ALIASES = mapOf("q" to "low", "h" to "medium", "f" to "high")

    private fun canonical(rid: String): String = ALIASES[rid] ?: rid

    /**
     * phase2 §5: match a `publisher.layers` RID against a sender encoding's
     * RID exactly, and also accept the other spelling of the same rung
     * (`q`↔`low`, `h`↔`medium`, `f`↔`high`).
     */
    fun ridMatches(encodingRid: String?, wireRid: String): Boolean {
        if (encodingRid == null) return false
        return encodingRid == wireRid || canonical(encodingRid) == canonical(wireRid)
    }

    /**
     * For each encoding RID, the `active` flag a `publisher.layers` frame
     * asks for. Encodings the frame does not mention are left alone (absent from the result).
     */
    fun activityFor(encodingRids: List<String?>, layers: List<Pair<String, Boolean>>): Map<Int, Boolean> {
        val out = linkedMapOf<Int, Boolean>()
        encodingRids.forEachIndexed { index, rid ->
            val match = layers.firstOrNull { (wire, _) -> ridMatches(rid, wire) } ?: return@forEachIndexed
            out[index] = match.second
        }
        return out
    }
}

/**
 * phase2 §4 client layer precedence, shared by every SDK:
 * an application pause → `off`; else a pinned layer; else, with adaptive
 * streaming on, `off` while no view is visible; else `auto`.
 */
internal object LayerPolicy {
    fun effectiveLayer(enabled: Boolean, pinned: VideoLayer?, adaptiveStream: Boolean, visible: Boolean): String = when {
        !enabled -> "off"
        pinned != null -> pinned.wire
        adaptiveStream && !visible -> "off"
        else -> "auto"
    }

    /** Becoming invisible is debounced; everything else applies at once. */
    const val HIDE_DEBOUNCE_MS = 500L
}
