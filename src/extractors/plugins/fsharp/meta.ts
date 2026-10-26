import { ML_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { fsharpManifest } from "./manifest.js";
import { fsharpCallHooks } from "./call-hooks.js";
import { FSharpExtractor } from "./functions-classes.js";
import { FSharpImportExportExtractor } from "./imports-exports.js";
import { FSharpDataSourceExtractor } from "./data-sources.js";
import { fsharpRouteExtractor } from "./routes.js";
import { fsharpReachability } from "./reachability.js";

const FSHARP_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "int64", "int16", "uint", "byte", "float", "float32", "decimal", "bool", "char", "string", "unit", "obj",
  "option", "voption", "list", "seq", "array", "Map", "Set", "Result", "Async", "Task", "ValueTask", "exn",
  "HttpHandler", "HttpFunc", "HttpContext",
]);

/** A GLSL shader also ends in `.fs`. */
const GLSL_RE = /^\s*#version\s+\d+|\bgl_FragColor\b|\bgl_FragCoord\b|^\s*(?:uniform|varying|precision\s+\w+p)\s/m;

export const fsharpMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: fsharpReachability,
  ...fsharpManifest,
  docComments: ML_DOCS,
  preprocess: (rawSource, relativePath) =>
    relativePath.toLowerCase().endsWith(".fs") && GLSL_RE.test(rawSource) ? { skip: "GLSL shader, not F#" } : null,
  functionsClasses: new FSharpExtractor(),
  importsExports: new FSharpImportExportExtractor(),
  dataSources: new FSharpDataSourceExtractor(),
  routes: fsharpRouteExtractor,
  builtinTypes: FSHARP_BUILTINS,
  apiCallRoots: ["HttpClient"],
  complexity: {
    branchNodes: new Set(["if_expression", "elif_expression", "rule", "while_expression", "for_expression"]),
    logicalOps: new Set(["&&", "||"]),
    logicalOpNodes: new Set(["infix_expression"]),
    nestingNodes: new Set(["fun_expression"]),
  },
  calls: fsharpCallHooks,
};
