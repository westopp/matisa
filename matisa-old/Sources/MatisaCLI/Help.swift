import Foundation

/// Help text — kept inline rather than read from a Resources file so the
/// CLI binary stays single-file-portable (matters for the `/usr/local/bin/
/// matisa` symlink-from-bundle install pattern). Two granularities:
/// global help (`matisa --help`) and per-topic help (`matisa help engine`).
enum Help {

    static func print(topic: String?) {
        switch topic {
        case nil:
            printGlobal()
        case "engine":
            printEngine()
        default:
            // Unknown topic → fall back to global help so users discover
            // what's available instead of getting an error.
            printGlobal()
        }
    }

    private static func printGlobal() {
        Output.println("""
matisa \(CLIVersion.value) — control Matisa from the command line

USAGE
  matisa <command> [options]

SERVICE COMMANDS
  list                   List all services and their current state
  start <id>             Start a service
  stop <id>              Stop a service
  restart <id>           Restart a service
  logs <id>              Tail the on-disk log file for a service
                         (--lines N, --all; -f streaming is Phase 5)

ENGINE COMMANDS
  engine status          Show engine status, version, and uptime
  engine start           Start the engine (no-op if already running)
  engine stop            Stop the engine cleanly

OTHER
  help [topic]           Show help; topic is 'engine' for engine details
  --version, -v          Show CLI and engine versions

OPTIONS
  --socket <path>        Override UDS path (default: $MATISA_SOCKET or
                         ~/Library/Application Support/Matisa/matisa.sock)
  --ensure-engine        Auto-spawn the engine if it isn't running
                         (default: fail loud)
  --json                 Emit raw JSON instead of human-readable text
  --help, -h             Show this help

EXIT CODES
  0  success
  1  usage error
  2  engine unreachable / transport failure
  3  engine returned an RPC error
  4  engine spawn/lifecycle failure
""")
    }

    private static func printEngine() {
        Output.println("""
matisa engine — manage the matisa-engine background daemon

USAGE
  matisa engine status
  matisa engine start
  matisa engine stop

  status   Returns the engine's reported version and uptime over the wire.
           Exit 2 if the engine isn't reachable.

  start    Idempotent. Locates the matisa-engine binary (env override
           MATISA_ENGINE_BINARY, sibling-of-CLI, .build/<config>) and
           posix_spawns it detached so it survives this process. Polls
           the socket up to 5s for readiness.

  stop     Sends engine.shutdown over the wire; the engine acks and exits
           ~100ms later. Reports "engine not running" if it was already
           down (exit 0).

ENGINE LIFETIME
  The engine is normally spawned by the Matisa app at launch and stays
  alive after the app quits. The CLI's start/stop commands give scripts
  and headless workflows the same control.
""")
    }
}
