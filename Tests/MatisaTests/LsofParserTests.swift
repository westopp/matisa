import XCTest
@testable import Matisa

final class LsofParserTests: XCTestCase {
    func testParsesProcessesAndAddresses() throws {
        let url = Bundle.module.url(forResource: "lsof-sample", withExtension: "txt", subdirectory: "Fixtures")!
        let raw = try String(contentsOf: url, encoding: .utf8)
        let listening = Lsof.parse(raw)

        XCTAssertEqual(listening.count, 4)

        let nodeEntry = listening[0]
        XCTAssertEqual(nodeEntry.pid, 1234)
        XCTAssertEqual(nodeEntry.command, "node")
        XCTAssertEqual(nodeEntry.port, 5478)

        let caddyHTTP = listening[1]
        XCTAssertEqual(caddyHTTP.pid, 5678)
        XCTAssertEqual(caddyHTTP.command, "caddy")
        XCTAssertEqual(caddyHTTP.port, 80)

        let caddyHTTPS = listening[2]
        XCTAssertEqual(caddyHTTPS.port, 443)

        XCTAssertEqual(listening[3].port, 5432)
    }

    func testPortFromAddressIPv6() {
        XCTAssertEqual(Lsof.portFromAddress("[::1]:5478"), 5478)
        XCTAssertEqual(Lsof.portFromAddress("*:80"), 80)
        XCTAssertEqual(Lsof.portFromAddress("127.0.0.1:5432"), 5432)
    }

    func testHeuristicsRecogniseDevServers() {
        let node = ListeningPort(pid: 1, command: "node", address: "*:5478", port: 5478)
        XCTAssertTrue(UnmanagedHeuristics.looksLikeDevServer(node))

        let mysql = ListeningPort(pid: 2, command: "mysqld", address: "*:3306", port: 3306)
        XCTAssertFalse(UnmanagedHeuristics.looksLikeDevServer(mysql))

        let pythonOnDevPort = ListeningPort(pid: 3, command: "python3", address: "*:8000", port: 8000)
        XCTAssertTrue(UnmanagedHeuristics.looksLikeDevServer(pythonOnDevPort))
    }
}
