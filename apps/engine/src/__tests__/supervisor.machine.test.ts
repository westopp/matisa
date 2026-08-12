import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Option } from "effect"
import { Event, State, runtimeStateOf, transition } from "../modules/supervisor/supervisor.machine.js"

// The FSM is the state-is-truth core: every reported state derives from these
// transitions fed with real process events. The table below pins the WHOLE
// machine — legal transitions produce the exact next state, and every other
// (state, event) pair must be ignored (none), so a stray event can never
// corrupt the reported state.

const next = (s: State, e: Event): State => {
  const r = transition(s, e)
  assert.ok(Option.isSome(r), `expected a transition from ${s._tag} on ${e._tag}`)
  return r.value
}

const rejected = (s: State, e: Event): void => {
  assert.ok(
    Option.isNone(transition(s, e)),
    `expected ${s._tag} to IGNORE ${e._tag}, got ${Option.map(transition(s, e), (n) => n._tag)}`
  )
}

const start = Event.Start({ attempt: 0 })
const healthy = Event.Healthy({ pid: 42, since: 1000 })
const cleanExit = Event.Exit({ code: 0, signal: null })
const crashExit = Event.Exit({ code: 1, signal: null })
const signalExit = Event.Exit({ code: null, signal: "SIGKILL" })
const fault = Event.Fault({ reason: "boom" })

describe("supervisor FSM — legal transitions", () => {
  it("Idle + Start → Starting", () => {
    assert.deepEqual(next(State.Idle(), start), State.Starting({ attempt: 0 }))
  })

  it("Idle + ForeignListener → Unmanaged", () => {
    assert.deepEqual(next(State.Idle(), Event.ForeignListener({ pid: 7 })), State.Unmanaged({ pid: 7 }))
  })

  it("Starting + Healthy → Running (pid + since carried)", () => {
    assert.deepEqual(next(State.Starting({ attempt: 0 }), healthy), State.Running({ pid: 42, since: 1000 }))
  })

  it("Starting + clean Exit → Idle", () => {
    assert.equal(next(State.Starting({ attempt: 0 }), cleanExit)._tag, "Idle")
  })

  it("Starting + unclean Exit → Crashed (code kept)", () => {
    assert.deepEqual(next(State.Starting({ attempt: 0 }), crashExit), State.Crashed({ code: 1, signal: null }))
  })

  it("Starting + Timeout → Errored", () => {
    assert.equal(next(State.Starting({ attempt: 0 }), Event.Timeout())._tag, "Errored")
  })

  it("Starting + Stop/Kill → Stopping", () => {
    assert.equal(next(State.Starting({ attempt: 0 }), Event.Stop())._tag, "Stopping")
    assert.equal(next(State.Starting({ attempt: 0 }), Event.Kill())._tag, "Stopping")
  })

  it("Running + clean Exit → Idle", () => {
    assert.equal(next(State.Running({ pid: 42, since: 0 }), cleanExit)._tag, "Idle")
  })

  it("Running + signal Exit → Crashed (signal kept)", () => {
    assert.deepEqual(
      next(State.Running({ pid: 42, since: 0 }), signalExit),
      State.Crashed({ code: null, signal: "SIGKILL" })
    )
  })

  it("Running + Stop/Kill → Stopping", () => {
    assert.equal(next(State.Running({ pid: 42, since: 0 }), Event.Stop())._tag, "Stopping")
    assert.equal(next(State.Running({ pid: 42, since: 0 }), Event.Kill())._tag, "Stopping")
  })

  it("Running + Fault → Errored (reason kept)", () => {
    assert.deepEqual(next(State.Running({ pid: 42, since: 0 }), fault), State.Errored({ reason: "boom" }))
  })

  it("Stopping + Exit/Timeout → Idle", () => {
    assert.equal(next(State.Stopping(), signalExit)._tag, "Idle")
    assert.equal(next(State.Stopping(), Event.Timeout())._tag, "Idle")
  })

  it("Crashed/Errored/Unmanaged + Start → Starting (restartable)", () => {
    for (const s of [
      State.Crashed({ code: 1, signal: null }),
      State.Errored({ reason: "x" }),
      State.Unmanaged({ pid: 9 })
    ]) {
      assert.deepEqual(next(s, Event.Start({ attempt: 3 })), State.Starting({ attempt: 3 }))
    }
  })

  it("Crashed/Errored + Reset → Idle (dismissing a failure)", () => {
    for (const s of [State.Crashed({ code: 1, signal: null }), State.Errored({ reason: "x" })]) {
      assert.deepEqual(next(s, Event.Reset()), State.Idle())
    }
  })

  it("Reset is illegal from every state that is not a terminal failure", () => {
    // Unmanaged included: a foreign process holds the port, and nothing this
    // engine does to its own record changes that.
    for (const s of [
      State.Idle(),
      State.Starting({ attempt: 0 }),
      State.Running({ pid: 1, since: 0 }),
      State.Stopping(),
      State.Unmanaged({ pid: 9 })
    ]) {
      assert.equal(Option.isNone(transition(s, Event.Reset())), true)
    }
  })
})

describe("supervisor FSM — clean-exit classification", () => {
  it("only code 0 with no signal is clean", () => {
    assert.equal(next(State.Running({ pid: 1, since: 0 }), Event.Exit({ code: 0, signal: null }))._tag, "Idle")
    assert.equal(next(State.Running({ pid: 1, since: 0 }), Event.Exit({ code: 0, signal: "SIGTERM" }))._tag, "Crashed")
    assert.equal(next(State.Running({ pid: 1, since: 0 }), Event.Exit({ code: null, signal: null }))._tag, "Crashed")
    assert.equal(next(State.Running({ pid: 1, since: 0 }), Event.Exit({ code: 137, signal: null }))._tag, "Crashed")
  })
})

describe("supervisor FSM — illegal pairs are ignored", () => {
  it("Idle ignores everything but Start/ForeignListener", () => {
    for (const e of [Event.Stop(), Event.Kill(), healthy, fault, cleanExit, Event.Timeout()]) {
      rejected(State.Idle(), e)
    }
  })

  it("Running ignores Start/Healthy/Timeout/ForeignListener", () => {
    for (const e of [start, healthy, Event.Timeout(), Event.ForeignListener({ pid: 1 })]) {
      rejected(State.Running({ pid: 42, since: 0 }), e)
    }
  })

  it("Stopping ignores everything but Exit/Timeout", () => {
    for (const e of [start, Event.Stop(), Event.Kill(), healthy, fault, Event.ForeignListener({ pid: 1 })]) {
      rejected(State.Stopping(), e)
    }
  })

  it("Crashed/Errored ignore process events (no ghost transitions)", () => {
    for (const s of [State.Crashed({ code: 1, signal: null }), State.Errored({ reason: "x" })]) {
      for (const e of [healthy, cleanExit, Event.Stop(), Event.Kill(), Event.Timeout()]) {
        rejected(s, e)
      }
    }
  })
})

describe("runtimeStateOf — wire projection", () => {
  it("maps every state to its RuntimeState literal", () => {
    assert.equal(runtimeStateOf(State.Idle()), "idle")
    assert.equal(runtimeStateOf(State.Starting({ attempt: 0 })), "starting")
    assert.equal(runtimeStateOf(State.Running({ pid: 1, since: 0 })), "running")
    assert.equal(runtimeStateOf(State.Stopping()), "stopping")
    assert.equal(runtimeStateOf(State.Crashed({ code: 1, signal: null })), "crashed")
    assert.equal(runtimeStateOf(State.Errored({ reason: "x" })), "errored")
    assert.equal(runtimeStateOf(State.Unmanaged({ pid: 1 })), "unmanaged")
  })
})
