import { ML_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { ocamlManifest } from "./manifest.js";
import { ocamlCallHooks } from "./call-hooks.js";
import { FILE_MODULE, OCamlExtractor } from "./functions-classes.js";
import { OCamlImportExportExtractor } from "./imports-exports.js";
import { OCamlDataSourceExtractor } from "./data-sources.js";
import { ocamlRouteExtractor } from "./routes.js";
import { opamPackages } from "./packages.js";
import { ocamlReachability } from "./reachability.js";

export const ocamlMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: ocamlReachability,
  ...ocamlManifest,
  docComments: ML_DOCS,
  // The file is the module of its capitalized name (`order_repo.ml` →
  // `Order_repo`); the extractor cannot see the path, so it is renamed here.
  preprocess(rawSource, filePath) {
    return {
      sourceText: rawSource,
      language: "ocaml",
      postExtract(analysis) {
        const own = analysis.classes.find((c) => c.name === FILE_MODULE);
        if (!own) return;
        const stem = filePath.split("/").pop()!.replace(/\.mli?$/i, "");
        own.name = stem.charAt(0).toUpperCase() + stem.slice(1);
      },
    };
  },
  functionsClasses: new OCamlExtractor(),
  importsExports: new OCamlImportExportExtractor(),
  dataSources: new OCamlDataSourceExtractor(),
  routes: ocamlRouteExtractor,
  knownPackages: opamPackages,
  builtinTypes: new Set([...COMMON_PRIMITIVES, "int", "float", "string", "bool", "char", "unit", "list", "array", "option", "result", "bytes", "int32", "int64", "exn"]),
  complexity: {
    branchNodes: new Set(["if_expression", "match_case", "while_expression", "for_expression"]),
    logicalOps: new Set(["&&", "||", "&", "or"]),
    logicalOpNodes: new Set(["infix_expression"]),
    nestingNodes: new Set(["let_binding", "fun_expression", "function_expression"]),
  },
  calls: ocamlCallHooks,
};
