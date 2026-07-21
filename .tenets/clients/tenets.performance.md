# Performance tenets — clients

Governance for the coding disciplines that produce light, fast clients. Performance is the cumulative outcome of many small decisions made at the keyboard — what to import, what to defer, what to render eagerly, what to reserve space for — and this file names the disciplines we hold ourselves to so the outcome is good by default. A runtime threshold is not a tenet because it cannot be applied in a diff; the disciplines below can.

---

## CPERF-200. Client code is written to be light to download and fast to render.

Every change to a client is written so the client stays light to download and fast to render — not retroactively after the Lighthouse gate fails (CTEST-200), not in a follow-up sprint, but at the moment the diff is authored. The disciplines below are the concrete shape of that intent; a reviewer can cite this tenet against any diff that violates one of them.

**Audit dependencies before adding them, not after the bundle grows.** Check the transferred weight of a candidate library (`bundlephobia`, the bundler's analyser, or an equivalent) before importing it. A 4 KB alternative that solves the same problem is the right answer when one exists; a 90 KB library that solves it with one more abstraction layer is not. The path that produces 500 KB bundles starts with "we'll trim later".

**Serve images the user can actually use.** Modern formats (AVIF, WebP, with appropriate fallbacks), responsive `srcset` and `sizes`, no 4K hero shipped to a phone. A single oversized image is the most common cause of a heavy page.

**Subset and preload fonts; avoid swap-induced reflow.** Ship only the glyph ranges actually rendered. Preload critical fonts. Use `font-display: optional` or fallback-metrics matching so a late-arriving webfont does not reflow the heading the user was already reading.

**Defer non-critical work past first paint.** `loading="lazy"` on offscreen images, `defer` or `async` on non-critical scripts, idle-time scheduling for heavy work that does not need to block the user. Long main-thread tasks are broken up; computation that does not need the DOM goes to a Web Worker.

**Load third-party scripts non-blockingly.** Analytics, chat widgets, marketing pixels load `async` or `defer` — never synchronously in `<head>`. Self-host where the third party allows it; a third-party CDN outage on the critical path is one you wear.

These disciplines are the tenet. The Lighthouse budgets are how we notice when we have failed at them.
