# Known Issues

## Probe / command env mismatch (SyncShell)

**Summary.** Discovery probes spawned via `SyncShell.runCapturing` inherit the
matisa process's environment unchanged, while user-facing task commands
spawned via `TaskRunner` / `TaskService` are run with the project's effective
env merged in (`base` + active context). When a project declares env vars
that change *where* a tool talks (most importantly `DOCKER_HOST` /
`DOCKER_CONTEXT`), the two sides see different worlds and the UI lies.

**Where.**
- `Sources/MatisaEngine/Discovery/SyncShell.swift:24` — `process.environment`
  is never assigned, so probes (`docker ps`, `lsof`, `brew services list`,
  the `which`-via-login-zsh helper) inherit only what matisa itself was
  launched with.
- Compare to `Sources/MatisaEngine/State/TaskService.swift:83-88` and
  `Sources/Matisa/Supervisor/TaskRunner.swift:106-112`, which merge
  `ProcessInfo.processInfo.environment` with caller-supplied `extraEnv`
  (project env, base + active context) and assign `process.environment`.

**Concrete failure case.** A project sets
`DOCKER_HOST=unix:///Users/me/.colima/default/docker.sock` in its env spec.

- A `docker compose up` task started from matisa goes through `TaskRunner` /
  `TaskService`, inherits `DOCKER_HOST`, and talks to **Colima**.
- The Docker discovery probe (`docker ps`) goes through `SyncShell`, does
  *not* see `DOCKER_HOST`, and falls back to Docker Desktop's default
  socket.
- Result: the Docker pane reports "no containers running" while the user's
  compose stack is in fact up — on a daemon matisa never queried.

**Why it's narrow today.** Most users set `DOCKER_HOST` at the shell level
(`.zshrc`, Colima shellenv, etc.), so the matisa process inherits it at
launch and probe + task happen to agree. The bug only surfaces when a
project overrides the value per-project, which is uncommon — but not absurd
(a service that talks to a remote daemon, or a project that pins Colima
while the rest of the user's shell defaults to Docker Desktop).

**Generalization.** Any probe that reads state from a tool whose target is
configurable via env is at risk:
- `DOCKER_HOST` / `DOCKER_CONTEXT` → `docker`
- `KUBECONFIG` → `kubectl`
- `AWS_PROFILE` / `AWS_REGION` → `aws`
- `GOOGLE_APPLICATION_CREDENTIALS` → `gcloud`

If the user's commands and matisa's probes both invoke the same tool, they
need to see the same environment, or the UI will be a confidently-wrong
view of the world.

**Fix sketch.** Thread an `extraEnv: [String: String] = [:]` parameter into
`SyncShell.runCapturing` (mirroring the `TaskRunner`/`TaskService` shape:
inherit from `ProcessInfo`, then overlay `extraEnv`, then assign
`process.environment`). Callers that have a project in hand
(Docker discovery, port-listener probes scoped to a service) pass
`service.spec.env?.effective(activeContext: activeEnvContext) ?? [:]`.
Callers without project context (`which`, global probes) pass `[:]` and
keep today's pure-inherit behavior. The `which` helper is *probably* fine
to leave pure-inherit since per-project PATH overrides could mask the
shell's nvm/fnm/bun resolution in surprising ways — worth a separate
discussion before changing.

**Status.** Not yet fixed.
