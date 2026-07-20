import { Layer } from "effect"

// Tracing is a thin stub for now: no span exporter is attached, so
// annotateCurrentSpan calls across services no-op through the default tracer.
// Swap this for an OTLP layer to light up end-to-end lifecycle traces.
export const TracingLive = Layer.empty
