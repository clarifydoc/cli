import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { PERCENT_DOCS } from "../../shared/doc-comment-specs.js";
import { rebarPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const erlangManifest: LanguagePluginManifest = {
  docComments: PERCENT_DOCS,
  language: "erlang",
  family: "erlang",
  packageManagers: [rebarPackageManager],
  packageEcosystems: ["hex"],
  parsing: "regex",
  extensions: [".erl", ".hrl"],
  testFilePatterns: [/_SUITE\.erl$/, /_tests\.erl$/],
  externalModulePrefixes: ["lists", "maps", "dict", "sets", "string", "io", "io_lib", "erlang", "gen_server", "gen_statem", "gen_event", "supervisor", "application", "ets", "mnesia", "proplists", "binary", "re", "os", "file", "filename"],
};
