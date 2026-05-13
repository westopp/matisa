import Foundation
import Darwin

/// Reads a stream of bytes from an fd, yielding one newline-terminated line
/// at a time. Returns nil on EOF or read error. Used by `ConnectionHandler`
/// to drive NDJSON framing.
final class LineReader {

    private let fd: Int32
    private var buffer = Data()
    private let chunkSize = 4096

    init(fd: Int32) {
        self.fd = fd
    }

    func readLine() -> Data? {
        while true {
            if let nlIndex = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[..<nlIndex])
                buffer.removeSubrange(...nlIndex)
                return line
            }
            var chunk = [UInt8](repeating: 0, count: chunkSize)
            let n = chunk.withUnsafeMutableBufferPointer { buf -> Int in
                read(fd, buf.baseAddress, buf.count)
            }
            if n > 0 {
                buffer.append(contentsOf: chunk[..<n])
                continue
            }
            if n == 0 {
                // EOF. If there's a trailing line without a newline, surface
                // it once; otherwise we're done.
                if !buffer.isEmpty {
                    let line = buffer
                    buffer.removeAll()
                    return line
                }
                return nil
            }
            // n < 0
            if errno == EINTR { continue }
            return nil
        }
    }
}
