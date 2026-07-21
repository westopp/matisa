# Service architecture tenets

This file governs how services are structured, how requests flow through them, and how their public surface is shaped. Concerns owned by adjacent files take precedence: testing tiers in [tenets.testing.md](./tenets.testing.md), security discipline in [tenets.security.md](./tenets.security.md), observability in [tenets.telemetry.md](./tenets.telemetry.md), analytics emission in [tenets.analytics.md](./tenets.analytics.md), authentication and authorisation in [tenets.auth.md](./tenets.auth.md), database access in [tenets.db.md](./tenets.db.md), cross-cutting policies in [tenets.general.md](./tenets.general.md).

Tenets are stable, prescriptive commitments. IDs are stable references — code review, PR descriptions, and incident postmortems can cite them. Numbers are not hierarchical; they are identifiers.

---

## API contract

### ARCH-200. The `@repo/api` package is the canonical contract.

Every endpoint exists first as a declaration in `@repo/api` — REST via `HttpApiEndpoint` / `HttpApiGroup`, RPC via `Rpc` / `RpcGroup`. Service modules implement those declarations via `HttpApiBuilder.group(...)` (REST) or the corresponding RPC handler binding; they do not invent endpoint shapes outside the contract. No endpoint reaches the network without a contract entry, and no handler is shaped freely — its inputs, outputs, and error channel are fixed by the contract.

### ARCH-201. Schema-first, not handler-first.

Request shapes, response shapes, and error shapes are decided in `@repo/api` before any handler logic exists. Adding a field is a contract edit; the handler change follows. Handler authors do not reach for ad-hoc parsing inside the handler body — by the time a handler runs, the contract has already parsed the request and narrowed every input to its typed shape.

### ARCH-202. REST and RPC are coupled where both exist.

A module exposing both protocols defines them together: the same Effect Schemas back the inputs, the same success-payload schema, the same error-channel schemas, and the route and procedure names are parallel. Adding an endpoint adds it on both protocols, or carries an explicit contract-level note documenting why one is omitted. A divergence in payload shape between REST and RPC for the same logical operation is a tenet violation, not a stylistic choice.

---

## Request flow

### ARCH-203. Requests flow in one direction: middleware → handler → service(s) → integrations.

Every request follows the same path. Middleware does cross-cutting work (auth, rate limit, security headers, logging, tracing, metrics). The handler translates transport into typed inputs, dispatches to a service, and returns a typed value or typed error. Services do business logic. Integrations do external I/O. Layers do not skip, invert, or reach upward — a service does not call a handler, an integration does not bypass its service, and middleware does not reach into business logic.

### ARCH-204. Handlers are thin.

A handler parses the request through its contract schema, calls into one or more services, and returns the result. Conditional logic that is not transport-shaped — domain rules, orchestration, fallback decisions, transactional composition — does not belong in the handler; it belongs in a service. A handler with a substantive `if` over domain state is a service extraction waiting to happen.

### ARCH-205. Services own business logic and are the unit of testing gravity.

Domain rules, orchestration across data sources, transactional boundaries, and authorisation qualification (AUTH-206) live in services and are consumed via their `Context.Tag`. The bulk of the system's correctness lives at this layer; the service tier (TEST-201) carries the bulk of the suite's signal. Handlers and middleware are thin precisely so that services can be the centre of gravity.

### ARCH-206. Integrations are isolated behind their own service.

External I/O — third-party APIs, queues, file storage, comms providers, external auth providers — is fronted by an internal service whose `ServiceShape` hides the underlying SDK. Modules consume the tag, not the SDK. Swapping a provider is a Layer change, not a sweep across handler files; an SDK upgrade is contained to one place.

---

## Response shape

### ARCH-207. Every response uses the standard envelope.

REST and RPC responses share the same envelope schemas — `ApiSuccessResponseSchema` for success and `ApiResponseErrorSchema` for failure, both declared in `@repo/api/common`. Bespoke top-level response shapes are not permitted — fields, metadata, and error structure live in the envelope's defined slots. The envelope is the surface every client, every test, and every dashboard counts on; per-protocol projections (REST status code, RPC failure union) are configured on the endpoint contract, but the body shape stays uniform.

### ARCH-208. Every endpoint registry entry has one shared `successEnvelope` referenced by both protocols.

Each module's API package (`@repo/api/<module>`) exposes its endpoints through a unified `*Apis` registry — `TodosApis`, `OrganisationsApis`, `InvitationsApis`, `FilesApis`, `HealthApis`. Each entry has the shape:

```ts
EndpointName: {
  successEnvelope: ApiSuccessResponseSchema(DataSchema),
  rest: HttpApiEndpoint.<verb>(...).addSuccess(successEnvelope).pipe(addRestErrors(EndpointNameErrors)),
  rpc:  Rpc.make("EndpointName", { ..., success: successEnvelope, error: errorUnion(EndpointNameErrors) }),
}
```

`successEnvelope` is the **single source of truth** for the response envelope. The same instance is referenced by the REST endpoint and the RPC procedure, and by the `successResponse` helper at every call site — REST and RPC cannot drift apart on success shape, because there is only one schema. Per-endpoint redeclaration on a protocol slot is not permitted; the wire-level details that genuinely belong to a protocol (REST status code, RPC failure union) are configured on `rest` / `rpc` directly.

Where the success shape genuinely needs to be void (`DeleteTodo`, `DeleteOrg`, `SetActiveOrg`, etc.), use `ApiSuccessResponseSchema(Schema.Void)` and pair it with `addSuccess(successEnvelope, { status: 204 })` on REST. Handlers pass `undefined` as the data argument; both protocols share the void shape.

Per-endpoint error sets live alongside the schemas (e.g. `GetTodoErrors`, `GetOrgsErrors` in `<module>.schemas.api.ts`) and are threaded through both protocols via `addRestErrors(...)` / `errorUnion(...)`. The per-error envelope schemas are centrally registered in `ApiErrors`; the per-endpoint slot declares which subset that endpoint is allowed to produce.

### ARCH-208a. Handlers and middleware construct responses through `successResponse` and `errorResponse`.

The `successResponse(entry, value)` and `errorResponse(ApiErrors.X, message)` helpers in [`services/server/src/server/responses.ts`](../../services/server/src/server/responses.ts) are the canonical constructors for response envelopes.

- `successResponse(entry, value)` accepts the registry entry itself — `TodosApis.GetTodo`, `OrganisationsApis.GetOrgs`, etc. — never a `.rest` / `.rpc` slot — and constructs the envelope via `entry.successEnvelope.make(...)`. The data type is derived from the entry's `successEnvelope` by the helper's type machinery, so drift between handler output and the contract fails to compile at the call site, and the envelope value is validated against the contract at construction. Both the REST and RPC handlers for an endpoint pass the *same* entry; the helper is protocol-agnostic.
- `errorResponse(ApiErrors.X, message)` constructs the error envelope via `ApiResponseErrorSchema([entry.code]).make(...)`. The error schemas are centrally registered in `ApiErrors`, so no per-endpoint argument is needed; the per-endpoint allowed-error set declared on the contract constrains which entries the handler is permitted to fail with — drift is caught by TypeScript via the handler's error channel.

In both helpers, `meta` (traceId + serverVersion) is populated uniformly from the active span and `AppConfig`.

Handlers do not hand-roll `{ code: "OK", success: true, data }` literals, do not call `ApiErrors.X.make(...)` inside `Effect.fail(...)`, and do not import bare response-shape schemas to construct values directly. Middleware constructing a typed failure follows the same rule — auth, origin, and org-guard middlewares fail with `errorResponse`, not with `ApiErrors.X.make`.

Direct use of `ApiSuccessResponseSchema` / `ApiResponseErrorSchema` (or `ApiErrors.X.make` for value construction) is permitted only where the helpers genuinely cannot serve — and the justification is recorded in a comment at the call site. The `errorEnvelope(entry, message)` value-form variant exists for surfaces that must embed the envelope into a non-Effect output (e.g. an HTTP middleware reformatting an already-built response body); use the short-circuiting `errorResponse` everywhere else.

### ARCH-208b. Typed-error → HTTP status mapping lives on the contract, not in handlers.

Tagged domain errors (`NotFoundError`, `ValidationError`, the others defined in `@repo/api/errors`) are mapped to HTTP status by the error-schema declaration on each endpoint — REST via `addRestErrors(errors)` (which threads `(schema, status)` for each entry), RPC via the framework's per-error-schema status annotation. Services do not reach for HTTP status codes, and handlers do not branch on status. The handler's job is to fail with the right envelope (via `errorResponse`); the framework applies the per-schema status it was already configured with.

### ARCH-209. Error codes come from `@apollis/shared/error-codes`.

Every error in a response envelope carries one of the shared error-code identifiers from `@apollis/shared/error-codes`. New codes are added to shared, not inlined per module; the dashboard, the client, and the tests all index off the same string set.

---

## List endpoints

### ARCH-210. List endpoints use the standard list params.

Pagination, sort, and search on list endpoints are accepted via the shared `ListParams` schema, and the response uses the shared list envelope (items + page metadata). Modules do not invent their own pagination shape, custom sort grammar, or bespoke search field names.

### ARCH-211. A list endpoint may opt out of the standard params only by replacing them with a superior alternative.

Endpoints whose underlying mechanism subsumes the standard params — geo-search, vector or semantic search, time-window streams, cursor-based event tails — may define their own param shape. They *replace* the standard params; they do not bolt onto them. The contract makes the choice explicit, and reviewers can tell at a glance whether an endpoint is a standard list or a specialised one.

---

## Module shape

### ARCH-212. Modules are self-contained; cross-module imports go through the module's index.

A module imports from its own files, from `@repo/api`, from `@apollis/shared`, and from another module's public exports surfaced through its `<module>.index.ts` — never from another module's internal handler, service, schema, or events files directly. The `<module>.index.ts` is the boundary: re-exporting a symbol there makes it part of the contract; importing through it makes the dependency explicit at the import site, and reviewers can read off the cross-module surface area by looking at one file. Service tags are the most common public symbol; per-module event schemas, public types, and module-owned constants count too when the consuming module needs them — the rule binds the *path* the import takes, not the *kind* of symbol. Reaching into `../other/other.services.ts` or `../other/other.events.ts` directly bypasses the boundary and turns every refactor of the consumed module into a search-and-replace across consumers; importing through `../other/other.index.ts` makes the public surface explicit and the refactor surface contained. Cross-module interaction is mediated by the consumed module's public surface, not by reaching into its private structure.

### ARCH-213. The service pattern is generally fixed.

Every service follows: `ServiceShape` interface → `Context.Tag` class → `make*` Effect constructor → `*Live` Layer. Consumers depend on the tag, not the implementation. Deviations are permitted only when vetted and justified — the default shape is the right answer until a concrete reason proves otherwise. The pattern is independent of file layout (ARCH-214) — a service may live in a single file or across multiple files within a `services/` directory; the tag is the contract, not the file count.

### ARCH-214. Modules follow a fixed layout for standard concerns.

Each module's standard files live at predictable paths: `<name>.services.ts`, `<name>.rest.handlers.ts`, `<name>.rpc.handlers.ts`, `<name>.index.ts`, `__tests__.<name>/`, `__seeds__.<name>/`. Modules may add additional files for concerns the standard layout does not cover — validators, repositories, codecs, providers, internal helpers — and those files follow the same naming convention (`<name>.<facet>.ts`) and live alongside the others. New file types are not enumerated centrally; patterns are followed, not prescribed exhaustively.

Any facet may opt into a `<name>.<facet>/` directory when it has two or more files — multiple distinct services in `<name>.services/`, multiple providers in `<name>.providers/`, and so on. File names inside the directory keep the full module prefix (e.g. `auth.session.services.ts`, not `session.services.ts`) so the convention is uniform whether a file lives at module root or in a sub-directory; tests mirror via `__tests__.<name>/<facet>/`. Handlers stay flat in all cases — the canonical pair is `<name>.rest.handlers.ts` and `<name>.rpc.handlers.ts`, used as appropriate to the protocols the module exposes. The default for every other facet is flat at module root; the directory escalation is opt-in per facet, applied independently as each facet outgrows the flat shape.

### ARCH-221. Abstractions earn their keep.

Every new abstraction — wrapper function, helper layer, intermediary type, indirection class — must solve a real pain point the abstraction-free code demonstrably has, and must offer a notable value-add against its cost: one more file to find, one more name to learn, one more layer to step through in a stack trace, one more place future contributors can put logic that does not belong there. Thin wrappers added to "look consistent", to "match the pattern", or to "leave room for future extension" are not introduced. An inline two-line use of a library API beats a same-shape one-line wrapper that obscures the underlying call; a service that calls its SDK directly beats a wrapper service whose only job is to forward arguments through. The load-bearing abstractions — the service pattern (ARCH-213), integration isolation (ARCH-206), the database boundary (ARCH-215) — exist for argued reasons documented in those tenets; new layers stacked on top of them without an equivalent argument are debt we incur for no return.

---

## Composition and boundaries

### ARCH-215. The `Database` tag is the only database surface services see.

Services depend on the `Database` tag — never on `postgres`, never on a Drizzle instance directly, never on a raw connection. Connection management, transaction primitives, and the mapping from postgres error codes to typed `DatabaseError` live behind the tag. See [DB-200](./tenets.db.md) for the full database-boundary statement.

### ARCH-216. Configuration is parsed at boot through `AppConfig`.

Service code reads typed configuration off `AppConfig`; it does not read `process.env` directly. Malformed environment crashes the process at startup, not a request later. Adding a config value is an `AppConfig` edit; every consumer receives it typed.

### ARCH-217. Authentication and session resolution happen once at the middleware boundary.

The auth middleware resolves the session once per request and exposes it to handlers and services through the request scope. Handlers do not call `auth.api.getSession` themselves; services do not re-resolve sessions or re-verify credentials. See AUTH-201 for the full statement.

### ARCH-220. Timeouts are owned by the operation that does the work.

Every operation that needs a timeout configures it at the layer doing the work — never at a transport-level middleware that wraps the entire request. A blanket route-level timeout produces the false-failure bug class: the client sees 504 while the underlying write completes asynchronously and the resource is created anyway. Per-operation timeouts compose by addition — a service making three database calls accepts roughly three database timeouts' worth of total budget — and the runtime or load balancer enforces the absolute outer cap; service code does not recreate that cap with its own wrapping `Effect.timeout`. Third-party operations always have an enforced timeout, but *where* it lives is operation-appropriate: SDK config, application-side wrapper, provider dashboard, or infrastructure cap (Lambda max duration, gateway timeout) are all valid homes — the right one is whichever layer is actually doing the work. Internal operations configure timeouts where they could plausibly hang. External fetches asymmetrically: GETs implement their own timeout because retrying or abandoning is safe; POST/PUT/DELETE lean on the called service's timeout because abandoning a write after the bytes have left re-introduces the orphan-write class. Timeouts surface as a tagged `TimeoutError` with a stable code from `@apollis/shared/error-codes` so clients can distinguish timeout from failure and choose retry policy.

---

## Naming and documentation

### ARCH-218. Identifiers in request surfaces are named for the entity they identify.

Route segments, path params, query string parameters, RPC arguments, and request/response body fields that reference a foreign entity are named for that entity, never as bare `id`. Routes are `/todos/:todoId` and `/orgs/:orgId/members/:memberId`; query strings are `?todoId=...`, not `?id=...`; RPC arguments and body fields take `todoId`, `orgId`, `memberId`, and so on. A reader of the contract should never have to look at the surrounding path or function signature to work out which entity an `id` refers to.

A self-referential body field — `{ id, ... }` on an object representing "this resource" — is permitted where the surrounding type leaves no ambiguity (e.g. the response payload of `GET /todos/:todoId` may carry `id` for the todo itself). The rule binds *foreign* identifiers, where the ambiguity is the bug class.

### ARCH-222. Service operations use the canonical CRUD verb set with explicit identifier suffixes.

Service functions and their corresponding handlers use one of four canonical verbs for CRUD operations: `create`, `get`, `update`, `delete`. There is no `list` verb — pluralisation of the resource carries cardinality, so `getTodos` returns many and `getTodo` returns one. The identifier suffix is always present and intentionally verbose for clarity at the call site: a primary-key lookup is `getTodoByTodoId`, a scoped list is `getTodosByOrgId`, an unscoped list is `getTodos`. `get` always returns the resource or fails with `NotFoundError` — there is no `find*` variant returning `Option<T>`; absence is an error channel, not a value channel, and code that genuinely tolerates absence catches the typed error explicitly. Operations that are not CRUD use domain verbs that describe the action in the language of the domain (`acceptInvitation`, `rotateApiKey`, `archiveTodo`, `setActiveOrg`); CRUD verbs are reserved for CRUD operations — dressing up a domain action as `updateInvitation` when it is really `acceptInvitation` flattens semantically distinct operations into the same name and is a tenet violation. This complements ARCH-218 on identifier naming: `getTodoByTodoId` takes a `todoId` parameter, never a bare `id`.

### ARCH-219. Every endpoint in the contract carries complete documentation metadata.

Every endpoint declared in `@repo/api` carries: a machine-readable **endpoint name** (the first argument to `HttpApiEndpoint.make` / `Rpc.make`, camelCase, unique within its group), a **human-readable description** annotation describing what the endpoint does (not how), a **status** annotation (`active`, `deprecated`, `internal`, or equivalent) that drives doc generation and client tooling, and an **exclude / hidden** annotation for surfaces that intentionally do not appear in generated client docs. Every response the contract produces — happy path and every typed error — is declared with its status code and envelope shape. The contract is the source of truth for what the API is; incomplete metadata makes the contract less than it claims to be.

---

## Cross-references

- **GEN-200** — schemas live in shared; the API contract package is one of those shared homes.
- **AUTH-201, AUTH-206** — session resolution at the middleware boundary; grant/qualification division across handler and service layers.
- **DB-200** — the `Database` service is the only way to interface with the database.
- **TEST-201, TEST-204** — service-tier and e2e-tier responsibilities mirror the layer boundaries this file establishes.
- **TEL-203** — the span tree mirrors the request call stack established by ARCH-203.
