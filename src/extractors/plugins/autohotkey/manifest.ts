import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of this plugin. This module must stay a leaf: types only. */
export const autohotkeyManifest: LanguagePluginManifest = {
  language: "autohotkey",
  family: "autohotkey",
  parsing: "regex",
  extensions: [".ahk", ".ah2"],
  // `#Include lib\db.ahk` pastes the file in: its functions are in scope by name.
  importsShareScope: true,
};
