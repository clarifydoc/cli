import type {
  FileAnalysis,
  Language,
  TypeReference,
  TypeUsageKind,
  ClassInfo,
  FunctionInfo,
} from "../types/analysis.js";
import {
  parseTypeRefs,
  emitTypeRefs,
  type ParsedTypeRef,
  type TypeRefContext,
} from "../extractors/shared/type-parser.js";
import { isBuiltinType } from "../extractors/shared/builtin-types.js";
import { declaredSupertypes } from "./typed-receivers.js";

/**
 * Walk a FileAnalysis and emit TypeReferences for every type-position usage
 * captured by the extractors:
 *
 *   - class extends         → kind: "extends"
 *   - class implements      → kind: "implements"
 *   - method param.type     → kind: "parameter"   (in containing ClassName.method)
 *   - method returnType     → kind: "return"
 *   - property.type         → kind: "field"
 *   - top-level fn param    → kind: "parameter"
 *   - top-level fn return   → kind: "return"
 *
 * Each parsed identifier becomes its own TypeReference. Generic args inside a
 * field/parameter type produce additional `generic-arg` records so the user
 * can see e.g. that `List<User>` references both `List` (filtered as built-in
 * for most langs) and `User` (the project type).
 *
 * This pass uses ONLY what's already in FileAnalysis — no AST access. The
 * tree-sitter extractors in Phase B add variable annotations, casts, and
 * instantiations separately.
 */
export function extractTypeReferences(a: FileAnalysis, language: Language): TypeReference[] {
  const refs: TypeReference[] = [];

  for (const cls of a.classes) {
    emitClassRefs(cls, a, language, refs);
    // Class-method calls inside this class body: `User.find(id)`, `Foo.new(x)`.
    // The leading PascalCase identifier is the class being used.
    for (const method of cls.methods ?? []) {
      emitClassMethodCallRefs(method.calls, language, a.filePath, method.line, `${cls.name}.${method.name}`, cls.name, refs);
    }
  }
  for (const fn of a.functions) {
    // Top-level functions have no enclosing class — pass undefined so file
    // nodes are used as the source in the class graph aggregator.
    emitFunctionRefs(fn, a.filePath, language, fn.name, undefined, refs);
    emitClassMethodCallRefs(fn.calls, language, a.filePath, fn.line, fn.name, undefined, refs);
  }

  return refs;
}

/**
 * Type references a class declaration makes: its base class, interfaces,
 * property types, the entities an ORM model relates to and, through
 * `emitFunctionRefs`, each method's signature.
 */
function emitClassRefs(cls: ClassInfo, a: FileAnalysis, language: Language, refs: TypeReference[]): void {
  const filePath = a.filePath;
  const classSymbol = cls.name;
  const baseCtx: TypeRefContext = { filePath, language, line: cls.line, sourceSymbol: classSymbol, sourceClass: cls.name };

  // Only what the class declares is a supertype; an entity extractor's relation
  // targets in `implements` are associations, referenced from the relation's field.
  if (cls.extends) emitTypeRefs(cls.extends, "extends", baseCtx, refs);
  for (const iface of declaredSupertypes(cls, a).slice(cls.extends ? 1 : 0)) emitTypeRefs(iface, "implements", baseCtx, refs);
  for (const r of a.entityRelations ?? []) {
    if (r.fromEntity === cls.name) emitTypeRefs(r.toEntity, "field", { ...baseCtx, sourceSymbol: `${classSymbol}.${r.fromField}` }, refs);
  }

  for (const prop of cls.properties ?? []) {
    if (prop.type) {
      emitTypeRefs(prop.type, "field", { ...baseCtx, sourceSymbol: `${classSymbol}.${prop.name}` }, refs);
    }
  }

  for (const method of cls.methods ?? []) {
    emitFunctionRefs(method, filePath, language, `${classSymbol}.${method.name}`, cls.name, refs);
  }
}

/**
 * Type references in one function's signature: its parameter and return types.
 */
function emitFunctionRefs(
  fn: FunctionInfo,
  filePath: string,
  language: Language,
  sourceSymbol: string,
  sourceClass: string | undefined,
  refs: TypeReference[],
): void {
  const ctx: TypeRefContext = { filePath, language, line: fn.line, sourceSymbol, sourceClass };
  for (const param of fn.params ?? []) {
    if (param.type) emitTypeRefs(param.type, "parameter", ctx, refs);
  }
  if (fn.returnType) emitTypeRefs(fn.returnType, "return", ctx, refs);
}

/**
 * Convenience for tests / external consumers: parse a single annotation
 * directly. Mostly re-exports the parser so callers don't need to know the
 * shared module layout.
 */
export function parseAnnotation(typeStr: string | null | undefined, language: Language): ParsedTypeRef[] {
  return parseTypeRefs(typeStr, language);
}

/**
 * Recognise class-method-call patterns inside a function's call list.
 * `User.find(id)` / `User.new(x)` / `AuthService::authenticate(...)` carry
 * the class name as a prefix — the call graph already records the call, but
 * for the data-model axis we also want the type to show up as a reference.
 *
 * This is how Ruby (no static types), Python (duck-typed), and any language
 * with `ClassName.method()` syntax surface their data-model usage.
 *
 * Confidence is INFERRED because the call graph might also point at a
 * variable named the same as a class, and the deny-list filtering is the
 * main defence against noise.
 */
// Class-method-call recognisers. Hoisted so they aren't re-allocated per
// call in the per-file × per-method hot path.
//   DOT_CALL    — `Class.method(...)` (JS/Py/Ruby/...)
//   COLON_CALL  — `Class::method(...)` (Perl/C++/PHP) preserving full namespace
// One-level chains only — `Foo.Bar.baz` is more often an instance chain.
const DOT_CALL = /^([A-Z][A-Za-z0-9_]*)\.[A-Za-z_]/;
const COLON_CALL = /^((?:[A-Z][A-Za-z0-9_]*)(?:::[A-Z][A-Za-z0-9_]*)*?)::[A-Za-z_]/;

/**
 * A `Class.method(…)` or `Class::method(…)` call references `Class`; emitted
 * once per type per symbol. One-level chains only, since `a.b.c` is usually
 * an instance chain.
 */
function emitClassMethodCallRefs(
  calls: import("../types/analysis.js").CallInfo[] | undefined,
  language: Language,
  filePath: string,
  fallbackLine: number,
  sourceSymbol: string,
  sourceClass: string | undefined,
  refs: TypeReference[],
): void {
  if (!calls || calls.length === 0) return;
  const seen = new Set<string>();
  for (const call of calls) {
    if (!call.name) continue;
    const dotMatch = call.name.match(DOT_CALL);
    const colonMatch = call.name.match(COLON_CALL);
    const typeName = dotMatch?.[1] ?? colonMatch?.[1];
    if (!typeName) continue;
    if (isBuiltinType(typeName, language)) continue;

    // Dedup multiple `Class.x` / `Class.y` calls down to a single ref per
    // (line, type) so we don't multi-count one usage.
    const key = `${typeName}::${call.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ref: TypeReference = {
      rawType: typeName,
      typeName,
      usageKind: "instantiation",
      sourceFile: filePath,
      sourceLine: call.line ?? fallbackLine,
      sourceSymbol,
      confidence: "INFERRED",
    };
    if (sourceClass) ref.sourceClass = sourceClass;
    refs.push(ref);
  }
}
