import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Scrollback, runSessionId, signalName } from "../modules/pty/pty.session.js"
import { restartDelayMs } from "../modules/supervisor/supervisor.backoff.js"

// Scrollback's seq numbers are what lets an attach replay history and then
// dedupe against the live hub (pump skips seq ≤ last replayed). If ordering or
// eviction breaks, attaches drop or duplicate terminal bytes.

describe("Scrollback", () => {
  it("assigns strictly increasing seqs and round-trips base64", () => {
    const sb = new Scrollback(1024)
    const a = sb.push("hello ")
    const b = sb.push("world")
    assert.equal(b.seq, a.seq + 1)
    const text = sb
      .snapshot()
      .map((c) => Buffer.from(c.data, "base64").toString("utf8"))
      .join("")
    assert.equal(text, "hello world")
  })

  it("evicts from the front when over the byte cap", () => {
    const sb = new Scrollback(40) // base64 of 10 chars ≈ 16 bytes per chunk
    sb.push("aaaaaaaaaa")
    sb.push("bbbbbbbbbb")
    sb.push("cccccccccc")
    const decoded = sb.snapshot().map((c) => Buffer.from(c.data, "base64").toString("utf8"))
    assert.ok(!decoded.includes("aaaaaaaaaa"), "oldest chunk should be evicted")
    assert.ok(decoded.includes("cccccccccc"), "newest chunk must remain")
  })

  it("never evicts the last remaining chunk, even oversized", () => {
    const sb = new Scrollback(4)
    sb.push("this single chunk exceeds the whole cap")
    assert.equal(sb.snapshot().length, 1)
  })

  it("seqs stay monotonic across eviction and bumpSeq (exit frames)", () => {
    const sb = new Scrollback(10)
    const first = sb.push("0123456789").seq
    const second = sb.push("0123456789").seq // evicts first
    const exitSeq = sb.bumpSeq()
    assert.equal(second, first + 1)
    assert.equal(exitSeq, second + 1)
  })
})

describe("signalName", () => {
  it("maps common signal numbers to names", () => {
    assert.equal(signalName(15), "SIGTERM")
    assert.equal(signalName(9), "SIGKILL")
    assert.equal(signalName(2), "SIGINT")
  })

  it("treats 0/undefined as no signal", () => {
    assert.equal(signalName(0), null)
    assert.equal(signalName(undefined), null)
  })

  it("falls back to SIG<n> for unknown numbers", () => {
    assert.equal(signalName(99), "SIG99")
  })
})

describe("runSessionId", () => {
  it("is deterministic per project", () => {
    assert.equal(runSessionId("p1" as never), "run:p1")
  })
})

describe("restartDelayMs", () => {
  it("doubles from base and respects the cap", () => {
    assert.equal(restartDelayMs(0, 500, 30_000), 500)
    assert.equal(restartDelayMs(1, 500, 30_000), 1000)
    assert.equal(restartDelayMs(3, 500, 30_000), 4000)
    assert.equal(restartDelayMs(10, 500, 30_000), 30_000)
  })
})
