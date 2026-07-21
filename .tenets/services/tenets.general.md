# General service tenets

Cross-cutting commitments every service module honours regardless of its domain. When this file overlaps a topic file (`tenets.testing.md`, `tenets.security.md`, `tenets.telemetry.md`, `tenets.analytics.md`, `tenets.auth.md`, `tenets.db.md`, `tenets.system-architecture.md`), the more specific tenet wins.

---

## GEN-200. Schemas are defined once, in shared.

Every Effect Schema describing a value that crosses a module boundary — payloads, persisted records, queue messages, config, RPC inputs and outputs — is defined once in `packages/shared/src/schemas` (or its `@repo/api` counterpart for contract-shaped schemas) and imported by every consumer. Modules do not redefine, parallel-copy, or regenerate schemas that already exist in shared.

## GEN-201. TaggedErrors carry a `cause`; `stackError` is a response field, derived at the boundary.

Every `Data.TaggedError` carries a `cause` populated at the throw site, capturing the underlying failure. The `stackError` field that appears in HTTP error envelopes is derived from `cause` by the response middleware; it is not stored on the error type, because the error type does not know about the wire representation.

## GEN-202. Time is read through Effect's `DateTime` module.

Every date/time read, construction, parse, format, comparison, or duration calculation in service code goes through Effect's `DateTime` module, not `Date.now()`, `new Date()`, `Date.parse(...)`, or `Date.prototype` arithmetic. Adapter code interfacing with libraries that require a platform `Date` may construct one at the call site, but the value crossing into or out of service code is `DateTime`.

## GEN-203. Repeated cross-cutting constants live in `shared/constants`.

Any constant value used in more than one file, domain, package, or app — HTTP statuses, header names, retry budgets, timeout defaults, content types, well-known URLs — is defined once in `packages/shared/src/constants` and imported by every consumer. Truly module-local magic numbers, meaningful only inside one file's logic, stay where they are.

## GEN-204. Common utilities, error codes, types, and enums live in `shared/`.

Cross-domain helpers — utilities, validation primitives, ID brands, error-code identifiers, shared enums, shared types not derived from a local schema — are defined in `packages/shared/` and imported by every consumer. The dependency direction is one-way (`module → shared`, never `module → module`); new shared concerns are added to `shared/`, not to the first module that happens to need them.
