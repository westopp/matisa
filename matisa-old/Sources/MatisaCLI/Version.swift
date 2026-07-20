/// CLI version. Bumped independently of the engine; the engine has its
/// own `Engine.version` exposed via `engine.status`. `matisa --version`
/// shows both when the engine is reachable.
enum CLIVersion {
    static let value = "0.1.0-phase4"
}
