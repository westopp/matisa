import Foundation

/// What a successful parse yields. `command` is what to run; `options` is
/// the env around it. Both are needed at the call site so we keep them as
/// a flat struct rather than threading a context through the dispatcher.
struct Parsed {
    let command: Command
    let options: Options
}

struct Options {
    /// Override socket path. Nil means resolve via the default order
    /// ($MATISA_SOCKET → ~/Library/Application Support/Matisa/matisa.sock).
    let socketPath: String?
    /// If true, transparent auto-spawn on engine-unreachable. CLI default
    /// is "fail loud" per plan.md — this opt-in matches the app's
    /// always-spawn policy for users who'd rather not run `matisa engine
    /// start` first.
    let ensureEngine: Bool
    /// If true, emit machine-readable JSON instead of human-readable text.
    /// Specifically: the raw `result` field of the JSON-RPC response,
    /// pretty-printed.
    let jsonOutput: Bool
}

/// Resolved subcommand. The "help" and "version" pseudo-commands sit
/// alongside real ones so the dispatcher has one switch site.
enum Command: Equatable {
    case help(topic: String?)   // nil = global help; non-nil = "matisa help engine"
    case version
    case list
    case start(id: String)
    case stop(id: String)
    case restart(id: String)
    case logs(id: String, lines: Int?, all: Bool)
    case engineStatus
    case engineStart
    case engineStop
}

enum Parser {

    /// Parse argv (without the program name). On success returns the resolved
    /// command + options. On failure throws `CLIError.usage(…)` with a
    /// pointer to `matisa --help` so the user sees something actionable.
    ///
    /// Mixed-order is supported: flags and positional args can interleave.
    /// `--` ends flag processing (every token after is treated as positional).
    static func parse(_ argv: [String]) throws -> Parsed {
        var socketPath: String? = nil
        var ensureEngine = false
        var jsonOutput = false
        var positionals: [String] = []

        var i = 0
        var sawDoubleDash = false
        while i < argv.count {
            let arg = argv[i]
            if sawDoubleDash {
                positionals.append(arg)
                i += 1
                continue
            }
            switch arg {
            case "--":
                sawDoubleDash = true
                i += 1
            case "-h", "--help":
                // Help bypasses normal subcommand parsing — if it appears
                // anywhere, that wins. Tail positionals become the topic.
                let rest = Array(argv[(i+1)...])
                let topic = rest.first { !$0.hasPrefix("-") }
                return Parsed(
                    command: .help(topic: topic),
                    options: Options(socketPath: nil, ensureEngine: false, jsonOutput: false)
                )
            case "-v", "--version":
                return Parsed(
                    command: .version,
                    options: Options(socketPath: nil, ensureEngine: false, jsonOutput: false)
                )
            case "--socket":
                guard i + 1 < argv.count else {
                    throw CLIError.usage("--socket requires a path argument")
                }
                socketPath = argv[i + 1]
                i += 2
            case "--ensure-engine":
                ensureEngine = true
                i += 1
            case "--json":
                jsonOutput = true
                i += 1
            default:
                // Equals-form for --flag=value support
                if arg.hasPrefix("--socket=") {
                    socketPath = String(arg.dropFirst("--socket=".count))
                    i += 1
                } else {
                    // Unknown tokens (positional args AND unknown flags)
                    // pass through verbatim. Subcommand parsers re-scan the
                    // positional list for their own flag space — e.g.
                    // `logs --lines 5` wouldn't be a global flag, but the
                    // `logs` parser knows what to do with it. The cost: a
                    // global-flag typo like `--socet` shows up as "unknown
                    // flag for '<sub>'" or "unknown command", but that's
                    // still a recoverable error message.
                    positionals.append(arg)
                    i += 1
                }
            }
        }

        let opts = Options(
            socketPath: socketPath,
            ensureEngine: ensureEngine,
            jsonOutput: jsonOutput
        )

        let command = try resolveCommand(positionals)
        return Parsed(command: command, options: opts)
    }

    private static func resolveCommand(_ positionals: [String]) throws -> Command {
        guard let head = positionals.first else {
            // No subcommand → default to help, exit 0, so a bare `matisa`
            // invocation discovers the surface instead of erroring out.
            return .help(topic: nil)
        }
        let rest = Array(positionals.dropFirst())

        switch head {
        case "list", "ls":
            try requireNoArgs(head, rest)
            return .list
        case "start":
            return .start(id: try requireOneArg(head, rest, hint: "<service-id>"))
        case "stop":
            return .stop(id: try requireOneArg(head, rest, hint: "<service-id>"))
        case "restart":
            return .restart(id: try requireOneArg(head, rest, hint: "<service-id>"))
        case "logs":
            return try parseLogs(rest)
        case "engine":
            guard let sub = rest.first else {
                throw CLIError.usage("engine: missing subcommand (status|start|stop)\n  try: matisa help engine")
            }
            let tail = Array(rest.dropFirst())
            switch sub {
            case "status":
                try requireNoArgs("engine status", tail)
                return .engineStatus
            case "start":
                try requireNoArgs("engine start", tail)
                return .engineStart
            case "stop":
                try requireNoArgs("engine stop", tail)
                return .engineStop
            default:
                throw CLIError.usage("engine: unknown subcommand '\(sub)' (expected status|start|stop)")
            }
        case "help":
            // `matisa help [topic]` is a synonym for `matisa --help [topic]`
            return .help(topic: rest.first)
        default:
            throw CLIError.usage("unknown command: '\(head)'\n  try: matisa --help")
        }
    }

    /// `logs <id>` accepts a subset of flags that the global parser doesn't
    /// know about (`--lines`, `-n`, `--all`). Done as a tail-only pass over
    /// the positional residue so the global flag handling stays simple.
    private static func parseLogs(_ rest: [String]) throws -> Command {
        var id: String? = nil
        var lines: Int? = nil
        var all = false

        var i = 0
        while i < rest.count {
            let arg = rest[i]
            switch arg {
            case "--all":
                all = true
                i += 1
            case "--lines", "-n":
                guard i + 1 < rest.count else {
                    throw CLIError.usage("\(arg) requires a number")
                }
                guard let n = Int(rest[i + 1]), n > 0 else {
                    throw CLIError.usage("\(arg) expects a positive integer (got '\(rest[i+1])')")
                }
                lines = n
                i += 2
            default:
                if arg.hasPrefix("--lines=") {
                    let raw = String(arg.dropFirst("--lines=".count))
                    guard let n = Int(raw), n > 0 else {
                        throw CLIError.usage("--lines expects a positive integer (got '\(raw)')")
                    }
                    lines = n
                    i += 1
                } else if arg.hasPrefix("-") && arg != "-" {
                    throw CLIError.usage("unknown flag for 'logs': \(arg)")
                } else {
                    if id != nil {
                        throw CLIError.usage("'logs' takes exactly one <service-id>")
                    }
                    id = arg
                    i += 1
                }
            }
        }

        guard let id else {
            throw CLIError.usage("'logs' requires <service-id>")
        }
        if all && lines != nil {
            throw CLIError.usage("'logs' --all and --lines are mutually exclusive")
        }
        return .logs(id: id, lines: lines, all: all)
    }

    private static func requireNoArgs(_ command: String, _ rest: [String]) throws {
        if !rest.isEmpty {
            throw CLIError.usage("'\(command)' takes no arguments (got: \(rest.joined(separator: " ")))")
        }
    }

    private static func requireOneArg(_ command: String, _ rest: [String], hint: String) throws -> String {
        guard let value = rest.first else {
            throw CLIError.usage("'\(command)' requires \(hint)")
        }
        if rest.count > 1 {
            throw CLIError.usage("'\(command)' takes exactly one argument (got: \(rest.joined(separator: " ")))")
        }
        return value
    }
}
