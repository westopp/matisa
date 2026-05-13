import Foundation

/// JSON-RPC 2.0 dispatch and error model.
///
/// Method handlers are registered with concrete Encodable result types; for
/// methods that take params, register the typed-params overload. The dispatcher
/// is the single boundary between Codable land and the raw bytes that go over
/// the socket.
///
/// Handlers are async so lifecycle methods (start/stop/kill/restart) can
/// `await` without blocking the dispatcher worker. Sync closures still work —
/// Swift transparently lifts a sync `() throws -> R` into an
/// `() async throws -> R` parameter, so existing pure-data registrations need
/// no changes at the call site.
///
/// Marked `@unchecked Sendable` because registration is single-threaded at
/// init time and the handlers dictionary is read-only after that. Captures
/// inside handlers must enforce their own thread-safety.
final class MethodDispatcher: @unchecked Sendable {

    typealias Handler = @Sendable (Data?) async throws -> Data

    private var handlers: [String: Handler] = [:]
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    private let decoder = JSONDecoder()

    /// Register a method that takes no params.
    func register<R: Encodable>(_ method: String, _ handler: @Sendable @escaping () async throws -> R) {
        handlers[method] = { [encoder] _ in
            try encoder.encode(try await handler())
        }
    }

    /// Register a method that takes typed params.
    func register<P: Decodable, R: Encodable>(
        _ method: String,
        _ handler: @Sendable @escaping (P) async throws -> R
    ) {
        handlers[method] = { [encoder, decoder] data in
            guard let data = data else {
                throw RPCError.invalidParams("\(method) requires params")
            }
            let params = try decoder.decode(P.self, from: data)
            return try encoder.encode(try await handler(params))
        }
    }

    /// Register a method that produces already-formed JSON bytes. Use for
    /// pass-through of a downstream tool's JSON output (e.g. `config.get`
    /// returning the bun eval result verbatim) where Codable round-tripping
    /// adds cost and risks shape drift.
    func registerRaw(_ method: String, _ handler: @Sendable @escaping () async throws -> Data) {
        handlers[method] = { _ in try await handler() }
    }

    func dispatch(method: String, params: Data?) async throws -> Data {
        guard let handler = handlers[method] else {
            throw RPCError.methodNotFound(method)
        }
        return try await handler(params)
    }
}

/// JSON-RPC 2.0 error model. Codes follow the spec:
/// https://www.jsonrpc.org/specification#error_object
enum RPCError: Error {
    case parseError(String)             // -32700
    case invalidRequest(String)         // -32600
    case methodNotFound(String)         // -32601
    case invalidParams(String)          // -32602
    case internalError(String)          // -32603

    var code: Int {
        switch self {
        case .parseError:     return -32700
        case .invalidRequest: return -32600
        case .methodNotFound: return -32601
        case .invalidParams:  return -32602
        case .internalError:  return -32603
        }
    }

    var message: String {
        switch self {
        case .parseError(let m),
             .invalidRequest(let m),
             .invalidParams(let m),
             .internalError(let m): return m
        case .methodNotFound(let name): return "Method not found: \(name)"
        }
    }
}
