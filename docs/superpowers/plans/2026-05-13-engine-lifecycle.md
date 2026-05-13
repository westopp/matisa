# Engine Lifecycle (bundled binary, spawn-on-demand, RPC shutdown) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `matisa-engine` a real lifecycle peer of `Matisa.app`: bundled inside the `.app`, spawned automatically by the app when the socket is unreachable, and stoppable over the wire via a new `engine.shutdown` RPC.

**Architecture:**
- `build-app.sh` builds and copies `matisa-engine` into `Matisa.app/Contents/MacOS/` alongside `Matisa`.
- A new `EngineLauncher` (app-side) resolves the binary path (bundled binary first, then `.build/<config>/matisa-engine` for `swift run` dev workflow), `posix_spawn`s it detached with `POSIX_SPAWN_SETSID` so it survives the app, then polls the UDS for readiness.
- A new `engine.shutdown` RPC posts `SIGTERM` to self after acking the request, reusing the existing signal-handled stop path so there's exactly one exit sequence.
- `MainWindowView`'s System group adds a third row ("Engine") with running/stopped dot and start/stop controls, mirroring the Caddy/Docker rows.

**Tech Stack:** Swift Package Manager · SwiftUI · POSIX `posix_spawn` / `flock` · Unix Domain Sockets · JSON-RPC 2.0 · XCTest

**Conventions inherited from plan.md (repo root):**
- Method names dotted-lowercase (`engine.shutdown`).
- Wire types live in `MatisaCore`. RPC param/response shapes that don't escape the seam can be tiny structs in the app's `EngineClient.swift` (mirrors today's `ServiceIDParams`/`EmptyResponse`).
- App fallback pattern: every engine RPC has `try? await EngineClient...` → local fallback on failure.
- Each slice is one commit. Commit when tests are green.
- Never include AI/Anthropic/Claude references in commit messages (per CLAUDE.md).
- Never commit/push without explicit user instruction.

---

## File Structure

**New files:**
- `Sources/Matisa/Engine/EngineLauncher.swift` — binary discovery, `posix_spawn` detached, socket-readiness polling.
- `Sources/Matisa/Window/EngineDetailView.swift` — detail pane for the engine row in the System group.
- `Tests/MatisaEngineTests/EngineShutdownRPCTests.swift` — black-box test: spawn `matisa-engine` binary, call `engine.shutdown`, assert process exits cleanly.
- `Tests/MatisaTests/EngineLauncherTests.swift` — binary-resolution + socket-polling unit tests.

**Modified files:**
- `Sources/MatisaEngine/Engine.swift` (registerMethods) — register `engine.shutdown`.
- `Sources/MatisaEngine/Engine.swift` (version constant) — bump to `0.6.0-phase3` once the slice lands.
- `Sources/Matisa/Engine/EngineClient.swift` — add `shutdown()` convenience; (optional) one auto-spawn-and-retry on `engineUnreachable`.
- `Sources/Matisa/Engine/EngineMirror.swift` — extend `Snapshot` with `engine: EngineStatus?` and pull `engine.status` each tick.
- `Sources/Matisa/Store/ServiceStore.swift` — engine state property, `performEngineStart` / `performEngineStop`, apply `engine.status` in refresh.
- `Sources/Matisa/App.swift` — call `EngineLauncher.shared.ensureRunning()` before first refresh.
- `Sources/Matisa/Window/MainWindowView.swift` — `SidebarSelection.engine`, `engineRow`, count = 3, `systemRunningCount`, detail switch.
- `build-app.sh` — build and copy `matisa-engine` into `Contents/MacOS/`.
- `plan.md` (repo root) — record this slice under "What's done" once landed.

**Untouched (for reference):**
- `Sources/MatisaEngine/main.swift` — already has SIGINT/SIGTERM handlers that call `engine.stop()` + `exit(0)`. The new `engine.shutdown` RPC reuses these.
- `Sources/MatisaEngine/Server.swift` — `flock` on `<sock>.lock` already provides the single-instance guard, so over-spawning by the launcher is safe.
- `Sources/MatisaCore/CorePaths.swift` — socket path resolution already agrees between engine and app.

---

## Task 1: Add `engine.shutdown` RPC method (engine side)

**Files:**
- Modify: `Sources/MatisaEngine/Engine.swift` (in `registerMethods`)
- Test: `Tests/MatisaEngineTests/EngineShutdownRPCTests.swift`

### Approach

The existing `main.swift` already installs `SIGINT`/`SIGTERM` dispatch sources that call `engine.stop()` then `exit(0)`. The cleanest implementation of `engine.shutdown` is therefore to **ack the RPC, then `raise(SIGTERM)` to self after a short delay** — the existing signal handler does the actual work. One exit path, no duplication.

The 100ms delay is so the response makes it back over the socket before the process exits. The dispatcher writes the response synchronously after the handler returns, but the kernel write buffer flush is not guaranteed instant; 100ms is generous and unobservable in practice.

- [ ] **Step 1: Write the failing integration test**

Create `Tests/MatisaEngineTests/EngineShutdownRPCTests.swift`:

```swift
import XCTest
import Foundation
@testable import MatisaEngine

/// Black-box test: spawn the built matisa-engine binary as a child process,
/// connect to its socket, send engine.shutdown, and verify the process
/// exits cleanly within a few seconds. Reuses the same MATISA_SOCKET
/// override pattern as the rest of the test suite.
final class EngineShutdownRPCTests: XCTestCase {

    /// Locate the matisa-engine binary built by `swift test` / `swift build`.
    /// Falls back to .build/<config>/matisa-engine relative to the package root.
    private func engineBinaryURL() -> URL? {
        // `swift test` sets the working directory to the package root.
        let pkgRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = pkgRoot
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
            // Universal-build layout: .build/apple/Products/<Config>/matisa-engine
            let universal = pkgRoot
                .appendingPathComponent(".build/apple/Products")
                .appendingPathComponent(config.capitalized)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: universal.path) {
                return universal
            }
        }
        return nil
    }

    func testShutdownRPCExitsTheEngineCleanly() throws {
        guard let binary = engineBinaryURL() else {
            throw XCTSkip("matisa-engine binary not built yet")
        }

        let sockPath = NSTemporaryDirectory()
            + "matisa-test-\(UUID().uuidString).sock"
        let lockPath = sockPath + ".lock"
        defer {
            unlink(sockPath)
            unlink(lockPath)
        }

        let proc = Process()
        proc.executableURL = binary
        proc.environment = ["MATISA_SOCKET": sockPath]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()

        // Wait for socket to appear (up to 3s).
        let deadline = Date().addingTimeInterval(3.0)
        while !FileManager.default.fileExists(atPath: sockPath) {
            if Date() > deadline {
                proc.terminate()
                XCTFail("engine never created socket at \(sockPath)")
                return
            }
            usleep(50_000)
        }

        // Send engine.shutdown.
        let request = #"{"jsonrpc":"2.0","method":"engine.shutdown","id":1}"# + "\n"
        let response = try sendOverUDS(socketPath: sockPath, line: request)
        XCTAssertTrue(response.contains("\"result\""),
                      "expected success response, got: \(response)")

        // Engine should exit within ~1s after acking shutdown.
        let exitDeadline = Date().addingTimeInterval(2.0)
        while proc.isRunning {
            if Date() > exitDeadline {
                proc.terminate()
                XCTFail("engine did not exit after engine.shutdown")
                return
            }
            usleep(50_000)
        }
        XCTAssertEqual(proc.terminationStatus, 0,
                       "engine exit status should be 0, got \(proc.terminationStatus)")
    }

    /// One-shot send: open UDS, write one line, read one line, close.
    private func sendOverUDS(socketPath: String, line: String) throws -> String {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "uds", code: Int(errno)) }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: capacity) { bp in
                for (i, b) in pathBytes.enumerated() { bp[i] = b }
                bp[pathBytes.count] = 0
            }
        }
        let connectResult = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else {
            throw NSError(domain: "uds-connect", code: Int(errno))
        }

        let data = Array(line.utf8)
        _ = data.withUnsafeBufferPointer { buf in
            write(fd, buf.baseAddress, buf.count)
        }

        var out = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = chunk.withUnsafeMutableBufferPointer { b in
                read(fd, b.baseAddress, b.count)
            }
            if n <= 0 { break }
            out.append(contentsOf: chunk[..<n])
            if out.contains(0x0A) { break }
        }
        return String(data: out, encoding: .utf8) ?? ""
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift test --filter EngineShutdownRPCTests/testShutdownRPCExitsTheEngineCleanly 2>&1 | tail -20
```

Expected: FAIL with an rpc error response (`-32601 methodNotFound` or similar), or — if binary doesn't exist — skipped. If skipped, build first:

```bash
swift build && swift test --filter EngineShutdownRPCTests/testShutdownRPCExitsTheEngineCleanly 2>&1 | tail -20
```

Expected after build: FAIL with `methodNotFound`.

- [ ] **Step 3: Implement `engine.shutdown` in `Engine.swift`**

In `Sources/MatisaEngine/Engine.swift`, just after the existing `engine.status` registration (around line 167), add:

```swift
        // engine.shutdown — phase 3. Acks the request, then raises SIGTERM
        // to self after a short delay so the response makes it back to the
        // client before the process exits. Reuses the existing SIGTERM
        // dispatch source in main.swift so there's exactly one shutdown path.
        dispatcher.register("engine.shutdown") { () -> EmptyResponse in
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100)) {
                _ = raise(SIGTERM)
            }
            return EmptyResponse()
        }
```

Note: `EmptyResponse` already exists as an internal type in the engine (`Sources/MatisaEngine/Methods.swift`). If for some reason it's been renamed or scoped differently in the current tree, search `EmptyResponse` in `Sources/MatisaEngine/` and use whatever the existing empty-return convention is.

- [ ] **Step 4: Run test to verify it passes**

```bash
swift build && swift test --filter EngineShutdownRPCTests/testShutdownRPCExitsTheEngineCleanly 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Run the full suite to confirm no regression**

```bash
swift test 2>&1 | tail -10
```

Expected: all tests pass; new total = previous total + 1.

- [ ] **Step 6: Commit**

```bash
git add Sources/MatisaEngine/Engine.swift Tests/MatisaEngineTests/EngineShutdownRPCTests.swift
git commit -m "Phase 3: add engine.shutdown RPC"
```

---

## Task 2: Bundle `matisa-engine` into the `.app`

**Files:**
- Modify: `build-app.sh`

### Approach

The existing script does `swift build` and copies `Matisa` into `Contents/MacOS/`. We need to also copy `matisa-engine` from the same build output. Swift Package Manager builds all executable products in one `swift build` invocation, so no separate compile step is needed — just one more `cp`.

The universal-vs-fat-fallback logic in the current script needs to apply to both binaries. Easiest is to derive both paths from the same `BIN_DIR` and copy each.

- [ ] **Step 1: Replace `build-app.sh` body so it bundles both binaries**

Open `build-app.sh` and replace the binary-resolution + copy block. The current shape is:

```bash
if [ "$UNIVERSAL" = "1" ]; then
    case "$CONFIG" in
        release) BIN_PATH=".build/apple/Products/Release/${APP_NAME}" ;;
        debug)   BIN_PATH=".build/apple/Products/Debug/${APP_NAME}" ;;
        *)       BIN_PATH=".build/apple/Products/${CONFIG}/${APP_NAME}" ;;
    esac
else
    BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/${APP_NAME}"
fi

if [ ! -x "$BIN_PATH" ]; then
    echo "✗ Binary not found at $BIN_PATH"
    exit 1
fi

echo "→ Assembling ${APP_DIR}…"
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
cp "$BIN_PATH" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp Resources/Info.plist "${APP_DIR}/Contents/Info.plist"
```

Replace with:

```bash
ENGINE_NAME="matisa-engine"

if [ "$UNIVERSAL" = "1" ]; then
    case "$CONFIG" in
        release) BIN_DIR=".build/apple/Products/Release" ;;
        debug)   BIN_DIR=".build/apple/Products/Debug" ;;
        *)       BIN_DIR=".build/apple/Products/${CONFIG}" ;;
    esac
else
    BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
fi

APP_BIN="${BIN_DIR}/${APP_NAME}"
ENGINE_BIN="${BIN_DIR}/${ENGINE_NAME}"

if [ ! -x "$APP_BIN" ]; then
    echo "✗ App binary not found at $APP_BIN"
    exit 1
fi
if [ ! -x "$ENGINE_BIN" ]; then
    echo "✗ Engine binary not found at $ENGINE_BIN"
    exit 1
fi

echo "→ Assembling ${APP_DIR}…"
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
cp "$APP_BIN" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp "$ENGINE_BIN" "${APP_DIR}/Contents/MacOS/${ENGINE_NAME}"
cp Resources/Info.plist "${APP_DIR}/Contents/Info.plist"
```

- [ ] **Step 2: Run the build script and verify both binaries land in the bundle**

```bash
./build-app.sh debug
ls -l build/Matisa.app/Contents/MacOS/
```

Expected: two executable files — `Matisa` and `matisa-engine`.

- [ ] **Step 3: Sanity-check the bundled engine runs**

```bash
MATISA_SOCKET=/tmp/matisa-bundled-test.sock \
    build/Matisa.app/Contents/MacOS/matisa-engine &
ENGINE_PID=$!
sleep 0.5
printf '{"jsonrpc":"2.0","method":"engine.status","id":1}\n' \
    | nc -U /tmp/matisa-bundled-test.sock
kill $ENGINE_PID 2>/dev/null
rm -f /tmp/matisa-bundled-test.sock /tmp/matisa-bundled-test.sock.lock
```

Expected: a JSON response containing `"status":"ok"`.

- [ ] **Step 4: Commit**

```bash
git add build-app.sh
git commit -m "Phase 3: bundle matisa-engine into Matisa.app/Contents/MacOS"
```

---

## Task 3: `EngineLauncher` — binary discovery (no spawning yet)

**Files:**
- Create: `Sources/Matisa/Engine/EngineLauncher.swift`
- Test: `Tests/MatisaTests/EngineLauncherTests.swift`

### Approach

Split the launcher across small, testable functions. This task lands the binary-discovery primitive only; spawning and polling come in Tasks 4 and 5.

Search order:
1. `MATISA_ENGINE_BINARY` env var (escape hatch for dev / CI).
2. Sibling of the running executable: `Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("matisa-engine")` — works for shipped `.app` because `Bundle.main` is the .app bundle URL, and `Contents/MacOS` is where both binaries live.
3. `.build/<config>/matisa-engine` relative to the package root, for `swift run` dev workflow. Try `debug` then `release`.

Return `nil` if none match (caller surfaces a real error).

- [ ] **Step 1: Write the failing test**

Create `Tests/MatisaTests/EngineLauncherTests.swift`:

```swift
import XCTest
@testable import Matisa

final class EngineLauncherTests: XCTestCase {

    func testResolvesBinaryFromEnvOverride() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("fake-engine-\(UUID().uuidString)")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: tmp)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: tmp.path
        )
        defer { try? FileManager.default.removeItem(at: tmp) }

        setenv("MATISA_ENGINE_BINARY", tmp.path, 1)
        defer { unsetenv("MATISA_ENGINE_BINARY") }

        let resolved = EngineLauncher.resolveBinaryURL()
        XCTAssertEqual(resolved?.path, tmp.path)
    }

    func testReturnsNilWhenNothingFound() {
        setenv("MATISA_ENGINE_BINARY", "/no/such/path", 1)
        defer { unsetenv("MATISA_ENGINE_BINARY") }
        // Test environments don't have a bundled binary either; resolution
        // should fail cleanly rather than returning a stale path.
        // (The .build/<config> fallback may exist when swift test is running,
        // so we don't assert nil unconditionally — instead assert that an
        // unreadable env override doesn't get returned.)
        let resolved = EngineLauncher.resolveBinaryURL()
        XCTAssertNotEqual(resolved?.path, "/no/such/path")
    }
}
```

- [ ] **Step 2: Run test to verify it fails (no EngineLauncher yet)**

```bash
swift test --filter EngineLauncherTests 2>&1 | tail -20
```

Expected: FAIL — compile error "cannot find 'EngineLauncher' in scope".

- [ ] **Step 3: Create `EngineLauncher` with `resolveBinaryURL`**

Create `Sources/Matisa/Engine/EngineLauncher.swift`:

```swift
import Foundation
import Darwin

/// Locates and starts the matisa-engine binary on behalf of the app.
///
/// The engine is normally spawned by the app at launch if the socket
/// isn't reachable, and is left running detached so it outlives the app
/// (the locked-in design — see plan.md). The launcher only spawns; the
/// engine's own flock on `<sock>.lock` (Server.swift) is the single-
/// instance guard, so spawning is safe even if a race produces two
/// concurrent attempts.
enum EngineLauncher {

    /// Resolution order:
    /// 1. `MATISA_ENGINE_BINARY` — env override, used by tests and as an
    ///    escape hatch for unusual dev setups.
    /// 2. Sibling of the running executable
    ///    (`Contents/MacOS/matisa-engine` inside the shipped `.app`).
    /// 3. `.build/<config>/matisa-engine` for `swift run` dev workflow.
    static func resolveBinaryURL() -> URL? {
        if let envPath = ProcessInfo.processInfo.environment["MATISA_ENGINE_BINARY"],
           !envPath.isEmpty,
           FileManager.default.isExecutableFile(atPath: envPath) {
            return URL(fileURLWithPath: envPath)
        }

        // Sibling of the running executable. Bundle.main resolves to the
        // .app bundle URL for app builds, so we go up to MacOS/ and look
        // for matisa-engine there. For SPM test binaries Bundle.main is
        // the test runner — sibling lookup will miss, which is fine; the
        // .build fallback below kicks in.
        if let exec = Bundle.main.executableURL {
            let sibling = exec
                .deletingLastPathComponent()
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: sibling.path) {
                return sibling
            }
        }

        // .build/<config>/matisa-engine for `swift run` development.
        // CWD when running the app via swift run is the package root.
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = cwd
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
swift test --filter EngineLauncherTests 2>&1 | tail -20
```

Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add Sources/Matisa/Engine/EngineLauncher.swift Tests/MatisaTests/EngineLauncherTests.swift
git commit -m "Phase 3: EngineLauncher binary discovery"
```

---

## Task 4: `EngineLauncher` — socket-readiness polling

**Files:**
- Modify: `Sources/Matisa/Engine/EngineLauncher.swift`
- Modify: `Tests/MatisaTests/EngineLauncherTests.swift`

### Approach

Polling has to be cheap and bounded. Reuse `EngineClient.shared.isReachable()` semantics: try `connect()`, give up if it fails, retry every ~50ms up to a timeout. Async so the caller can `await` without blocking.

- [ ] **Step 1: Add the failing tests**

Append to `Tests/MatisaTests/EngineLauncherTests.swift`:

```swift
    func testWaitForSocketTimesOutWhenSocketIsMissing() async {
        let sockPath = NSTemporaryDirectory()
            + "launcher-test-\(UUID().uuidString).sock"
        let result = await EngineLauncher.waitForSocketReady(
            path: sockPath,
            timeout: 0.3
        )
        XCTAssertFalse(result, "socket that never exists should time out")
    }

    func testWaitForSocketReturnsTrueWhenSocketBecomesAvailable() async throws {
        let sockPath = NSTemporaryDirectory()
            + "launcher-test-\(UUID().uuidString).sock"
        defer { unlink(sockPath) }

        // Spawn a minimal listener in the background.
        let listenerReady = expectation(description: "listener ready")
        Task.detached {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            defer { close(fd) }
            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(sockPath.utf8)
            let cap = MemoryLayout.size(ofValue: addr.sun_path)
            withUnsafeMutablePointer(to: &addr.sun_path) { tup in
                tup.withMemoryRebound(to: UInt8.self, capacity: cap) { bp in
                    for (i, b) in bytes.enumerated() { bp[i] = b }
                    bp[bytes.count] = 0
                }
            }
            _ = withUnsafePointer(to: &addr) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            _ = listen(fd, 8)
            listenerReady.fulfill()
            // Keep listening until the test tears down — accept and close.
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { break }
                close(c)
            }
        }
        await fulfillment(of: [listenerReady], timeout: 1.0)

        let result = await EngineLauncher.waitForSocketReady(
            path: sockPath,
            timeout: 1.0
        )
        XCTAssertTrue(result)
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
swift test --filter EngineLauncherTests 2>&1 | tail -20
```

Expected: FAIL — `waitForSocketReady` doesn't exist.

- [ ] **Step 3: Add `waitForSocketReady` to `EngineLauncher`**

In `Sources/Matisa/Engine/EngineLauncher.swift`, append before the closing `}` of the enum:

```swift
    /// Polls `path` every 50ms for up to `timeout` seconds. Returns true as
    /// soon as a UDS `connect()` to the path succeeds, false on timeout.
    /// Cheap: opens and immediately closes a probe socket per attempt.
    static func waitForSocketReady(path: String, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if probeConnect(path: path) {
                return true
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }

    private static func probeConnect(path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < cap else { return false }
        withUnsafeMutablePointer(to: &addr.sun_path) { tup in
            tup.withMemoryRebound(to: UInt8.self, capacity: cap) { bp in
                for (i, b) in bytes.enumerated() { bp[i] = b }
                bp[bytes.count] = 0
            }
        }
        let result = withUnsafePointer(to: &addr) { p -> Int32 in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return result == 0
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
swift test --filter EngineLauncherTests 2>&1 | tail -20
```

Expected: all four `EngineLauncherTests` pass.

- [ ] **Step 5: Commit**

```bash
git add Sources/Matisa/Engine/EngineLauncher.swift Tests/MatisaTests/EngineLauncherTests.swift
git commit -m "Phase 3: EngineLauncher socket-readiness polling"
```

---

## Task 5: `EngineLauncher` — `ensureRunning` (spawn + wait)

**Files:**
- Modify: `Sources/Matisa/Engine/EngineLauncher.swift`
- Modify: `Tests/MatisaTests/EngineLauncherTests.swift`

### Approach

The high-level entry point:

1. If socket already reachable: success, no spawn.
2. Otherwise locate the binary; bail with error if not found.
3. `posix_spawn` it with `POSIX_SPAWN_SETSID` so the engine starts a new session — when the app quits, the engine is reparented to launchd, matching the design in plan.md:38.
4. Poll the socket for readiness up to a generous timeout (3s).
5. Return success/failure with a descriptive error.

We deliberately do **not** keep a reference to the spawned `pid_t` — the engine is supposed to outlive the app, so we don't supervise it. The kernel reaps it when its parent (launchd) reaps the orphan.

- [ ] **Step 1: Write the failing integration test**

Append to `Tests/MatisaTests/EngineLauncherTests.swift`:

```swift
    /// Integration test: locate the actual built engine binary, spawn it
    /// with a temp socket path, verify it comes up, then SIGTERM it.
    func testEnsureRunningSpawnsTheEngine() async throws {
        guard let binary = locateBuiltEngineBinary() else {
            throw XCTSkip("matisa-engine binary not built; run `swift build`")
        }

        let sockPath = NSTemporaryDirectory()
            + "launcher-test-\(UUID().uuidString).sock"
        defer {
            unlink(sockPath)
            unlink(sockPath + ".lock")
        }

        setenv("MATISA_ENGINE_BINARY", binary.path, 1)
        setenv("MATISA_SOCKET", sockPath, 1)
        defer {
            unsetenv("MATISA_ENGINE_BINARY")
            unsetenv("MATISA_SOCKET")
        }

        let result = try await EngineLauncher.ensureRunning(
            socketPath: sockPath,
            timeout: 5.0
        )
        XCTAssertTrue(result.didSpawn || result.alreadyRunning)
        XCTAssertTrue(FileManager.default.fileExists(atPath: sockPath))

        // Tear down: SIGTERM the engine via its pidfile contents. The
        // .lock file holds the engine's PID.
        if let pidStr = try? String(contentsOfFile: sockPath + ".lock"),
           let pid = pid_t(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
            kill(pid, SIGTERM)
            // Best-effort wait for shutdown.
            for _ in 0..<40 where kill(pid, 0) == 0 {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    private func locateBuiltEngineBinary() -> URL? {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for config in ["debug", "release"] {
            let candidate = cwd
                .appendingPathComponent(".build")
                .appendingPathComponent(config)
                .appendingPathComponent("matisa-engine")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
swift build && swift test --filter EngineLauncherTests/testEnsureRunningSpawnsTheEngine 2>&1 | tail -20
```

Expected: FAIL — `ensureRunning` doesn't exist.

- [ ] **Step 3: Add `ensureRunning` to `EngineLauncher`**

Append to `Sources/Matisa/Engine/EngineLauncher.swift` (inside the enum):

```swift
    enum LaunchError: Error, CustomStringConvertible {
        case binaryNotFound
        case spawnFailed(Int32, String)
        case didNotComeUp(String)

        var description: String {
            switch self {
            case .binaryNotFound:
                return "matisa-engine binary not found (set MATISA_ENGINE_BINARY or build the app bundle)"
            case .spawnFailed(let code, let msg):
                return "posix_spawn failed rc=\(code): \(msg)"
            case .didNotComeUp(let path):
                return "engine spawned but socket at \(path) never became reachable"
            }
        }
    }

    struct LaunchResult {
        let alreadyRunning: Bool
        let didSpawn: Bool
    }

    /// Ensures the engine is reachable at `socketPath`. If it's not, locates
    /// the binary, spawns it detached, and polls the socket up to `timeout`
    /// seconds for readiness.
    ///
    /// Safe to call concurrently or repeatedly: over-spawn is harmless because
    /// the engine's `flock` on `<sock>.lock` rejects duplicate instances.
    static func ensureRunning(
        socketPath: String,
        timeout: TimeInterval = 5.0
    ) async throws -> LaunchResult {
        if await waitForSocketReady(path: socketPath, timeout: 0.0)
            || probeConnect(path: socketPath) {
            return LaunchResult(alreadyRunning: true, didSpawn: false)
        }

        guard let binary = resolveBinaryURL() else {
            throw LaunchError.binaryNotFound
        }

        try spawnDetached(binary: binary)

        if await waitForSocketReady(path: socketPath, timeout: timeout) {
            return LaunchResult(alreadyRunning: false, didSpawn: true)
        }
        throw LaunchError.didNotComeUp(socketPath)
    }

    /// posix_spawn the engine in its own session so it survives the app.
    /// stdout/stderr redirected to /dev/null — the engine writes its own
    /// log file via the OS_LOG / FileHandle.standardError path it already
    /// uses; we don't need its noise in the app's console.
    private static func spawnDetached(binary: URL) throws {
        var fileActions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&fileActions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(&fileActions, 2, "/dev/null", O_WRONLY, 0)

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // SETSID: new session, detached from app's controlling terminal /
        // process group. When the app quits, the engine survives and is
        // reparented to launchd.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))

        // Inherit the user's environment so the engine sees PATH etc.
        var env = ProcessInfo.processInfo.environment
        // MATISA_SOCKET is already read from the env; if set in the app,
        // we want the spawned engine to use the same value.
        let envStrings: [String] = env.map { "\($0.key)=\($0.value)" }
        let envCArray = envStrings.map { strdup($0) }
        defer { envCArray.forEach { free($0) } }
        var envPtrs: [UnsafeMutablePointer<CChar>?] = envCArray + [nil]

        let argv: [UnsafeMutablePointer<CChar>?] = [
            strdup(binary.path),
            nil
        ]
        defer { argv.forEach { if let p = $0 { free(p) } } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, binary.path, &fileActions, &attr,
                             argv, &envPtrs)
        if rc != 0 {
            throw LaunchError.spawnFailed(
                rc,
                String(cString: strerror(rc))
            )
        }
        // Deliberately don't wait — the engine is meant to outlive us.
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
swift build && swift test --filter EngineLauncherTests/testEnsureRunningSpawnsTheEngine 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Run the full suite**

```bash
swift test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add Sources/Matisa/Engine/EngineLauncher.swift Tests/MatisaTests/EngineLauncherTests.swift
git commit -m "Phase 3: EngineLauncher.ensureRunning (spawn detached, wait for socket)"
```

---

## Task 6: `EngineClient.shutdown()` convenience + auto-spawn retry

**Files:**
- Modify: `Sources/Matisa/Engine/EngineClient.swift`

### Approach

Two thin additions:

1. `shutdown()` — wraps the `engine.shutdown` RPC for callers.
2. Auto-spawn-and-retry: when an `engineUnreachable` error is observed at `call`-time, attempt `EngineLauncher.ensureRunning` once, then retry the call. The retry is opt-in via a parameter so the launcher's own callers don't recurse.

We don't write tests for this directly — the integration loops in Task 5 + manual UI verification cover it.

- [ ] **Step 1: Add `shutdown()` method**

In `Sources/Matisa/Engine/EngineClient.swift`, just after the `call<R>` method (around line 98), add:

```swift
    /// Request a clean engine shutdown over the wire. Returns when the
    /// engine has acked the request — the engine then exits ~100ms later.
    /// Callers that want to confirm the process actually exited can poll
    /// `isReachable()` afterwards.
    func shutdown() throws {
        _ = try callRaw("engine.shutdown")
    }
```

- [ ] **Step 2: Add auto-spawn-and-retry as a wrapper method**

Below `shutdown()`, add:

```swift
    /// Like `call(_:params:as:)` but if the engine is unreachable, attempts
    /// to spawn it once via `EngineLauncher.ensureRunning` and retries.
    /// Use this for caller code-paths where the engine is expected to be
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
```

- [ ] **Step 3: Build to confirm it compiles**

```bash
swift build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Run the full suite**

```bash
swift test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add Sources/Matisa/Engine/EngineClient.swift
git commit -m "Phase 3: EngineClient.shutdown() and auto-spawn-and-retry wrapper"
```

---

## Task 7: App startup spawns the engine

**Files:**
- Modify: `Sources/Matisa/App.swift`

### Approach

The simplest place to hook `ensureRunning` is the `init()` of `MatisaApp` — before the first `ServiceStore.bootstrap()` runs. We fire-and-forget a `Task` so the app window appears immediately; if the engine isn't up yet, the first refresh uses the local fallback, and subsequent refreshes pick up the now-running engine.

If the binary isn't found (dev box without `swift build` having run, weird environment), we just log to stderr and let the local-fallback path handle everything — that's the existing degraded behaviour, not a regression.

- [ ] **Step 1: Update `App.swift`**

Replace the existing `init()` with:

```swift
    init() {
        _ = Paths.supportDir
        _ = Paths.logsDir
        _ = Paths.configDir

        // Spawn the engine eagerly. Fire-and-forget: the engine is the
        // single source of truth when it's up, but the app's local-fallback
        // path keeps things working if the spawn fails (e.g. dev box where
        // the binary hasn't been built). Logged but not surfaced — the UI
        // will degrade visibly via the Engine row in the System group.
        Task {
            do {
                _ = try await EngineLauncher.ensureRunning(
                    socketPath: EngineClient.defaultSocketPath()
                )
            } catch {
                FileHandle.standardError.write(
                    Data("Matisa: engine spawn failed: \(error)\n".utf8)
                )
            }
        }
    }
```

- [ ] **Step 2: Build the app and run it**

```bash
./build-app.sh debug
open build/Matisa.app
```

Then, in a separate terminal, confirm the engine is running:

```bash
ls -l ~/Library/Application\ Support/Matisa/matisa.sock
printf '{"jsonrpc":"2.0","method":"engine.status","id":1}\n' \
    | nc -U ~/Library/Application\ Support/Matisa/matisa.sock
```

Expected: socket file exists; `engine.status` response is `{"status":"ok",...}`.

- [ ] **Step 3: Quit the app and confirm the engine survives**

In the app, press ⌘Q. Then in terminal:

```bash
pgrep -fl matisa-engine
```

Expected: matisa-engine process is still running (it was reparented to launchd when the app exited).

- [ ] **Step 4: Stop the orphaned engine for clean state**

```bash
pkill -f matisa-engine
```

- [ ] **Step 5: Commit**

```bash
git add Sources/Matisa/App.swift
git commit -m "Phase 3: app auto-spawns the engine at launch"
```

---

## Task 8: Engine status in `EngineMirror.Snapshot`

**Files:**
- Modify: `Sources/Matisa/Engine/EngineMirror.swift`
- Modify: `Sources/Matisa/Store/ServiceStore.swift` (the field, the refresh-applier)

### Approach

`EngineMirror.pull` already issues `services.snapshot` first as the gate. Add `engine.status` to the pulled fields. Surface it on `ServiceStore` as a published property the UI can bind to.

`EngineStatus` is defined engine-side; for the app to decode it, the simplest path is a mirror struct in `EngineClient.swift` (matching the shape). Future-cleaner is to move `EngineStatus` to `MatisaCore`, but that's a wider change — defer.

- [ ] **Step 1: Add a mirror `EngineStatus` shape in EngineClient.swift**

At the bottom of `Sources/Matisa/Engine/EngineClient.swift`, alongside the other shared shapes, append:

```swift
/// Mirror of the engine's `EngineStatus`. Decoded from `engine.status` RPC
/// responses. Kept in lock-step with the engine-side type in
/// `Sources/MatisaEngine/Methods.swift`.
struct EngineStatusInfo: Decodable {
    let status: String
    let version: String
    let uptimeSeconds: Int
}
```

Note: If `EngineStatus` is already public from `MatisaCore`, skip this struct and import it instead. Search `EngineStatus` under `Sources/MatisaCore/` first.

- [ ] **Step 2: Extend `EngineMirror.Snapshot`**

In `Sources/Matisa/Engine/EngineMirror.swift`, in the `Snapshot` struct definition, add a new field:

```swift
        let engine: EngineStatusInfo?
```

In `pull`, after the `services.snapshot` gate succeeds and before `launch_failures.list`, add:

```swift
        let engine = try? await EngineClient.shared.call(
            "engine.status",
            as: EngineStatusInfo.self
        )
```

Then include `engine: engine` in both the success and failure `Snapshot(...)` returns. In the failure-gate return (where everything is nil), use `engine: nil`.

- [ ] **Step 3: Surface on `ServiceStore` and apply in refresh**

In `Sources/Matisa/Store/ServiceStore.swift`, find where other engine-mirrored fields (e.g. `caddyService`, `dockerSystem`) are declared as published/`@Observable` properties. Add a sibling:

```swift
    var engineStatus: EngineStatusInfo? = nil
```

In the refresh-applier function (where `snap.caddy`, `snap.dockerSystem`, etc. are read), add:

```swift
        if let engine = snap.engine {
            self.engineStatus = engine
        } else if snap.services == nil {
            // engine unreachable — mark stale
            self.engineStatus = nil
        }
```

The second arm matters because a sticky non-nil value would lie when the engine has died. We mirror the same gate used by the other fields.

- [ ] **Step 4: Build**

```bash
swift build 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 5: Run tests**

```bash
swift test 2>&1 | tail -10
```

Expected: all pass (no new tests for this slice; existing refresh tests should be unaffected).

- [ ] **Step 6: Commit**

```bash
git add Sources/Matisa/Engine/EngineClient.swift Sources/Matisa/Engine/EngineMirror.swift Sources/Matisa/Store/ServiceStore.swift
git commit -m "Phase 3: mirror engine.status into ServiceStore"
```

---

## Task 9: System group adds Engine row

**Files:**
- Modify: `Sources/Matisa/Window/MainWindowView.swift`
- Create: `Sources/Matisa/Window/EngineDetailView.swift`
- Modify: `Sources/Matisa/Store/ServiceStore.swift` (add `performEngineStart` / `performEngineStop`)

### Approach

Three pieces:

1. **`SidebarSelection.engine`** — new enum case in `MainWindowView.swift`.
2. **`engineRow`** — view inside the System group, modelled on `caddyRow`. Status dot from `store.engineStatus != nil`. Trailing button calls `performEngineStop` (when running) or `performEngineStart` (when down).
3. **`EngineDetailView`** — detail pane (Engine version, uptime, socket path, last error if any). Keep minimal — this is information, not a control surface beyond start/stop.

ServiceStore actions wrap `EngineClient.shutdown()` (stop) and `EngineLauncher.ensureRunning()` (start).

- [ ] **Step 1: Add `case engine` to `SidebarSelection`**

In `Sources/Matisa/Window/MainWindowView.swift:5-10`:

```swift
enum SidebarSelection: Hashable {
    case service(String)
    case caddy
    case docker
    case engine
    case configError
}
```

- [ ] **Step 2: Bump count and add `engineRow` to the System group**

Find the System `CollapsibleSection` (around line 147-159) and replace:

```swift
                    CollapsibleSection(
                        id: "system",
                        title: "System",
                        count: 3,
                        collapsedAccessory: {
                            GroupRunningIndicator(runningCount: systemRunningCount)
                        }
                    ) {
                        VStack(spacing: 6) {
                            caddyRow
                            dockerRow
                            engineRow
                        }
                    }
```

- [ ] **Step 3: Update `systemRunningCount`**

In `Sources/Matisa/Window/MainWindowView.swift`, find `systemRunningCount` (around line 579) and update:

```swift
    /// System section has three rows (Caddy, Docker, Engine).
    /// Lit when each is up.
    private var systemRunningCount: Int {
        (store.caddyService.running ? 1 : 0)
            + (store.dockerSystem.isRunning ? 1 : 0)
            + (store.engineStatus != nil ? 1 : 0)
    }
```

- [ ] **Step 4: Add `engineRow` view**

In `Sources/Matisa/Window/MainWindowView.swift`, after `dockerRow` (around line 453), append:

```swift
    @ViewBuilder
    private var engineRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "gearshape.2.fill")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text("Engine")
                    .font(.body.weight(.medium))
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.engineStatus != nil ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    Text(engineStatusLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            IconButton(
                store.engineStatus != nil ? "stop.fill" : "play.fill",
                help: store.engineStatus != nil ? "Stop engine" : "Start engine",
                tint: store.engineStatus != nil ? .red : .green
            ) {
                Task {
                    if store.engineStatus != nil {
                        await store.performEngineStop()
                    } else {
                        await store.performEngineStart()
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(selection == .engine ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(
                    selection == .engine ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.12)
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .onTapGesture { selection = .engine }
    }

    private var engineStatusLabel: String {
        if let s = store.engineStatus {
            return "Running · v\(s.version)"
        } else {
            return "Stopped"
        }
    }
```

- [ ] **Step 5: Add the detail-view case**

In `Sources/Matisa/Window/MainWindowView.swift`, in the `detail` switch (around line 504), add:

```swift
        case .engine:
            EngineDetailView()
```

- [ ] **Step 6: Create `EngineDetailView`**

Create `Sources/Matisa/Window/EngineDetailView.swift`:

```swift
import SwiftUI

struct EngineDetailView: View {
    @Environment(ServiceStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "gearshape.2.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Matisa Engine")
                        .font(.title2.weight(.semibold))
                    Text(headerSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(store.engineStatus != nil ? "Stop" : "Start") {
                    Task {
                        if store.engineStatus != nil {
                            await store.performEngineStop()
                        } else {
                            await store.performEngineStart()
                        }
                    }
                }
                .controlSize(.large)
            }

            Divider()

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    Text("Status").foregroundStyle(.secondary)
                    Text(store.engineStatus?.status ?? "—")
                }
                GridRow {
                    Text("Version").foregroundStyle(.secondary)
                    Text(store.engineStatus?.version ?? "—")
                }
                GridRow {
                    Text("Uptime").foregroundStyle(.secondary)
                    Text(uptimeLabel)
                }
                GridRow {
                    Text("Socket").foregroundStyle(.secondary)
                    Text(EngineClient.defaultSocketPath())
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .font(.body)

            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var headerSubtitle: String {
        store.engineStatus != nil ? "Running" : "Not reachable"
    }

    private var uptimeLabel: String {
        guard let s = store.engineStatus else { return "—" }
        let h = s.uptimeSeconds / 3600
        let m = (s.uptimeSeconds % 3600) / 60
        let sec = s.uptimeSeconds % 60
        if h > 0 { return "\(h)h \(m)m \(sec)s" }
        if m > 0 { return "\(m)m \(sec)s" }
        return "\(sec)s"
    }
}
```

- [ ] **Step 7: Add `performEngineStart` / `performEngineStop` to `ServiceStore`**

In `Sources/Matisa/Store/ServiceStore.swift`, near `performCaddy` (around line 863), add:

```swift
    func performEngineStart() async {
        do {
            _ = try await EngineLauncher.ensureRunning(
                socketPath: EngineClient.defaultSocketPath()
            )
            await refresh()
        } catch {
            FileHandle.standardError.write(
                Data("performEngineStart: \(error)\n".utf8)
            )
        }
    }

    func performEngineStop() async {
        do {
            try await EngineClient.shared.shutdown()
        } catch {
            FileHandle.standardError.write(
                Data("performEngineStop: \(error)\n".utf8)
            )
        }
        // Clear the mirror immediately — the next refresh will confirm
        // the socket is gone, but the UI shouldn't lag behind a known stop.
        self.engineStatus = nil
        await refresh()
    }
```

- [ ] **Step 8: Build the app and verify the row appears**

```bash
./build-app.sh debug
open build/Matisa.app
```

Click around. Verify:
- System group shows 3 items.
- Engine row has a green dot and "Running · v0.5.0-phase2" (or current version).
- Clicking the row selects it and the detail pane shows version/uptime/socket.
- The stop button SIGTERMs the engine — within a second, the dot goes grey, the row label says "Stopped", and the start button appears.
- Clicking start re-spawns the engine, dot turns green again.

- [ ] **Step 9: Commit**

```bash
git add Sources/Matisa/Window/MainWindowView.swift Sources/Matisa/Window/EngineDetailView.swift Sources/Matisa/Store/ServiceStore.swift
git commit -m "Phase 3: Engine row in System group with start/stop controls"
```

---

## Task 10: Bump engine version + update `plan.md`

**Files:**
- Modify: `Sources/MatisaEngine/Engine.swift` (version constant)
- Modify: `plan.md` (repo root)

- [ ] **Step 1: Bump engine version**

In `Sources/MatisaEngine/Engine.swift:9`:

```swift
    static let version = "0.6.0-phase3"
```

- [ ] **Step 2: Update `plan.md`**

Open `plan.md` and:

1. Move the three Phase 3 commits already there (engine-action clients extraction, EngineMirror extraction, local-fallback bodies) plus the new commits from this plan into the "What's done" table. Each row: short hash, slice name, 2-3 line summary.

2. Update the architecture summary at the top to reflect: the engine is now auto-spawned by the app, bundled in the .app, and stoppable via `engine.shutdown`. The dev-time "open a second terminal" caveat (plan.md:191) is gone — note it as historical.

3. In "Open decisions": remove the `engine.shutdown` entry (it now exists). Mark engine-side log rotation timer still pending. Update the "no engine spawn-on-demand from app yet" convention note to reflect that it's now done; Phase 8 remains for `SMAppService` (start-at-login, supervised respawn).

4. In "Remaining phases", mark Phase 3 as in-progress / complete (depending on whether all 10 tasks above landed), and confirm Phase 8's scope narrowed (`SMAppService` + login-item integration only — actual lifecycle plumbing is done).

- [ ] **Step 3: Run the full suite one last time**

```bash
swift test 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Build the .app and smoke-test once more**

```bash
./build-app.sh debug
open build/Matisa.app
```

Manual checks (no automation — UI):
- Engine spawns automatically.
- Engine row visible with green dot.
- Stop button stops it (row goes grey).
- Start button re-spawns it (row goes green).
- ⌘Q quits the app; engine keeps running (`pgrep -fl matisa-engine` confirms).
- Re-launch app; existing engine is reused (no second spawn — flock would have rejected anyway).

- [ ] **Step 5: Commit**

```bash
git add Sources/MatisaEngine/Engine.swift plan.md
git commit -m "Phase 3: bump engine to 0.6.0-phase3; update plan.md"
```

---

## Self-Review Checklist (already applied)

**Spec coverage:**
- ✅ Engine bundled in .app — Task 2.
- ✅ Any client can start the engine — Task 5 (`ensureRunning` is callable from any client; app wires it in Task 7, CLI/MCP can use the same primitive when they exist).
- ✅ Any client can stop the engine — Tasks 1 + 6 (`engine.shutdown` RPC + `EngineClient.shutdown()` wrapper). CLI/MCP just need the wire method.
- ✅ Engine row in System group — Task 9.
- ✅ "Properly first time" — Tasks 1-2 land the wire method and bundling; we don't ship a stopgap that has to be reverted.

**Placeholder scan:**
- No TBDs, no "implement later", no "handle edge cases" without code.
- One soft caveat: Task 8 step 1 says "if `EngineStatus` is already public from MatisaCore, skip this struct and import it." This is conditional but explicit — it tells the engineer exactly how to decide.

**Type consistency:**
- `EmptyResponse` referenced in Task 1 matches the engine's existing type.
- `EngineStatusInfo` introduced in Task 8 is the only place that name appears — and it's the app-side mirror, distinct from engine-side `EngineStatus`. Naming is explicit.
- `LaunchResult` / `LaunchError` are local to `EngineLauncher`, only consumed by ensureRunning's caller.

**Known gaps deliberately deferred (not blocking):**
- No App Group integration (Phase 7 / widget concern).
- No `SMAppService` registration (Phase 8).
- No supervised respawn-on-crash (Phase 8 — `SMAppService` gives this for free via launchd).
- Engine-side log rotation timer still not driven from engine main loop — pre-existing plan.md gap, not in this slice's scope.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-13-engine-lifecycle.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because most tasks are independent and each ends with a test command + commit.

**2. Inline Execution** — Execute tasks in this session, batch execution with checkpoints for review.

**Which approach?**
