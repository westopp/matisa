import Foundation

/// JSON-RPC 2.0 request-line handling, pulled out of the I/O glue so it can
/// be unit-tested as a pure `Data -> Data?` function. `ConnectionHandler` is
/// the only production caller — it reads lines off the wire, hands them
/// here, writes the result back.
///
/// Returns nil for notifications (spec §4.1: server MUST NOT reply).
struct JSONRPCEnvelope {

    let dispatcher: MethodDispatcher

    func handle(_ line: Data) async -> Data? {
        // Parse the envelope as a generic dictionary. We only need a few
        // top-level fields; everything else flows through opaquely.
        let obj: Any
        do {
            obj = try JSONSerialization.jsonObject(with: line, options: [.fragmentsAllowed])
        } catch {
            return encodeError(id: nil, code: -32700, message: "Parse error: \(error.localizedDescription)")
        }
        // Deliberate phase 0/1 punt: JSON-RPC 2.0 §6 batch requests
        // (top-level JSON array) are not supported. Conformant clients get
        // -32600 with id=null. When batch lands, the NDJSON framing also has
        // to change — one response *line* containing a JSON array of
        // responses, not N response lines. Don't add it casually.
        guard let dict = obj as? [String: Any] else {
            return encodeError(id: nil, code: -32600, message: "Invalid Request: top-level must be an object")
        }

        // Distinguish "id absent" (notification) from "id present and null"
        // (request with explicit null id). Dictionary[K] returns nil only for
        // absent keys; NSNull is a non-nil value.
        let isNotification = (dict["id"] == nil)

        // Validate id type when present. Spec §4: id MUST be a String, Number,
        // or Null. For anything else id is "indeterminable" → respond with
        // null per §5.1 and never as a notification.
        let id: Any?
        if isNotification {
            id = nil
        } else {
            switch dict["id"] {
            case is NSNull:
                id = NSNull()
            case let s as String:
                id = s
            case let n as NSNumber:
                // JSONSerialization parses true/false as NSNumber wrapping
                // kCFBoolean. Reject booleans per spec.
                if CFGetTypeID(n) == CFBooleanGetTypeID() {
                    return encodeError(id: nil, code: -32600, message: "Invalid Request: id must be string, number, or null")
                }
                id = n
            default:
                return encodeError(id: nil, code: -32600, message: "Invalid Request: id must be string, number, or null")
            }
        }

        // Method must be a non-empty string. For notifications we still
        // dispatch (if valid) but never respond.
        guard let method = dict["method"] as? String, !method.isEmpty else {
            return isNotification ? nil
                : encodeError(id: id, code: -32600, message: "Invalid Request: missing method")
        }

        // Re-serialize params back to bytes so the dispatcher can hand them
        // to a typed Decodable. Slight redundancy in the no-params path, but
        // it keeps the dispatcher's contract simple.
        let paramsData: Data?
        if let params = dict["params"] {
            paramsData = try? JSONSerialization.data(withJSONObject: params, options: [])
        } else {
            paramsData = nil
        }

        do {
            let resultBytes = try await dispatcher.dispatch(method: method, params: paramsData)
            return isNotification ? nil : encodeSuccess(id: id, resultBytes: resultBytes)
        } catch let err as RPCError {
            return isNotification ? nil
                : encodeError(id: id, code: err.code, message: err.message)
        } catch {
            return isNotification ? nil
                : encodeError(id: id, code: -32603, message: "Internal error: \(error)")
        }
    }

    // MARK: - Response encoding
    //
    // We assemble the envelope by hand rather than using a Codable type — the
    // `id` field is allowed to be string | number | null, which doesn't map
    // cleanly to a single Swift type, and the `result` is already encoded.

    private func encodeSuccess(id: Any?, resultBytes: Data) -> Data {
        let resultObj = (try? JSONSerialization.jsonObject(with: resultBytes, options: [.fragmentsAllowed])) ?? NSNull()
        let dict: [String: Any] = [
            "jsonrpc": "2.0",
            "result": resultObj,
            "id": id ?? NSNull(),
        ]
        return (try? JSONSerialization.data(withJSONObject: dict, options: [])) ?? Data()
    }

    private func encodeError(id: Any?, code: Int, message: String) -> Data {
        let dict: [String: Any] = [
            "jsonrpc": "2.0",
            "error": ["code": code, "message": message],
            "id": id ?? NSNull(),
        ]
        return (try? JSONSerialization.data(withJSONObject: dict, options: [])) ?? Data()
    }
}
