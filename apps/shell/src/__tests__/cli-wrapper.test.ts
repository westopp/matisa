import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, describe, it } from "node:test"

// ────────────────────────────────────────────────────────────────────────────
// The wrapper's whole job is to find the app bundle from its own location, and
// the one invocation that matters — a symlink on PATH, which is how it is meant
// to be installed — is the one that cannot be checked by reading it. $0 is the
// path the caller used, so a symlinked run hands the script a location that is
// nowhere near the bundle, and every path derived from it silently addresses
// the wrong filesystem. It fails as `env: .../MacOS/Matisa: No such file`, in a
// terminal, after packaging: about as far from the edit as a bug can get.
//
// So this stages a real bundle layout in a temp dir, points a stand-in at the
// Electron binary, and runs the actual shipped script through every path it can
// be reached by. What is asserted is the argv and env the wrapper hands over —
// they contain the resolved paths, so a wrong RES cannot produce a right answer.
// ────────────────────────────────────────────────────────────────────────────

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const WRAPPER_SRC = here("../../scripts/cli-wrapper.sh")
const PACKAGE_SCRIPT = here("../../scripts/package.mjs")

// realpath: on macOS mkdtemp hands back /var/folders/… while the wrapper's own
// `cd … && pwd` resolves it to /private/var/folders/…, and comparing the two
// would fail on the symlink rather than on anything the wrapper did wrong.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "matisa-wrapper-")))
after(() => rmSync(TMP, { recursive: true, force: true }))

// A stand-in for the Electron binary that reports what it was handed, so a
// misresolved RES surfaces as a wrong path rather than an opaque exec failure.
const stageBundle = (): { readonly resources: string; readonly wrapper: string } => {
  const contents = join(TMP, "Matisa.app", "Contents")
  const resources = join(contents, "Resources")
  for (const dir of [join(resources, "bin"), join(resources, "engine"), join(contents, "MacOS")]) {
    mkdirSync(dir, { recursive: true })
  }

  const electron = join(contents, "MacOS", "Matisa")
  writeFileSync(electron, '#!/bin/sh\necho "ARGV=$*"\necho "ENGINE_ENTRY=$MATISA_ENGINE_ENTRY"\n')
  chmodSync(electron, 0o755)
  writeFileSync(join(resources, "engine", "cli.cjs"), "// stand-in\n")
  writeFileSync(join(resources, "engine", "engine.cjs"), "// stand-in\n")

  const wrapper = join(resources, "bin", "matisa")
  cpSync(WRAPPER_SRC, wrapper)
  chmodSync(wrapper, 0o755)
  return { resources, wrapper }
}

const { resources, wrapper } = stageBundle()

const links = join(TMP, "usr-local-bin")
mkdirSync(links, { recursive: true })
symlinkSync(wrapper, join(links, "abs"))
symlinkSync("../Matisa.app/Contents/Resources/bin/matisa", join(links, "rel"))
symlinkSync(join(links, "abs"), join(links, "chain"))

/** What the wrapper handed the Electron binary, for one way of reaching it. */
const invoke = (path: string): string => execFileSync(path, ["guide"], { encoding: "utf8" })

const REACHES = [
  ["its real path", wrapper],
  ["an absolute symlink, as `ln -s` into /usr/local/bin makes", join(links, "abs")],
  ["a relative symlink", join(links, "rel")],
  ["a symlink to a symlink", join(links, "chain")]
] as const

describe("cli-wrapper.sh", () => {
  for (const [reach, path] of REACHES) {
    it(`resolves the bundle when invoked via ${reach}`, () => {
      const out = invoke(path)
      assert.match(out, new RegExp(`ARGV=${join(resources, "engine", "cli.cjs")} guide`))
      assert.match(out, new RegExp(`ENGINE_ENTRY=${join(resources, "engine", "engine.cjs")}`))
    })
  }

  it("is valid POSIX shell", () => {
    // Catches an unbalanced quote or `case` in the script before it ships as
    // the only thing standing between a user and the CLI.
    execFileSync("/bin/sh", ["-n", WRAPPER_SRC])
  })

  it("is the script packaging actually ships", () => {
    // Everything above tests scripts/cli-wrapper.sh. If packaging ever stops
    // copying that file, all of it keeps passing while the shipped wrapper goes
    // unchecked — so pin the reference.
    assert.match(readFileSync(PACKAGE_SCRIPT, "utf8"), /"cli-wrapper\.sh"/)
  })
})
