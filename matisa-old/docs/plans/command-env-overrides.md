# Command-level Env Overrides + README

**Status:** Pending  
**Date:** 2026-05-25

---

## Goal

Two deliverables in one commit:

1. **Feature** — `commands` entries in `matisa.config.ts` can declare their own `env` block. Command-level env merges on top of service-level env; command wins on conflict. The string form stays valid — the object form is opt-in.
2. **Documentation** — Create `README.md` at the project root. It must give a user enough context to start using Matisa, including concrete config examples, without needing to read `services.ts` or any internal docs.

---

## Part A — Feature Implementation

### User-facing shape

```ts
// String form — existing, still valid
commands: {
  'Run tests': 'jest --watch',
}

// Object form — new
commands: {
  'Run tests': {
    command: 'jest --watch',
    env: {
      CI: 'false',          // all contexts
      prod: {               // applied only when active context === 'prod'
        CI: 'true',
      },
    },
  },
}
```

### Env resolution order (highest wins)

```
.zshrc / .zprofile  (login shell: -i -l)
  ↓
service env.base
  ↓
service env.<activeContext>
  ↓
command env.base           ← new
  ↓
command env.<activeContext> ← new
```

Unknown context key in a command's env (a context name absent from the service's `env` block) → warn to stderr at config-load time, continue.

### Files to change

#### 1. `Sources/MatisaEngine/ConfigService.swift` — bun eval script

The inline JS `norm()` function currently maps `{ name: string }` object entries to `[{ name, command }]`. Extend it to handle `string | { command: string, env?: object }` per entry:

```js
const norm = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.entries(v).map(([name, val]) => {
    if (typeof val === 'string')
      return { name, command: val };
    if (typeof val === 'object' && val !== null && typeof val.command === 'string')
      return { name, command: val.command, env: splitEnv(val.env) };
    return null;
  }).filter(Boolean);
};
```

After normalising each service's commands, warn for unknown context names:

```js
const serviceCtxNames = new Set((s.env?.contexts ?? []).map(c => c.name));
(mappedCommands ?? []).forEach(cmd => {
  (cmd.env?.contexts ?? []).forEach(ctx => {
    if (!serviceCtxNames.has(ctx.name))
      process.stderr.write(
        `matisa: warning: command "${cmd.name}" env context "${ctx.name}" ` +
        `is not declared in service "${s.name || 'unknown'}" — it will never be applied\n`
      );
  });
});
```

`build` deprecation: if `s.build` exists, emit a stderr deprecation warning and drop the field before forwarding JSON to Swift.

#### 2. `Sources/Matisa/Config/ConfigLoader.swift` — app-side bun eval script

`ConfigService.swift` and `ConfigLoader.swift` embed the same eval script (the file header says "keep in sync"). Apply the identical `norm()` and warning changes here.

#### 3. `Sources/MatisaCore/Config/Config.swift`

Add `env: RawEnv?` to `RawNamedCommand`:

```swift
public struct RawNamedCommand: Decodable, Hashable {
    public let name: String
    public let command: String
    public let env: RawEnv?           // new
}
```

Update `commandsFromRaw` to pass env through:

```swift
.map { NamedCommand(name: $0.name, command: $0.command, env: Self.envFromRaw($0.env)) }
```

Update the stale comment on line ~110: remove "`build` / " from "Same trick we use for `build` / `scripts`".

#### 4. `Sources/MatisaCore/Models/ServiceSpec.swift`

Add `env: EnvSpec?` to `NamedCommand` with a default of `nil` so existing call-sites compile unchanged:

```swift
public struct NamedCommand: Hashable, Sendable, Codable {
    public let name: String
    public let command: String
    public let env: EnvSpec?          // new — optional, auto-Codable, wire-additive
    public init(name: String, command: String, env: EnvSpec? = nil) {
        self.name = name; self.command = command; self.env = env
    }
}
```

Wire compatibility: `env` is optional. Old clients decoding `NamedCommand` without the key receive `nil`. No manual `Codable` conformance needed.

#### 5. `Sources/Matisa/Store/ServiceStore.swift` — env resolution at spawn time

The existing env resolution is around line ~710:

```swift
let env = service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]
```

Replace with a merge that layers the matched command's env on top:

```swift
var env = service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]
if let cmdEnv = match.env {
    env.merge(cmdEnv.effective(activeContext: activeEnvContext)) { _, cmd in cmd }
}
```

`match` is the `NamedCommand` already retrieved on line ~651. No other call-sites change — the engine receives the same flat `extraEnv: [String: String]`.

### `build` cleanup checklist

- [ ] Bun eval script (both files): detect `s.build`, emit deprecation warning, drop field
- [ ] `Config.swift` line ~110 comment: remove "`build` / "
- [ ] Grep codebase for any remaining `build:` referring to the old config property (not the Swift build system) — update or remove stray references

### Tests

- [ ] `MatisaCoreTests`: round-trip `NamedCommand` with `env: nil` — confirms existing callers still work
- [ ] `MatisaCoreTests`: round-trip `NamedCommand` with a populated `EnvSpec` — confirms new field serialises correctly
- [ ] New unit test: command env merge precedence
  - service base `{ A: "service" }` + command base `{ A: "command", B: "cmd-only" }` → `{ A: "command", B: "cmd-only" }`
  - service context `{ A: "svc-ctx" }` + command context `{ A: "cmd-ctx" }` → `{ A: "cmd-ctx" }`
  - non-conflicting service keys survive: `{ C: "svc-only" }` still present
- [ ] String-form command regression: `norm()` change must leave string-form commands with `env == nil`

### Commit

One commit — all five files change together. A half-applied state (Swift types updated, bun script not) would produce decode failures.

---

## Part B — README

No `README.md` exists today. Create it at the project root.

### Audience

A developer who has just installed Matisa. They know what a dev environment is; they do not know Matisa's concepts or config shape. The README replaces reading `services.ts`, internal docs, and the source.

### Structure

```
1. What is Matisa
2. How it works (one-paragraph architecture)
3. Installation
4. Your first config (matisa.config.ts)
   4a. Project service
   4b. Docker service
   4c. Compose service
5. Environment variables
   5a. Base env
   5b. Environment contexts (dev / staging / prod)
   5c. Command-level env overrides  ← include the new feature
6. Named commands
7. Groups
8. CLI quick reference
9. Engine
```

### Section content spec

#### 1. What is Matisa

One sentence: Matisa is a macOS dev-environment manager — it starts and monitors your dev servers, Docker containers, and Compose stacks, and exposes them over a local reverse proxy with optional public tunnels and same-network mDNS.

#### 2. How it works

Three sentences: The Matisa app reads a TypeScript config (`matisa.config.ts`), starts a background engine process, and renders live status. The engine owns all state; the SwiftUI app, a CLI (`matisa`), and (coming soon) an MCP server all talk to it over a local socket. Services keep running after you quit the app or close the window.

#### 3. Installation

- Download the `.app` from releases (placeholder — link TBD)
- Open the app
- **Install CLI:** open the Engine row in the sidebar → Install command-line tool → grants `matisa` on your PATH

#### 4. Your first config

Config lives at `~/.config/matisa/services.ts`. The file is TypeScript evaluated by `bun` — you get type safety, imports, and dynamic values.

**4a. Project service** — a local dev-server process Matisa spawns and supervises:

```ts
// ~/.config/matisa/services.ts
export default {
  services: [
    {
      type: 'project',
      name: 'api',
      path: '~/projects/my-api',
      port: 3000,
      command: 'bun run dev',
    },
  ],
}
```

`path` — the working directory. `port` — what the service listens on. `command` — the shell command Matisa runs.

**4b. Docker service** — a container Matisa pulls and runs:

```ts
{
  type: 'docker',
  name: 'postgres',
  image: 'postgres:16',
  port: 5432,
}
```

**4c. Compose service** — delegates to `docker compose`:

```ts
{
  type: 'compose',
  name: 'workers',
  file: '~/projects/my-api/docker-compose.yml',
  ports: [
    { host: 6379, url: 'redis://localhost:6379' },
  ],
}
```

**Full example — multiple services:**

```ts
export default {
  services: [
    {
      type: 'project',
      name: 'api',
      path: '~/projects/my-api',
      port: 3000,
      command: 'bun run dev',
      group: 'Backend',
    },
    {
      type: 'project',
      name: 'web',
      path: '~/projects/my-web',
      port: 5173,
      command: 'npm run dev',
      group: 'Frontend',
    },
    {
      type: 'docker',
      name: 'postgres',
      image: 'postgres:16',
      port: 5432,
      group: 'Infrastructure',
    },
  ],
}
```

#### 5. Environment variables

**5a. Base env** — always injected, every context:

```ts
{
  type: 'project',
  name: 'api',
  path: '~/projects/my-api',
  port: 3000,
  command: 'bun run dev',
  env: {
    DATABASE_URL: 'postgres://localhost/mydb_dev',
    LOG_LEVEL: 'debug',
  },
}
```

**5b. Environment contexts** — named overlays. Switch the active context from the app's Environment tab or with `matisa env use <name>`. Context vars layer on top of base; context wins on conflict:

```ts
env: {
  DATABASE_URL: 'postgres://localhost/mydb_dev',  // base — all contexts
  LOG_LEVEL: 'debug',

  staging: {
    DATABASE_URL: 'postgres://staging-host/mydb',
    LOG_LEVEL: 'info',
  },
  prod: {
    DATABASE_URL: 'postgres://prod-host/mydb',
    LOG_LEVEL: 'warn',
  },
},
```

When `staging` is active, the service sees `DATABASE_URL=postgres://staging-host/mydb` and `LOG_LEVEL=info`. Base keys not overridden by the context are still injected.

**5c. Command-level env overrides** — individual commands can declare their own env. Same base/context pattern. Command env layers on top of service env; command wins on conflict. This is the new feature from Phase 5.0:

```ts
commands: {
  // String form — simple case, no env override needed
  'Run tests': 'jest --watch',

  // Object form — override env for this command only
  'Build': {
    command: 'bun run build',
    env: {
      NODE_ENV: 'production',     // overrides service-level NODE_ENV in all contexts
      SOURCEMAPS: 'false',

      staging: {
        SOURCEMAPS: 'true',       // only when active context is 'staging'
      },
    },
  },

  // Another example: integration tests need a separate DB
  'Integration tests': {
    command: 'jest --testPathPattern=integration',
    env: {
      DATABASE_URL: 'postgres://localhost/mydb_test',
    },
  },
},
```

Resolution order (highest wins): login shell PATH → service env base → service env context → command env base → command env context.

#### 6. Named commands

Commands are ad-hoc tasks attached to a service — builds, tests, lints, migrations, anything you want one click away. They appear in the service row's command menu in the app and via `matisa run <service> <command>` in the CLI.

```ts
{
  type: 'project',
  name: 'api',
  path: '~/projects/my-api',
  port: 3000,
  command: 'bun run dev',
  commands: {
    'Run tests':    'bun test',
    'Lint':         'eslint src',
    'Type check':   'tsc --noEmit',
    'DB migrate':   'bun run db:migrate',
    'DB seed':      'bun run db:seed',
  },
}
```

At most two commands run concurrently per service. Output streams into the log pane and is retained until you close it.

#### 7. Groups

`group` is an optional string that collapses services under a shared header in the sidebar:

```ts
{ type: 'project', name: 'api',      group: 'Backend',        … },
{ type: 'project', name: 'worker',   group: 'Backend',        … },
{ type: 'project', name: 'web',      group: 'Frontend',       … },
{ type: 'docker',  name: 'postgres', group: 'Infrastructure', … },
```

#### 8. CLI quick reference

```bash
matisa list                     # all services and their status
matisa start <id>               # start a service
matisa stop <id>                # stop a service
matisa restart <id>             # restart a service
matisa logs <id>                # last 200 lines of a service's log
matisa logs <id> --lines 50     # last N lines
matisa engine status            # is the engine running?
matisa engine start             # start the engine
matisa engine stop              # stop the engine
matisa --socket /tmp/alt.sock … # target a non-default socket
matisa --json …                 # emit raw JSON-RPC result (scriptable)
```

Exit codes: `0` success · `1` usage error · `2` engine unreachable · `3` RPC error · `4` spawn failure.

#### 9. Engine

The Matisa engine is a background process that owns all state. It starts automatically when you open the app and keeps running after you quit — your services stay up. The app, CLI, and (soon) an MCP server all talk to the engine over a local Unix socket at `~/Library/Application Support/Matisa/matisa.sock`.

To stop both the engine and your services: **Engine row → Stop engine** in the app, or `matisa engine stop` in the CLI.

### README writing notes

- Keep it scannable — short paragraphs, code blocks for everything config-shaped.
- Do not reference internal architecture, Swift, or engine internals — those belong in `plan.md`.
- The command-level env section (5c) must explicitly call out that both string and object forms are accepted and that string form is the common case — don't make users feel they have to use the object form.
- The CLI section is a quick reference, not exhaustive documentation. Full help is `matisa help`.
- No version numbers in the README yet — Matisa hasn't shipped a stable release.

---

## Implementation order

1. **Feature (Part A)** — implement and get tests green first. A green test suite is the prerequisite for the README being accurate.
2. **README (Part B)** — write it after the feature lands. The command-level env examples in section 5c must match the implemented behaviour exactly.
3. **One commit per part** — two commits total:
   - `Phase 5.0: command-level env overrides` — all Swift + bun eval changes + tests
   - `docs: add README with config examples and command-level env docs` — README only

---

## Definition of done

- [ ] `swift test` passes (all existing tests + new merge-precedence tests)
- [ ] String-form commands still work end-to-end (manual smoke test: start a service with a string command)
- [ ] Object-form command with env override: start the command, confirm the env var is injected (check via `env | grep VAR` in the command's output or log)
- [ ] Unknown context warning appears in the engine log when a command declares a context not in the service's env block
- [ ] `build:` in a config emits a deprecation warning and the service still loads
- [ ] README exists at project root, renders correctly on GitHub
- [ ] README examples are copy-paste runnable (no placeholder values that would cause config parse errors)
