import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseComposeLine } from "../modules/supervisor/supervisor.run-docker.js"

// Compose's multiplexed log format: `<service>-<n>  | body`. The parser feeds
// log_line attribution, so a mistake here mis-files lines in the UI filter.

describe("parseComposeLine — compose log prefix attribution", () => {
  it("attributes a prefixed line to its service and strips the prefix", () => {
    assert.deepEqual(parseComposeLine("web-1         | listening on 3000"), {
      line: "listening on 3000",
      service: "web"
    })
  })

  it("keeps dashes inside the service name; only the replica index is stripped", () => {
    assert.deepEqual(parseComposeLine("redis-cache-2  | ready"), {
      line: "ready",
      service: "redis-cache"
    })
  })

  it("passes compose's own unprefixed output through unattributed", () => {
    assert.deepEqual(parseComposeLine("Attaching to web-1, db-1"), {
      line: "Attaching to web-1, db-1"
    })
  })

  it("keeps a body containing pipes intact", () => {
    assert.deepEqual(parseComposeLine("db-1  | SELECT a | b FROM t"), {
      line: "SELECT a | b FROM t",
      service: "db"
    })
  })

  it("handles an empty body after the prefix", () => {
    assert.deepEqual(parseComposeLine("web-1  | "), { line: "", service: "web" })
  })
})
