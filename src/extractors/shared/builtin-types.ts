import type { Language } from "../../types/analysis.js";

/**
 * Builtin-type deny lists: identifiers that should NOT be tracked as project
 * type references (primitives, stdlib collections, keywords).
 *
 * The per-language sets live in each plugin's meta (`plugins/<lang>/meta.ts`,
 * `builtinTypes` field) and are pushed in here by `extractors/registry.ts` at
 * load time. This module stays a leaf — it is imported by shared extractor
 * code (type-parser) that plugin modules also import, so it must not import
 * the registry or any plugin itself.
 */

/** Primitives and universal noise shared by most languages — base for plugin sets. */
export const COMMON_PRIMITIVES: ReadonlySet<string> = new Set<string>([
  "string", "String", "str",
  "number", "Number", "int", "long", "short", "byte",
  "float", "double", "decimal", "real", "single",
  "bool", "Bool", "boolean", "Boolean",
  "void", "Void", "Unit", "Nothing",
  "any", "Any", "unknown", "object", "Object",
  "null", "undefined", "None", "nil", "nullptr",
  "this", "Self", "self",
]);

const DENY_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();

/** Called by the registry while aggregating plugin metas. */
export function registerBuiltinTypes(language: Language, types: ReadonlySet<string>): void {
  DENY_BY_LANGUAGE.set(language, types);
}

/** Return true if the identifier is a built-in / stdlib type for the language. */
export function isBuiltinType(typeName: string, language: Language): boolean {
  const deny = DENY_BY_LANGUAGE.get(language);
  return deny ? deny.has(typeName) : false;
}
