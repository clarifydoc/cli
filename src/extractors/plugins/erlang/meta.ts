import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { erlangSpec } from "./index.js";
import { erlangPackages } from "./packages.js";

export const erlangMeta: LanguagePluginMeta = {
  language: "erlang",
  parsing: "regex",
  extensions: erlangSpec.extensions,
  regexSpec: erlangSpec,
  // Common Test / EUnit suites: `foo_SUITE.erl`, `foo_tests.erl`.
  testFilePatterns: [/_SUITE\.erl$/, /_tests\.erl$/],
  builtinTypes: new Set<string>([
    ...COMMON_PRIMITIVES,
    "atom", "binary", "bitstring", "boolean", "float", "integer", "list",
    "map", "pid", "port", "reference", "tuple", "term", "any", "none",
  ]),
  knownPackages: erlangPackages,
  externalModulePrefixes: [
    "lists", "maps", "dict", "sets", "string", "io", "io_lib", "erlang",
    "gen_server", "gen_statem", "gen_event", "supervisor", "application",
    "ets", "mnesia", "proplists", "binary", "re", "os", "file", "filename",
  ],
  apiCallRoots: ["hackney", "httpc", "ibrowse", "gun"],
  dbCallRoots: ["mnesia", "epgsql", "ets"],
};
