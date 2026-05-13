import Foundation
import Darwin

/// Owns a single accepted client fd. Reads newline-delimited JSON-RPC
/// requests, hands them to `JSONRPCEnvelope`, writes responses back. Closes
/// the fd when the peer hangs up.
///
/// Framing: NDJSON (one JSON object per line). Compact encoding only.
/// Sufficient for phase 0/1; if we ever need messages with embedded newlines
/// (we won't — JSON encoders escape them) we can swap to length-prefix.
struct ConnectionHandler {

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
            if let response = envelope.handle(line) {
                writeLine(response)
            }
        }
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
