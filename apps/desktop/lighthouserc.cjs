// Lighthouse quality gate (CTEST-200).
//
// Runs against the PRODUCTION build served by `vite preview`, in real headless
// Chrome, on the mobile preset with simulated throttling, three times per route
// taking the median. Assertions are blocking — a non-blocking gate says
// performance is not a release criterion, and the build ships the regression.
//
// Route list: the surface a real user reaches in the first sixty seconds. The
// engine is not running in CI, so both routes render their disconnected state —
// which is exactly the first paint a user gets before the socket opens, and the
// one whose weight we are gating.
//
// The numeric budgets below are the measurement contract, not a tenet; the
// coding decisions that produce them are governed by tenets.performance.md.

module.exports = {
  ci: {
    collect: {
      startServerCommand: "pnpm vite preview --port 4321 --strictPort",
      startServerReadyPattern: "Local:",
      url: ["http://localhost:4321/", "http://localhost:4321/project/none"],
      numberOfRuns: 3,
      settings: {
        // No `preset`: Lighthouse's default IS the mobile profile. Naming the
        // desktop preset here would hide exactly the regressions this gate is
        // for, so the mobile emulation below is stated explicitly instead.
        formFactor: "mobile",
        throttlingMethod: "simulate",
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false
        },
        // The app is a local-only tool served over http from a loopback engine;
        // an installable-PWA score is not a product concern here.
        onlyCategories: ["performance", "accessibility", "best-practices"]
      }
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "total-blocking-time": ["error", { maxNumericValue: 300 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "resource-summary:script:size": ["error", { maxNumericValue: 400000 }],
        "resource-summary:total:size": ["error", { maxNumericValue: 700000 }],
        "unused-javascript": ["warn", { maxLength: 1 }]
      }
    },
    upload: { target: "temporary-public-storage" }
  }
}
