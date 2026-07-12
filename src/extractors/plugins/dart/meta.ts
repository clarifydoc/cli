import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { dartSpec } from "./index.js";
import { pubPackages } from "./packages.js";
import { dartFrameworkRules } from "./frameworks.js";

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
  language: "dart",
  parsing: "regex",
  extensions: dartSpec.extensions,
  regexSpec: dartSpec,
  knownPackages: pubPackages,
  frameworkRules: dartFrameworkRules,
  // `package:test` / `flutter_test`: `foo_test.dart` is the canonical suffix.
  testFilePatterns: [/_test\.dart$/],
  builtinTypes: DART_BUILTINS,
  // `dart:core`, `package:flutter/...` etc. are SDK/package imports, never local files.
  externalNamespaceRoots: ["dart", "package"],
  frameworkImportHints: {
    "package:flutter": "flutter",
    "package:go_router": "go_router",
    "package:http": "http",
    "package:dio": "dio",
    "package:cloud_firestore": "firestore",
    "package:sqflite": "sqflite",
    "package:supabase_flutter": "supabase",
    "package:shelf": "shelf",
    "package:shelf_router": "shelf",
  },
  apiCallRoots: ["http", "dio", "Dio", "Client", "client"],
  dbCallRoots: ["FirebaseFirestore", "Firestore", "Database", "db", "supabase"],
};
