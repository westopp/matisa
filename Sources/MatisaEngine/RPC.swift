import Foundation

/// JSON-RPC 2.0 dispatch and error model.
///
/// Method handlers are registered with concrete Encodable result types; for
/// methods that take params, register the typed-params overload. The dispatcher
/// is the single boundary between Codable land and the raw bytes that go over
/// the socket.
final class MethodDispatcher {

    typealias Handler = (Data?) throws -> Data

    private var handlers: [String: Handler] = [:]
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    private let decoder = JSONDecoder()

    /// Register a method that takes no params.
    func register<R: Encodable>(_ method: String, _ handler: @escaping () throws -> R) {
        handlers[method] = { [encoder] _ in
            try encoder.encode(handler())
        }
    }

    /// Register a method that takes typed params.
    func register<P: Decodable, R: Encodable>(
        _ method: String,
        _ handler: @escaping (P) throws -> R
    ) {
        handlers[method] = { [encoder, decoder] data in
            guard let data = data else {
                throw RPCError.invalidParams("\(method) requires params")
            }
            let params = try decoder.decode(P.self, from: data)
            return try encoder.encode(handler(params))
        }
    }

    func dispatch(method: String, params: Data?) throws -> Data {
        guard let handler = handlers[method] else {
            throw RPCError.methodNotFound(method)
        }
        return try handler(params)
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
