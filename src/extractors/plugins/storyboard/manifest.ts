import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of the storyboard plugin: Interface Builder storyboards. A leaf: types only. */
export const storyboardManifest: LanguagePluginManifest = {
  language: "storyboard",
  parsing: "regex",
  extensions: [".storyboard"],
  importTarget: false,
};
