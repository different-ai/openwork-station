import { resolve } from "node:path"
import { defineConfig } from "vite"

// The background bundle.
//
// A library build rather than an app build: there is no HTML and no DOM. The
// host loads `dist/background.js` as a module and calls its exported
// `activate`, so the entry must keep that export rather than being tree-shaken
// down to nothing.
export default defineConfig({
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    target: "es2022",
    lib: {
      entry: resolve(__dirname, "src/background/index.ts"),
      formats: ["es"],
      fileName: () => "background.js",
    },
    sourcemap: false,
    minify: "esbuild",
  },
})
