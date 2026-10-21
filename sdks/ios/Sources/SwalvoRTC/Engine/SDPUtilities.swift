import Foundation

/// Small, pure SDP readers. Pure so they are unit-testable without WebRTC.
enum SDPUtilities {
    /// The `a=msid:<stream> <track>` track id of the m-section with `mid`.
    ///
    /// The SFU forwards every subscription carrying the *publisher's* track
    /// id as the msid track id, and that is what attributes a remote track to
    /// a `track.published` announcement. Found via the mid rather than by
    /// scanning every msid line: someone publishing a camera and a screen
    /// share has two video m-sections, and picking the wrong one labels a
    /// screen share as somebody's face.
    static func msidTrackId(forMid mid: String, in sdp: String) -> String? {
        for section in mediaSections(sdp) {
            guard section.contains(where: { $0 == "a=mid:\(mid)" }) else { continue }
            for line in section where line.hasPrefix("a=msid:") {
                let parts = line.dropFirst("a=msid:".count).split(separator: " ")
                if parts.count >= 2 { return String(parts[1]) }
            }
            return nil
        }
        return nil
    }

    /// Whether an SDP negotiates the full simulcast ladder in a send direction.
    static func negotiatesSimulcast(_ sdp: String, rids: [String] = Simulcast.layers.map(\.rid)) -> Bool {
        let lines = splitLines(sdp)
        let hasSend = lines.contains { $0.hasPrefix("a=simulcast:send") }
        let declared = Set(lines.filter { $0.hasPrefix("a=rid:") }
            .compactMap { $0.dropFirst("a=rid:".count).split(separator: " ").first.map(String.init) })
        return hasSend && rids.allSatisfy(declared.contains)
    }

    static func splitLines(_ sdp: String) -> [String] {
        sdp.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    }

    /// The m-sections, each as its lines (the session section is dropped).
    static func mediaSections(_ sdp: String) -> [[String]] {
        var sections: [[String]] = []
        var current: [String]?
        for line in splitLines(sdp) {
            if line.hasPrefix("m=") {
                if let current { sections.append(current) }
                current = [line]
            } else if current != nil {
                current?.append(line)
            }
        }
        if let current { sections.append(current) }
        return sections
    }
}

/// The simulcast ladder, identical to the web and Flutter SDKs. The RIDs
/// are not labels: the SFU maps them onto its layer names.
public enum Simulcast {
    public struct Layer: Equatable, Sendable {
        public let rid: String
        public let scaleResolutionDownBy: Double
        public let maxBitrateBps: Int
        public let maxFramerate: Int
    }

    public static let layers: [Layer] = [
        Layer(rid: "low", scaleResolutionDownBy: 4, maxBitrateBps: 150_000, maxFramerate: 15),
        Layer(rid: "medium", scaleResolutionDownBy: 2, maxBitrateBps: 500_000, maxFramerate: 30),
        Layer(rid: "high", scaleResolutionDownBy: 1, maxBitrateBps: 1_500_000, maxFramerate: 30),
    ]

    /// RID spellings that mean the same rung (phase 2 §5): `q`↔`low`,
    /// `h`↔`medium`, `f`↔`high`.
    static let aliases: [String: String] = ["q": "low", "h": "medium", "f": "high", "low": "q", "medium": "h", "high": "f"]

    /// Resolves a `publisher.layers` frame against a sender's RIDs: the
    /// activity per sender RID. Exact match first, then the alias. RIDs the
    /// frame does not mention are left out (unchanged).
    static func activity(for senderRids: [String], frame: [LayerActivity]) -> [String: Bool] {
        var byRid: [String: Bool] = [:]
        for entry in frame { byRid[entry.rid] = entry.active }
        var result: [String: Bool] = [:]
        for rid in senderRids {
            if let active = byRid[rid] {
                result[rid] = active
            } else if let alias = aliases[rid], let active = byRid[alias] {
                result[rid] = active
            }
        }
        return result
    }
}
