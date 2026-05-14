import Foundation
import Darwin
import MatisaCore

/// Thin JSON-RPC 2.0 client over a Unix domain socket. One-shot semantics:
/// each `call` opens a fresh connection, sends one request line, reads one
/// response line, closes. That's enough for phase 2a (config.get is cheap
/// and infrequent); the long-lived connection model will land alongside
/// streaming in phase 5.
///
/// The client is intentionally minimal — it doesn't spawn the engine, doesn't
/// retry, doesn't keep connections warm. Reachability is the caller's
/// responsibility: today, the app keeps a local fallback path so the UI
/// degrades gracefully when the engine isn't running.
actor EngineClient {

    static let shared = EngineClient()

    /// Socket path resolution mirrors the engine's:
    ///   1. $MATISA_SOCKET
    ///   2. ~/Library/Application Support/Matisa/matisa.sock
    static func defaultSocketPath() -> String {
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

    enum ClientError: Error, CustomStringConvertible {
        case engineUnreachable(String)
        case rpcError(code: Int, message: String)
        case protocolError(String)
        case decodeFailed(String)

        var description: String {
            switch self {
            case .engineUnreachable(let m): return "engine unreachable: \(m)"
            case .rpcError(let c, let m):   return "rpc error \(c): \(m)"
            case .protocolError(let m):     return "protocol error: \(m)"
            case .decodeFailed(let m):      return "decode failed: \(m)"
            }
        }
    }

    private var nextID: Int = 1
    private let socketPath: String

    init(socketPath: String = EngineClient.defaultSocketPath()) {
        self.socketPath = socketPath
    }

    /// True if the engine socket exists and accepts a connection right now.
    /// Cheap probe — opens and immediately closes a socket. Use this when the
    /// caller wants to decide between RPC and a local fallback without paying
    /// for a full call+timeout.
    func isReachable() -> Bool {
        guard let fd = openConnection() else { return false }
        close(fd)
        return true
    }

    /// Send a request, return the raw JSON bytes of the `result` field.
    /// Throws on transport failure, JSON-RPC error response, or malformed
    /// response. Callers that want a typed result should pass the bytes to
    /// `JSONDecoder().decode(T.self, from: data)`.
    func callRaw(_ method: String, params: Encodable? = nil) throws -> Data {
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
    func call<R: Decodable>(_ method: String, params: Encodable? = nil, as: R.Type = R.self) throws -> R {
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
    func shutdown() throws {
        _ = try callRaw("engine.shutdown")
    }

    /// Like `call(_:params:as:)` but if the engine is unreachable, attempts
    /// to spawn it once via `EngineLauncher.ensureRunning` and retries.
    /// Use this for caller code paths where the engine is expected to be
    /// running — the app's lifecycle methods.
    func callEnsuringEngine<R: Decodable>(
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
            // Don't throw — just log to stderr in debug builds.
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
// Mirror images of the engine's `ServiceIDParams: Decodable` /
// `EmptyResponse: Encodable`. The engine decodes what the app encodes here,
// and the app decodes what the engine encodes there. Tiny enough to keep
// out of MatisaCore — they're shape-only and don't escape the JSON-RPC seam.

struct ServiceIDParams: Encodable {
    let id: String
}

/// Mirror of the engine's `ServiceLifecycleParams`. Used for the lifecycle
/// RPCs that (re)spawn — start, restart, take_over — to carry the globally
/// selected env context name so the engine can resolve project env as
/// `base + that overlay` rather than base only.
struct ServiceLifecycleClientParams: Encodable {
    let id: String
    let activeEnvContext: String?
}

struct EmptyResponse: Decodable {}

/// Mirror of the engine's `TaskStartParams`. `TaskKind` rides as a string
/// since it's `Codable` via its `String` RawValue.
struct TaskStartClientParams: Encodable {
    let id: String
    let kind: MatisaCore.TaskKind
    let name: String
    let command: String
    let cwd: URL
    let extraEnv: [String: String]
}

/// Mirror of the engine's `TaskCancelParams`. Shared by `tasks.cancel`,
/// `tasks.clear`, and `tasks.close_pane`.
struct TaskCancelClientParams: Encodable {
    let id: String
    let kind: MatisaCore.TaskKind
}

/// Mirror of the engine's `EngineStatus`. Decoded from `engine.status` RPC
/// responses. Kept in lock-step with the engine-side type in
/// `Sources/MatisaEngine/Methods.swift`.
struct EngineStatusInfo: Decodable {
    let status: String
    let version: String
    let uptimeSeconds: Int
}
