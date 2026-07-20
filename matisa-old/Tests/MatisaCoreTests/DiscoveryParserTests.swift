import XCTest
@testable import MatisaCore

/// Direct tests for the JSON parsers added in 2b.1. The legacy lsof parser
/// has its own fixture-based tests (`LsofParserTests`); this file covers the
/// docker and brew JSON parsers, which had no tests before.
final class DiscoveryParserTests: XCTestCase {

    // MARK: - DockerJSONParser.parseContainers (NDJSON; one object per line)

    func testParseContainers_singleLine() {
        let raw = #"{"ID":"abc","Names":"redis","Image":"redis:7","State":"running","Status":"Up 5m","Ports":"0.0.0.0:6379->6379/tcp"}"#
        let out = DockerJSONParser.parseContainers(raw)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out.first?.id, "abc")
        XCTAssertEqual(out.first?.name, "redis")
        XCTAssertEqual(out.first?.state, "running")
        XCTAssertTrue(out.first?.isRunning ?? false)
    }

    func testParseContainers_multipleLines() {
        let raw = """
        {"ID":"a","Names":"one","Image":"x","State":"running","Status":"","Ports":""}
        {"ID":"b","Names":"two","Image":"y","State":"exited","Status":"","Ports":""}
        """
        let out = DockerJSONParser.parseContainers(raw)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].name, "one")
        XCTAssertEqual(out[1].name, "two")
        XCTAssertFalse(out[1].isRunning)
    }

    func testParseContainers_lowercasesState() {
        // docker prints "running" lowercase already, but be defensive — our
        // isRunning check compares to lowercase "running".
        let raw = #"{"ID":"x","Names":"y","Image":"z","State":"RUNNING","Status":"","Ports":""}"#
        let out = DockerJSONParser.parseContainers(raw)
        XCTAssertEqual(out.first?.state, "running")
        XCTAssertTrue(out.first?.isRunning ?? false)
    }

    func testParseContainers_skipsMalformedLines() {
        let raw = """
        {"ID":"a","Names":"one","Image":"x","State":"running","Status":"","Ports":""}
        not-json-garbage
        {"ID":"b","Names":"two","Image":"y","State":"running","Status":"","Ports":""}
        """
        let out = DockerJSONParser.parseContainers(raw)
        XCTAssertEqual(out.count, 2)
    }

    func testParseContainers_emptyInput() {
        XCTAssertTrue(DockerJSONParser.parseContainers("").isEmpty)
    }

    // MARK: - DockerJSONParser.parseComposeStacks (single JSON array)

    func testParseComposeStacks_normal() {
        let raw = #"[{"Name":"obs","Status":"running(3)","ConfigFiles":"/x/c.yml"},{"Name":"db","Status":"exited(1)","ConfigFiles":"/y/c.yml"}]"#
        let out = DockerJSONParser.parseComposeStacks(raw)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].name, "obs")
        XCTAssertEqual(out[0].status, "running(3)")
        XCTAssertEqual(out[1].configFiles, "/y/c.yml")
    }

    func testParseComposeStacks_emptyArray() {
        XCTAssertTrue(DockerJSONParser.parseComposeStacks("[]").isEmpty)
    }

    func testParseComposeStacks_emptyInput() {
        XCTAssertTrue(DockerJSONParser.parseComposeStacks("").isEmpty)
    }

    func testParseComposeStacks_garbageReturnsEmpty() {
        XCTAssertTrue(DockerJSONParser.parseComposeStacks("not json").isEmpty)
    }

    // MARK: - BrewJSONParser

    func testParseBrew_normal() {
        let raw = #"[{"name":"caddy","status":"started","user":"thulane","file":"/p1.plist"},{"name":"redis","status":"stopped","user":"","file":"/p2.plist"}]"#
        let out = BrewJSONParser.parse(raw)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].name, "caddy")
        XCTAssertTrue(out[0].isRunning)
        XCTAssertFalse(out[1].isRunning)
        XCTAssertEqual(out[1].plist, "/p2.plist")
    }

    func testParseBrew_caseInsensitiveRunningCheck() {
        let raw = #"[{"name":"x","status":"STARTED","user":"","file":""}]"#
        XCTAssertTrue(BrewJSONParser.parse(raw).first?.isRunning ?? false)
    }

    func testParseBrew_emptyInput() {
        XCTAssertTrue(BrewJSONParser.parse("").isEmpty)
    }

    func testParseBrew_garbageReturnsEmpty() {
        XCTAssertTrue(BrewJSONParser.parse("nope").isEmpty)
    }
}
