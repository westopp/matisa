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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { globSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const shell = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(shell, "..", "..")
const vendor = join(shell, "vendor", "engine")

const run = (cmd, cwd = repo, env = {}) => {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } })
}

// ── 0. One version number ────────────────────────────────────────────────────
// apps/shell/package.json is the product version — it is what electron-builder
// stamps into the bundle and what the updater compares against the feed. The
// engine carries the same string (baked in below, read back over engine.status)
// so the renderer can tell whether the daemon it reached came from THIS build.
// That check is the whole reason the number is single-sourced: two independent
// literals would always agree with themselves and never catch the skew.
const version = JSON.parse(readFileSync(join(shell, "package.json"), "utf8")).version

// ── 1. Build everything ─────────────────────────────────────────────────────
run("pnpm --filter @matisa/desktop build")
run("pnpm --filter @matisa/engine build", repo, { MATISA_VERSION: version })
run("pnpm --filter matisa-cli build", repo, { MATISA_VERSION: version })
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

// ── 3b. Prune the staged natives ─────────────────────────────────────────────
// npm installs what the packages ship, which is what they need to BUILD on any
// platform. What runs here is one architecture on one OS, and the difference is
// most of the app: node-pty alone carries 58MB of Windows prebuilds — bigger
// than every other non-Electron thing in the bundle combined — and
// better-sqlite3 carries a 10MB copy of the SQLite amalgamation it was compiled
// from an hour earlier.
//
// This runs AFTER @electron/rebuild, which genuinely needs better-sqlite3's
// `src` and `deps` to compile. Prune before it and the build fails.
//
// Every path here is a build input or another platform's binary. Nothing is
// removed on a guess: the assertion below re-checks that what actually gets
// require()d at runtime survived, so a future version reorganising its layout
// fails the build loudly instead of shipping an app whose terminals do not open.
const PRUNE = [
  "node-pty/prebuilds/win32-x64",
  "node-pty/prebuilds/win32-arm64",
  "node-pty/prebuilds/darwin-x64",
  "node-pty/third_party",
  "node-pty/deps",
  "node-pty/src",
  "node-pty/scripts",
  "better-sqlite3/deps",
  "better-sqlite3/src"
]
const sizeOf = (path) =>
  Number(execSync(`du -sk "${path}" 2>/dev/null | cut -f1`, { encoding: "utf8" }).trim() || 0)

const beforeKb = sizeOf(join(vendor, "node_modules"))
for (const rel of PRUNE) rmSync(join(vendor, "node_modules", rel), { recursive: true, force: true })
const afterKb = sizeOf(join(vendor, "node_modules"))
console.log(
  `\npruned natives: ${Math.round((beforeKb - afterKb) / 1024)}MB removed, ${Math.round(afterKb / 1024)}MB kept`
)

// The four files the engine cannot run without. Cheap to check, and the failure
// they prevent is silent at build time and fatal at run time.
for (const required of [
  "node-pty/prebuilds/darwin-arm64/pty.node",
  "node-pty/prebuilds/darwin-arm64/spawn-helper",
  "better-sqlite3/build/Release/better_sqlite3.node",
  "better-sqlite3/lib/index.js"
]) {
  if (!existsSync(join(vendor, "node_modules", required))) {
    throw new Error(`pruning removed something load-bearing: ${required} is missing`)
  }
}

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
// Two builds come out of one config. Which one depends entirely on what
// credentials this machine has, because there is no useful middle ground:
//
//   RELEASE — a Developer ID in the keychain (or CSC_LINK/CSC_NAME). Produces
//   the dmg + zip + latest-mac.yml that electron-updater consumes. Notarised
//   when Apple credentials are present too.
//
//   LOCAL — no identity. Produces an unpacked .app, ad-hoc signed, that runs on
//   THIS machine and nowhere else. Ad-hoc is not a weaker release: Squirrel.Mac
//   compares the running app's designated requirement against the update's, and
//   with no signing identity that requirement collapses to the cdhash — which
//   changes every build, so every update is rejected as a different app. A local
//   build is for developing, never for shipping.
//
// The natives are no longer copied in after this returns; scripts/after-pack.cjs
// stages them inside the bundle before it is signed, which is the only ordering
// that survives `codesign --verify`.
const identity = (() => {
  if (process.env.CSC_LINK !== undefined || process.env.CSC_NAME !== undefined) return "env"
  try {
    const found = execSync("security find-identity -v -p codesigning", { encoding: "utf8" })
    return found.includes("Developer ID Application") ? "keychain" : null
  } catch {
    return null
  }
})()

// The three ways electron-builder can reach notarytool, in ITS order of
// precedence (app-builder-lib/out/mac/MacTargetHelper.js — getNotarizeOptions).
// Mirrored rather than approximated: guessing wrong in the permissive direction
// asks for a notarised build with no credentials and fails ten minutes in;
// guessing wrong in the strict direction passes `notarize=false` and silently
// ships a build that Gatekeeper will block on every tester's machine.
//
// APPLE_KEYCHAIN_PROFILE is the one worth using — `xcrun notarytool
// store-credentials` puts the app-specific password in the login keychain, so it
// is never in a shell profile, a build log, or this repo's database.
const canNotarize =
  (process.env.APPLE_ID !== undefined &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD !== undefined &&
    process.env.APPLE_TEAM_ID !== undefined) ||
  (process.env.APPLE_API_KEY !== undefined &&
    process.env.APPLE_API_KEY_ID !== undefined &&
    process.env.APPLE_API_ISSUER !== undefined) ||
  process.env.APPLE_KEYCHAIN_PROFILE !== undefined

const feedUrl = process.env.MATISA_FEED_URL

const flags = ["--mac", "--config electron-builder.yml"]
if (identity === null) {
  flags.push("--dir", "-c.mac.identity=null", "-c.mac.notarize=false")
} else if (!canNotarize) {
  // Signed but not notarised still updates correctly — Squirrel checks the
  // signature, not the notarisation ticket. It is first LAUNCH that suffers:
  // Gatekeeper blocks the download until the user goes through System Settings.
  // Fine for a build you carry to a second machine yourself, wrong for testers.
  flags.push("-c.mac.notarize=false")
  console.log("\n⚠ signing without notarisation — testers will hit a Gatekeeper block on first launch")
}
// The feed is added here rather than in the config, because its presence is
// what puts app-update.yml inside the bundle — and an app that ships with a
// feed it cannot reach checks, fails, and reports an error every six hours. No
// feed configured, no update machinery: the shell treats the file's absence as
// "updates are not this build's concern".
if (feedUrl !== undefined) {
  flags.push("-c.publish.provider=generic", `-c.publish.url=${feedUrl}`)
} else if (identity !== null) {
  console.log("\n⚠ MATISA_FEED_URL unset — no latest-mac.yml, this build cannot be an update")
}

console.log(
  `\n▸ ${identity === null ? "LOCAL build (ad-hoc signed, this machine only)" : `RELEASE build v${version} — signing via ${identity}, notarise: ${canNotarize}`}`
)
run(`npx electron-builder ${flags.join(" ")}`, shell)

const appPath = join(shell, "release", "mac-arm64", "Matisa.app")

// ── 6. Ad-hoc seal, LOCAL builds only ────────────────────────────────────────
// electron-builder skipped signing, which leaves the renamed Electron binary
// with a stale linker signature — arm64 macOS then kills the GUI process
// silently at launch. A release build is already properly signed and re-signing
// it here would strip the hardened runtime and the entitlements with it.
if (identity === null) {
  run(`codesign --force --deep --sign - "${appPath}"`, shell)
} else {
  run(`codesign --verify --deep --strict --verbose=2 "${appPath}"`, shell)
}

console.log("\npackaged → apps/shell/release/")

// The `generic` provider is download-only: electron-builder writes
// latest-mac.yml next to the artifacts but has no credentials and no way to
// upload them. Releasing is therefore a deliberate second step — which is the
// right shape, since it means building a release candidate never publishes one.
// All three files go up together; a latest-mac.yml pointing at a zip that is not
// there yet turns every running copy's update check into a failed download.
if (identity !== null && feedUrl !== undefined) {
  console.log(
    `\nto release: upload release/*.dmg, release/*.zip and release/latest-mac.yml to ${feedUrl}`
  )
}
