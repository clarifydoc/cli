import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of this plugin. This module must stay a leaf: types only. */
export const autoitManifest: LanguagePluginManifest = {
  language: "autoit",
  family: "autoit",
  parsing: "regex",
  extensions: [".au3"],
  // `#include "lib\db.au3"` pastes the file in: its functions are in scope by name.
  importsShareScope: true,
  // AutoIt names are case-insensitive: `_saveorder()` calls `Func _SaveOrder()`.
  caseInsensitiveNames: true,
};
