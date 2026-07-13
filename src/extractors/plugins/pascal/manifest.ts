import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { pascalFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const pascalManifest: LanguagePluginManifest = {
  language: "pascal",
  parsing: "tree-sitter",
  extensions: [".pas", ".pp", ".lpr", ".dpr", ".dpk"],
  grammar: { variants: { pascal: { pkg: "tree-sitter-pascal", wasm: "tree-sitter-pascal.wasm" } } },
  externalModulePrefixes: ["System.", "Vcl.", "Fmx.", "Data.", "Datasnap.", "EMS.", "Winapi.", "Posix.", "IdHTTP", "IdTCP", "IdSSL"],
  frameworkRules: pascalFrameworkRules,
  // The DFM→handler UI bridge joins .dfm event wirings to form methods, so
  // discovering dfm files must load this plugin's resolvers too.
  dispatchLanguages: ["dfm"],
};

export const dfmManifest: LanguagePluginManifest = {
  language: "dfm",
  parsing: "custom",
  // .lfm = Lazarus form files — same object syntax (always text), same parser.
  extensions: [".dfm", ".lfm"],
  importTarget: false,
};
