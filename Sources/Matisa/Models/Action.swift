import Foundation

/// User-triggered actions on a service. Validated by the store; not every
/// action is valid for every kind/state.
enum ServiceAction: Hashable, Sendable {
    case start
    case stop
    case kill           // SIGKILL (no graceful shutdown)
    case restart
    case openURL
    case copyURL
    case revealInFinder
    case revealInEditor
    case revealInTerminal
    case takeOver       // managed service running unmanaged: stop the rogue, respawn under us
    case pull
    case execShell
    case openCaddyfile
    case validateCaddy
    case reloadCaddy
}
