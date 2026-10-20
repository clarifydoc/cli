import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { storyboardFacts } from "../shared/storyboard.js";
import { storyboardManifest } from "./manifest.js";

/** Storyboards state their scenes and segues as a fact the Swift resolver joins to the view controller classes. */
const storyboardSpec: RegexLangSpec = {
  language: "storyboard",
  extensions: [".storyboard"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  extractRoutes: (lines, _classes, _filePath, _functions, facts) => {
    if (facts) storyboardFacts(lines, facts);
    return [];
  },
};

/** Interface Builder storyboards: layout, not code — no security scan. */
export const storyboardMeta: LanguagePluginMeta = {
  ...storyboardManifest,
  regexSpec: storyboardSpec,
  skipSecurityScan: true,
};
