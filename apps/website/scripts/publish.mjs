// Move a finished build into the site, and keep the last three.
//
// This is the second half of releasing. `pnpm package` produces artifacts; this
// puts them where matisa.westopp.com/updates/mac/ serves them from. The split is
// deliberate — building a release candidate should never publish one.
//
// WHAT IT DOES NOT DO: rename anything. electron-builder's filenames already
// carry the version (Matisa-0.1.2-arm64-mac.zip), and latest-mac.yml references
// the zip BY NAME with a sha512 beside it. Rename the file and every installed
// copy asks the feed for a name that is not there — the update silently stops
// working, and the only symptom is nobody updating. Versioned filenames are also
// what makes three of them coexist in one directory, which is the whole point of
// retention.
//
// Retention keeps the newest three VERSIONS, not the newest N files: a version
// is four files (zip, dmg, and a blockmap each), and deleting half of one is
// worse than keeping all of it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const websiteDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const repo = join(websiteDir, "..", "..")
const release = join(repo, "apps", "shell", "release")
const target = join(websiteDir, "site", "updates", "mac")
const indexPath = join(websiteDir, "site", "index.html")

/** How many versions stay downloadable. The newest is what the feed points at;
 *  the two behind it are there so a tester on a broken build has something to
 *  fall back to without waiting for you to rebuild. */
const KEEP_VERSIONS = 3

const fail = (message) => {
  console.error(`\npublish: ${message}\n`)
  process.exit(1)
}

// ── 1. Find the build ────────────────────────────────────────────────────────
const feedPath = join(release, "latest-mac.yml")
if (!existsSync(feedPath)) {
  fail(
    "apps/shell/release/latest-mac.yml is missing.\n" +
      "  It is only written when MATISA_FEED_URL is set and the build produces real\n" +
      "  targets — a --dir build has neither. Rebuild with:\n\n" +
      "    APPLE_KEYCHAIN_PROFILE=matisa MATISA_FEED_URL=https://matisa.westopp.com/updates/mac/ pnpm package"
  )
}

const feed = readFileSync(feedPath, "utf8")
const version = /^version:\s*(.+)$/m.exec(feed)?.[1]?.trim()
if (version === undefined) fail("could not read a version out of latest-mac.yml")

// Every artifact for this version, plus the feed itself. The zip is the only one
// the updater strictly needs; the dmg is what a human downloads, and the
// blockmaps are what let a client fetch only the changed parts.
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

// ── 2. Copy in ───────────────────────────────────────────────────────────────
mkdirSync(target, { recursive: true })
for (const file of [...artifacts, "latest-mac.yml"]) {
  copyFileSync(join(release, file), join(target, file))
  const size = statSync(join(target, file)).size
  console.log(`  → ${file} (${(size / 1024 / 1024).toFixed(1)}MB)`)
}

// ── 3. Prune ─────────────────────────────────────────────────────────────────
// Newest first. Numeric segment comparison, with a release ranking above any
// prerelease that shares its numbers (0.2.0 beats 0.2.0-beta.1).
const compareVersions = (a, b) => {
  const [aNum, aPre] = a.split("-")
  const [bNum, bPre] = b.split("-")
  const aParts = aNum.split(".").map(Number)
  const bParts = bNum.split(".").map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (aPre === bPre) return 0
  if (aPre === undefined) return -1
  if (bPre === undefined) return 1
  return aPre < bPre ? 1 : -1
}

const versionOf = (file) => /^Matisa-(.+?)-arm64/.exec(file)?.[1]
const present = [...new Set(readdirSync(target).map(versionOf).filter((v) => v !== undefined))]
present.sort(compareVersions)

const keep = new Set(present.slice(0, KEEP_VERSIONS))
const drop = present.slice(KEEP_VERSIONS)

// The version the feed points at must survive regardless of where it sorts —
// publishing a build and immediately deleting it is the one outcome that would
// break every installed copy at once.
if (!keep.has(version)) fail(`refusing to prune: ${version} is what latest-mac.yml points at`)

for (const file of readdirSync(target)) {
  const v = versionOf(file)
  if (v !== undefined && !keep.has(v)) {
    rmSync(join(target, file))
    console.log(`  ✕ ${file}`)
  }
}

// The Apple mark, inline so the button needs no second request. It lives here
// as well as in index.html because this script REWRITES that element — a glyph
// added to the page by hand would survive exactly until the next publish.
const APPLE_MARK =
  '<svg class="apple" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>'

// ── 4. Point the page at it ──────────────────────────────────────────────────
// Between the markers, nothing else — a regex over the whole document would
// eventually match something in the copy and rewrite that instead.
const html = readFileSync(indexPath, "utf8")
const markers = /<!-- download:start -->[\s\S]*?<!-- download:end -->/
// Checked BEFORE the replace, not by comparing the result to the input.
// Re-publishing the same version produces a byte-identical block, so
// `updated === html` is true in the ordinary case of running this twice — which
// would report missing markers on a file that has them.
if (!markers.test(html)) fail("could not find the download:start / download:end markers in index.html")

const block =
  `<!-- download:start -->\n` +
  `      <a class="download" href="updates/mac/${dmg}" download>${APPLE_MARK}<span>Download for macOS</span></a>\n` +
  `      <p class="meta">Version ${version} · ${(statSync(join(target, dmg)).size / 1024 / 1024).toFixed(0)}MB</p>\n` +
  `      <!-- download:end -->`
writeFileSync(indexPath, html.replace(markers, block))

console.log(`\npublished ${version} — keeping ${[...keep].join(", ")}${drop.length > 0 ? `, dropped ${drop.join(", ")}` : ""}`)

// The site directory is now what should be on the server. Deliberately NOT
// uploaded from here: the artifacts are gitignored and 150MB each, so how they
// reach Dokploy is a deployment decision this script has no business making.
console.log(`\nto deploy: rsync -av --delete ${join(websiteDir, "site")}/ <host>:<path>/`)
