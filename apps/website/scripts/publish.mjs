// Release a finished build: upload it to the releases repo, then point the site
// at it.
//
// This is the second half of releasing. `pnpm package` produces artifacts and
// deliberately refuses to upload them (`--publish never`); this is the step that
// makes a candidate into a release. The split is the point — building a release
// candidate should never publish one.
//
// WHY A SEPARATE REPO. The updater reads its feed from the assets of a GitHub
// release. westopp/matisa is private, and a private repo's assets need a token
// on every download — the only place that token could live is inside the app,
// where it is not a token but a published credential. So releases go to a
// public, code-free repo instead, and the source stays private.
//
// WHAT IT DOES NOT DO: rename anything. electron-builder's filenames already
// carry the version (Matisa-0.1.2-arm64-mac.zip), and latest-mac.yml references
// the zip BY NAME with a sha512 beside it. GitHub serves assets under the exact
// filename they were uploaded with, so a rename here is an update that asks for
// a name that is not there — it stops working silently, and the only symptom is
// nobody updating.
//
// RETENTION IS GITHUB'S NOW. Every release stays until someone deletes it, and
// old releases cost nothing, so the three-version pruning this script used to do
// is gone rather than reimplemented against the API. What that pruning bought —
// a tester on a broken build having something to fall back to — a release page
// gives for free, and better.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const websiteDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(websiteDir, "..", "..")
const release = join(repo, "apps", "shell", "release")
const indexPath = join(websiteDir, "site", "index.html")

/** Where releases go. Must match RELEASES_OWNER/RELEASES_REPO in
 *  apps/shell/scripts/package.mjs — that is what is baked into every shipped
 *  bundle as the address to check, and this is where the thing it checks for is
 *  put. They disagree and the update simply never arrives. */
const RELEASES_REPO = "westopp/matisa-releases"

const fail = (message) => {
  console.error(`\npublish: ${message}\n`)
  process.exit(1)
}

const gh = (args, { capture = true } = {}) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" })
  } catch (error) {
    const detail = error.stderr?.toString().trim() ?? error.message
    fail(`gh ${args.slice(0, 2).join(" ")} failed —\n  ${detail}`)
  }
}

/** The same, for the one question whose answer is allowed to be "no such
 *  thing". `gh release view` exits non-zero on a release that does not exist,
 *  which is the ordinary case here — the version being published is usually new
 *  — so it cannot go through the fatal path above. */
const ghOrNull = (args) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return null
  }
}

// ── 1. Find the build ────────────────────────────────────────────────────────
const feedPath = join(release, "latest-mac.yml")
if (!existsSync(feedPath)) {
  fail(
    "apps/shell/release/latest-mac.yml is missing.\n" +
      "  It is only written for a SIGNED build with real targets — an unsigned\n" +
      "  --dir build has neither. Rebuild with:\n\n" +
      "    APPLE_KEYCHAIN_PROFILE=matisa pnpm package"
  )
}

const feed = readFileSync(feedPath, "utf8")
const version = /^version:\s*(.+)$/m.exec(feed)?.[1]?.trim()
if (version === undefined) fail("could not read a version out of latest-mac.yml")

const tag = `v${version}`

// Every artifact for this version. The zip is the only one the updater strictly
// needs; the dmg is what a human downloads, and the blockmaps are what let a
// client fetch only the changed parts — unused on macOS today, uploaded anyway
// because they cost nothing and the feed names them.
const artifacts = readdirSync(release).filter(
  (f) => f.startsWith(`Matisa-${version}-`) && !f.endsWith(".yml")
)
if (artifacts.length === 0) fail(`latest-mac.yml names version ${version} but no Matisa-${version}-* files are beside it`)

const dmg = artifacts.find((f) => f.endsWith(".dmg"))
const zip = artifacts.find((f) => f.endsWith(".zip"))
if (zip === undefined) fail(`no .zip for ${version} — without it the updater has nothing to install`)
if (dmg === undefined) fail(`no .dmg for ${version} — without it the download button has nothing to offer`)

// The feed names the zip and its hash. If the file beside it is not the file it
// describes, every update fails its integrity check AFTER downloading 150MB.
if (!feed.includes(zip)) fail(`latest-mac.yml does not reference ${zip} — the release directory is inconsistent, rebuild`)

// ── 2. Check the destination ─────────────────────────────────────────────────
// A private releases repo is the failure this whole arrangement exists to avoid,
// and it is invisible from the outside: the release page looks right to you,
// signed in, and every installed copy gets a 404 with no token to offer. Cheaper
// to ask now than to find out from a fleet that stopped updating.
const view = JSON.parse(gh(["repo", "view", RELEASES_REPO, "--json", "visibility,isPrivate"]))
if (view.isPrivate === true) {
  fail(
    `${RELEASES_REPO} is PRIVATE. Its release assets need a token to download, and the app has none —\n` +
      `  every update would 404. Make it public:\n\n    gh repo edit ${RELEASES_REPO} --visibility public`
  )
}

// Re-releasing a version is not a thing that can be done quietly: installed
// copies compare version strings, so a v0.1.2 that is not the v0.1.2 they
// already have is a build that never reaches them, or reaches them and fails its
// hash. Bump the version instead.
const existing = ghOrNull(["release", "view", tag, "--repo", RELEASES_REPO, "--json", "tagName"])
if (existing !== null) {
  fail(`${tag} already exists in ${RELEASES_REPO}. Bump the version in apps/shell/package.json and rebuild.`)
}

// ── 3. Upload ────────────────────────────────────────────────────────────────
// latest-mac.yml is an asset like any other — it is the file the updater asks
// for by name under the LATEST release, and without it in the upload there is no
// feed at all, only files nobody is told about.
const uploads = [...artifacts, "latest-mac.yml"].map((f) => join(release, f))
for (const file of uploads) {
  console.log(`  ↑ ${file.split("/").pop()} (${(statSync(file).size / 1024 / 1024).toFixed(1)}MB)`)
}
gh(
  [
    "release",
    "create",
    tag,
    ...uploads,
    "--repo",
    RELEASES_REPO,
    "--title",
    `Matisa ${version}`,
    "--notes",
    `Matisa ${version} for macOS (Apple silicon).\n\nInstalled copies update themselves — this page is for first installs.`
  ],
  { capture: false }
)

// ── 4. Point the page at it ──────────────────────────────────────────────────
// The Apple mark, inline so the button needs no second request. It lives here
// as well as in index.html because this script REWRITES that element — a glyph
// added to the page by hand would survive exactly until the next publish.
const APPLE_MARK =
  '<svg class="apple" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>'

// Between the markers, nothing else — a regex over the whole document would
// eventually match something in the copy and rewrite that instead.
const html = readFileSync(indexPath, "utf8")
const markers = /<!-- download:start -->[\s\S]*?<!-- download:end -->/
// Checked BEFORE the replace, not by comparing the result to the input.
// Re-publishing the same version produces a byte-identical block, so
// `updated === html` is true in the ordinary case of running this twice — which
// would report missing markers on a file that has them.
if (!markers.test(html)) fail("could not find the download:start / download:end markers in index.html")

// The full asset URL, not a `/releases/latest` alias. The alias would save this
// rewrite and cost the guarantee it exists for: a versioned href is a name a
// cache cannot hand someone yesterday's build under.
const assetUrl = `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${dmg}`
const block =
  `<!-- download:start -->\n` +
  `      <a class="download" href="${assetUrl}">${APPLE_MARK}<span>Download for macOS</span></a>\n` +
  `      <p class="meta">Version ${version} · ${(statSync(join(release, dmg)).size / 1024 / 1024).toFixed(0)}MB</p>\n` +
  `      <!-- download:end -->`
writeFileSync(indexPath, html.replace(markers, block))

console.log(`\npublished ${tag} → https://github.com/${RELEASES_REPO}/releases/tag/${tag}`)

// The site is now a page with an off-site download link and nothing heavy in it,
// so deploying it is whatever moves static files — no artifacts travel with it
// any more.
console.log("\nto deploy: commit the rewritten index.html and push — Dokploy rebuilds the site image from the repo.")
