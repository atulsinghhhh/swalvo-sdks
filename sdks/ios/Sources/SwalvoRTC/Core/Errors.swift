import Foundation

/// A typed SDK error. Codes match the web SDK's `RTCErrorCode`.
public struct RTCError: Error, Equatable, Sendable, CustomStringConvertible {
    public enum Code: String, Sendable, CaseIterable {
        case invalidToken = "INVALID_TOKEN"
        case tokenExpired = "TOKEN_EXPIRED"
        case tokenRevoked = "TOKEN_REVOKED"
        case usageLimitExceeded = "USAGE_LIMIT_EXCEEDED"
        case roomNotFound = "ROOM_NOT_FOUND"
        case connectionFailed = "CONNECTION_FAILED"
        case permissionDenied = "PERMISSION_DENIED"
        case cameraPermissionDenied = "CAMERA_PERMISSION_DENIED"
        case microphonePermissionDenied = "MICROPHONE_PERMISSION_DENIED"
        case deviceNotFound = "DEVICE_NOT_FOUND"
        case networkError = "NETWORK_ERROR"
        case signalingError = "SIGNALING_ERROR"
        case mediaError = "MEDIA_ERROR"
        case unsupported = "UNSUPPORTED"
        case timeout = "TIMEOUT"
        case notConnected = "NOT_CONNECTED"
        /// Phase 5 §3: an E2EE key operation failed. (Kept for source
        /// compatibility; publishing refusals use the two codes below.)
        case e2eeError = "E2EE_ERROR"
        /// The room is end-to-end encrypted and no E2EE key provider is
        /// configured, so publishing was refused rather than sending
        /// plaintext into it (as the web SDK's `E2EE_REQUIRED`).
        case e2eeRequired = "E2EE_REQUIRED"
        /// E2EE is configured (or required) but this build cannot encrypt
        /// media frames (as the web SDK's `E2EE_NOT_SUPPORTED`).
        case e2eeNotSupported = "E2EE_NOT_SUPPORTED"
        /// Phase 7: an argument broke a documented limit (data topic or
        /// destinations too long, metadata or attributes over their caps).
        case invalidArgument = "INVALID_ARGUMENT"
    }

    public let code: Code
    public let message: String
    /// The server's own code, when the error came from an `error` frame.
    public let serverCode: SignalingErrorCode?

    public init(_ code: Code, _ message: String, serverCode: SignalingErrorCode? = nil) {
        self.code = code
        self.message = message
        self.serverCode = serverCode
    }

    public var description: String { "\(code.rawValue): \(message)" }

    /// Maps a server error frame onto an SDK error, as the web SDK's `toError`.
    static func fromServer(_ code: SignalingErrorCode, _ message: String) -> RTCError {
        let mapped: Code
        switch code {
        case .invalidToken: mapped = .invalidToken
        case .tokenExpired: mapped = .tokenExpired
        case .tokenRevoked: mapped = .tokenRevoked
        case .usageLimitExceeded: mapped = .usageLimitExceeded
        case .roomNotFound: mapped = .roomNotFound
        case .unauthorized, .permissionDenied, .originNotAllowed: mapped = .permissionDenied
        case .roomFull, .noRTCCapacity, .rtcServerUnreachable: mapped = .connectionFailed
        case .rateLimited: mapped = .networkError
        default: mapped = .signalingError
        }
        return RTCError(mapped, message, serverCode: code)
    }
}

/// Why a room ended up disconnected. Passed with `RoomEvent.disconnected`.
///
/// The first five match the web SDK's `DisconnectReason`. `tokenRevoked`
/// and `replaced` are native additions for cases the protocol names
/// (`room.left { reason: "TOKEN_REVOKED" }`, close 4002) that the web SDK
/// folds into others.
public enum DisconnectReason: String, Sendable, Equatable {
    case clientInitiated = "CLIENT_INITIATED"
    /// Removed by the server moderation API. Do not rejoin automatically.
    case removed = "REMOVED"
    /// The room was closed. Do not rejoin automatically.
    case roomClosed = "ROOM_CLOSED"
    case tokenExpired = "TOKEN_EXPIRED"
    case tokenRevoked = "TOKEN_REVOKED"
    /// Another connection for the same identity took over (close 4002).
    case replaced = "REPLACED"
    case connectionFailed = "CONNECTION_FAILED"
}

/// Something worth knowing that did not stop the call.
public struct RTCWarning: Equatable, Sendable {
    public enum Code: String, Sendable {
        /// The server says the token expires soon and no `refreshToken` is configured.
        case tokenExpiring = "TOKEN_EXPIRING"
        /// `refreshToken` threw, or the server refused the new token.
        case tokenRefreshFailed = "TOKEN_REFRESH_FAILED"
    }

    public let code: Code
    public let message: String
    /// ISO timestamp the current token expires at, when the server said.
    public let expiresAt: String?

    public init(code: Code, message: String, expiresAt: String? = nil) {
        self.code = code
        self.message = message
        self.expiresAt = expiresAt
    }
}
