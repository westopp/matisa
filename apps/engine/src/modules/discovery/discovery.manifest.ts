import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

// ────────────────────────────────────────────────────────────────────────────
// cwd → a name a human recognises, and the evidence that it is a project at all.
//
// `lsof` can tell us a listener is `node` in `/Users/me/dev/api`. "node" is
// useless — half the machine is node. The directory is the identity, so this
// reads the project manifest that lives there, walking up a few levels because
// a dev server is commonly started from a package inside a monorepo rather than
// at its root.
//
// Two tiers of manifest, because the languages differ on whether a name is even
// declared:
//
//   named   — the file states what the project is called (package.json,
//             Cargo.toml, go.mod, composer.json, mix.exs, pom.xml, …). Use it.
//   unnamed — the file proves this is a project root but names nothing a person
//             would use (Gemfile, requirements.txt, a bare build.gradle). Fall
//             back to the directory name.
//
// That fallback is not the same as guessing from a path. The manifest is what
// establishes "this is a project"; the directory only supplies the label once
// that is already settled. Without the tier split, Ruby, PHP and JVM services
// stayed anonymous forever, since none of their common manifests carries a name.
//
// Every read is best-effort and synchronous: these are small files in the page
// cache, and the alternative (async fan-out over a dozen candidate paths) buys
// nothing but complexity on a path that already spent seconds in lsof.
// ────────────────────────────────────────────────────────────────────────────

const MAX_LEVELS = 3

/** Directories that must never count as a project root, however many stray
 *  manifests they contain. A `package.json` in $HOME is common enough, and
 *  without this guard every daemon whose cwd is `/` or `~` — which is most of
 *  them — would be reported as the user's own application. */
const NEVER_ROOTS = new Set(["/", homedir()])

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Filenames in `dir`, or empty when it cannot be listed. Only reached after
 *  every direct file probe has missed, so the common case never pays for it. */
const entries = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const unquote = (raw: string): string | undefined => {
  const hash = raw.indexOf("#")
  let value = (hash < 0 ? raw : raw.slice(0, hash)).trim()
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted) value = value.slice(1, -1)
  return value.length > 0 ? value : undefined
}

// ── named manifests ─────────────────────────────────────────────────────────

/** `name` out of a JSON manifest.
 *
 *  A composer `vendor/package` reduces to `package` — the vendor is publishing
 *  metadata nobody says out loud. An npm `@scope/pkg` is kept whole, because
 *  there the scope is usually the monorepo it belongs to, and `@matisa/desktop`
 *  says more in a list than `desktop` does. The leading `@` is what tells the
 *  two apart. */
const jsonName = (raw: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const name = (parsed as Record<string, unknown>)["name"]
    if (typeof name !== "string" || name.length === 0) return undefined
    return name.startsWith("@") ? name : basename(name)
  } catch {
    return undefined
  }
}

/** Find `name = "..."` inside `[section]`. Not a TOML parser — it only has to
 *  handle `[package]`, `[project]` and `[tool.poetry]`, where the key sits at
 *  the top level of a literal section header. */
export const tomlNameInSection = (raw: string, section: string): string | undefined => {
  let inSection = false
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed.slice(1, -1) === section
      continue
    }
    if (!inSection || !trimmed.startsWith("name")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const value = unquote(trimmed.slice(eq + 1))
    if (value !== undefined) return value
  }
  return undefined
}

/** `module github.com/me/api` → `api`: the last path segment is the name a
 *  person uses, and the rest is hosting trivia. */
export const goModuleName = (raw: string): string | undefined => {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("module ")) continue
    const module = trimmed.slice("module ".length).trim()
    const last = basename(module)
    return last.length > 0 ? last : undefined
  }
  return undefined
}

/** `mix.exs` declares `app: :my_app` inside `def project`. The atom is the
 *  canonical OTP application name, which is what `iex` and releases both use. */
export const mixAppName = (raw: string): string | undefined => {
  const match = /\bapp:\s*:([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)
  return match?.[1]
}

/** Maven's `<artifactId>`, skipping the one inside `<parent>` — that names the
 *  parent POM, not this module, and taking it would label every module in a
 *  multi-module build with the same wrong name. */
export const pomArtifactId = (raw: string): string | undefined => {
  const withoutParent = raw.replace(/<parent>[\s\S]*?<\/parent>/g, "")
  const match = /<artifactId>\s*([^<\s][^<]*?)\s*<\/artifactId>/.exec(withoutParent)
  return match?.[1]
}

/** Gradle declares the real name in settings, not in the build script:
 *  `rootProject.name = "api"` (Groovy or Kotlin DSL). */
export const gradleRootProjectName = (raw: string): string | undefined => {
  const match = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(raw)
  return match?.[1]
}

// ── the walk ────────────────────────────────────────────────────────────────

/** A manifest that states a name. Ordered by how specific the file is, so a
 *  polyglot repo is labelled by the ecosystem that actually owns the directory
 *  rather than by whichever reader happened to run first. */
const namedManifest = (dir: string): string | undefined => {
  const pkg = read(join(dir, "package.json"))
  if (pkg !== undefined) {
    const name = jsonName(pkg)
    if (name !== undefined) return name
  }

  const cargo = read(join(dir, "Cargo.toml"))
  if (cargo !== undefined) {
    const name = tomlNameInSection(cargo, "package")
    if (name !== undefined) return name
  }

  const pyproject = read(join(dir, "pyproject.toml"))
  if (pyproject !== undefined) {
    const name =
      tomlNameInSection(pyproject, "project") ?? tomlNameInSection(pyproject, "tool.poetry")
    if (name !== undefined) return name
  }

  const goMod = read(join(dir, "go.mod"))
  if (goMod !== undefined) {
    const name = goModuleName(goMod)
    if (name !== undefined) return name
  }

  const composer = read(join(dir, "composer.json"))
  if (composer !== undefined) {
    const name = jsonName(composer)
    if (name !== undefined) return name
  }

  const mix = read(join(dir, "mix.exs"))
  if (mix !== undefined) {
    const name = mixAppName(mix)
    if (name !== undefined) return name
  }

  for (const settings of ["settings.gradle.kts", "settings.gradle"]) {
    const raw = read(join(dir, settings))
    if (raw === undefined) continue
    const name = gradleRootProjectName(raw)
    if (name !== undefined) return name
  }

  const pom = read(join(dir, "pom.xml"))
  if (pom !== undefined) {
    const name = pomArtifactId(pom)
    if (name !== undefined) return name
  }

  const deno = read(join(dir, "deno.json")) ?? read(join(dir, "deno.jsonc"))
  if (deno !== undefined) {
    const name = jsonName(deno)
    if (name !== undefined) return name
  }

  return undefined
}

/** Manifests whose FILENAME is the name: `Api.csproj`, `api.gemspec`. Costs a
 *  readdir, so it runs only after every direct read above has missed. */
const NAMING_EXTENSIONS: ReadonlyArray<string> = [".csproj", ".fsproj", ".gemspec"]

const filenameManifest = (dir: string): string | undefined => {
  for (const entry of entries(dir)) {
    const ext = NAMING_EXTENSIONS.find((e) => entry.endsWith(e))
    if (ext !== undefined) return entry.slice(0, -ext.length)
  }
  return undefined
}

/** Files that prove a project root without naming it. Ruby is the reason this
 *  tier exists — a Rails app declares its name nowhere a shallow reader can
 *  reach — but requirements.txt and a bare Gradle build have the same shape. */
const UNNAMED_MANIFESTS: ReadonlyArray<string> = [
  "Gemfile",
  "Gemfile.lock",
  "config.ru",
  "requirements.txt",
  "Pipfile",
  "build.gradle.kts",
  "build.gradle",
  "CMakeLists.txt",
  "Makefile.am",
  "mix.lock",
  "composer.lock"
]

const hasUnnamedManifest = (dir: string): boolean =>
  UNNAMED_MANIFESTS.some((f) => read(join(dir, f)) !== undefined)

const nameAt = (dir: string): string | undefined => {
  if (NEVER_ROOTS.has(dir)) return undefined
  const named = namedManifest(dir) ?? filenameManifest(dir)
  if (named !== undefined) return named
  // Tier two: something here says "project", nothing says what it is called.
  // The directory is then the best label available, and a truthful one — the
  // manifest is what earned the right to use it.
  return hasUnnamedManifest(dir) ? basename(dir) : undefined
}

/** Walk up from `cwd` looking for a manifest. Returns undefined rather than
 *  guessing: outside a project root the directory name means nothing, and a
 *  wrong name presented confidently is worse than the raw command, which is at
 *  least visibly raw. */
export const appNameAt = (cwd: string): string | undefined => {
  let dir = cwd
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const name = nameAt(dir)
    if (name !== undefined) return name
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}
