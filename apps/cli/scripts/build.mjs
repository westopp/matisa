// Bundles the CLI into dist/cli.cjs — single file, pure JS (no natives), runs
// under plain node or the app's Electron binary with ELECTRON_RUN_AS_NODE=1.
// The packaged wrapper script points MATISA_ENGINE_ENTRY at the engine bundle
// shipped alongside it.
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "cli.cjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info"
})
