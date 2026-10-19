import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of the stylesheet family — SCSS, Sass and Less share one
 * plugin (meta.ts). This module must stay a leaf: types only. Their
 * packages (Bootstrap, Bulma …) are npm's, declared in package.json.
 */
const shared = {
  family: "stylesheet",
  parsing: "regex",
  packageEcosystems: ["npm"],
  // `@import "mixins"` (and `@use … as *`) puts the file's mixins in scope by name.
  importsShareScope: true,
  // `@import "shared/fonts/inter"` is searched on the build's load paths too.
  importLoadPaths: true,
} as const;

export const scssManifest: LanguagePluginManifest = {
  ...shared,
  language: "scss",
  extensions: [".scss"],
  // `@use "buttons"` loads the partial `_buttons.scss`.
  partialPrefix: "_",
};

export const sassManifest: LanguagePluginManifest = {
  ...shared,
  language: "sass",
  extensions: [".sass"],
  partialPrefix: "_",
};

export const lessManifest: LanguagePluginManifest = {
  ...shared,
  language: "less",
  extensions: [".less"],
};
