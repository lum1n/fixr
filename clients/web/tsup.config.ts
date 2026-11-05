import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    external: ["html-to-image"],
  },
  {
    // <script src=".../fixr.global.js"> → window.Fixr. A script tag cannot resolve the bare
    // `import("html-to-image")`, so this build inlines html-to-image as a lazily initialised
    // chunk; the ESM build keeps it an optional peer loaded with a dynamic import.
    entry: { fixr: "src/index.ts" },
    format: ["iife"],
    globalName: "Fixr",
    minify: true,
    sourcemap: true,
    target: "es2020",
    noExternal: ["html-to-image"],
  },
]);
