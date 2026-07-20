import Foundation
import Darwin

/// Thin JSON-RPC 2.0 client over a Unix domain socket. One-shot semantics:
/// each `call` opens a fresh connection, sends one request line, reads one
/// response line, closes. Enough for the request/response surface today; the
/// long-lived connection model lands alongside streaming in phase 5.
///
/// Lives in MatisaCore so the app, CLI, and (later) MCP/widget all share one
/// implementation of the wire. The client is intentionally minimal — it
/// doesn't spawn the engine on its own, doesn't retry, doesn't keep
/// connections warm. Spawn policy is the caller's concern (the app silently
/// auto-spawns via `callEnsuringEngine`; the CLI fails loud unless invoked
/// with `--ensure-engine`).
public actor EngineClient {

    public static let shared = EngineClient()

    /// Socket path resolution mirrors the engine's:
    ///   1. $MATISA_SOCKET
    ///   2. ~/Library/Application Support/Matisa/matisa.sock
    public static func defaultSocketPath() -> String {
        if let override = ProcessInfo.processInfo.environment["MATISA_SOCKET"],
           !override.isEmpty {
            return override
        }
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
        return appSupport
            .appendingPathComponent("Matisa", isDirectory: true)
            .appendingPathComponent("matisa.sock")
            .path
    }

    public enum ClientError: Error, CustomStringConvertible {
        case engineUnreachable(String)
        case rpcError(code: Int, message: String)
        case protocolError(String)
        case decodeFailed(String)

        public var description: String {
            switch self {
            case .engineUnreachable(let m): return "engine unreachable: \(m)"
            case .rpcError(let c, let m):   return "rpc error \(c): \(m)"
            case .protocolError(let m):     return "protocol error: \(m)"
            case .decodeFailed(let m):      return "decode failed: \(m)"
            }
        }
    }

    private var nextID: Int = 1
    public let socketPath: String

    /// Per-call read/write timeout. 5s is plenty for any RPC in today's
    /// surface — `services.snapshot` is the slowest and lands well under
    /// a second in practice. The timeout exists so a stuck engine
    /// (listening fd still alive via an inherited child after the
    /// engine crashed; see plan.md's FD_CLOEXEC fix) surfaces as a
    /// clean `engineUnreachable("read timeout")` instead of hanging
    /// the CLI / app forever.
    ///
    /// Set per-instance so the rare caller that needs longer can opt in;
    /// streaming RPCs in Phase 5 will want a much larger value.
    public let timeoutSeconds: Int

    public init(
        socketPath: String = EngineClient.defaultSocketPath(),
        timeoutSeconds: Int = 5
    ) {
        self.socketPath = socketPath
        self.timeoutSeconds = timeoutSeconds
    }

    /// True if the engine socket exists and accepts a connection right now.
    /// Cheap probe — opens and immediately closes a socket. Use this when the
    /// caller wants to decide between RPC and a local fallback without paying
    /// for a full call+timeout.
    public func isReachable() -> Bool {
        guard let fd = openConnection() else { return false }
        close(fd)
        return true
    }

    /// Send a request, return the raw JSON bytes of the `result` field.
    /// Throws on transport failure, JSON-RPC error response, or malformed
    /// response. Callers that want a typed result should pass the bytes to
    /// `JSONDecoder().decode(T.self, from: data)`.
    public func callRaw(_ method: String, params: Encodable? = nil) throws -> Data {
        let id = nextID
        nextID += 1

        let requestBytes = try buildRequest(method: method, params: params, id: id)

        guard let fd = openConnection() else {
            throw ClientError.engineUnreachable("could not connect to \(socketPath)")
        }
        defer { close(fd) }

        try writeAll(fd: fd, data: requestBytes + Data([0x0A]))

        let line = try readLine(fd: fd)
        return try extractResult(responseLine: line, expectedID: id)
    }

    /// Typed convenience: decode the `result` field as `R`.
    public func call<R: Decodable>(_ method: String, params: Encodable? = nil, as: R.Type = R.self) throws -> R {
        let bytes = try callRaw(method, params: params)
        do {
            return try JSONDecoder().decode(R.self, from: bytes)
        } catch {
            throw ClientError.decodeFailed("\(error)")
        }
    }

    /// Request a clean engine shutdown over the wire. Returns when the
    /// engine has acked the request — the engine then exits ~100ms later.
    /// Callers that want to confirm the process actually exited can poll
    /// `isReachable()` afterwards.
    public func shutdown() throws {
        _ = try callRaw("engine.shutdown")
    }

    /// Like `call(_:params:as:)` but if the engine is unreachable, attempts
    /// to spawn it once via `EngineLauncher.ensureRunning` and retries.
    /// Use this for caller code paths where the engine is expected to be
    /// running — the app's lifecycle methods, or any CLI invocation made
    /// with `--ensure-engine`.
    public func callEnsuringEngine<R: Decodable>(
        _ method: String,
        params: Encodable? = nil,
        as: R.Type = R.self
    ) async throws -> R {
        do {
            return try call(method, params: params, as: R.self)
        } catch ClientError.engineUnreachable {
            _ = try await EngineLauncher.ensureRunning(socketPath: socketPath)
            return try call(method, params: params, as: R.self)
        }
    }

    // MARK: - Wire

    private func buildRequest(method: String, params: Encodable?, id: Int) throws -> Data {
        var dict: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "id": id,
        ]
        if let params {
            let encoded = try JSONEncoder().encode(AnyEncodable(params))
            dict["params"] = try JSONSerialization.jsonObject(with: encoded)
        }
        return try JSONSerialization.data(withJSONObject: dict, options: [])
    }

    private func extractResult(responseLine: Data, expectedID: Int) throws -> Data {
        guard let obj = try? JSONSerialization.jsonObject(with: responseLine) as? [String: Any] else {
            throw ClientError.protocolError("response is not a JSON object")
        }
        if let err = obj["error"] as? [String: Any] {
            let code = err["code"] as? Int ?? -1
            let msg = err["message"] as? String ?? "(no message)"
            throw ClientError.rpcError(code: code, message: msg)
        }
        // Light id sanity check — useful when we move to multiplexed
        // connections later. Ignore mismatches today; one-shot semantics
        // mean a stale id would only show up after a misbehaving engine.
        if let returnedID = obj["id"] as? Int, returnedID != expectedID {
            #if DEBUG
            FileHandle.standardError.write(Data("EngineClient: id mismatch (\(returnedID) vs \(expectedID))\n".utf8))
            #endif
        }
        guard let result = obj["result"] else {
            throw ClientError.protocolError("response has neither result nor error")
        }
        return try JSONSerialization.data(withJSONObject: result, options: [])
    }

    // MARK: - Socket I/O

    /// Open and connect a UDS to `socketPath`. Returns nil if the engine is
    /// not reachable (no socket, refused, etc.) — callers treat that as
    /// "engine down" and fall back.
    private func openConnection() -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            close(fd)
            return nil
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: capacity) { bp in
                for (i, b) in pathBytes.enumerated() { bp[i] = b }
                bp[pathBytes.count] = 0
            }
        }
        let connectResult = withUnsafePointer(to: &addr) { addrPtr -> Int32 in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connectResult != 0 {
            close(fd)
            return nil
        }

        // SO_RCVTIMEO / SO_SNDTIMEO so a stuck engine doesn't hang us
        // indefinitely. Triggers `EAGAIN` from read(2) / write(2) after
        // `timeoutSeconds`, which `readLine` / `writeAll` translate into
        // a clean `engineUnreachable("read timeout")`.
        var tv = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        let sz = socklen_t(MemoryLayout<timeval>.size)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sz)
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sz)
        return fd
    }

    private func writeAll(fd: Int32, data: Data) throws {
        try data.withUnsafeBytes { buf -> Void in
            guard let base = buf.baseAddress else { return }
            var remaining = buf.count
            var ptr = base
            while remaining > 0 {
                let n = write(fd, ptr, remaining)
                if n <= 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN || errno == EWOULDBLOCK {
                        throw ClientError.engineUnreachable(
                            "write timeout (\(timeoutSeconds)s) — engine not responding"
                        )
                    }
                    throw ClientError.engineUnreachable("write failed: \(String(cString: strerror(errno)))")
                }
                ptr = ptr.advanced(by: n)
                remaining -= n
            }
        }
    }

    private func readLine(fd: Int32) throws -> Data {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                return Data(buffer[..<nl])
            }
            let n = chunk.withUnsafeMutableBufferPointer { b -> Int in
                Darwin.read(fd, b.baseAddress, b.count)
            }
            if n > 0 {
                buffer.append(contentsOf: chunk[..<n])
                continue
            }
            if n == 0 {
                if !buffer.isEmpty { return buffer }
                throw ClientError.protocolError("connection closed before response")
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                throw ClientError.engineUnreachable(
                    "read timeout (\(timeoutSeconds)s) — engine not responding"
                )
            }
            throw ClientError.engineUnreachable("read failed: \(String(cString: strerror(errno)))")
        }
    }
}

/// Type-erased Encodable so `call(params:)` can accept any Encodable value
/// without becoming generic over the params type.
private struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void
    init(_ value: Encodable) {
        self._encode = { encoder in try value.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try _encode(encoder) }
}

// MARK: - Shared RPC param/response shapes
//
// Mirror images of the engine-side `Params` / `EmptyResponse` types defined in
// `Sources/MatisaEngine/Methods.swift`. The engine decodes what clients encode
// here, and clients decode what the engine encodes there. Kept here (not in
// the engine target) because every client — app, CLI, future widget/MCP —
// needs to construct or consume them; the engine's own decode-side copies
// stay alongside the dispatcher.

public struct ServiceIDParams: Encodable {
    public let id: String
    public init(id: String) { self.id = id }
}

/// Mirror of the engine's `ServiceLifecycleParams`. Used for the lifecycle
/// RPCs that (re)spawn — start, restart, take_over — to carry the globally
/// selected env context name so the engine can resolve project env as
/// `base + that overlay` rather than base only.
public struct ServiceLifecycleClientParams: Encodable {
    public let id: String
    public let activeEnvContext: String?
    public init(id: String, activeEnvContext: String?) {
        self.id = id
        self.activeEnvContext = activeEnvContext
    }
}

public struct EmptyResponse: Decodable {
    public init() {}
}

/// Mirror of the engine's `TaskStartParams`. Slot identity is the command
/// `name` (the user-visible label from the service's `commands:` block).
public struct TaskStartClientParams: Encodable {
    public let id: String
    public let name: String
    public let command: String
    public let cwd: URL
    public let extraEnv: [String: String]
    public init(id: String, name: String, command: String, cwd: URL, extraEnv: [String: String]) {
        self.id = id; self.name = name; self.command = command
        self.cwd = cwd; self.extraEnv = extraEnv
    }
}

/// Mirror of the engine's `TaskCancelParams`. Shared by `tasks.cancel`,
/// `tasks.clear`, and `tasks.close_pane`.
public struct TaskCancelClientParams: Encodable {
    public let id: String
    public let name: String
    public init(id: String, name: String) {
        self.id = id; self.name = name
    }
}

/// Mirror of the engine's `EngineStatus`. Decoded from `engine.status` RPC
/// responses. Kept in lock-step with the engine-side type in
/// `Sources/MatisaEngine/Methods.swift`.
public struct EngineStatusInfo: Decodable {
    public let status: String
    public let version: String
    public let uptimeSeconds: Int
    public init(status: String, version: String, uptimeSeconds: Int) {
        self.status = status
        self.version = version
        self.uptimeSeconds = uptimeSeconds
    }
}
