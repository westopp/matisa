# Post-implementation checklist

A short list of yes/no questions to walk through after any non-trivial implementation, before opening a PR. The questions are pointers — each one references the tenet that owns the rule, where the full reasoning and exceptions live. Every answer should be **yes** or **n/a (does not apply to this change)**; a **no** is a tenet violation and must be addressed or explicitly justified in the PR description.

This is a checklist, not a substitute for the tenets. When in doubt, read the cited tenet.

---

## Overall

- [ ] Were the tenets followed? Specifically: did you read the tenet file(s) covering the areas this change touches before writing the code, and does the implementation honour them — not just the recogniser questions below, but the spirit and reasoning of the tenets they point at? If you cannot truthfully answer "yes" because you skipped the relevant files, stop and read them now.

---

## Contracts & architecture

- [ ] If the change introduces or alters an HTTP/RPC surface, is the contract defined in `@repo/api` first and only implemented by the handler? (ARCH-200, ARCH-201)
- [ ] Are handlers thin — parsing, calling services, returning the envelope — with business logic living in services? (ARCH-204, ARCH-205)
- [ ] Does every response — success and error — go through the standard envelope, with error codes from `@apollis/shared/error-codes`? (ARCH-207, ARCH-208, ARCH-209)
- [ ] Do new list endpoints use the standard list params, or replace them with a deliberately superior alternative? (ARCH-210, ARCH-211)
- [ ] Does any new abstraction (helper, wrapper, layer) earn its keep against at least two concrete call sites today? (ARCH-221)
- [ ] Do all cross-module imports go through the consumed module's `<module>.index.ts`, not directly into its services/handlers/schemas/events files? (ARCH-212)

## Shared, schemas, time

- [ ] Are schemas crossing module boundaries defined once in `packages/shared/src/schemas` or `@repo/api`, and imported — never redefined or copied? (GEN-200)
- [ ] Do new `TaggedError`s carry a populated `cause` at the throw site? (GEN-201)
- [ ] Does every date/time read, parse, format, or duration go through Effect's `DateTime` module rather than `Date.now()` / `new Date()`? (GEN-202)
- [ ] Are constants used in more than one file lifted into `packages/shared/src/constants`? (GEN-203)

## Auth & permissions

- [ ] Is every new endpoint either explicitly public-listed or behind the auth middleware boundary? (AUTH-203)
- [ ] Do all permission and authorisation checks go through the permissions service via `check`, never hand-rolled? (AUTH-204, AUTH-207)
- [ ] Is tenant scoping applied at the query layer, with the active organisation read from the session and never from request input? (AUTH-208, AUTH-209)
- [ ] Does any client-supplied identifier function as the authorisation actor, instead of the session-resolved one? (SEC-205 — must be **no**)

## Security

- [ ] Are secrets typed as `Redacted<T>` end-to-end and only unwrapped at the call site that hands them to the underlying library? (SEC-200)
- [ ] Is external input parsed through Effect Schema (no manual `if`-validation, no `as` casts on untrusted data)? (SEC-202)
- [ ] Is every SQL statement parameterised — no string interpolation, no template-built queries? (SEC-203 — must be **yes**)
- [ ] Do error responses leak any internal detail — stack traces, internal IDs, infra hints — beyond what the envelope sanctions? (SEC-206 — must be **no**)

## Database

- [ ] Do all queries and transactions go through the `Database` service tag, not a direct driver handle? (DB-200, ARCH-215)
- [ ] Are new invariants encoded as database constraints (NOT NULL, FK, unique, check) where the database can enforce them — not just in application code? (DB-202)
- [ ] Do new tables have a co-located Effect Schema with the compile-time alignment assertion, and use the project's Postgres dialect for column types? (DB-206, DB-217)
- [ ] Are any new migrations forward-only? (DB-204)

## Telemetry

- [ ] Does every new service function have a span whose operation name exactly matches the function name, dot-separated and lowercase? (TEL-204, TEL-205)
- [ ] Has each log level been used where it applies — **debug** at boundary points (service-function entry with id-only params, decision outcomes, external-provider call sites, retry attempts), **info** for every significant lifecycle event (one per logical event, past tense), **warning** for domain errors and recoverable/suspicious paths, **error** for request- or job-level system failures, **fatal** only when the process is about to exit — rather than skimping on debug/info and only logging when something goes wrong? (TEL-211)
- [ ] Are errors logged at the handling boundary (response middleware), not at the throw site? (TEL-213)
- [ ] Are log bodies constant event-name strings, with variable data in attributes — and free of PII or secrets in the clear? (TEL-210, TEL-214)
- [ ] Are cross-cutting log bodies (resource CRUD, not-found, validation, forbidden, auth, infrastructure) imported from `LOG_EVENTS` in `@apollis/shared/constants`, and module-specific singleton bodies kept inline? (TEL-219)
- [ ] Do identity attributes on logs and spans use the explicit `actor.*` / `target.*` namespaces, and does the service annotate `target.*` only when it differs from actor? (TEL-220)
- [ ] Do new metrics declare units, follow OTel semantic conventions where one exists, and keep label cardinality bounded? (TEL-215, TEL-216, TEL-217)

## Analytics

- [ ] Do any analytics events emitted by this change represent user or domain success (or a deliberate product-signal failure), and not system faults? (ANA-200)

## Testing

- [ ] Is each new service function covered by a service test, with helpers/validators covered by unit tests, and through-the-wire behaviour covered by e2e? (TEST-201, TEST-202)
- [ ] Do tests assert externally observable behaviour rather than implementation detail, and would they still pass under a sensible refactor? (TEST-205, TEST-215)
- [ ] Are the new tests deterministic and isolated — no order dependency, no shared mutable state, no real-clock or real-network flake? (TEST-218, TEST-219)

## Language

- [ ] Does all new English-language text — code, comments, logs, errors, docs, copy — use South African (British) English spelling? (CORE-200)
