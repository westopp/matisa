import XCTest
import Darwin
@testable import MatisaEngine

/// Tier 2 — NDJSON framing edge cases for the byte-stream reader.
/// Tests use a real `pipe()` pair so we exercise the actual `read(2)`
/// path rather than mocking it.
final class LineReaderTests: XCTestCase {

    // MARK: - Helpers

    private func makePipe() -> (read: Int32, write: Int32) {
        var fds = [Int32](repeating: 0, count: 2)
        let r = pipe(&fds)
        XCTAssertEqual(r, 0, "pipe() failed: \(String(cString: strerror(errno)))")
        return (fds[0], fds[1])
    }

    /// Write a string to the write end, then close it to signal EOF.
    private func writeAllAndClose(_ writeEnd: Int32, _ string: String) {
        let data = Array(string.utf8)
        data.withUnsafeBufferPointer { buf in
            var remaining = buf.count
            var ptr = UnsafeRawPointer(buf.baseAddress!)
            while remaining > 0 {
                let n = write(writeEnd, ptr, remaining)
                if n <= 0 { break }
                ptr = ptr.advanced(by: n)
                remaining -= n
            }
        }
        close(writeEnd)
    }

    private func utf8(_ s: String) -> Data { s.data(using: .utf8)! }

    // MARK: - Tests

    func testSingleLineThenEOF() {
        let p = makePipe()
        defer { close(p.read) }
        writeAllAndClose(p.write, "hello\n")

        let reader = LineReader(fd: p.read)
        XCTAssertEqual(reader.readLine(), utf8("hello"))
        XCTAssertNil(reader.readLine())
    }

    func testMultipleLinesInOneStream() {
        let p = makePipe()
        defer { close(p.read) }
        writeAllAndClose(p.write, "alpha\nbeta\ngamma\n")

        let reader = LineReader(fd: p.read)
        XCTAssertEqual(reader.readLine(), utf8("alpha"))
        XCTAssertEqual(reader.readLine(), utf8("beta"))
        XCTAssertEqual(reader.readLine(), utf8("gamma"))
        XCTAssertNil(reader.readLine())
    }

    func testTrailingLineWithoutNewline_surfacedOnEOF() {
        // The last line has no terminating newline. LineReader should
        // surface it once on EOF, then return nil.
        let p = makePipe()
        defer { close(p.read) }
        writeAllAndClose(p.write, "first\nsecond-no-newline")

        let reader = LineReader(fd: p.read)
        XCTAssertEqual(reader.readLine(), utf8("first"))
        XCTAssertEqual(reader.readLine(), utf8("second-no-newline"))
        XCTAssertNil(reader.readLine())
    }

    func testEmptyLine_yieldsEmptyData() {
        let p = makePipe()
        defer { close(p.read) }
        writeAllAndClose(p.write, "\nafter\n")

        let reader = LineReader(fd: p.read)
        XCTAssertEqual(reader.readLine(), Data())
        XCTAssertEqual(reader.readLine(), utf8("after"))
        XCTAssertNil(reader.readLine())
    }

    func testEofWithoutData_returnsNil() {
        let p = makePipe()
        defer { close(p.read) }
        close(p.write) // immediate EOF, nothing was ever written

        let reader = LineReader(fd: p.read)
        XCTAssertNil(reader.readLine())
    }

    func testLongLineSpanningMultipleReads() {
        // chunkSize is 4096; write 10K bytes + newline so the line definitely
        // spans multiple read() calls regardless of pipe-buffer scheduling.
        let p = makePipe()
        defer { close(p.read) }
        let big = String(repeating: "x", count: 10_000) + "\n"
        writeAllAndClose(p.write, big)

        let reader = LineReader(fd: p.read)
        let line = reader.readLine()
        XCTAssertEqual(line?.count, 10_000)
        XCTAssertNil(reader.readLine())
    }
}
