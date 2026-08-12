// Builds main + preload into dist/. The renderer is NOT built here — in dev it
// is the vite server; for packaging, package.mjs builds it and copies it in.
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info"
}

await build({
  ...common,
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(root, "dist", "main.cjs")
})

await build({
  ...common,
  entryPoints: [join(root, "src", "preload.ts")],
  outfile: join(root, "dist", "preload.cjs")
})
