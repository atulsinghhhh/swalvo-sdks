import Foundation
#if canImport(os)
import os
#endif

public enum LogLevel: Int, Comparable, Sendable {
    case debug = 0, info, warn, error, silent

    public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The SDK's logger. Silent by default; set `SwalvoClient.Options.logLevel`.
/// Never logs tokens or SDP bodies above `debug`.
public final class RTCLogger: @unchecked Sendable {
    public let level: LogLevel
    /// Optional sink, for routing SDK logs into the app's own logging.
    public let sink: (@Sendable (LogLevel, String) -> Void)?
    #if canImport(os)
    private let osLog = Logger(subsystem: "com.swalvo.rtc", category: "SwalvoRTC")
    #endif

    public init(level: LogLevel = .silent, sink: (@Sendable (LogLevel, String) -> Void)? = nil) {
        self.level = level
        self.sink = sink
    }

    func debug(_ message: @autoclosure () -> String) { log(.debug, message()) }
    func info(_ message: @autoclosure () -> String) { log(.info, message()) }
    func warn(_ message: @autoclosure () -> String) { log(.warn, message()) }
    func error(_ message: @autoclosure () -> String) { log(.error, message()) }

    private func log(_ messageLevel: LogLevel, _ message: @autoclosure () -> String) {
        guard messageLevel >= level, level != .silent else { return }
        let text = message()
        if let sink {
            sink(messageLevel, text)
            return
        }
        #if canImport(os)
        switch messageLevel {
        case .debug: osLog.debug("\(text, privacy: .public)")
        case .info: osLog.info("\(text, privacy: .public)")
        case .warn: osLog.warning("\(text, privacy: .public)")
        case .error, .silent: osLog.error("\(text, privacy: .public)")
        }
        #else
        print("[SwalvoRTC] \(text)")
        #endif
    }
}
