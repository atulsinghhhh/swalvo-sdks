import Foundation

/// The RTC token's payload, decoded *without* verification — the server is
/// the source of truth. Reads Swalvo's own claim names (`rid`, `rnm`,
/// `sub`, `exp`, `e2ee`), like the web SDK's `decodeTokenPayload`.
public struct TokenClaims: Equatable, Sendable {
    /// `rid`: the room's id.
    public var roomId: String?
    /// `rnm`: the room's name.
    public var roomName: String?
    /// `sub`: the participant identity.
    public var identity: String?
    /// `exp`, seconds since the epoch.
    public var expiresAt: Date?
    /// Phase 5 §3.1: set for E2EE rooms.
    public var e2ee: Bool
    /// Phase 7 §2 `md`: this participant's initial metadata.
    public var metadata: String? = nil
    /// Phase 7 §2 `attrs`: this participant's initial attributes.
    public var attributes: [String: String] = [:]
    /// Phase 7 §2 `perms.updateOwnMetadata`: may change its own metadata.
    public var canUpdateOwnMetadata: Bool = false
    /// `perms.publishData`, or nil when the token carries no `perms` claim.
    public var canPublishData: Bool? = nil

    public static func decode(_ token: String) throws -> TokenClaims {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw RTCError(.invalidToken, "RTC token is malformed (expected a JWT with 3 parts)")
        }
        guard let data = Data(base64URLEncoded: String(parts[1])),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw RTCError(.invalidToken, "RTC token payload could not be decoded")
        }
        var claims = TokenClaims(roomId: nil, roomName: nil, identity: nil, expiresAt: nil, e2ee: false)
        claims.roomId = object["rid"] as? String
        claims.roomName = object["rnm"] as? String
        claims.identity = object["sub"] as? String
        if let exp = object["exp"] as? NSNumber {
            claims.expiresAt = Date(timeIntervalSince1970: exp.doubleValue)
        }
        claims.e2ee = (object["e2ee"] as? Bool) ?? false
        claims.metadata = object["md"] as? String
        if let attrs = object["attrs"] as? [String: Any] {
            claims.attributes = attrs.compactMapValues { $0 as? String }
        }
        if let perms = object["perms"] as? [String: Any] {
            claims.canUpdateOwnMetadata = (perms["updateOwnMetadata"] as? Bool) ?? false
            claims.canPublishData = (perms["publishData"] as? Bool) ?? false
        }
        return claims
    }
}

extension Data {
    /// Decodes unpadded base64url, as found in a JWT.
    init?(base64URLEncoded string: String) {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: base64)
    }
}
