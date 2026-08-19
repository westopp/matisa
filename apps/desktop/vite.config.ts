import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// @matisa/core is consumed as TypeScript source (it has no build step) — Vite
// resolves its NodeNext-style `./x.js` specifiers back to `.ts` on its own.
// The alias is only needed because the package `main` points at a .ts file.
export default defineConfig({
  // Relative asset URLs: the same build is served by vite preview AND loaded
  // via file:// inside the Electron shell, where absolute /assets paths would
  // resolve to the filesystem root.
  base: "./",
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@matisa/core": fileURLToPath(new URL("../../packages/core/src/core.index.ts", import.meta.url)),
      "~": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendors out of the entry chunk so the
        // first paint does not wait on the form builder or the terminal
        // emulator, and so an app-code change does not invalidate them (CPERF-200).
        manualChunks: {
          react: ["react", "react-dom", "@tanstack/react-router"],
          effect: ["effect"],
          xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links"],
          pgform: ["@westopp/pgform"]
        }
      }
    }
  },
  server: {
    port: 6110,
    strictPort: true,
    // 127.0.0.1 explicitly, not the `localhost` default: on a machine where
    // localhost resolves to ::1 first, Vite binds [::1] ONLY — and matisa's
    // Caddy proxies its stable URL to 127.0.0.1, so http://matisa.localhost
    // answers 502 while http://localhost:6110 works. Browsers and Electron try
    // both families, so nothing else here notices the difference.
    host: "127.0.0.1"
  }
})
