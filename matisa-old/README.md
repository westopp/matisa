# Matisa

A macOS dev-environment manager — Matisa starts and monitors your dev servers, Docker containers, and Compose stacks, and exposes them over a local reverse proxy with optional public tunnels and same-network mDNS.

## How it works

The Matisa app reads a TypeScript config (`matisa.config.ts`), starts a background engine process, and renders live status. The engine owns all state; the SwiftUI app, a CLI (`matisa`), and (coming soon) an MCP server all talk to it over a local socket. Services keep running after you quit the app or close the window.

## Installation

- Download the `.app` from releases _(link TBD)_
- Open the app
- **Install CLI:** open the Engine row in the sidebar → **Install command-line tool** → grants `matisa` on your PATH

## Your first config

Config lives at `~/.config/matisa/services.ts`. The file is TypeScript evaluated by `bun` — you get type safety, imports, and dynamic values.

### Project service

A local dev-server process Matisa spawns and supervises:

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

### Docker service

A container Matisa pulls and runs:

```ts
{
  type: 'docker',
  name: 'postgres',
  image: 'postgres:16',
  port: 5432,
}
```

### Compose service

Delegates to `docker compose`:

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

### Full example — multiple services

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

## Environment variables

### Base env

Always injected, every context:

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

### Environment contexts

Named overlays. Switch the active context from the app's **Environment** tab or with `matisa env use <name>`. Context vars layer on top of base; context wins on conflict:

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

### Command-level env overrides

Individual commands can declare their own env. The shape mirrors service-level env — same base/context pattern. Command env layers on top of service env; command wins on conflict.

Both the string form and the object form are valid. The string form is the common case — only reach for the object form when you need a per-command override:

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

Resolution order, lowest precedence to highest (later layers override earlier ones on key collisions):

1. login shell PATH (inherited)
2. service `env` base
3. service `env.<activeContext>`
4. command `env` base
5. command `env.<activeContext>` ← wins

So if both the service and the command define `DATABASE_URL`, the command's value is what the spawned process sees.

## Named commands

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

## Groups

`group` is an optional string that collapses services under a shared header in the sidebar:

```ts
{ type: 'project', name: 'api',      group: 'Backend',        /* … */ },
{ type: 'project', name: 'worker',   group: 'Backend',        /* … */ },
{ type: 'project', name: 'web',      group: 'Frontend',       /* … */ },
{ type: 'docker',  name: 'postgres', group: 'Infrastructure', /* … */ },
```

## CLI quick reference

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

Full help: `matisa help`.

Exit codes: `0` success · `1` usage error · `2` engine unreachable · `3` RPC error · `4` spawn failure.

## Engine

The Matisa engine is a background process that owns all state. It starts automatically when you open the app and keeps running after you quit — your services stay up. The app, CLI, and (soon) an MCP server all talk to the engine over a local Unix socket at `~/Library/Application Support/Matisa/matisa.sock`.

To stop both the engine and your services: **Engine row → Stop engine** in the app, or `matisa engine stop` in the CLI.
