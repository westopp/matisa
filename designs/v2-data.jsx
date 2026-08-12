/* Matisa 2 — mock state, modelled on the real Local Services window */

const ENVS = {
  base: [
    { k: "NODE_ENV", v: "development" },
    { k: "LOG_LEVEL", v: "debug" },
    { k: "MATISA_ROOT", v: "~/Desktop/dev/tools/matisa" },
  ],
  dev: [
    { k: "DATABASE_URL", v: "postgres://matisa@localhost:5432/dev" },
    { k: "API_TOKEN", v: "sk_live_8f31c0a9d4e27b6f", secret: true },
  ],
  main: [
    { k: "PORT", v: "4310" },
    { k: "HOST", v: "0.0.0.0" },
  ],
};

const WEB_TERM = [
  { lvl: "cmd", msg: "$ node -e const h=require(http).createServer((q,s)=>s.end(hello\\n));h.listen(4310)" },
  { t: "23:18:02.114", lvl: "info", msg: "web listening on 4310" },
  { t: "23:18:02.118", lvl: "dim", msg: "watching 42 files for changes" },
  { t: "23:20:41.902", lvl: "ok", msg: "GET / 200 · 4ms" },
  { t: "23:20:44.331", lvl: "ok", msg: "GET /health 200 · 1ms" },
  { t: "23:21:09.774", lvl: "warn", msg: "keep-alive timeout raised to 65s" },
  { t: "23:21:12.006", lvl: "err", msg: "Error: listen EADDRINUSE: address already in use :::4310" },
  { indent: 1, lvl: "dim", msg: "at Server.setupListenHandle [as _listen2] (node:net:1817:16)" },
  { indent: 1, lvl: "dim", msg: "at listenInCluster (node:net:1865:12)" },
  { t: "23:21:12.011", lvl: "err", msg: "process exited with code 1" },
];

const WORKER_TERM = [
  { lvl: "cmd", msg: "$ node worker.js --concurrency 4" },
  { t: "22:04:11.002", lvl: "info", msg: "worker up · concurrency 4 · queue default" },
  { t: "23:19:58.441", lvl: "ok", msg: "job:resize#8812 completed in 212ms" },
  { t: "23:20:24.118", lvl: "ok", msg: "job:email#8813 completed in 44ms" },
  { t: "23:21:01.556", lvl: "dim", msg: "idle · waiting for jobs" },
];

const SERVICES = [
  {
    id: "web", name: "web", kind: "process", icon: "Home", section: "Projects", group: "Demo Stack",
    status: "errored", statusNote: "exited code 1 · 2m ago",
    url: "http://localhost:4310", port: 4310, pid: null, cpu: 0, mem: 0, memMax: 512,
    path: "~/Desktop/dev/tools/matisa/", env: "dev", uptime: "—",
    cpuSeries: [4, 9, 6, 12, 7, 5, 8, 4, 3, 6, 2, 1, 0, 0, 0, 0],
    incident: {
      title: "Port 4310 is already in use",
      detail: "EADDRINUSE — pid 8123 (node) is holding the port. Free it, or start web on the next open port.",
      actions: ["Free port & start", "Start on 4311"],
    },
    commands: [
      { name: "web", cmd: "node -e const h=require(http).createServer((q,s)=>s.end(hello\\n));h.listen(4310)", env: "main", primary: true },
      { name: "ask", cmd: "bash -c 'read -p \"your name: \" n; echo hi $n'", env: null },
      { name: "seed", cmd: "node -e 'console.log(\"seeding with NODE_ENV=\"+process.env.NODE_ENV)'", env: "1 var" },
    ],
    terminals: [{ id: "web", title: "web", status: "stopped", lines: WEB_TERM }],
  },
  {
    id: "worker", name: "worker", kind: "process", icon: "Code", section: "Projects", group: "Demo Stack",
    status: "running", statusNote: "up 1h 17m",
    url: null, port: null, pid: 8231, cpu: 0.4, mem: 9, memMax: 256,
    path: "~/Desktop/dev/tools/matisa/worker", env: "base", uptime: "1h 17m",
    cpuSeries: [1, 2, 1, 4, 2, 1, 3, 6, 2, 1, 2, 1, 3, 1, 1, 2],
    commands: [
      { name: "worker", cmd: "node worker.js --concurrency 4", env: "base", primary: true },
      { name: "drain", cmd: "node worker.js --drain --timeout 30", env: null },
    ],
    terminals: [{ id: "worker", title: "worker", status: "running", lines: WORKER_TERM }],
  },
  {
    id: "shellbox", name: "shellbox", kind: "shell", icon: "Terminal", section: "Projects", group: "Tooling",
    status: "stopped", statusNote: "never started",
    url: null, port: null, pid: null, cpu: 0, mem: 0, memMax: 128,
    path: "~/Desktop/dev/tools/shellbox", env: "base", uptime: "—",
    cpuSeries: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    commands: [{ name: "shell", cmd: "zsh -l", env: "base", primary: true }],
    terminals: [{ id: "sh", title: "shell", status: "stopped", lines: [{ lvl: "dim", msg: "no session — press Start to open a shell" }] }],
  },
  {
    id: "slowstop", name: "slowstop", kind: "process", icon: "Code", section: "Projects", group: "Ungrouped",
    status: "errored", statusNote: "stop timed out · 6m ago",
    url: "http://localhost:4399", port: 4399, pid: 9014, cpu: 0, mem: 12, memMax: 256,
    path: "~/Desktop/dev/tools/slowstop", env: "dev", uptime: "—",
    cpuSeries: [3, 2, 4, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    incident: {
      title: "Graceful stop timed out after 10s",
      detail: "pid 9014 ignored SIGTERM. Matisa can escalate to SIGKILL, or you can raise the stop timeout for this service.",
      actions: ["Force quit", "Raise timeout"],
    },
    commands: [{ name: "start", cmd: "node slowstop.js --grace 30", env: "dev", primary: true }],
    terminals: [{ id: "ss", title: "slowstop", status: "stopped", lines: [
      { lvl: "cmd", msg: "$ node slowstop.js --grace 30" },
      { t: "23:14:20.001", lvl: "info", msg: "listening on 4399" },
      { t: "23:15:02.114", lvl: "warn", msg: "SIGTERM received — draining" },
      { t: "23:15:12.115", lvl: "err", msg: "stop timeout exceeded (10s)" },
    ] }],
  },
  {
    id: "redis-cache", name: "redis-cache", kind: "container", icon: "Stack", section: "Containers", group: "Demo Stack",
    status: "stopped", statusNote: "image redis:7-alpine",
    url: null, port: 6379, pid: null, cpu: 0, mem: 0, memMax: 512,
    path: "compose/demo-stack.yml", env: "base", uptime: "—",
    cpuSeries: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    commands: [{ name: "up", cmd: "docker compose up redis-cache -d", env: "base", primary: true }],
    terminals: [{ id: "rc", title: "redis-cache", status: "stopped", lines: [{ lvl: "dim", msg: "container not running" }] }],
  },
  {
    id: "postgres", name: "postgres", kind: "container", icon: "Stack", section: "Systems", group: "Always on",
    status: "running", statusNote: "up 6d",
    url: null, port: 5432, pid: 412, cpu: 0.9, mem: 256, memMax: 1024,
    path: "compose/systems.yml", env: "base", uptime: "6d 4h",
    cpuSeries: [2, 1, 3, 2, 2, 1, 4, 2, 2, 3, 1, 2, 2, 1, 3, 2],
    commands: [{ name: "up", cmd: "docker compose up postgres -d", env: "base", primary: true }],
    terminals: [{ id: "pg", title: "postgres", status: "running", lines: [
      { t: "17:02:11", lvl: "info", msg: "database system is ready to accept connections" },
      { t: "23:20:04", lvl: "dim", msg: "checkpoint complete: wrote 42 buffers" },
    ] }],
  },
  {
    id: "traefik", name: "traefik", kind: "container", icon: "Globe", section: "Systems", group: "Always on",
    status: "running", statusNote: "up 6d",
    url: "http://matisa.localhost", port: 80, pid: 398, cpu: 0.1, mem: 28, memMax: 256,
    path: "compose/systems.yml", env: "base", uptime: "6d 4h",
    cpuSeries: [1, 1, 2, 1, 1, 0, 1, 1, 2, 1, 1, 1, 0, 1, 1, 1],
    commands: [{ name: "up", cmd: "docker compose up traefik -d", env: "base", primary: true }],
    terminals: [{ id: "tk", title: "traefik", status: "running", lines: [
      { t: "17:02:09", lvl: "info", msg: "Configuration loaded from flags." },
      { t: "23:21:40", lvl: "ok", msg: "router matisa@docker updated" },
    ] }],
  },
];

const TREE = [
  { section: "Projects", groups: [
    { title: "Demo Stack", ids: ["web", "worker"] },
    { title: "Tooling", ids: ["shellbox"] },
    { title: "Ungrouped", ids: ["slowstop"] },
  ] },
  { section: "Containers", groups: [{ title: "Demo Stack", ids: ["redis-cache"] }] },
  { section: "Systems", groups: [{ title: "Always on", ids: ["postgres", "traefik"] }] },
];

Object.assign(window, { ENVS, SERVICES, TREE });
