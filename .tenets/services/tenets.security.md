# Security tenets

Cross-cutting security beyond authentication. Auth surface — sessions, RBAC, organisations, OTP/2FA, OAuth, login flows — lives in [tenets.auth.md](./tenets.auth.md); this file does not encroach on it. Logging-side leakage is owned by TEL-214; this file references it rather than restating it.

Tenets are stable, prescriptive commitments. IDs are stable references — code review, PR descriptions, and incident postmortems can cite them. Numbers are not hierarchical; they are identifiers.

---

## Secrets & cryptography

### SEC-200. Secrets live in `Redacted<T>` end-to-end.

Every secret — database URL, third-party API key, signing key, OAuth client secret, webhook signing token — is loaded into typed config as `Redacted<T>` (e.g. `AppConfig.db.connectionString: Redacted<string>`), propagated as `Redacted<T>` through services, and unwrapped only at the call site that hands it to the underlying library. No `process.env.STRIPE_KEY` in service code, no `{ apiKey: config.foo }` diagnostic responses, no `Effect.logInfo("config", config)` lines that walk a struct of redacted fields. The type is the enforcement mechanism: a `Redacted<string>` cannot be interpolated, JSON-serialised, or default-formatted; reaching for `Redacted.value(...)` is the visible, reviewable moment a secret leaves its wrapper. See TEL-214 for the logging-side counterpart.

---

### SEC-201. Use the library; never roll your own crypto.

Hashing, signing, encryption, key derivation, token generation, MAC computation, and randomness all go through vetted primitives — better-auth for passwords and session tokens, Node's `crypto` for general primitives. No `crypto.createHash("sha256")` masquerading as `hashPassword`, no bespoke `crypto.createCipheriv` wrapper for "small JSON blobs", no `Math.random()` or `Date.now()`-derived values for anything security-bearing, no DIY constant-time compare in place of `crypto.timingSafeEqual`. Cryptographic primitives are a category where plausible-looking mistakes produce silent, exploitable failures; the library has been reviewed by people who do this for a living, and our wrapper has been reviewed by us.

---

## Input & output discipline

### SEC-202. External input is parsed, not validated.

Every value crossing a trust boundary into the system — HTTP bodies, query parameters, headers, RPC payloads, queue messages, third-party API responses, file contents, environment variables — is parsed through an Effect Schema that yields a typed value or a `ValidationError`. REST bodies are parsed via `HttpApiBuilder` schemas; `AppConfig` parses `process.env` at boot and crashes on malformed values; the service function receives the typed result and uses it directly. No handler pulls `body.foo` off an `unknown` body and forwards it, no service re-checks `if (typeof input.email === "string")` after the boundary has already parsed it, no third-party webhook is trusted by JSON shape alone. Parsing is also where sanitisation, normalisation, and coercion happen — trim whitespace, lowercase emails, normalise unicode, reject control characters; service functions do not re-sanitise inputs they receive. The distinction between parsing and validation is load-bearing: validation suggests the value passes through unchanged, parsing makes the type narrowing explicit, and downstream code trusts the type.

---

### SEC-203. No string-built SQL, ever.

Every database query goes through Drizzle's typed builder or its parameterised `` sql`...` `` template. No `` `SELECT * FROM ${table}` ``, no `` `WHERE id = ${id}` `` interpolation outside the parameter-binding template, no dynamic table or column names sourced from request data, no `db.execute(sql.raw(...))` carrying user-shaped fragments. The exception that proves the rule: when a query genuinely needs dynamic structure (e.g. a sort column chosen by the user), the dynamic value is matched against an allow-list of known-safe identifiers before it touches any SQL builder, and the query is composed from the matched constant — never from the input string. SQL injection is closed as a bug class by construction; review enforces the construction.

---

### SEC-204. No dynamic code construction.

`eval`, `new Function`, `vm.runInContext`, `vm.runInNewContext`, dynamic `import()` of paths derived from input, `require(variable)`, and any equivalent mechanism for turning a string into executable code are forbidden in service code. There is no "but only with sanitised input" carve-out; the ban is unconditional. No `eval(userExpression)` to "let admins write filter rules", no `new Function("ctx", body)` to compile a user snippet, no `` await import(`./plugins/${name}.ts`) `` where `name` originates from a request. Configuration is data; templates render through a library that does not evaluate arbitrary expressions; dynamic dispatch goes through typed maps keyed by enumerated values, not string-to-code lookup. The bug class this closes is remote code execution — sanitisation is a probabilistic defence against an adversarial input space, refusal to construct code from data is a deterministic one.

---

### SEC-205. Never trust a client-supplied identifier as the authorisation actor.

When a handler decides "can the caller act on resource X?", the *actor* of the authorisation check (`user.id`, `session.id`, `organisation.id`) is read from the resolved session — never from the request body, query string, header, or URL path. Path and body parameters identify the *target* of the action; the session identifies the *actor*. The check joins the two and refuses if the join fails: `POST /orgs/:orgId/invitations` reads `:orgId` as the target and `userId` from the session, then verifies the session's user has membership in `:orgId` before issuing the invitation. No handler reads `body.userId` and treats it as the actor, no audit-log writer records `body.actor` rather than `session.user.id`, no "internal" endpoint accepts an arbitrary actor field on the assumption that only trusted callers reach it. This closes BOLA / IDOR via someone-else's-id-in-a-JSON-field — the defence is structural: the body cannot be the source of the actor. The auth tenets file owns *how* sessions are resolved and what RBAC means; this tenet owns the rule that the session is the only acceptable source of actor identity. The `actor.*` / `target.*` attribute namespacing on logs and spans (TEL-220) is the observability-side counterpart to the asymmetry this tenet establishes.

---

### SEC-206. Responses leak nothing internal.

Error responses follow `RestApiResponseErrorSchema` (REST) or the RPC error envelope only. They contain no stack traces, no internal file paths, no raw exception messages from infrastructure libraries, no database error text, no SQL fragments, no internal IDs unrelated to the request, no query plans or row counts. The `strip-stack-error` middleware enforces this on the way out, and handlers do not compose bespoke error bodies that bypass it: no `Effect.catchAll(e => HttpApiError.InternalServerError({ message: e.message }))`, no `{ ok: false, error: String(cause) }` from a generic error path, no affected-table name in a user-facing error. Typed domain errors carry the user-visible payload; everything else maps to a generic infrastructure-failure envelope at the boundary, with the underlying `Cause` logged in full detail (TEL-211, TEL-213) but never escaping into the response. The on-the-wire shape is part of the API contract — a handler that lets a `DatabaseError` message through has changed that contract and disclosed implementation detail an attacker can use to map the system.

---

## Transport, headers, abuse resistance

### SEC-207. Security headers are middleware-owned and non-optional.

The security-headers middleware sets the canonical header set on every response — Content-Security-Policy, Strict-Transport-Security, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, frame-ancestors, and any others it declares. Handlers do not set their own security headers, do not opt out, and do not override middleware-set values: no `response.setHeader("Content-Security-Policy", ...)` in handler code to relax a directive, no per-endpoint disabling of `frame-ancestors` because "this one serves an iframe", no new module shipping without exercising the middleware. Adding, removing, or weakening a header is a single-file change in the middleware, reviewed once and tested in `middleware.security-headers.test.ts` (TEST-216). Distributed enforcement decays — five handlers each setting CSP diverge as features grow, and a sixth shipping without CSP is invisible; one owner, one set, applied uniformly.

---

### SEC-208. CORS is closed by default; allow-lists are explicit.

The CORS middleware ships with no allowed origins. Origins live in `AppConfig.cors.allowedOrigins` as a typed array, populated per-environment and validated at boot; the middleware compares the request `Origin` against the list and refuses requests whose origin is absent. No `Access-Control-Allow-Origin: *` paired with `Access-Control-Allow-Credentials: true`, no middleware that reads `request.headers.origin` and writes it back as the allowed origin, no `["*"]` allow-list for "easier local development". Development uses the same allow-list mechanism with development origins listed — there is no parallel "permissive in dev" mode that diverges in shape from production. Wildcard reflection in particular is the most common CORS misconfiguration in the wild and is functionally equivalent to having no CORS at all while looking like a configured allow-list.

---

### SEC-209. Rate limiting applies globally; opt-outs are explicit and justified.

The rate-limit middleware applies to every endpoint by default. Buckets are scoped per-identity — the resolved auth subject where present, falling back to a hashed client IP — so that an abusive client cannot exhaust capacity for others; an endpoint with a resolved session that buckets only by IP lets a single authenticated abuser hide behind shared NAT. Endpoints exempted from rate limiting are individually annotated at the route definition with the reason for exemption, and the empty set of exemptions is the safe default: no handler disabling the limit because "it's slow when I run my load test", no module exempted wholesale without per-route justification. Liveness and readiness probes are the canonical exemption — they are called by infrastructure on a schedule and rate-limiting them produces false-negative health signals; any other proposed exemption is treated as a security-review item, not a routine choice.

---

## Supply chain

### SEC-210. Dependencies are vetted, pinned, and minimised.

Every new runtime dependency is justified at review against the alternative — the standard library, an existing dependency, or thirty lines of our own code — and the justification appears in the PR description, not the diff. Versions are pinned in `bun.lock`; lockfile changes are reviewed as code; transitive dependency growth is a review concern, not a side effect; floating versions where they do not need to float is a tenet violation. The dependency graph is periodically audited for unmaintained packages, packages with known advisories, and packages whose maintainership has changed hands, and unused dependencies are removed when noticed. The bias is toward the smallest plausible dependency surface — a direct dependency that pulls in fifty transitive packages is not free, because every package is code we run, a maintainer we trust, and a future supply-chain incident we are exposed to.

---

## Cross-references

- **TEL-214** — PII and secrets never appear in logs in the clear; this is the logging-surface counterpart to SEC-200.
- **TEST-208** — the e2e tier exercises every endpoint against malformed, oversized, and injection-style inputs; SEC-202 and SEC-203 are why those tests find nothing.
- **TEST-216** — middleware has its own dedicated test surface; SEC-207, SEC-208, and SEC-209 are tested there, not per-module.
- **`tenets.auth.md`** — sessions, RBAC, organisations, OTP/2FA, OAuth, and the login surface are owned there; SEC-205 is the single hand-off point.
