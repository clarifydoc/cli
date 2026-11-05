import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { luaSpec } from "./index.js";
import { luaPackages } from "./packages.js";
import { luaManifest } from "./manifest.js";
import { luaReachability } from "./reachability.js";
import { LUA_REGEX_CONTROL_FLOW } from "./control-flow.js";
import { luaTables } from "./tables.js";

export const luaMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: luaReachability,
  ...luaManifest,
  regexSpec: luaSpec,
  // A table holding functions is a class, `obj:method()` keeps its receiver (see tables.ts).
  preprocess(rawSource) {
    return { sourceText: rawSource, language: "lua", postExtract: luaTables, restoreTypedCalls: true };
  },
  // Functions and calls read by the grammars-v4 Lua grammar, while the `antlr:lua` feature is on (antlr.ts).
  antlr: { grammar: "lua", load: () => import("./antlr.js").then((m) => m.readLua) },
  // Control flow from source: keyword-delimited blocks (see control-flow.ts).
  regexControlFlow: LUA_REGEX_CONTROL_FLOW,
  knownPackages: luaPackages,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
