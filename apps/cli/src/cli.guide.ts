// ────────────────────────────────────────────────────────────────────────────
// cli.guide — the agent-facing description of this application.
//
// `matisa --help` already lists every command, but a list of usage lines is not
// enough to USE matisa correctly: it cannot say that a lifecycle transition
// returns "accepted" rather than "started", that `unmanaged` means someone else
// holds the port, that half a dozen commands block forever, or that the CLI is
// one of two clients of a daemon that owns all the state. An agent that reads
// only the usage lines gets all of that wrong, and each of those mistakes looks
// like a bug in matisa rather than a misreading of it.
//
// So this is the wall of text `matisa guide` prints: an llms.txt for the CLI,
// written to be pasted into a coding agent's context whole. It is hand-written
// prose on purpose — the semantics are the entire value here, and semantics
// cannot be generated from a command tree. What CAN drift is coverage, so
// __tests__/guide.test.ts walks the real command tree and fails if a command
// exists that this document never mentions.
//
// Kept free of ANSI, backticks and interpolation so it survives being written
// to a file, embedded in a prompt, or read through a pipe.
// ────────────────────────────────────────────────────────────────────────────

export const GUIDE = `matisa — orientation for coding agents
======================================

This is the whole contract: what matisa is, what this CLI can do, and how to
drive it from a script. Reading it needs no running engine.

Save it for your own context:  matisa guide > llms.txt


0. BEFORE YOU DO ANYTHING
─────────────────────────

Run this first, every session, before you start, stop, add or change anything:

    matisa operations-instructions

It prints the rules the person who owns this machine has written for agents
working in it — a port range to allocate inside, projects you must not touch,
whether you may add to the catalog on your own, anything else they decided
matters. It is free text. matisa does not parse or enforce a word of it, which
means nothing else will stop you from breaking a rule you did not read.

Re-read it rather than remembering it: the user edits it while you work, and
this guide is static while those instructions are not. Empty output is a normal
answer — it means no rules have been set, not that the command failed.


1. WHAT IT IS
─────────────

matisa is an application and command runner. It spins applications up and tears
them down, reports which applications and which of their commands are running
right now, and holds the environment variables they run with.

Those three jobs are deliberately one tool, and that is the whole idea: the
thing that launches an application is also the thing that knows what it is
currently doing and the thing its configuration lives in. Configuring, running
and inspecting an application stop being three separate surfaces you keep in
sync by hand.

What it runs: local dev servers, docker containers and compose stacks, held as a
catalog of named projects. Each project has a root directory, a way to start,
declared ports, saved ad-hoc commands, and an environment assembled from
reusable named contexts.

It is what you would otherwise do with eight terminal tabs, a .env file you keep
re-copying, a mental note of which port is which, and an lsof when something
refuses to start.


2. ARCHITECTURE — THE ENGINE IS THE PRODUCT
───────────────────────────────────────────

    matisa (this CLI) ──┐
                        ├── JSON-RPC 2.0 ──> ENGINE ──> processes / docker / caddy
    the desktop app ────┘                    (daemon)      │
                                                        sqlite

The engine is a single background daemon that owns everything: the catalog, the
supervisor state machine, PTY sessions, the durable event queue, docker, and the
reverse proxy. It is the only thing that ever spawns a process.

The CLI and the desktop app are BOTH clients of that engine. They are peers, not
layers — neither drives the other, both speak the same method set over the same
socket, and neither holds state of its own.

Four consequences you have to hold on to:

  - Anything done here appears in the desktop window immediately, and anything
    done there is visible here. There is one truth and both surfaces read it.
  - Killing this CLI never kills what it started. A project you start keeps
    running under the engine after this process exits.
  - The engine outlives your shell. Only 'matisa engine stop' ends it, and that
    takes every supervised child down with it.
  - Two clients can act at once. Treat state you read as a snapshot, not a lock.

Transports: a unix socket (this CLI) and a loopback WebSocket bridge (the desktop
UI runs in a browser sandbox and cannot open a unix socket). Same methods, same
events, either way. 'engine status' reports the socket path it is actually
listening on.


3. THE MODEL
────────────

PROJECT — a catalog entry: name, root directory, kind, declared ports, and
optionally an env context, a group and an icon. That is all it is — a
description. Adding a project starts nothing; removing one stops nothing.

KIND — how the supervisor runs it, fixed at add time by which flag you pass:

    process    --cmd "npm run dev"      spawned on a PTY in the project root.
                                        At most ONE declared port.
    docker     --image postgres:16      one container named matisa.<name>, run
                                        with --restart unless-stopped.
    compose    --compose ./compose.yml  the whole stack is the lifecycle unit.

PORTS — a declared port is a contract, not documentation. The engine probes it
to decide health, uses it as the reverse-proxy upstream, and refuses to let two
projects claim the same one.

RUNTIME STATE — what the supervisor currently believes:

    idle        not running
    starting    spawned, not confirmed up
    running     up
    stopping    SIGTERM sent, waiting for exit (8s, then SIGKILL)
    crashed     the child ran and exited non-zero
    errored     the ENGINE could not manage it — spawn refused, port held,
                docker declined, restarts exhausted. Not the same as crashed.
    unmanaged   the project IS up, but something other than the engine started
                it. See 7 (discovery) and 9.4.

HEALTH — observed readiness, orthogonal to state:

    waiting     spawned, declared port not bound yet
    ready       port bound
    timeout     never bound within the 10s start window (process left alone)
    unknown     no declared port, so nothing to observe

running + timeout is a real and useful combination: alive, never opened its port.

ACCEPT-THEN-OBSERVE — every lifecycle transition returns immediately with
{id, state} meaning ACCEPTED, not DONE. The outcome arrives later as an event.
Never read the return of 'lifecycle start' as proof anything came up; see 9.2.

ENV CONTEXTS — named variable sets applied at spawn time, layered lowest to
highest:

    the project's base  ->  the project's active context  ->  a named
    command's own vars

EVERY CONTEXT BELONGS TO EXACTLY ONE PROJECT. There is no installation-wide
layer and no way to make one: a variable is only ever reachable by the spawns of
the project that owns it. 'env use' refuses a context belonging to another
project, and removing a project removes its environments with it.

Each project has exactly one 'base', created with the project and always applied
to it. It cannot be renamed or deleted. Context names are unique within a
project, not globally — every project has its own 'dev', so 'env list' groups by
project and 'env set' addresses a context by its id, which is unique. A project
selects its active context with 'env use', which takes effect on its NEXT spawn.

Values print MASKED as <secret> everywhere, including under --json — the masking
happens to the data, not the renderer, so no flag gets around it. 'env reveal'
is the single exception, which is the point: it is named after what it does and
its presence in shell history is a record that the secret was asked for.

EXPOSURE — a project that declares a port gets a stable URL by default: a
hostname routed to it through Caddy on loopback, derived by the engine the
moment the port exists. No command creates it.

Two switches sit on top, and they are independent:
  stable URL   on by default; 'exposure off' declines the hostname entirely.
               The project's own http://localhost:<port> is unaffected — this
               only skips the Caddy route.
  LAN sharing  off by default; 'exposure share' adds an mDNS hostname and a
               dedicated same-network listener.
A project can have either, both or neither.

DO NOT CONSTRUCT THESE URLS — read them. The port Caddy serves on is probed at
boot and stepped up if something already holds the preferred one, and the mDNS
domain, the LAN port base and the preferred http port are all env-overridable,
so the address is only knowable by asking:

    matisa --json exposure list <project>   that project's addresses
    matisa --json exposure list             every address, plus Caddy's own
                                            status — whether the binary is
                                            installed, whether it is running,
                                            the http port actually in use, and
                                            the current LAN IP

Each entry carries its kind (stable_url or lan), the url to open, and a state:
active, or error/unavailable with a message saying why — no caddy binary on
PATH, no LAN interface, port never bound.

EVENTS — every state change, log line, crash, health change, exposure change and
configuration edit lands in a durable sqlite queue with a monotonic seq cursor
(last 20,000 retained). Types: state_changed, log_line, crashed, health_changed,
exposure_changed, catalog_changed, config_changed. Read it by pulling from a
cursor ('events') or by holding a live stream ('watch').

Every type but the last names a project. config_changed is the configuration
that belongs to no single project — a group, an env context, a project's saved
commands or its cleared failures — so it carries a scope (group | context |
commands | failures) and the id within that scope instead of a projectId. It
renders with a dash in the project column, and 'events --project' excludes it:
filtering to one project cannot mean "and also the global rows".

PATH — at boot the engine adopts your login shell's PATH, so a project's command
resolves the way it would in your terminal rather than the way it would in a
bare daemon (nvm, mise, homebrew, bun and friends are all present).


4. ADDRESSING A PROJECT
───────────────────────

Every command taking <project> or <id> accepts EITHER the name or the uuid; a
name is matched case-insensitively against the catalog.

    matisa lifecycle restart web
    matisa lifecycle restart 873f2058-0ee9-4d8b-8eea-e5dabd2ef007

A name matching two projects is refused, not guessed — the error names both
candidates with their ids so you can retype with one. A uuid costs no extra
round trip; a name costs one catalog read.

<ref> (discovery) is a different handle entirely: pid:1234 or container:api-db-1,
copied verbatim out of 'discovery list'.

<session> (pty) is a session id: run:<projectId> for a supervised project,
sh:<...> for an ad-hoc shell, cmd:<...> for a named command run.


5. OUTPUT AND EXIT CODES
────────────────────────

--json turns every command's output into the raw wire shape. Use it always; the
default table output is for humans and its column layout is not a contract.

    matisa --json project list
    matisa project list --json          (either position parses)
    MATISA_OUTPUT=json                  (set it once)

Exit codes are stable and are the intended way to branch:

    0     ok
    1     unexpected defect (a bug; the cause is printed)
    2     engine unreachable at the socket
    3     the engine returned an error, or the request timed out
    4     usage error, bad config, or an ambiguous project name
    5     not found
    130   interrupted

Errors go to stderr as one line. stdout stays parseable.


6. ENVIRONMENT AND GLOBAL FLAGS
───────────────────────────────

    MATISA_ROOT           root of all engine state. Default ~/.matisa
    MATISA_SOCK           socket path. Default $MATISA_ROOT/engine.sock
    MATISA_OUTPUT         table | json. Default table
    MATISA_TIMEOUT_MS     per-request timeout. Default 30000
    MATISA_ENGINE_ENTRY   explicit engine bundle for --ensure-engine to spawn

    --json                force JSON output
    --socket <path>       override the socket for this invocation
    --ensure-engine       if the socket refuses, spawn the engine and retry once

The engine is a singleton — a second one exits 0 rather than fighting for the
socket — so --ensure-engine is safe on every call. If you are scripting against
a machine where the engine may be down, pass it.

The engine reads its own set at boot — MATISA_DB, MATISA_WS_PORT,
MATISA_LOG_LEVEL, MATISA_CADDY_HTTP_PORT, MATISA_LAN_PORT_BASE,
MATISA_MDNS_DOMAIN — which is the reason no port or hostname in this document is
written as a literal. Ask the engine ('engine status', 'exposure list') rather
than assuming a default.


7. COMMAND REFERENCE
────────────────────

Semantics only; 'matisa <command> --help' prints the exact flags.

CATALOG

    project add --name <n> --dir <path>
                [--cmd "..." | --image <img> | --compose <file>]
                [--port <n>]... [--group <slug>] [--icon <path>]
        Register a project. The kind is derived from which of --cmd / --image /
        --compose you pass. Starts nothing.
    project list
        Every project with its live state, pid, ports and command.
    project update <project> [same flags] [--no-ports]
        Patch an entry. --group "" clears the group, --icon "" clears the icon,
        --no-ports clears the ports (--port with nothing after it cannot mean
        "none", and a stale port claim keeps every OTHER project off it).
    project path <project> [--reveal]
        Prints the root directory and nothing else, so it composes:
            cd $(matisa project path web)
        --reveal also opens it in the file manager (macOS).
    project rm <project>
        Forget the entry. Does not stop what is running.

    group set <slug> --title <t> [--description] [--notes] [--icon]
    group list
    group rm <slug>
        Organisational buckets, purely presentational. A project joins one via
        project add/update --group <slug>; --group "" leaves.

LIFECYCLE

    lifecycle start <project>
    lifecycle stop <project>
    lifecycle restart <project>
        Accepted immediately. Poll status or read events for the outcome.
    lifecycle kill <project>
        SIGKILL the process group (or docker rm -f) now, with no drain. The
        escape hatch for a stop that will not finish.
    lifecycle reset <project>
        Acknowledge a terminal failure: crashed/errored -> idle. Starts, stops
        and signals nothing — there is no process on either side of it. A no-op
        from any other state, so it can never disturb something that is alive.
    lifecycle status <project>
        Current state, pid, since, health, and the run session id.

    takeover <project> [--force]
        Reclaim a project already up outside matisa: stop whatever holds its
        declared port, then start it under the engine. Refused without --force
        when the only link between the holder and the project is the port
        number — see 9.4.

OBSERVING

    logs <project> [--lines N]
        Tail the recorded output and exit. Default 200 lines.
    logs <project> -f
        Attach to the live run session. BLOCKS until the project exits.
    events [--since <cursor>] [--limit N] [--project <p>]
        Pull from the durable queue and exit. Prints each event, then the next
        cursor — persist it and pass it as --since next time.
    watch [--project <p>]
        Live push stream. BLOCKS forever.
    failures [<project>] [--limit N]
        Recorded failure history — the WHY. Each row says whether it was a
        crash (child exited non-zero) or an error (the engine could not manage
        it), with exit code, signal, summary and log tail.
    failures --clear [<project>]
        Forget them. Nothing running is touched.
    resources
        cpu% and RSS for everything currently running.

ENVIRONMENT

    env create <project> <name> [--description]
                                  the project is required — an environment
                                  cannot exist without one
    env rename <context> <name>   a project's base cannot be renamed
    env rm <context>              takes its variables, including secrets, with
                                  it; a project's base cannot be removed
    env list [--project <p>]      values masked, grouped by project
    env reveal [<context>] [--project <p>]
                                  values shown; pair a name with --project,
                                  since a name identifies one context only
                                  within its project
    env set <context> <key> <value> [--secret]
                                  the context must already exist
    env unset <context> <key>
    env use <project> <context>   select the project's active context; refused
                                  if the context belongs to another project.
                                  Applies at its next spawn, so restart to see it

    import [<config-dir>] [--project <p>] [--dry-run]
        Re-derive each project's environments from the pre-engine config files
        (default ~/.config/matisa, evaluated with bun). Those files are the
        source of truth: base becomes exactly their top-level values, one
        context per named overlay, and any other context on a project the config
        names is REMOVED. Projects the config does not mention are untouched.
        Re-runnable — edit a config file and import again. Run --dry-run first;
        it prints the same plan without executing it.

TASKS

    commands set <project> <name> --cmd "<shell line>" [--var KEY=VAL]...
        Save a named per-project task with its own env overrides, injected on
        every run of it.
    commands list <project>
    commands rm <project> <name>
    run <project> <name>
        Run a saved command as an interactive PTY session. BLOCKS until it exits.

TERMINALS

    pty sh <project> [--cmd] [--cols] [--rows]
        A shell in the project's root with the project's resolved environment.
        Interactive; BLOCKS. The session outlives this CLI process — that is
        what makes it reattachable — and an unattached shell is reaped after
        15 minutes.
    pty logs <session> [-f]
        Attach to a session's live output; scrollback replays first. BLOCKS.
    pty close <session>
        End a shell or command session. Refused for a run: session — a project
        is stopped with lifecycle stop, not by closing a terminal.
    pty clear <session>
        Drop recorded scrollback. The process is untouched.

EXPOSURE

    exposure list [<project>]
        With no project: every exposed project plus Caddy's own status. With
        one: just that project's addresses. An unexposed project renders empty
        rather than erroring — declare a port first.
    exposure off <project>
        Stop publishing this project through Caddy. The hostname stops
        resolving and the entry disappears from 'exposure list'; nothing about
        the project's own http://localhost:<port> changes, and LAN sharing is
        untouched. Same switch as 'project update --no-stable-url' and the
        desktop's Stable URL control.
    exposure on <project>
        Give the hostname back.
    exposure share <project>
        Turn on LAN sharing: rebind Caddy to 0.0.0.0, publish the mDNS name,
        allocate a dedicated LAN listener. Prints the project's full address
        set, so the new URL appears immediately.
    exposure unshare <project>
        Turn it back off. The loopback stable URL is unaffected — it is not
        opt-in and cannot be removed while the port is declared.

WHAT MATISA DID NOT START

    discovery list [--refresh]
        Sweep the machine. Two answers in one output:
          claims    — a configured project that is up, run by something else.
                      Evidence is root (the pid's cwd is inside the project
                      root: this IS your app), container (it carries the name
                      matisa would have given it), or port (nothing but the
                      number matches — a coincidence often enough that it is
                      reported as the weak evidence it is).
          unmanaged — everything else listening or containerised, each with the
                      ref the next two commands take.
        Cached for a few seconds; --refresh forces a new sweep.
    discovery stop <ref>
        Stop an unmanaged process or container. Nothing is adopted — the engine
        ends something it does not own because you asked.
    discovery start <ref>
        Start a stopped unmanaged container. Containers only: a dead process has
        no command left to re-run, which is what a catalog entry is for.

ENGINE

    engine status
        pid, version, uptime, socket path, db path, module list.
    engine start
        Spawn the daemon detached and wait for its socket (up to 15s).
    engine stop
        Shut it down. Every supervised child goes with it.
    docker status
    docker start
    docker stop
        The Docker Desktop daemon itself, which the engine can bring up for you
        before running a docker or compose project.

    guide
        This document.


8. WHAT BLOCKS
──────────────

These never return on their own. Do not call them from an agent loop without a
timeout:

    matisa watch                    streams until interrupted
    matisa pty sh <project>         interactive shell; stdin EOF does NOT end it
    matisa logs <project> -f        until the project exits
    matisa pty logs <session>       until the session exits
    matisa run <project> <name>     until the command exits — bounded only if
                                    the command is (a test run is fine, a
                                    watcher is not)

The non-blocking equivalents, which are what you want:

    matisa events --since <cursor>  instead of watch
    matisa logs <project>           instead of logs -f
    matisa lifecycle status <p>     instead of watching for a transition


9. RECIPES
──────────

9.1 See what is going on

    matisa --json project list
    matisa --json discovery list

9.2 Start something and confirm it actually came up

    'lifecycle start' returns accepted, not started, so poll:

    matisa lifecycle start web
    for _ in $(seq 20); do
      matisa --json lifecycle status web | grep -q '"state":"running"' && break
      sleep 0.5
    done
    matisa --json lifecycle status web

    A project with a declared port is only really serving at health=ready.

9.3 Diagnose one that will not start

    matisa --json lifecycle status web      # errored? crashed? still starting?
    matisa --json failures web              # the WHY, with the log tail
    matisa logs web --lines 100             # its own output
    matisa --json discovery list            # is something else on its port?

    Once you have read the reason, 'lifecycle reset web' clears the terminal
    state back to idle so it can be started again.

9.4 A project reads unmanaged

    It is up and the engine did not start it — you launched it in a terminal
    earlier, most likely. Do not call 'lifecycle start': that fails on the port.

    matisa --json discovery list            # who holds it, and on what evidence
    matisa takeover web                     # stop the holder, start it here

    If the evidence is only 'port', takeover refuses. Check what the holder
    actually is before adding --force: killing the wrong process is the one
    mistake here that cannot be undone.

9.5 Register a new dev server

    matisa project add --name api --dir /path/to/api \\
      --cmd "pnpm dev" --port 3000 --group backend
    matisa lifecycle start api
    matisa --json exposure list api         # its stable URL

9.6 Consume events incrementally

    cursor=$(cat .matisa-cursor 2>/dev/null || echo 0)
    matisa --json events --since "$cursor" --limit 200
    # one JSON object per event, then a final {"nextCursor":N} — persist N

9.7 Run a project's test suite

    matisa commands set api test --cmd "pnpm test"
    matisa run api test                     # blocks until it exits

9.8 Share a running project on the LAN

    matisa exposure share api               # mDNS name + LAN listener
    matisa --json exposure list api
    matisa exposure unshare api


10. GOTCHAS
───────────

  - Adding a project starts nothing; removing one stops nothing.
  - A process project may declare at most one port. docker and compose may
    declare several.
  - 'env use' applies at the next spawn. Restart the project to pick it up.
  - Secrets stay masked under --json. Only 'env reveal' prints them.
  - The stable URL exists as soon as a port is declared. No command creates it,
    and 'exposure share' is only the LAN opt-in on top. Read the address from
    'exposure list' — never build it from a port you assumed.
  - crashed and errored are different failures, actioned differently. failures
    records which one it was.
  - Stop escalates: SIGTERM, then SIGKILL after 8s. 'kill' skips the wait.
  - 'pty close' will not end a run: session. Use 'lifecycle stop'.
  - The engine is shared. Something you did not do may have changed state
    between two of your commands.
`
