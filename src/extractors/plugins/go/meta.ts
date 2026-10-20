import { goRouterFnResolver } from "./router-fn-resolver.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { goSpec } from "./index.js";
import { goPackages } from "./packages.js";
import { goManifest } from "./manifest.js";
import { GoEntityExtractor } from "./entities.js";
import { goRequestSchema } from "./request-schema.js";
import { goReachability } from "./reachability.js";
import { humaBaseResolver } from "./huma-resolver.js";
import { GO_SECURITY_RULES } from "./security-rules.js";
import { goGrpcStub } from "../shared/grpc-stubs.js";

const GO_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128",
  "byte", "rune", "string", "bool", "error",
  "any", "comparable",
  "map", "chan", "interface",
]);

export const goMeta: LanguagePluginMeta = {
  securityRules: GO_SECURITY_RULES,
  // Huma operations get the base their API is served under (huma-resolver.ts).
  routeResolvers: [humaBaseResolver, goRouterFnResolver],
  // Dead-code reachability (see reachability.ts).
  reachability: goReachability,
  // Go has no grammar here, so its control flow is read off the source. The
  // brace defaults cover it almost entirely; what it adds is `select`, the
  // backtick raw string (a brace inside one would otherwise move the nesting),
  // and `panic` as the throw.
  regexControlFlow: extendRegexControlFlow(
    [{ match: /^select\s*\{?\s*$/, type: "switch_statement" }],
    { quotes: ['"', "`"], multilineStrings: true },
  ),
  ...goManifest,
  regexSpec: goSpec,
  builtinTypes: GO_BUILTINS,
  knownPackages: goPackages,
  entities: new GoEntityExtractor(),
  requestSchema: goRequestSchema,
  grpcStubService: goGrpcStub,
  complexity: {
    branchNodes: new Set([
      "if_statement", "for_statement", "expression_switch_statement",
      "type_switch_statement", "select_statement", "case_clause",
    ]),
    logicalOps: new Set(["&&", "||"]),
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call_expression", "composite_literal"]) },
};
