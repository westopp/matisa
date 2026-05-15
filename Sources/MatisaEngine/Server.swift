import Foundation
import Darwin

/// Minimal Unix Domain Socket server.
///
/// We use POSIX sockets directly rather than Network.framework — UDS listeners
/// work via NWListener but the API is awkward (port-shaped where UDS is path-
/// shaped) and adds layers we don't need. Direct sockets are ~80 lines, easy
/// to reason about, and let us set filesystem permissions explicitly.
///
/// The server accepts on a serial queue and hands each accepted fd off to a
/// concurrent worker queue. The connection handler owns the fd from there.
final class UnixSocketServer {

    let path: String
    private var serverFD: Int32 = -1
    private var lockFD: Int32 = -1
    private let onConnection: (Int32) -> Void

    private let acceptQueue = DispatchQueue(label: "engine.socket.accept", qos: .userInitiated)
    private let workerQueue = DispatchQueue(
        label: "engine.socket.workers",
        qos: .userInitiated,
        attributes: .concurrent
    )

    init(path: String, onConnection: @escaping (Int32) -> Void) {
        self.path = path
        self.onConnection = onConnection
    }

    func start() throws {
        // Ensure parent directory exists.
        let parent = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: parent,
            withIntermediateDirectories: true
        )

        // Acquire exclusive lock on a sibling lockfile *before* touching the
        // socket node. If another engine is already running against this path
        // we fail fast instead of silently stealing its socket via unlink+bind
        // (which would leave the first engine running on an unnamed inode
        // while new clients connect to us). The lock is held for the lifetime
        // of the process and auto-released on close / process exit.
        let lockPath = path + ".lock"
        let lfd = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard lfd >= 0 else { throw SocketError.lock(errnoCopy(), lockPath) }
        // Stamp FD_CLOEXEC before flock so the fd doesn't leak into any child
        // process the engine spawns. Without this, a child started by one of
        // our service spawns inherits this fd; when the engine then exits but
        // the child outlives it (reparented to launchd), the child keeps the
        // flock alive and every subsequent engine start fails with "another
        // matisa-engine appears to be running" until the child is killed.
        // Observed in the wild against an orphan `bun run dev` from a
        // long-stopped service spawn.
        _ = fcntl(lfd, F_SETFD, FD_CLOEXEC)
        if flock(lfd, LOCK_EX | LOCK_NB) != 0 {
            let e = errnoCopy()
            close(lfd)
            throw SocketError.alreadyRunning(path: lockPath, errno: e)
        }
        lockFD = lfd
        // Stamp PID into the lockfile for diagnostics.
        ftruncate(lfd, 0)
        let pidString = "\(getpid())\n"
        _ = pidString.withCString { ptr in write(lfd, ptr, strlen(ptr)) }

        // umask before bind so the socket node is created mode-600 from the
        // kernel's perspective — closes the window between bind() and the
        // defensive chmod below where another local user could connect.
        let prevUmask = umask(0o077)
        defer { umask(prevUmask) }

        // Safe to remove a stale socket file now that we own the lock.
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.create(errnoCopy()) }

        // Build sockaddr_un with the path. sun_path is a fixed C array
        // (typically 104 bytes on macOS); the path must fit including the
        // trailing NUL.
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            close(fd)
            throw SocketError.pathTooLong(path)
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: UInt8.self, capacity: capacity) { bytePtr in
                for (i, b) in pathBytes.enumerated() { bytePtr[i] = b }
                bytePtr[pathBytes.count] = 0
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { addrPtr -> Int32 in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                Darwin.bind(fd, saPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            let e = errnoCopy()
            close(fd)
            throw SocketError.bind(e)
        }

        // Belt-and-braces. The umask above is the primary guarantee; this
        // covers exotic filesystems / mount options that ignore umask.
        chmod(path, 0o600)

        guard listen(fd, 32) == 0 else {
            let e = errnoCopy()
            close(fd)
            throw SocketError.listen(e)
        }

        serverFD = fd
        acceptQueue.async { [weak self] in self?.acceptLoop() }
    }

    func stop() {
        let fd = serverFD
        serverFD = -1
        if fd >= 0 { close(fd) }
        unlink(path)

        // Releases the flock as a side effect of close(). We deliberately do
        // NOT unlink the lockfile — a new engine starting concurrently would
        // create a fresh inode and miss our lock. The lockfile is small and
        // sticks around.
        let lfd = lockFD
        lockFD = -1
        if lfd >= 0 { close(lfd) }
    }

    private func acceptLoop() {
        while true {
            let listenFD = serverFD
            guard listenFD >= 0 else { return }

            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                let e = errnoCopy()
                if e == EINTR { continue }
                // EBADF / closed socket = clean shutdown
                if e == EBADF { return }
                FileHandle.standardError.write(
                    Data("matisa-engine: accept failed: \(String(cString: strerror(e)))\n".utf8)
                )
                return
            }

            let cb = onConnection
            workerQueue.async { cb(clientFD) }
        }
    }

    private func errnoCopy() -> Int32 { errno }
}

enum SocketError: Error, CustomStringConvertible {
    case create(Int32)
    case bind(Int32)
    case listen(Int32)
    case pathTooLong(String)
    case lock(Int32, String)
    case alreadyRunning(path: String, errno: Int32)

    var description: String {
        switch self {
        case .create(let e): return "socket() failed: \(String(cString: strerror(e)))"
        case .bind(let e):   return "bind() failed: \(String(cString: strerror(e)))"
        case .listen(let e): return "listen() failed: \(String(cString: strerror(e)))"
        case .pathTooLong(let p): return "socket path too long for sockaddr_un: \(p)"
        case .lock(let e, let p): return "could not open lockfile \(p): \(String(cString: strerror(e)))"
        case .alreadyRunning(let p, _):
            return "another matisa-engine appears to be running (lock held on \(p)). Stop it first or set MATISA_SOCKET to a different path."
        }
    }
}
