import Foundation

/// Fans one event out to any number of `AsyncStream` consumers. Each call
/// to `stream()` gets its own stream that ends when the consumer stops
/// iterating or the broadcaster finishes.
@MainActor
final class EventBroadcaster<Event: Sendable> {
    private var continuations: [UUID: AsyncStream<Event>.Continuation] = [:]
    private var finished = false

    func stream() -> AsyncStream<Event> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            guard !finished else {
                continuation.finish()
                return
            }
            let id = UUID()
            continuations[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.continuations.removeValue(forKey: id) }
            }
        }
    }

    func emit(_ event: Event) {
        for continuation in continuations.values {
            continuation.yield(event)
        }
    }

    func finish() {
        finished = true
        for continuation in continuations.values {
            continuation.finish()
        }
        continuations = [:]
    }
}
