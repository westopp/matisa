// Packages the whole product: renderer (asar) + engine/cli bundles and their
// natives (resources/engine, unpacked) + a CLI wrapper (resources/bin).
//
// The natives problem, solved here once:
//   - node-pty ships NAPI prebuilds — ABI-independent, works under Electron.
//   - better-sqlite3 is NOT NAPI — it is rebuilt against Electron's headers
//     with @electron/rebuild.
// Both are installed into vendor/engine with REAL npm (no pnpm symlinks — the
// staged tree is copied verbatim into the app), and the node-pty spawn-helper
// gets its exec bit forced, since tarball extraction is known to drop it.
import { execSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { globSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const shell = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(shell, "..", "..")
const vendor = join(shell, "vendor", "engine")

const run = (cmd, cwd = repo) => {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { cwd, stdio: "inherit" })
}

// ── 1. Build everything ─────────────────────────────────────────────────────
run("pnpm --filter @matisa/desktop build")
run("pnpm --filter @matisa/engine build")
run("pnpm --filter matisa-cli build")
run("node scripts/build.mjs", shell)

// ── 2. Renderer → dist/renderer, with a CSP the vite dev server never needs ──
// file:// pages get no server headers, so the policy travels in the document.
// connect-src is the whole point: the renderer may speak only to the loopback
// engine bridge.
const rendererOut = join(shell, "dist", "renderer")
rmSync(rendererOut, { recursive: true, force: true })
cpSync(join(repo, "apps", "desktop", "dist"), rendererOut, { recursive: true })
const indexPath = join(rendererOut, "index.html")
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*"
writeFileSync(
  indexPath,
  readFileSync(indexPath, "utf8").replace(
    "<meta charset=\"utf-8\" />",
    `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
  )
)

// ── 3. Stage the engine + natives with real npm ──────────────────────────────
rmSync(join(shell, "vendor"), { recursive: true, force: true })
mkdirSync(vendor, { recursive: true })
cpSync(join(repo, "apps", "engine", "dist", "engine.cjs"), join(vendor, "engine.cjs"))
cpSync(join(repo, "apps", "cli", "dist", "cli.cjs"), join(vendor, "cli.cjs"))

const enginePkg = JSON.parse(readFileSync(join(repo, "apps", "engine", "package.json"), "utf8"))
writeFileSync(
  join(vendor, "package.json"),
  JSON.stringify(
    {
      name: "matisa-engine-runtime",
      private: true,
      dependencies: {
        "node-pty": enginePkg.dependencies["node-pty"],
        "better-sqlite3": enginePkg.dependencies["better-sqlite3"]
      }
    },
    null,
    2
  )
)
run("npm install --omit=dev --no-audit --no-fund", vendor)

// Rebuild better-sqlite3 against the Electron ABI the app (and the daemon,
// via ELECTRON_RUN_AS_NODE) actually runs.
const electronVersion = JSON.parse(
  readFileSync(join(shell, "node_modules", "electron", "package.json"), "utf8")
).version
run(
  `npx @electron/rebuild --version ${electronVersion} --module-dir . --only better-sqlite3`,
  vendor
)

for (const helper of globSync(join(vendor, "node_modules", "node-pty", "prebuilds", "*", "spawn-helper"))) {
  chmodSync(helper, 0o755)
  console.log(`chmod 755 ${helper}`)
}

// ── 4. CLI wrapper — symlink this into PATH (the docker/code pattern) ────────
// The script lives in scripts/cli-wrapper.sh rather than a template literal
// here. It is shell, so it belongs in a .sh file that a shell tool can lint and
// a test can execute — src/__tests__/cli-wrapper.test.ts stages a fake bundle
// and drives it through symlinks, which is the case that actually broke. Inline,
// every backslash and backtick needed escaping for JS, and a wrong escape there
// is not a build error: it is a broken command in the user's terminal.
const binDir = join(shell, "resources", "bin")
mkdirSync(binDir, { recursive: true })
const wrapper = join(binDir, "matisa")
cpSync(join(shell, "scripts", "cli-wrapper.sh"), wrapper)
chmodSync(wrapper, 0o755)

// ── 5. electron-builder ──────────────────────────────────────────────────────
run("npx electron-builder --mac --dir --config electron-builder.json", shell)

// electron-builder's copier hard-ignores node_modules inside extraResources,
// so the natives are copied in by hand afterwards. If code signing is ever
// enabled, this MUST move before the sign step (or the natives will break the
// seal) — sign manually with codesign --deep after this script, or switch to
// an afterPack hook.
const appResources = join(shell, "release", "mac-arm64", "Matisa.app", "Contents", "Resources")
cpSync(join(vendor, "node_modules"), join(appResources, "engine", "node_modules"), {
  recursive: true
})
for (const helper of globSync(
  join(appResources, "engine", "node_modules", "node-pty", "prebuilds", "*", "spawn-helper")
)) {
  chmodSync(helper, 0o755)
  console.log(`chmod 755 ${helper}`)
}

// ── 6. Re-sign ───────────────────────────────────────────────────────────────
// electron-builder skipped signing (identity: null), which leaves the renamed
// Electron binary with a stale linker signature — arm64 macOS then kills the
// GUI process silently at launch. Ad-hoc signing after the post-copy above
// seals the final bundle. Replace with a real identity + notarisation for
// distribution beyond this machine.
run(`codesign --force --deep --sign - "${join(shell, "release", "mac-arm64", "Matisa.app")}"`, shell)

console.log("\npackaged → apps/shell/release/")
