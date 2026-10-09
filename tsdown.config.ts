import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    // Worker-thread entry: spawned via new URL("./analyze-worker.js", import.meta.url),
    // so it must exist as its own file at the dist root.
    "analyze-worker": "src/core/analyze-worker.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  // Keep `.js` (tsdown defaults to `.mjs`): package.json main/bin, the worker
  // URL above and the VS Code extension's bundle script all name dist/*.js.
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  // Grammar packages load their .wasm relative to their own install directory,
  // so they must stay real imports rather than be inlined.
  deps: { neverBundle: [/^web-tree-sitter/, /^tree-sitter-/] },
  // Shebang on the JS chunks only; a plain string would land in the .d.ts too.
  outputOptions: {
    banner: (chunk) => (chunk.fileName.endsWith(".d.ts") ? "" : "#!/usr/bin/env node"),
  },
  // Mirror the committed standalone-viewer template into dist/ (same relative
  // subpath as in src/) so html-report.ts resolves it via import.meta.url in
  // both the source (vitest) and bundled layouts.
  onSuccess: "node scripts/copy-viewer-asset.mjs",
});
