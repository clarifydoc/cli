import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the Core Data plugin: an Xcode data model, the XML file
 * `contents` inside `<Model>.xcdatamodel/` (itself inside `.xcdatamodeld/`
 * when the model is versioned). Claimed by name; `preprocess` refuses any
 * other file called `contents`. A leaf: types only.
 */
export const coredataManifest: LanguagePluginManifest = {
  language: "coredata",
  parsing: "regex",
  extensions: [],
  namedFiles: ["contents"],
  importTarget: false,
};
