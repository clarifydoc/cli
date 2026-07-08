import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { qtuiSpec } from "./index.js";

/**
 * Qt Designer `.ui` forms — the Qt Widgets analog of Delphi `.dfm`. Screens +
 * interactive elements only; the behaviour lives in the companion C++ class
 * (same basename), parsed by the cpp plugin.
 */
export const qtuiMeta: LanguagePluginMeta = {
  language: "qtui",
  parsing: "regex",
  extensions: qtuiSpec.extensions,
  regexSpec: qtuiSpec,
  // Designer markup is never an import target; the companion .cpp shares its
  // basename, so keeping .ui out of the import path map avoids collisions
  // (mirrors the dfm handling).
  importTarget: false,
};
