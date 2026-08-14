import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { matchProject, type Named } from "../cli.resolve.js"

// The decision "which project did they mean", isolated from the wire.

const CATALOG: ReadonlyArray<Named> = [
  { id: "a47966f5-e387-4738-b9f9-55fe380f9885", name: "web" },
  { id: "d33d9e8b-987b-4974-8505-8a15a8e892c8", name: "worker" },
  { id: "6c5e8fe7-e68b-43aa-9cf1-e0030910e9a8", name: "redis-cache" }
]

describe("matchProject", () => {
  it("passes a uuid straight through without consulting the catalog", () => {
    const r = matchProject([], "a47966f5-e387-4738-b9f9-55fe380f9885")
    assert.equal(r._tag, "id")
    if (r._tag === "id") assert.equal(r.id, "a47966f5-e387-4738-b9f9-55fe380f9885")
  })

  it("resolves a unique name", () => {
    const r = matchProject(CATALOG, "worker")
    assert.equal(r._tag, "one")
    if (r._tag === "one") assert.equal(r.id, "d33d9e8b-987b-4974-8505-8a15a8e892c8")
  })

  it("matches case-insensitively — shells and humans disagree about case", () => {
    const r = matchProject(CATALOG, "Redis-Cache")
    assert.equal(r._tag, "one")
  })

  it("matches the whole name, never a prefix", () => {
    assert.equal(matchProject(CATALOG, "web")._tag, "one")
    assert.equal(matchProject(CATALOG, "wor")._tag, "none")
  })

  it("refuses a name held by two projects rather than picking one", () => {
    const dupes: ReadonlyArray<Named> = [
      { id: "id-1", name: "api" },
      { id: "id-2", name: "API" }
    ]
    const r = matchProject(dupes, "api")
    assert.equal(r._tag, "many")
    if (r._tag === "many") assert.deepEqual(r.matches.map((m) => m.id), ["id-1", "id-2"])
  })

  it("reports an unknown name as none", () => {
    assert.equal(matchProject(CATALOG, "nope")._tag, "none")
  })
})
