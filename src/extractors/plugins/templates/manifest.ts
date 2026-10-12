import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the server-template plugin (see meta.ts): four markup
 * dialects, one reader. A leaf: types only.
 */
export const handlebarsManifest: LanguagePluginManifest = {
  language: "handlebars",
  parsing: "regex",
  extensions: [".hbs", ".handlebars"],
  importTarget: false,
};

export const liquidManifest: LanguagePluginManifest = {
  language: "liquid",
  parsing: "regex",
  extensions: [".liquid"],
  importTarget: false,
};

export const velocityManifest: LanguagePluginManifest = {
  language: "velocity",
  parsing: "regex",
  extensions: [".vm"],
  importTarget: false,
};

/** Razor views and pages (`.cshtml`); Blazor components (`.razor`) are the blazor plugin's. */
export const razorManifest: LanguagePluginManifest = {
  language: "razor",
  parsing: "regex",
  extensions: [".cshtml"],
  family: "dotnet",
  importTarget: false,
};
