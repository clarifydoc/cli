import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { qtuiSpec } from "./index.js";
import { qtuiManifest } from "./manifest.js";

/**
 * Qt Designer `.ui` forms — the Qt Widgets analog of Delphi `.dfm`. Screens +
 * interactive elements only; the behaviour lives in the companion C++ class
 * (same basename), parsed by the cpp plugin.
 */
export const qtuiMeta: LanguagePluginMeta = {
  ...qtuiManifest,
  regexSpec: qtuiSpec,
};
