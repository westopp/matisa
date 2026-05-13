import XCTest
@testable import MatisaEngine

/// Tier 1 — pin down the JSON-RPC 2.0 wire contract.
/// These tests are the canonical "what does Matisa speak?" reference; every
/// future client (CLI, MCP, widget, app) codes against this shape.
final class JSONRPCEnvelopeTests: XCTestCase {

    // MARK: - Test fixtures

    private struct Pong: Codable {
        let value: String
    }

    private struct EchoParams: Codable {
        let message: String
    }

    private func makeEnvelope() -> JSONRPCEnvelope {
        let dispatcher = MethodDispatcher()
        dispatcher.register("ping") { () -> Pong in
            Pong(value: "ok")
        }
        dispatcher.register("echo") { (p: EchoParams) -> EchoParams in
            p
        }
        dispatcher.register("explode") { () -> Pong in
            throw RPCError.internalError("kaboom")
        }
        dispatcher.register("badparams") { () -> Pong in
            throw RPCError.invalidParams("bad")
        }
        // `raw_passthrough` exercises the registerRaw path used by config.get
        // — the handler returns pre-formed JSON bytes that should appear
        // unchanged in the response's `result` field.
        dispatcher.registerRaw("raw_passthrough") {
            Data(#"{"already":"json","values":[1,2,3]}"#.utf8)
        }
        return JSONRPCEnvelope(dispatcher: dispatcher)
    }

    private func responseDict(_ data: Data?) -> [String: Any]? {
        guard let data = data else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func line(_ json: String) -> Data {
        json.data(using: .utf8)!
    }

    // MARK: - Happy path

    func testValidRequest_returnsSuccessResponse() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":1}"#))
        let dict = responseDict(out)!
        XCTAssertEqual(dict["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(dict["id"] as? Int, 1)
        XCTAssertNil(dict["error"])
        let result = dict["result"] as? [String: Any]
        XCTAssertEqual(result?["value"] as? String, "ok")
    }

    func testRequestWithStringId_echoesId() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":"abc-123"}"#))
        XCTAssertEqual(responseDict(out)?["id"] as? String, "abc-123")
    }

    func testRequestWithNumericId_echoesId() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":42}"#))
        XCTAssertEqual(responseDict(out)?["id"] as? Int, 42)
    }

    func testRequestWithNullId_responseHasNullId() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":null}"#))
        let dict = responseDict(out)!
        XCTAssertTrue(dict["id"] is NSNull)
        XCTAssertNotNil(dict["result"])
    }

    func testRequestWithParams_paramsReachHandler() async {
        let out = await makeEnvelope().handle(
            line(#"{"jsonrpc":"2.0","method":"echo","params":{"message":"hi"},"id":1}"#)
        )
        let result = responseDict(out)?["result"] as? [String: Any]
        XCTAssertEqual(result?["message"] as? String, "hi")
    }

    func testResponseAlwaysHasJsonrpcField() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":1}"#))
        XCTAssertEqual(responseDict(out)?["jsonrpc"] as? String, "2.0")
    }

    // MARK: - Notifications (F-002 regression coverage)

    func testNotificationWithoutId_returnsNil() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping"}"#))
        XCTAssertNil(out)
    }

    func testNotificationWithMissingMethod_returnsNil() async {
        // No id and no method — still a notification, server MUST NOT respond.
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0"}"#))
        XCTAssertNil(out)
    }

    func testNotificationWithUnknownMethod_returnsNil() async {
        // Dispatch fails internally, but spec is clear: no response, ever.
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"does_not_exist"}"#))
        XCTAssertNil(out)
    }

    func testNotificationWithThrowingHandler_returnsNil() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"explode"}"#))
        XCTAssertNil(out)
    }

    // MARK: - id type validation (F-007 regression coverage)

    func testRequestWithBoolId_returnsInvalidRequestAndNullId() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":true}"#))
        let dict = responseDict(out)!
        XCTAssertTrue(dict["id"] is NSNull)
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32600)
    }

    func testRequestWithArrayId_returnsInvalidRequest() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":[1,2]}"#))
        let dict = responseDict(out)!
        XCTAssertTrue(dict["id"] is NSNull)
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32600)
    }

    func testRequestWithObjectId_returnsInvalidRequest() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"ping","id":{"x":1}}"#))
        let dict = responseDict(out)!
        XCTAssertTrue(dict["id"] is NSNull)
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32600)
    }

    // MARK: - Invalid Request

    func testMissingMethod_returnsInvalidRequest() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","id":1}"#))
        let dict = responseDict(out)!
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32600)
        XCTAssertEqual(dict["id"] as? Int, 1)
    }

    func testEmptyMethod_returnsInvalidRequest() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"","id":1}"#))
        XCTAssertEqual(
            (responseDict(out)?["error"] as? [String: Any])?["code"] as? Int,
            -32600
        )
    }

    // MARK: - Method not found

    func testUnknownMethod_returnsMethodNotFoundError() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"does_not_exist","id":1}"#))
        XCTAssertEqual(
            (responseDict(out)?["error"] as? [String: Any])?["code"] as? Int,
            -32601
        )
    }

    // MARK: - Parse error

    func testMalformedJSON_returnsParseErrorWithNullId() async {
        let out = await makeEnvelope().handle(line("not json at all"))
        let dict = responseDict(out)!
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32700)
        XCTAssertTrue(dict["id"] is NSNull)
    }

    // MARK: - Batch punt (F-009 regression coverage)
    //
    // If/when batch support is added, this test will need to change — and
    // crucially, the NDJSON framing in ConnectionHandler has to change too.

    func testTopLevelArray_returnsInvalidRequest() async {
        let out = await makeEnvelope().handle(line(#"[{"jsonrpc":"2.0","method":"ping","id":1}]"#))
        let dict = responseDict(out)!
        XCTAssertEqual((dict["error"] as? [String: Any])?["code"] as? Int, -32600)
        XCTAssertTrue(dict["id"] is NSNull)
    }

    // MARK: - Handler-thrown errors

    func testHandlerThrowsInternalError_returnsInternalErrorCode() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"explode","id":1}"#))
        let err = responseDict(out)?["error"] as? [String: Any]
        XCTAssertEqual(err?["code"] as? Int, -32603)
        XCTAssertEqual(err?["message"] as? String, "kaboom")
    }

    func testHandlerThrowsInvalidParams_returnsInvalidParamsCode() async {
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"badparams","id":1}"#))
        XCTAssertEqual(
            (responseDict(out)?["error"] as? [String: Any])?["code"] as? Int,
            -32602
        )
    }

    // MARK: - Raw pass-through (config.get's wire path)

    func testRawHandler_resultIsParsedJSON() async {
        // The raw handler returns `{"already":"json","values":[1,2,3]}` bytes.
        // The envelope must place those bytes verbatim under `result` —
        // crucially, NOT wrap them in quotes as a string.
        let out = await makeEnvelope().handle(line(#"{"jsonrpc":"2.0","method":"raw_passthrough","id":1}"#))
        let dict = responseDict(out)!
        let result = dict["result"] as? [String: Any]
        XCTAssertNotNil(result, "result should be a JSON object, not a string")
        XCTAssertEqual(result?["already"] as? String, "json")
        XCTAssertEqual(result?["values"] as? [Int], [1, 2, 3])
    }
}
