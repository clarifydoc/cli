import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the HEEx plugin (see meta.ts). A leaf: types only.
 * Phoenix templates: `.heex` (HEEx), `.eex` (EEx), `.leex` (legacy LiveView).
 */
export const heexManifest: LanguagePluginManifest = {
  language: "heex",
  parsing: "regex",
  extensions: [".heex", ".eex", ".leex"],
  family: "elixir",
  importTarget: false,
};
