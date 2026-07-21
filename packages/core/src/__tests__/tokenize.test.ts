import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { tokenize } from "../core.tokenize.js"

// The command tokenizer decides exactly what program + args the engine spawns.
// Whitespace-splitting mangled quoted commands (the original smoke-test bug);
// these cases pin the POSIX-ish rules it must keep.

describe("tokenize", () => {
  it("splits plain words on whitespace", () => {
    assert.deepEqual(tokenize("npm run dev"), ["npm", "run", "dev"])
    assert.deepEqual(tokenize("  spaced   out  "), ["spaced", "out"])
  })

  it("keeps single-quoted strings literal (the original bug)", () => {
    assert.deepEqual(tokenize("node -e 'let i=0;setInterval(()=>console.log(++i),200)'"), [
      "node",
      "-e",
      "let i=0;setInterval(()=>console.log(++i),200)"
    ])
    assert.deepEqual(tokenize("echo 'no $expansion \\here'"), ["echo", "no $expansion \\here"])
  })

  it("groups double quotes and honours their escapes", () => {
    assert.deepEqual(tokenize('echo "hello world"'), ["echo", "hello world"])
    assert.deepEqual(tokenize('echo "a \\"quoted\\" word"'), ["echo", 'a "quoted" word'])
    assert.deepEqual(tokenize('echo "escaped \\$var and \\\\slash"'), ["echo", "escaped $var and \\slash"])
  })

  it("backslash escapes the next char outside quotes", () => {
    assert.deepEqual(tokenize("echo one\\ token"), ["echo", "one token"])
  })

  it("supports empty-string args", () => {
    assert.deepEqual(tokenize("cmd '' end"), ["cmd", "", "end"])
  })

  it("handles adjacent quoted segments as one token", () => {
    assert.deepEqual(tokenize("echo 'a b'\"c d\""), ["echo", "a bc d"])
  })

  it("returns null on unterminated quotes", () => {
    assert.equal(tokenize("node -e 'oops"), null)
    assert.equal(tokenize('echo "dangling'), null)
  })

  it("returns [] for empty/blank input", () => {
    assert.deepEqual(tokenize(""), [])
    assert.deepEqual(tokenize("   "), [])
  })
})
