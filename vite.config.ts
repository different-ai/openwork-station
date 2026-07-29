import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The surface bundle: a sandboxed renderer loaded over `openwork-app://`.
//
// Rooted at the surface directory so the emitted HTML lands at
// `dist/station/index.html`, which is exactly the path `openwork.app.json`
// declares. A build whose output does not match the manifest is a package that
// only fails on someone else's machine.
//
// Everything is inlined or emitted into the bundle. An OpenWork App package is
// a closed file list with per-file hashes, so nothing may be fetched at runtime
// that was not in the archive: no CDN, no remote font, no dynamic import by URL.
export default defineConfig({
  root: resolve(__dirname, "src/surfaces/station"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/station"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
    assetsInlineLimit: 16384,
    cssCodeSplit: false,
    sourcemap: false,
    minify: "esbuild",
  },
})
