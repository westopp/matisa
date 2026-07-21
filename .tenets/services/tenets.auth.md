# Authentication tenets

This file governs authentication, authorisation, multi-tenancy, credentials, second factors, OAuth flows, and the lifecycle of all of the above. Cross-cutting security concerns — secrets discipline, transport, headers, dependency hygiene, the strict prohibition on rolling our own crypto — live in [tenets.security.md](./tenets.security.md). Logging-side PII discipline lives in TEL-214. This file references both rather than restating them.

The architectural commitment underpinning every tenet that follows: **the permissions service and its registry are the only place in this codebase where authorisation decisions are made.** Every other module — handlers, services, middleware, helpers — delegates. The tenets here elaborate that commitment and the disciplines that surround it.

Tenets are stable, prescriptive commitments. IDs are stable references — code review, PR descriptions, and incident postmortems can cite them. Numbers are not hierarchical; they are identifiers.

---

## Authentication boundary

### AUTH-200. Better-auth is the single authentication implementation.

There is one authentication implementation in this codebase: better-auth, configured in [auth.config.ts](services/server/src/modules/auth/auth.config.ts). No parallel session-cookie management, no hand-rolled password verification, no sibling token issuance, no parallel OAuth client. Where better-auth's primitives do not fit a need, the response is to extend its plugin surface — not to ship a second implementation. The bug class this closes: two divergent definitions of "authenticated" growing apart at the seams as features ship.

### AUTH-201. Authentication happens at the middleware boundary, once per request.

The auth middleware resolves the session once per request, attaches it to the request scope, and exposes it to handlers and services. Handlers do not call `auth.api.getSession` themselves. Service functions do not re-resolve sessions or re-verify credentials. One resolution site, audited once, trusted everywhere downstream.

### AUTH-202. Layers downstream of the auth boundary trust that authentication and authorisation have been resolved.

A handler, service, or helper that runs after the auth boundary trusts that the resolution of identity and entitlement has already happened. It does not re-authenticate, does not re-resolve sessions, does not second-guess the actor identity it has been given. The work of establishing identity and entitlement happens once, upstream, and downstream operates on that assumption. If a layer is reachable from a path that has not done that work, the path is the bug, not the layer.

### AUTH-203. Permission-protected actions require a resolved session; public surfaces are explicitly enumerated.

Every action gated by a permission check has a resolved session as its prerequisite — the gate cannot run without an identity to evaluate against. This is the load-bearing prerequisite for every authorisation tenet that follows: when the gate runs, there is always something for `permissions` to ask the question *of*.

Public surfaces — paths that legitimately run without a session — are a closed, enumerated set, not an open category. The sanctioned categories are: pre-session credential surfaces (sign-up, sign-in, forgot-password, password-reset acceptance, OAuth initiation and callback, magic-link and OTP verification), operational endpoints (liveness and readiness probes), and any inbound webhook receivers that authenticate via signature rather than session. The current sanctioned list lives in [auth.config.ts](services/server/src/modules/auth/auth.config.ts) and the middleware mount points in [app.ts](services/server/src/server/app.ts); both are reviewed together.

Adding a new public surface is an architectural decision, not a routing detail. It requires explicit addition to the enumerated set, a documented justification for why a session cannot be required, and review against AUTH-210 (no enumeration leakage) and AUTH-212 (any token surface it produces is short-lived, single-use, and rate-limited). A handler that quietly omits the auth middleware is a tenet violation regardless of how innocuous the path appears.

---

## Permissions and authorisation

### AUTH-204. All permission and authorisation checks go through the permissions service.

No module — handler, service, middleware, helper, anywhere — implements an authorisation rule of its own. The permissions service and its registry ([permissions.services.ts](services/server/src/modules/permissions/permissions.services.ts), [permissions.registry.ts](services/server/src/modules/permissions/permissions.registry.ts)) are the only place authorisation decisions are made; every other module delegates. An `if (resource.ownerId !== principal.id) throw new ForbiddenError(...)` line outside the permissions service is a tenet violation regardless of the file it lives in or the value it returns. Centralising authorisation logic in one module is what makes the rest of these tenets enforceable; without it, the rules drift and the "single source of truth" claim hollows out within a quarter.

### AUTH-205. The permissions catalog is the single authority for grants.

The `PERMISSIONS` registry in [permissions.registry.ts](services/server/src/modules/permissions/permissions.registry.ts) is the only source of truth for what is checkable. `PermissionKey` — the literal-union type derived from the registry — is the typed handle every call site uses. No string-keyed role comparisons (`session.user.role === "admin"`, `member.role === "owner"`) appear at any call site; the role-to-permission resolution is the responsibility of the permissions service and the better-auth `customSession` plugin. Adding a permission means editing the registry; everything else flows from there at compile time.

### AUTH-206. Each layer asks the authorisation question its context allows.

Handlers ask **grant** questions — does this caller hold permission `X` in principle? — because they have the session but not the resource data. Services ask **qualification** questions — does this caller substantively qualify to perform this action against this specific resource (membership, ownership, role authority, lifecycle state)? — because they have the data the relevant `check` callback needs. Both questions are required for an action to proceed; neither layer covers the other. Handlers do not attempt qualification questions because they lack the data context; services do not attempt grant questions because they lack the catalog scope.

In this codebase, grant questions are asked via `permissions.hasPermission` / `permissions.requirePermission`; qualification questions via `permissions.can` / `permissions.requireCan`. The handler-side grant check is structurally enforced by the [handler-coverage semtest](services/server/src/modules/permissions/__tests__.permissions/__semtests__.permissions/handler-coverage.test.md); the service-side qualification check is covered by per-service-function error-channel tests under TEST-208.

### AUTH-207. `check` is the central validation primitive; all substantive authorisation logic lives there.

Every permission validation — simple ownership, multi-join role-authority comparisons, lifecycle state predicates, anything else — is expressed as a `check` callback registered against an entry in [permissions.registry.ts](services/server/src/modules/permissions/permissions.registry.ts). `check` does not fetch its own data; it receives all required information as parameters and asserts whether the caller's conditions match the required conditions. Callers assemble the data the relevant `check` needs (the registry documents the shape per entry) and pass it through `can` / `requireCan`. The permissions service plus its registry and repository are the central source of truth for all things permissions; nothing else encodes an authorisation rule.

The `can` / `requireCan` signatures are typed end-to-end: the registry's `PermissionCheck<Args>` shape, combined with a `PermissionKey`-parametric overload, makes "wrong-shaped argument for this permission" a compile error. Passing the wrong data to a `check` is not a runtime concern — the type system rules it out.

### AUTH-218. Permission checks are pure functions.

A `check` callback is a pure function: it receives every value it needs as a parameter, performs validation and comparison logic against those values, and returns a decision. It does not call services, does not query the database, does not read from external systems, does not consume Effect Layers, and has no I/O of any kind. Acquiring the data a check needs — fetching the resource, joining the membership row, resolving the lifecycle state — is the caller's responsibility; the check evaluates, the caller supplies. Purity is what makes every permission decision deterministically testable from a fixed set of inputs, keeps authorisation logic free of I/O failure modes, and stops `check` from becoming a back door through which incidental side effects accumulate inside the registry.

---

## Multi-tenancy

### AUTH-208. Tenant scoping happens at the query layer, not the application layer.

Every query against tenant-scoped data carries the `organisation_id` as a query-level constraint composed inside the data access function — not "fetched broadly then filtered in application code afterwards". Application-layer filtering is a structural BOLA waiting to be forgotten on the next refactor; query-layer scoping is the deterministic guarantee. The authorisation question is "may this caller see *anything* in this org?" (AUTH-206); the data question is "what rows in this org should be returned?". Both happen, but the row-set is bounded at the query layer.

### AUTH-209. The active organisation lives in the session, not in request input.

Switching the active organisation is a deliberate, audited action that re-resolves the session and rebinds the active-org claim ([organisations.services.ts](services/server/src/modules/orgs/organisations/organisations.services.ts)). Handlers and services read the active org from the session; they never read it from a body field, query parameter, or header. The orgId-match middleware enforces that request-target organisation IDs equal the session's active organisation; the equivalence makes a check against the active org equivalent to a check against the request target. Pairs with SEC-205 — the session is the only acceptable source of actor identity, and the same is true of the active organisation the actor is acting through.

---

## Credentials

### AUTH-210. Authentication responses do not reveal whether an account exists.

Login, sign-up, forgot-password, OAuth-link, and account-recovery surfaces produce the same response shape and the same timing characteristics for "account exists" and "account does not exist". Email-existence enumeration is a free-form gift to credential-stuffing attackers; the rule closes it at the response shape and at the timing of the response. Better-auth's defaults handle most of this; the tenet's job is to forbid wrappers, custom error messages, and "improved error UX" that re-introduce enumeration through the back door.

### AUTH-211. Password policy is a single Effect Schema in `@repo/api/common`.

The password policy — length, complexity, character requirements — is a single branded Effect Schema (e.g. `Password`) defined alongside the other shared schemas in `@repo/api/common`. The frontend imports it for live form validation; the server consumes it via a better-auth `hooks.before` hook on sign-up, password-change, and password-reset endpoints, decoding the incoming password and rejecting on `ParseError`. Better-auth's own `minPasswordLength` / `maxPasswordLength` is either removed or kept as a defensive lower bound; the schema is the source of truth. There is exactly one place that defines what a valid password is, and it is consumed by both sides of the wire.

---

## Tokens and second factors

### AUTH-212. One-time secrets are short-lived, single-use, and rate-limited per identity.

OTP codes, magic-link tokens, invitation tokens, and password-reset tokens all have bounded TTL, are consumed atomically on first acceptance, and are subject to per-identity rate limiting on issuance and verification. The rule applies uniformly across better-auth's primitives and any token surfaces added on top. A token that is reusable, long-lived, or unbounded in issuance frequency is a tenet violation regardless of which surface produces it.

### AUTH-213. Second-factor enforcement is policy-driven; TOTP plus backup codes is the floor.

Whether a request requires a second factor is decided by a policy that maps roles, sensitive operations, and trust signals to a 2FA requirement — not by individual handlers checking `if (user.has2fa) ...`. TOTP and backup codes are always available as second-factor mechanisms; SMS-only 2FA is treated as a fallback, not a primary mechanism, given the known SIM-swap risk. Adding a sensitive operation to the 2FA-required set is a policy edit, not a handler edit.

---

## OAuth

### AUTH-214. OAuth flows enforce server-validated `state`.

Every outbound OAuth redirect generates a `state` value server-side, stored against the originating session, and single-use. The callback handler refuses any response whose `state` is missing, mismatched, or already consumed. This is the CSRF defence for OAuth — without it, an attacker can cause a victim's browser to complete an OAuth flow that links the attacker's account into the victim's session. Better-auth handles `state` by default; the tenet's job is to forbid any code path that disables, bypasses, or "reimplements" it.

### AUTH-215. OAuth post-flow redirects are validated against an allow-list.

The `returnTo` / `callbackURL` parameter that follows a successful OAuth flow is checked against a configured allow-list of paths or origins before a `Location` header is set. Open redirects on auth endpoints are particularly damaging because they make a phishing URL appear to originate from a trusted domain. The allow-list lives in typed config, is validated at boot, and is reviewed alongside any change to the OAuth surface.

### AUTH-216. Linking a new identity to an existing account requires fresh authentication.

A user who is already signed in cannot link a new OAuth provider on the strength of a passive session alone. Linking requires recent re-authentication — a recent password entry, a fresh OTP, or a 2FA challenge — within a short window. The bug class this closes: an attacker who has captured a stale session token can permanently bind their own identity into the victim's account, bypassing every future password reset.

---

## Lifecycle

### AUTH-217. Logout, revocation, and role changes invalidate server-side immediately.

Logging out clears the session record on the server, not just the client cookie. Revoking a session, removing a user from an organisation, or downgrading a role takes effect on the next request — not at the session's natural expiry. The session store is the source of truth; the cookie is a pointer into it. Better-auth's `customSession` plugin and the [SessionInvalidation service](services/server/src/modules/auth/auth.session-invalidation.ts) propagate role and permission changes; the tenet is that those propagations are mandatory, not best-effort.

---

## Cross-references

- **SEC-200** — auth secrets (better-auth signing keys, OAuth client secrets) are subject to the `Redacted<T>` discipline.
- **SEC-201** — password hashing, token generation, and signature primitives go through better-auth and Node `crypto`; never roll your own.
- **SEC-205** — the session is the only acceptable source of actor identity; this file's tenets assume it.
- **TEL-209** — request-scope log attributes (`user.id`, `session.id`, `organisation.id`) are populated by the auth middleware once per request.
- **TEL-214** — PII and secrets never appear in logs in the clear; all auth-handled values respect this.
- **TEST-208** — service-side qualification-check coverage (AUTH-206) relies on per-service-function error-channel tests under this tenet.
- **TEST-216** — auth middleware behaviour is tested in the dedicated middleware test surface, not per-module.
- **`handler-coverage.test.md`** — handler-side grant-check coverage (the structural enforcement of AUTH-206's grant-question side) lives at [`services/server/src/modules/permissions/__tests__.permissions/__semtests__.permissions/handler-coverage.test.md`](services/server/src/modules/permissions/__tests__.permissions/__semtests__.permissions/handler-coverage.test.md).
