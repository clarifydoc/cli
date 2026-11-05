import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { erlangSpec } from "./index.js";
import { erlangPackages } from "./packages.js";
import { erlangManifest } from "./manifest.js";
import { erlangReachability } from "./reachability.js";
import { erlangFunReferences } from "./funs.js";

export const erlangMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: erlangReachability,
  ...erlangManifest,
  regexSpec: erlangSpec,
  // A function named as a value (`fun kick/1`) is a reference, not a call (see funs.ts).
  preprocess(rawSource) {
    return { sourceText: rawSource, language: "erlang", postExtract: erlangFunReferences };
  },
  builtinTypes: new Set<string>([
    ...COMMON_PRIMITIVES,
    "atom", "binary", "bitstring", "boolean", "float", "integer", "list",
    "map", "pid", "port", "reference", "tuple", "term", "any", "none",
  ]),
  knownPackages: erlangPackages,
  apiCallRoots: ["hackney", "httpc", "ibrowse", "gun"],
  dbCallRoots: ["mnesia", "epgsql", "ets"],
};
