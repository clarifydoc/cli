import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { conventionReachability } from "../shared/reachability-kit.js";
import { autohotkeySpec, blankAhkComments, tidySetup } from "./index.js";
import { autohotkeyManifest } from "./manifest.js";

export const autohotkeyMeta: LanguagePluginMeta = {
  // A script is run by its interpreter, an included file by its script:
  // every file is kept alive, none is reported dead.
  reachability: conventionReachability({
    extensions: [".ahk", ".ah2"],
    importPath: (source) => (/^\.{1,2}\//.test(source) ? source : null),
    names: { functions: true, types: true, stem: true },
    passiveFiles: [[/\.ah[k2]$/i, "AutoHotkey script (run by AutoHotkey, or #Include-d)"]],
  }),
  ...autohotkeyManifest,
  // Block comments are prose, never code.
  preprocess(rawSource) {
    return {
      sourceText: blankAhkComments(rawSource) ?? rawSource,
      language: "autohotkey",
      postExtract(analysis) {
        tidySetup(analysis.functions);
      },
    };
  },
  regexSpec: autohotkeySpec,
};
