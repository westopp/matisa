import Foundation

// Phase 0 / Phase 1 engine skeleton.
// - Boots a UDS listener at ~/Library/Application Support/Matisa/matisa.sock
//   (overridable via MATISA_SOCKET).
// - Speaks JSON-RPC 2.0 framed as newline-delimited JSON.
// - Exposes:
//     engine.status   (phase 0) — proves wiring
//     projects.list   (phase 1) — proves the contract end-to-end against stub state

// Ignore SIGPIPE before anything can write to a socket. Default Darwin
// disposition is process termination on a write to a peer that closed its
// read end; a single ill-behaved client would otherwise take the engine down
// and every other in-flight connection with it.
signal(SIGPIPE, SIG_IGN)

let engine = Engine()

do {
    try engine.start()
} catch {
    FileHandle.standardError.write(Data("matisa-engine: failed to start: \(error)\n".utf8))
    exit(1)
}

// Clean shutdown on SIGINT / SIGTERM.
// We have to ignore the default disposition before installing dispatch sources,
// otherwise the process is killed before our handler runs.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler {
    engine.stop()
    exit(0)
}
sigint.resume()

let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler {
    engine.stop()
    exit(0)
}
sigterm.resume()

dispatchMain()
