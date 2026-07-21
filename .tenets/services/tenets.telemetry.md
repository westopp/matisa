# Telemetry tenets

This file governs the operational telemetry surface — traces, logs, and metrics — emitted by services in this repository. Analytics tenets — the producer-side discipline for what gets emitted to the analytics warehouse — live in [tenets.analytics.md](./tenets.analytics.md); see TEL-202 for the dividing line between the two surfaces.

Tenets are stable, prescriptive commitments. IDs are stable references — code review, PR descriptions, and incident postmortems can cite them. Numbers are not hierarchical; they are identifiers.

---

## Pipeline integrity

### TEL-200. One pipeline, no side channels.

All telemetry — traces, logs, metrics — flows through the OpenTelemetry-instrumented Effect runtime. No `console.log`, no ad-hoc HTTP calls to dashboards, no parallel logging libraries, no direct writes to stdout that bypass Effect's logger. If a signal is not in the pipeline, it does not exist for ops; a hotfix that reaches for `console.log` to "see what's happening" produces data that is invisible the moment the incident is over and breaks every downstream guarantee — correlation, structure, retention, redaction.

### TEL-201. Don't redundantly instrument; do enrich with intent.

HTTP middleware, RPC middleware, and the `Database` tag already emit spans, metrics, and logs for their layer; don't re-emit a counter for HTTP status codes, don't duplicate the access log inside a handler, don't wrap a single framework-emitted span just to rename it. Do add custom spans when the framework span lacks business intent — a parent span for a reconciliation batch, a workflow span enclosing several `db.query` children, a decision-point span that explains *why* a sequence of operations happened. The line is duplication versus enrichment: a custom span that adds business meaning the framework can't know about is welcome; one that mirrors a framework emission with no new information is noise that produces duplicated waterfalls in Tempo and double-counted metrics in Prometheus, both of which corrode trust in the dashboards.

### TEL-202. OTel carries operational signals only.

Operational signals — request rate, latency, error rate, resource saturation, internal queue depth — belong in OTel. Product questions ("how many todos did this organisation create this month?") and per-entity drill-down are out of scope for OTel and live in the analytics platform. The dividing line is cardinality and aggregation shape: operational metrics aggregate over low-cardinality dimensions, product metrics drill into individual entities. When in doubt, ask "is this a graph the on-call watches?" — if yes, OTel; if no, analytics.

---

## Spans

### TEL-203. The span tree mirrors the request call stack.

Every request produces nested spans in order: `possible-propagated-client → service-root (HTTP/RPC middleware) → handler → service → db`. Each layer is responsible for its own span; no layer skips itself or claims another's. The trace waterfall in Tempo is the on-call runbook.

### TEL-204. Span names are dot-separated, lowercase, no spaces.

Pattern is `{layer}.{module}.{operation}`. Spaces in span names are forbidden — they don't help search and they hurt readability and tooling integration. Framework-emitted root spans (`HTTP GET /api/todos`, `RPC TodoRpcs.GetTodo`) are exempt because their format is set by the framework.

### TEL-205. The service span operation matches the service-function name exactly.

If the service function is `createTodo`, the span is `service.todos.createTodo`. Greppability is the point — searching for the function name surfaces the trace. Renaming a service function renames the span; downstream consumers of that span name are not this server's concern.

### TEL-206. DB transactions are span parents; queries inside them are children.

Every `db.query.{module}.{op}` issued inside a transaction is a child of the enclosing `db.transaction.{module}.{op}` span. Query spans carry their own duration; the transaction span carries total time including commit/rollback. Rollback failures are visible at the transaction-span level with the offending query as a child.

### TEL-207. Spans carry the full operation context.

Service-function spans annotate their inputs, the resource(s) acted upon, and operation-relevant business tags as structured attributes, subject to the `Redacted<T>` discipline of TEL-214. The trace is the source of truth for *what the operation was*; logs reference it via `trace_id` and `span_id` and carry only the event and identifiers — context is not lost, it is relocated to its proper home, which is what makes the minimal-log discipline of TEL-210 viable. A `createTodo` span carries the full input; the corresponding log line says "Todo created" with `todo.id`.

### TEL-208. Errors annotate the span and propagate to span status correctly.

Typed errors set `error.type` on the active span. HTTP 5xx and RPC infrastructure failures set span status to `Error`. Domain errors (`NotFoundError`, `ValidationError`, `Forbidden`) leave span status `Unset` — they are correct outcomes, not pipeline failures, and marking them as errors poisons error-rate dashboards. `Unset` (not `Ok`) is the correct default per the OTel spec: `Ok` is reserved for explicit developer assertion of success and, once set, must not be overridden by libraries.

---

## Logs

### TEL-209. Logs are structured as three attribute layers — resource, request-scope, operation-scope.

**Resource attributes** (`service.name`, `service.version`, `deployment.environment`) are set once on the OTLP exporter. Call sites never touch them.

**Request-scope attributes** are set once by middleware and inherited by every log inside the request:

- *Identity* — `user.id`, `session.id`, `organisation.id`, attached to the active root span and to every log line emitted inside the request scope once auth resolves. "Find all requests for user X" is the most common Tempo/Loki query and it must be one filter, not a join.
- *Request id* — middleware generates `request.id`, annotates it on the root span, attaches it to every log in scope, and returns it as `X-Request-Id` (REST) or equivalent metadata (RPC). The user can quote the id in a bug report; you can grep it across logs, traces, and metrics.
- *Trace correlation* — every log line emitted inside an active span carries `trace_id` and `span_id`. Without this, Grafana's log↔trace linkage breaks and observability degrades to two parallel silos.

**Operation-scope attributes** (`todo.id`, `error.type`, validation field, anything specific to *this* log line) are set at the call site. A call site never re-annotates identity or request context — those come for free from the request scope; if you find yourself adding `user.id` to a log line, the middleware isn't doing its job, and the fix is in the middleware, not at every call site.

### TEL-210. Log bodies are constant event names; variable data lives in attributes.

The body is a short past-tense noun phrase ("Todo created", "Database error", "Request completed") with no string interpolation and no `[Module]` prefixes; variable values are attached via `Effect.annotateLogs(...)`. This is what makes a log line groupable, aggregatable, and queryable. What goes in operation-scope attributes depends on level (TEL-211).

### TEL-211. Severity reflects system state, not domain outcome; payload context follows level.

Levels are **debug / info / warning / error / fatal** with fixed meanings. Severity describes the health of the system, not the success of a domain operation. The local vocabulary tracks Effect's logger; at the OTel exporter, `Warning` maps to `WARN` and the rest map identically — alignment happens at the wire, not in our prose.

- **debug** — diagnostic detail; off in prod by default. Pre-configured at boundary points: service-function entry with id-only params, decision outcomes ("policy: allowed because owner"), external-provider call about to fire, retry attempt n of m. Not pre-configured inside business logic; ad-hoc additions during active development are removed before merge. Full operation payload is fine here — debug is on deliberately and volume is acceptable.
- **info** — significant lifecycle events, one per logical event, past tense. "Todo created", "User signed in", "Server started", "Migration applied". Operation-scope attributes carry identifiers and the event-defining fields, not full payloads — the full payload lives on the span (TEL-207). If you are emitting more than one info log per request on the happy path, you have drifted into debug territory.
- **warning** — recoverable and suspicious. Domain errors (`NotFoundError`, `ValidationError`, `Forbidden`) are warning at most; they are correct outcomes of bad input, not system failures, and logging them as `error` poisons error-rate alerting. Also: retry succeeded after failure, rate limit exceeded, deprecated endpoint hit, fallback path taken. Operation-scope attributes name the disambiguator (`validation.field`, `retry.attempt`), not the whole payload.
- **error** — request- or job-level system failure. DB unreachable, external provider hard-failed with no degrade, unexpected exception in handler, partial migration. Always carries the full `Cause` so the OTLP exporter maps it into structured `exception.type` / `exception.message` / `exception.stacktrace` fields rather than a flat string. Operation-scope attributes carry enough payload context to triage without leaving Loki — Loki-first is the on-call reflex.
- **fatal** — process-terminating only. Failed to bind port, can't acquire DB pool at boot, unrecoverable config, OOM. After this log, the process exits. If you are not exiting, it is not fatal. (This is a Apollis-specific tightening; OTel's `FATAL` severity does not itself require process termination — we narrow it on purpose so that fatal-level alerts always correspond to a restart event.)

Carrying the `Cause` looks like:

```ts
Effect.catchTag("DatabaseError", (cause) =>
  Effect.logError("Todo creation failed", cause).pipe(
    Effect.annotateLogs({ "todo.id": id, "operation": "createTodo" })
  )
)
```

The `Cause` carries failure shape — typed error, defects, parallel and sequential composition, interrupts — which a stringified message would flatten into noise.

### TEL-212. Logs complement spans; they do not duplicate the trace.

One log per logical event, not one per step. Per-step detail belongs in **span events** on the active span, not in additional log lines. Operation context belongs on the span (TEL-207). Log attributes describe what is specific to *this log line*; identity and request context come from request-scope (TEL-209), so they don't need re-annotating per call site.

### TEL-213. Errors are logged at the handling boundary, not the throw site.

Tagged errors flowing through the error channel are the contract; logging at every `Effect.catchTag` rung produces noise — the same failure recorded N times in N different shapes. Log once, at the boundary that decides the user-visible outcome (REST handler, RPC handler, background-job runner), with the full `Cause`, error tag, and operation-scope attributes. Intermediate `catchTag` rungs that recover (translate one error into another, fall back to a default, retry) do their work silently; the final outcome is the only event worth logging.

### TEL-214. PII and secrets never appear in logs in the clear.

IPs are hashed at the boundary. Emails, phone numbers, names, tokens, session cookies, and request/response bodies are never logged raw; sensitive values use `Redacted<T>` types so they cannot be accidentally stringified, and when debugging needs a user, log `user.id` and join via the database rather than logging identifying values. This applies equally to span attributes and metric labels — `Redacted<T>` is the type-level enforcement that makes the broader operation-context discipline of TEL-207 safe; without it, the "spans hold the full payload" position becomes a leakage risk.

---

## Attributes & metrics

### TEL-215. Attributes follow OTel semantic conventions where one exists; custom attributes are namespaced.

HTTP attributes use `http.request.method`, `http.response.status_code`, `url.path`, `http.route`. Custom attributes are namespaced: `todo.id`, `user.id`, `organisation.id`. Bare keys (`method`, `status_code`, `id`) are forbidden everywhere — span attributes, log fields, and metric labels alike.

### TEL-216. Metric label cardinality is bounded and pre-declared.

High-cardinality dimensions never appear as Prometheus labels. Obvious offenders — `user.id`, `organisation.id`, `todo.id`, `request.id`, raw URL paths — are easy to catch. The footguns that slip past review are the ones that *look* bounded:

- **`error.message`** — free-text strings reach unbounded cardinality the moment any variable detail (id, path, value) ends up in the message. Use `error.type` (the tagged-error name) as the label and put the message on the log/span.
- **User-agent strings** — thousands of variants in the wild, including bots and scrapers that mutate per request. If you need browser breakdowns, parse to a coarse family at the boundary and label that.
- **Raw query strings or request bodies** — by definition contain user input.

Route labels are normalised (`/todos/:id`, not `/todos/abc-123`). Per-entity questions go to the analytics platform (TEL-202), not to metrics. This tenet is the load-bearing one for keeping the metrics bill reasonable.

### TEL-217. Metric instruments declare their unit.

Every instrument declares its unit per UCUM (`s`, `ms`, `By`, `%`, `1`). Histograms in particular use `s` for HTTP latency, per OTel HTTP semantic conventions; sizes use `By`. Mixing units silently is a query-level bug — a dashboard built against seconds reads milliseconds as 1000× over budget, with no error to flag the mismatch. The unit is part of the instrument's contract; changing it is a breaking change to dashboards and alerting.

### TEL-218. Choose the metric instrument that matches the observable.

OTel offers four instrument types; each models a different shape of observable. The choice is not stylistic — it is the difference between a dashboard that means what it shows and one that quietly misleads.

- **Counter** — monotonically increasing tally. Fits things that only go up: requests served, errors observed, jobs completed, bytes written. The meaningful query is the rate (`rate(name[5m])`), not the absolute value.
- **UpDownCounter** — value maintained by `add(+1)` / `add(-1)`. Fits things tracked by deltas: items in a queue, active connections, in-flight requests.
- **Histogram** — distribution of observations. Fits latency, payload size, batch size — anywhere percentiles matter. Default OTel SDK buckets are tuned for seconds-scale latency; for any other range (microseconds, kilobytes, 0–100 percentages), declare explicit bucket boundaries at instrument creation, otherwise every observation lands in the same bucket and your p99 is meaningless.
- **Gauge** (observable / async) — point-in-time value, observed rather than maintained. Fits memory usage, configured pool size, queue depth at observation time, build version.

Common mistakes the tenet rules out: Counter for in-flight values (the graph rises forever because the counter cannot decrement); Histogram with default buckets for non-second-scale data (every observation in one bucket, quantiles meaningless); UpDownCounter when you only observe the current value rather than tracking deltas (drift and double-counting on restart).

---

## Vocabulary and conventions

### TEL-219. Cross-cutting log bodies are constants from shared; module-specific bodies are inline.

Log bodies that recur across modules — `Resource not found`, `Database error`, `Validation failed`, `Forbidden`, `Authentication failed`, the resource-CRUD lifecycle (`Resource created/updated/deleted`), and the like — are exported as named constants from `@apollis/shared/constants/shared.log-events.constants.ts` (the `LOG_EVENTS` object) and imported at every call site, so that a single logical event has a single string across the codebase and Loki indexes it as one entry. Module-specific lifecycle bodies that happen at exactly one site in the whole codebase — `Server started`, `Migration applied`, `BetterAuth initialised` — stay inline at their call site because there is no drift risk by construction (one site, one string), and lifting them to shared adds overhead without preventing a bug. The split is the load-bearing decision: forcing every body into the constants file produces a junk drawer of single-use strings; leaving every body inline produces the fragmented-index bug class TEL-210 closes. When in doubt, ask "could a future module emit this same logical event?" — if yes, constant; if no, inline. The variable specifics that the body would otherwise interpolate (`"Todo not found"`, `"User not found"`) live in attributes (`resource.type: "Todo"`) per TEL-210, so the body stays groupable while drill-down stays one filter away.

### TEL-220. Identity attributes distinguish actor from target.

Identity attributes on logs and spans use explicit `actor.*` and `target.*` namespaces. **Actor** is the entity making the request — read from the resolved session, set once on every request by the auth middleware (TEL-209) onto request-scope. **Target** is the entity being acted upon — read from path or body parameters, annotated by the service only when target ≠ actor; the ownership-collapsed case (a user acting on their own resource) needs no service-side target annotation because actor identity already covers it. Bare `user.id` and `organisation.id` are forbidden in this context because they hide the asymmetry: a log line `user.id=A user.id=B` is malformed; `actor.user.id=A target.user.id=B` is unambiguous and dispatchable in queries. The bug class closed: admin-on-behalf-of audit confusion — a log line that records "user X performed action Y" without distinguishing whether X was the caller or the affected party, leading to incorrect attribution in incident reviews and broken audit trails. Cross-references: SEC-205 owns the rule that actor identity is read from the session, never from request input; this tenet owns the attribute-naming convention that makes the actor/target distinction visible in observability data.

---

## Cross-references

- **TEST-208** — telemetry emission is the framework's responsibility; per-module unit and service tests assert behaviour, not the presence of spans, logs, or metrics.
- **TEST-217** — the observability pipeline is verified by a manual, human-driven smoke test, not automated assertions. The pipeline is the runbook; if it produces noise no one reads, it is functionally broken.
