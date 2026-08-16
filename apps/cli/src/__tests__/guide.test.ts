import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CliConfig, Command, HelpDoc } from "@effect/cli"
import { cli } from "../cli.command.js"
import { GUIDE } from "../cli.guide.js"

// ────────────────────────────────────────────────────────────────────────────
// The guide is hand-written prose, so nothing stops the command tree from
// growing past it — and a reference that silently omits a command is worse than
// no reference, because an agent reading it concludes the command does not
// exist. The tree is the authority: every path it can dispatch has to appear in
// the document, written the way the document writes commands.
//
// Coverage only. Whether a description is any GOOD is not something a test can
// hold, and pretending otherwise would only invite padding to satisfy it.
// ────────────────────────────────────────────────────────────────────────────

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g")

/** The leading run of bare words in a usage line — "project add --name text …"
 *  is the path "project add". Stops at the first flag or placeholder. */
const pathOf = (usage: string): string => {
  const path: Array<string> = []
  for (const token of usage.split(/\s+/)) {
    if (/^[a-z][a-z-]*$/.test(token) === false) break
    path.push(token)
  }
  return path.join(" ")
}

/** Every command path the root can dispatch, read out of the same help document
 *  `matisa --help` prints. */
const commandPaths = (): ReadonlyArray<string> => {
  const text = HelpDoc.toAnsiText(Command.getHelp(cli, CliConfig.defaultConfig))
  const paths = text
    .split("\n")
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => pathOf(line.slice(2).trim()))
    .filter((path) => path.length > 0)
  return [...new Set(paths)]
}

/** Present means listed as a command — at the head of its own line in the
 *  reference, or spelled out as an invocation. A bare substring match would
 *  pass on prose ("run", "logs", "events" all occur as English words). */
const documents = (path: string): boolean =>
  new RegExp(`(^[ \\t]*|matisa )${path}\\b`, "m").test(GUIDE)

describe("matisa guide", () => {
  it("covers every command the CLI can dispatch", () => {
    const paths = commandPaths()
    // A tree that yielded nothing would make the assertion below vacuously true.
    assert.ok(paths.length > 20, `expected a populated command tree, got ${paths.length}`)

    assert.deepEqual(
      paths.filter((path) => documents(path) === false),
      [],
      "commands exist that the guide never lists"
    )
  })

  it("stays plain text — it gets pasted into prompts and written to files", () => {
    assert.equal(GUIDE.includes(ESC), false, "guide contains ANSI escapes")
    assert.equal(GUIDE.includes("`"), false, "guide contains backticks")
  })
})
