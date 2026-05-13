import Foundation
import Darwin

/// Owns a single accepted client fd. Reads newline-delimited JSON-RPC
/// requests, hands each to `JSONRPCEnvelope`, writes responses back. Closes
/// the fd when the peer hangs up.
///
/// **Threading:** `run()` is invoked on `UnixSocketServer.workerQueue` (a
/// growing concurrent dispatch queue). The blocking `read(2)` in `LineReader`
/// holds that worker thread for the lifetime of the connection, which is the
/// right context for a syscall that may block indefinitely — dispatch worker
/// threads scale; the Swift concurrency cooperative pool does not. Each
/// dispatcher invocation runs as a `Task` on the cooperative pool, so handlers
/// can `await` freely; we use a `DispatchSemaphore` to bring the bytes back to
/// the synchronous caller. The caller is going to block on the next `read(2)`
/// anyway, so blocking briefly on the dispatch result is no worse.
///
/// Framing: NDJSON (one JSON object per line). Compact encoding only.
struct ConnectionHandler: Sendable {

    let fd: Int32
    let dispatcher: MethodDispatcher

    func run() {
        defer { close(fd) }
        let envelope = JSONRPCEnvelope(dispatcher: dispatcher)
        let reader = LineReader(fd: fd)
        while let line = reader.readLine() {
            if line.isEmpty { continue }
            // handle() returns nil for notifications (JSON-RPC 2.0 §4.1:
            // "The Server MUST NOT reply to a Notification.").
            if let response = awaitHandle(envelope: envelope, line: line) {
                writeLine(response)
            }
        }
    }

    /// Bridge the async envelope back to the synchronous worker-queue caller.
    /// The Task runs on the cooperative pool — the handler can `await` —
    /// while this thread is parked on the semaphore. The semaphore signal
    /// happens-after the box write, establishing a synchronization edge so
    /// the surrounding sync context's read of `box.value` is well-defined.
    private func awaitHandle(envelope: JSONRPCEnvelope, line: Data) -> Data? {
        let semaphore = DispatchSemaphore(value: 0)
        let box = Box<Data>()
        Task {
            box.value = await envelope.handle(line)
            semaphore.signal()
        }
        semaphore.wait()
        return box.value
    }

    private func writeLine(_ data: Data) {
        var payload = data
        payload.append(0x0A) // '\n'
        payload.withUnsafeBytes { buf in
            guard let base = buf.baseAddress else { return }
            var remaining = buf.count
            var ptr = base
            while remaining > 0 {
                let n = write(fd, ptr, remaining)
                if n <= 0 {
                    if errno == EINTR { continue }
                    return // peer hung up; outer loop will catch the read EOF
                }
                ptr = ptr.advanced(by: n)
                remaining -= n
            }
        }
    }
}

/// Mutable reference cell used to ferry a value out of a Task back to a
/// synchronous caller that's parked on a DispatchSemaphore. `@unchecked
/// Sendable` is sound here because the semaphore signal/wait pair establishes
/// the necessary happens-before edge between the Task's write and the
/// caller's read.
private final class Box<T>: @unchecked Sendable {
    var value: T?
    init() {}
}
