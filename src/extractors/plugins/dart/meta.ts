import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { dartSpec } from "./index.js";
import { pubPackages } from "./packages.js";
import { dartManifest } from "./manifest.js";
import { dartRequestSchema } from "./request-schema.js";
import { dartReachability } from "./reachability.js";
import { DartEntityExtractor } from "./entities.js";
import { goRouterResolver } from "./go-router.js";
import { DriftQueryResolver } from "./drift-queries.js";

const DART_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "double", "num", "bool", "String", "Symbol", "Runes",
  "List", "Set", "Map", "Iterable", "Iterator", "MapEntry",
  "Future", "Stream", "FutureOr", "Completer", "Duration", "DateTime", "Stopwatch",
  "Function", "Record", "Type", "Object", "Null", "Never", "dynamic", "void",
  "Comparable", "Pattern", "RegExp", "StringBuffer", "Uri",
  "Exception", "Error", "StateError", "ArgumentError", "Expando",
  // Flutter framework core types — never project type references.
  "Widget", "StatelessWidget", "StatefulWidget", "State", "BuildContext", "Key",
  "Color", "EdgeInsets", "TextStyle", "Container", "Scaffold", "Text",
]);

export const dartMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: dartReachability,
  regexControlFlow: extendRegexControlFlow([], { quotes: ['"', "'"] }),
  ...dartManifest,
  docComments: C_STYLE_DOCS,
  regexSpec: dartSpec,
  // Functions and calls read by tree-sitter-dart while the `tree-sitter:dart` feature is on (tree-sitter.ts).
  treeSitter: { grammar: "dart", load: () => import("./tree-sitter.js").then((m) => m.loadDartReader()) },
  entities: new DartEntityExtractor(),
  knownPackages: pubPackages,
  builtinTypes: DART_BUILTINS,
  apiCallRoots: ["http", "dio", "Dio", "Client", "client"],
  dbCallRoots: ["FirebaseFirestore", "Firestore", "Database", "db", "supabase"],
  requestSchema: dartRequestSchema,
  routeResolvers: [goRouterResolver],
  // `_db.mergedAssetDrift.mergedBucket(…)` → the named query of `merged_asset.drift`.
  dispatchResolvers: [new DriftQueryResolver()],
};
