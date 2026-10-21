import Foundation

/// What a signaling socket reports.
public enum WebSocketEvent: Equatable, Sendable {
    case text(String)
    /// The socket closed. Always the last event. `code` is the WebSocket
    /// close code (1006 when the connection dropped without one).
    case closed(code: Int, reason: String?)
}

/// One open WebSocket. Abstracted so the signaling state machine can be
/// driven by a fake in tests, with no network.
public protocol WebSocketConnection: AnyObject, Sendable {
    /// Events in arrival order, ending with exactly one `.closed`.
    var events: AsyncStream<WebSocketEvent> { get }
    /// Queues a text frame. Order is preserved.
    func send(_ text: String)
    /// Starts a close handshake. A `.closed` event follows.
    func close(code: Int, reason: String?)
}

/// Opens WebSockets. `open` returns once the socket is open, and throws if
/// it could not be opened within `timeout`.
public protocol WebSocketFactory: Sendable {
    func open(url: URL, timeout: TimeInterval) async throws -> WebSocketConnection
}

// MARK: - URLSession implementation

/// The production transport: `URLSessionWebSocketTask`.
public final class URLSessionWebSocketFactory: WebSocketFactory {
    public init() {}

    public func open(url: URL, timeout: TimeInterval) async throws -> WebSocketConnection {
        let connection = URLSessionWebSocketConnection(url: url)
        try await connection.start(timeout: timeout)
        return connection
    }
}

final class URLSessionWebSocketConnection: NSObject, WebSocketConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    let events: AsyncStream<WebSocketEvent>
    private let continuation: AsyncStream<WebSocketEvent>.Continuation
    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var openContinuation: CheckedContinuation<Void, Error>?
    private var didFinish = false
    private var didOpen = false

    init(url: URL) {
        var cont: AsyncStream<WebSocketEvent>.Continuation!
        events = AsyncStream { cont = $0 }
        continuation = cont
        super.init()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .default, delegate: self, delegateQueue: queue)
        task = session.webSocketTask(with: url)
        // Signaling frames are small; anything this large is not ours.
        task.maximumMessageSize = 4 * 1024 * 1024
    }

    func start(timeout: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.lock()
            openContinuation = cont
            lock.unlock()
            task.resume()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self else { return }
                if self.resolveOpen(with: RTCError(.timeout, "Signaling connection timed out")) {
                    self.task.cancel(with: .goingAway, reason: nil)
                    self.finish(code: CloseCode.abnormal, reason: "open timeout")
                }
            }
        }
        receiveLoop()
    }

    /// Resolves the open continuation once. Returns whether it was pending.
    @discardableResult
    private func resolveOpen(with error: Error?) -> Bool {
        lock.lock()
        let cont = openContinuation
        openContinuation = nil
        if error == nil { didOpen = true }
        lock.unlock()
        guard let cont else { return false }
        if let error { cont.resume(throwing: error) } else { cont.resume() }
        return true
    }

    private func receiveLoop() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    self.continuation.yield(.text(text))
                case let .data(data):
                    // Swalvo signaling is text-only; a binary frame is passed
                    // on as text only if it is valid UTF-8 JSON.
                    if let text = String(data: data, encoding: .utf8) {
                        self.continuation.yield(.text(text))
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                // The close code arrives through the delegate; give it a
                // moment, then fall back to 1006.
                let code = self.task.closeCode
                if code != .invalid {
                    self.finish(code: code.rawValue, reason: self.closeReasonString())
                } else {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                        let late = self.task.closeCode
                        self.finish(code: late == .invalid ? CloseCode.abnormal : late.rawValue,
                                    reason: self.closeReasonString())
                    }
                }
            }
        }
    }

    private func closeReasonString() -> String? {
        task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
    }

    private func finish(code: Int, reason: String?) {
        lock.lock()
        let already = didFinish
        didFinish = true
        lock.unlock()
        guard !already else { return }
        resolveOpen(with: RTCError(.networkError, "The signaling connection closed (code \(code))"))
        continuation.yield(.closed(code: code, reason: reason))
        continuation.finish()
        session.invalidateAndCancel()
    }

    func send(_ text: String) {
        task.send(.string(text)) { _ in
            // A failed send is followed by the socket closing, which is
            // where reconnection is decided.
        }
    }

    func close(code: Int, reason: String?) {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task.cancel(with: closeCode, reason: reason.map { Data($0.utf8) })
        // URLSession does not always report our own close back through the
        // delegate; report it ourselves.
        finish(code: code, reason: reason)
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        resolveOpen(with: nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) })
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = webSocketCloseCode()
        if !isOpen() {
            resolveOpen(with: RTCError(.networkError, "Could not reach the signaling endpoint"))
        }
        finish(code: code, reason: closeReasonString())
    }

    private func isOpen() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return didOpen
    }

    private func webSocketCloseCode() -> Int {
        let code = task.closeCode
        return code == .invalid ? CloseCode.abnormal : code.rawValue
    }
}
