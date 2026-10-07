import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { batchSpec, batchImports } from "./index.js";
import { batchManifest } from "./manifest.js";
import { batchReachability } from "./reachability.js";

export const batchMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: batchReachability,
  ...batchManifest,
  regexSpec: batchSpec,
  // Scripts run by path are imports (`executes`); the spec has no hook for them.
  preprocess: (rawSource) => ({
    sourceText: rawSource,
    language: "batch",
    postExtract(analysis) {
      analysis.imports = batchImports(rawSource.split(/\r?\n/));
    },
  }),
};
