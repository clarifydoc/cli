import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { conventionReachability } from "../shared/reachability-kit.js";
import { autoitSpec, blankAu3Comments, tidySetup } from "./index.js";
import { autoitManifest } from "./manifest.js";

export const autoitMeta: LanguagePluginMeta = {
  // A script is run (or compiled) by itself, an included file by its script:
  // every file is kept alive, none is reported dead.
  reachability: conventionReachability({
    extensions: [".au3"],
    importPath: (source) => (/^\.{1,2}\//.test(source) ? source : null),
    names: { functions: true, stem: true },
    caseInsensitive: true,
    passiveFiles: [[/\.au3$/i, "AutoIt script (run by AutoIt, or #include-d)"]],
  }),
  ...autoitManifest,
  // `#cs … #ce` comment blocks are prose, never code.
  preprocess(rawSource) {
    return {
      sourceText: blankAu3Comments(rawSource) ?? rawSource,
      language: "autoit",
      postExtract(analysis) {
        tidySetup(analysis.functions);
      },
    };
  },
  regexSpec: autoitSpec,
};
