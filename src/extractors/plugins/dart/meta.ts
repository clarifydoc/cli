import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { dartSpec } from "./index.js";
import { pubPackages } from "./packages.js";
import { dartManifest } from "./manifest.js";
import { dartRequestSchema } from "./request-schema.js";
import { dartReachability } from "./reachability.js";

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
  regexSpec: dartSpec,
  knownPackages: pubPackages,
  builtinTypes: DART_BUILTINS,
  apiCallRoots: ["http", "dio", "Dio", "Client", "client"],
  dbCallRoots: ["FirebaseFirestore", "Firestore", "Database", "db", "supabase"],
  requestSchema: dartRequestSchema,
};
