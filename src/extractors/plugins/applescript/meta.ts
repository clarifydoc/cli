import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { conventionReachability } from "../shared/reachability-kit.js";
import { applescriptSpec, blankAsComments, tidySetup } from "./index.js";
import { applescriptManifest } from "./manifest.js";

export const applescriptMeta: LanguagePluginMeta = {
  // A script is run by osascript or Script Editor, a library loaded by name:
  // every file is kept alive, none is reported dead.
  reachability: conventionReachability({
    extensions: [".applescript"],
    names: { functions: true, types: true, stem: true },
    caseInsensitive: true,
    passiveFiles: [[/\.applescript$/i, "AppleScript (run by osascript, or loaded as a library)"]],
  }),
  ...applescriptManifest,
  // `(* … *)` comments are prose, never code.
  preprocess(rawSource) {
    return {
      sourceText: blankAsComments(rawSource) ?? rawSource,
      language: "applescript",
      postExtract(analysis) {
        tidySetup(analysis.functions);
      },
    };
  },
  regexSpec: applescriptSpec,
};
