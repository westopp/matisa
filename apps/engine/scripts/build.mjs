// Bundles the engine into a single dist/engine.cjs that runs under plain
// `node` (or Electron with ELECTRON_RUN_AS_NODE=1) with no tsx, no workspace,
// no node_modules resolution — except the two native modules, which cannot be
// bundled and are resolved at runtime from wherever the packaged app unpacks
// them (see apps/shell packaging).
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "engine.cjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // keepNames because Effect's tags, error classes and layer identities are
  // read by name in places; the size it costs is noise next to what it prevents.
  minify: true,
  keepNames: true,
  // Native addons: left as require()s for the host to provide.
  external: ["node-pty", "better-sqlite3"],
  // The packager passes the product version in; a standalone build honestly
  // labels itself a dev build rather than inventing a number. Baked at compile
  // time because the daemon is spawned by whoever gets there first — app or
  // CLI — and neither can be relied on to set an environment variable.
  define: {
    "process.env.MATISA_VERSION": JSON.stringify(process.env.MATISA_VERSION ?? "0.0.0-dev")
  },
  logLevel: "info"
})
