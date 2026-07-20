import { Layer, Metric } from "effect"

// Effect Metric registry. Counters are module-global values usable from any
// Effect; no layer wiring is required to increment them. The layer exists so the
// composition root can provide a metrics backend later without touching callers.

export const spawnsTotal = Metric.counter("matisa_spawns_total")
export const restartsTotal = Metric.counter("matisa_restarts_total")
export const crashesTotal = Metric.counter("matisa_crashes_total")
export const eventsEmittedTotal = Metric.counter("matisa_events_emitted_total")
export const activePtySessions = Metric.counter("matisa_pty_sessions_active")

// No external metrics exporter is wired yet — counters aggregate in-process.
export const MetricsLive = Layer.empty
