import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

// @matisa/core is consumed as TypeScript source (it has no build step) — Vite
// resolves its NodeNext-style `./x.js` specifiers back to `.ts` on its own.
// The alias is only needed because the package `main` points at a .ts file.
export default defineConfig({
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
    strictPort: true
  }
})
