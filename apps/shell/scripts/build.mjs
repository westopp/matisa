// Builds main + preload into dist/. The renderer is NOT built here — in dev it
// is the vite server; for packaging, package.mjs builds it and copies it in.
import { build } from "esbuild"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// electron-updater is a devDependency and is BUNDLED here rather than shipped
// as a node_modules tree. electron-builder auto-includes production deps
// regardless of the `files` globs, so listing it as one put its whole dependency
// tree — 300-odd files, source maps included — inside the asar next to the copy
// already bundled into main.cjs. Dev dependency, one copy, no duplication.
//
// keepNames survives minification: this is a supervisor whose error handling
// leans on constructor and tag names, and a mangled class name is the kind of
// bug that only shows up in the packaged build, in a log, days later.
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  minify: true,
  keepNames: true,
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
