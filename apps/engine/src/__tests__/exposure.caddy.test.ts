import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ProjectId } from "@matisa/core"
import {
  bootstrapConfig,
  desiredConfig,
  routeFor,
  slugify,
  type RouteSpec
} from "../modules/exposure/exposure.caddy.js"

// The Caddy config is a pure projection of the store — these tests pin the
// derivation: hostnames, upstream dials, the loopback→0.0.0.0 listener flip,
// and the dedicated per-project LAN listeners.

const OPTS = { adminPort: 2019, httpPort: 7777, mdnsDomain: "matisa.local" }

const spec = (over: Partial<RouteSpec> = {}): RouteSpec => ({
  projectId: ProjectId.make("p1"),
  slug: "my-api",
  upstreamPort: 3000,
  ...over
})

type Servers = Record<
  string,
  { listen: Array<string>; routes: Array<{ "@id": string; match?: Array<{ host: Array<string> }> }> }
>
const serversOf = (cfg: Record<string, unknown>): Servers =>
  (cfg["apps"] as { http: { servers: Servers } }).http.servers

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    assert.equal(slugify("My API (v2)"), "my-api-v2")
  })
  it("trims leading/trailing separators", () => {
    assert.equal(slugify("  spaced out  "), "spaced-out")
  })
})

describe("routeFor", () => {
  it("stable-only: one .localhost host, tagged with the project id", () => {
    const route = routeFor(spec(), OPTS.mdnsDomain) as {
      "@id": string
      match: Array<{ host: Array<string> }>
      handle: Array<{ handler: string; upstreams: Array<{ dial: string }> }>
    }
    assert.equal(route["@id"], "matisa:p1")
    assert.deepEqual(route.match[0]?.host, ["my-api.localhost"])
    assert.equal(route.handle[0]?.upstreams[0]?.dial, "127.0.0.1:3000")
  })

  it("lan: the mDNS hostname joins the matcher", () => {
    const route = routeFor(spec({ lan: { lanPort: 7801 } }), OPTS.mdnsDomain) as {
      match: Array<{ host: Array<string> }>
    }
    assert.deepEqual(route.match[0]?.host, ["my-api.localhost", "my-api.matisa.local"])
  })
})

describe("desiredConfig", () => {
  it("no specs → only the 404 fallback route, loopback listener", () => {
    const servers = serversOf(desiredConfig([], OPTS))
    assert.deepEqual(servers["matisa"]?.listen, ["127.0.0.1:7777"])
    assert.deepEqual(
      servers["matisa"]?.routes.map((r) => r["@id"]),
      ["matisa:fallback"]
    )
  })

  it("fallback 404 route is last, after every project route", () => {
    const servers = serversOf(desiredConfig([spec()], OPTS))
    assert.deepEqual(
      servers["matisa"]?.routes.map((r) => r["@id"]),
      ["matisa:p1", "matisa:fallback"]
    )
  })

  it("no LAN rows → main server stays loopback-bound", () => {
    const servers = serversOf(desiredConfig([spec()], OPTS))
    assert.deepEqual(servers["matisa"]?.listen, ["127.0.0.1:7777"])
    assert.equal(Object.keys(servers).length, 1)
  })

  it("any LAN row flips the main listener to 0.0.0.0 and adds the dedicated server", () => {
    const specs = [spec(), spec({ projectId: ProjectId.make("p2"), slug: "web", upstreamPort: 5173, lan: { lanPort: 7801 } })]
    const servers = serversOf(desiredConfig(specs, OPTS))
    assert.deepEqual(servers["matisa"]?.listen, ["0.0.0.0:7777"])
    assert.deepEqual(servers["matisa_lan_p2"]?.listen, ["0.0.0.0:7801"])
    // The dedicated listener routes hostless — a bare IP:port cannot carry Host.
    assert.equal(servers["matisa_lan_p2"]?.routes[0]?.["@id"], "matisa:lan:p2")
    assert.equal(servers["matisa_lan_p2"]?.routes[0]?.match, undefined)
  })

  it("both hostnames route through the main server when LAN is on", () => {
    const servers = serversOf(desiredConfig([spec({ lan: { lanPort: 7801 } })], OPTS))
    assert.deepEqual(servers["matisa"]?.routes[0]?.match?.[0]?.host, [
      "my-api.localhost",
      "my-api.matisa.local"
    ])
  })

  it("admin endpoint is loopback-only in both bootstrap and desired configs", () => {
    assert.equal(
      (bootstrapConfig(2019)["admin"] as { listen: string }).listen,
      "127.0.0.1:2019"
    )
    assert.equal(
      (desiredConfig([], OPTS)["admin"] as { listen: string }).listen,
      "127.0.0.1:2019"
    )
  })
})
