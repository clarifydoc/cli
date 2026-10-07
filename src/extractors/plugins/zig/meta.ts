import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { zigManifest } from "./manifest.js";
import { zigCallHooks } from "./call-hooks.js";
import { FILE_STRUCT, ZigExtractor } from "./functions-classes.js";
import { ZigImportExportExtractor } from "./imports-exports.js";
import { ZigDataSourceExtractor } from "./data-sources.js";
import { zigRouteExtractor } from "./routes.js";
import { zigPackages } from "./packages.js";
import { zigReachability } from "./reachability.js";

export const zigMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: zigReachability,
  ...zigManifest,
  // A file that declares fields is a struct named after the file (`Order.zig`
  // → `Order`); the extractor cannot see the path, so it is renamed here.
  preprocess(rawSource, filePath) {
    return {
      sourceText: rawSource,
      language: "zig",
      postExtract(analysis) {
        const own = analysis.classes.find((c) => c.name === FILE_STRUCT);
        if (own) own.name = filePath.split("/").pop()!.replace(/\.zig$/, "");
      },
    };
  },
  functionsClasses: new ZigExtractor(),
  importsExports: new ZigImportExportExtractor(),
  dataSources: new ZigDataSourceExtractor(),
  routes: zigRouteExtractor,
  knownPackages: zigPackages,
  builtinTypes: new Set([
    ...COMMON_PRIMITIVES, "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize",
    "f16", "f32", "f64", "f128", "bool", "void", "noreturn", "type", "anyerror", "anytype", "anyopaque", "comptime_int",
    "comptime_float", "c_int", "c_uint", "c_long", "c_char",
  ]),
  complexity: {
    branchNodes: new Set(["if_statement", "if_expression", "for_statement", "for_expression", "while_statement", "while_expression", "switch_case", "catch_expression"]),
    logicalOps: new Set(["and", "or", "orelse"]),
    logicalOpNodes: new Set(["binary_expression"]),
    nestingNodes: new Set(["function_declaration"]),
  },
  calls: zigCallHooks,
};
