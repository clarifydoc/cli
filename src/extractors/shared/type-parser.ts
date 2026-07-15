import type { Language, TypeReference, TypeUsageKind, Confidence } from "../../types/analysis.js";
import { isBuiltinType } from "./builtin-types.js";

/** Context shared between every TypeReference emitted from the same site. */
export interface TypeRefContext {
  filePath: string;
  language: Language;
  /** Outer source line — used as both the ref's line and the dedup key seed. */
  line: number;
  /** Containing function/method/class name — surfaced in the report's site list. */
  sourceSymbol: string;
  /** Containing class, if any — feeds class→class edges in the class graph. */
  sourceClass?: string;
}

/**
 * Parse a type annotation and push one TypeReference per non-builtin
 * identifier into `out`. Used by both the FileAnalysis-walking extractor
 * and the AST-level extractor so the emission rules stay in lock-step:
 *
 *   - `base` parser results carry `kindAtBase` (parameter/return/field/...)
 *   - `generic-arg` results always become `"generic-arg"`
 *   - `union-member` inherits the base kind so `User | Admin` as a
 *     parameter counts both as parameter-User AND parameter-Admin
 *
 * `confidenceOverride` defaults to EXTRACTED; pass INFERRED for synthesised
 * references (e.g. `new SomeClass(...)` discovered via AST walk).
 */
export function emitTypeRefs(
  rawType: string,
  kindAtBase: TypeUsageKind,
  ctx: TypeRefContext,
  out: TypeReference[],
  confidenceOverride: Confidence = "EXTRACTED",
): void {
  const parsed = parseTypeRefs(rawType, ctx.language);
  for (const p of parsed) {
    const finalKind: TypeUsageKind = p.kind === "generic-arg" ? "generic-arg" : kindAtBase;
    // Defence in depth — parser already filters but skip just in case.
    if (isBuiltinType(p.typeName, ctx.language)) continue;
    const ref: TypeReference = {
      rawType: p.rawType === rawType ? rawType : p.rawType,
      typeName: p.typeName,
      usageKind: finalKind,
      sourceFile: ctx.filePath,
      sourceLine: ctx.line,
      sourceSymbol: ctx.sourceSymbol,
      confidence: confidenceOverride,
    };
    if (ctx.sourceClass) ref.sourceClass = ctx.sourceClass;
    out.push(ref);
  }
}

/**
 * Parse a type annotation string into a list of base type identifiers,
 * dropping built-ins and surface decoration (optionals, arrays, pointers,
 * unions). Returns one record per identifier found, tagged with whether the
 * identifier was the outermost type or a generic-arg / union-member.
 *
 * Handles the shapes ClarifyDoc's extractors emit today:
 *   - Optionals:   `User?`, `User | null`, `User | undefined`, `Optional<User>`, `Optional[User]`
 *   - Arrays:      `User[]`, `Array<User>`, `List<User>`, `IEnumerable<User>`, `[]User` (Go), `Vec<User>`
 *   - Generics:    `Promise<User>`, `Map<string, User>`, `Dict[str, User]` (Python)
 *   - Unions:      `User | Admin`, `Union[User, Admin]`
 *   - References:  `*User`, `&User`, `&mut User`, `User*`, `&'a User`
 *   - Pascal:      `TList<TUser>`
 *
 * Anything not parseable just yields a single base-typed reference with the
 * cleaned string — better to emit a slightly wrong rawType than to drop the
 * usage entirely.
 */

export interface ParsedTypeRef {
  /** The original (or cleaned) type token as it appeared in source. */
  rawType: string;
  /** Bare identifier the user can match against ClassInfo.name. */
  typeName: string;
  /** Outermost identifier (`base`) vs. type-argument (`generic-arg`) vs. union member. */
  kind: "base" | "generic-arg" | "union-member";
}

/**
 * Return all non-builtin type identifiers found in `typeStr`. Empty when the
 * string is null, empty, or contains only built-ins.
 */
export function parseTypeRefs(typeStr: string | null | undefined, language: Language): ParsedTypeRef[] {
  if (!typeStr) return [];
  const cleaned = typeStr.trim();
  if (!cleaned) return [];

  const refs: ParsedTypeRef[] = [];
  collectRefs(cleaned, language, "base", refs);
  return dedup(refs);
}

function collectRefs(input: string, language: Language, kindAtThisLevel: ParsedTypeRef["kind"], out: ParsedTypeRef[]): void {
  const stripped = stripDecoration(input, language);
  if (!stripped) return;

  // Top-level split on `|` (union) and `&` (intersection in TS).
  // Must respect bracket nesting so `Map<string, A | B>` doesn't split on the
  // inner `|`.
  const unionParts = splitTopLevel(stripped, ["|", "&"]);
  if (unionParts.length > 1) {
    for (const part of unionParts) {
      collectRefs(part, language, kindAtThisLevel === "base" ? "union-member" : "generic-arg", out);
    }
    return;
  }

  // Detect `name<args>` or `name[args]` (Python generic syntax).
  const generic = matchGeneric(stripped);
  if (generic) {
    const outerName = generic.name;
    if (outerName && isIdentifier(outerName) && !isBuiltinType(outerName, language)) {
      out.push({ rawType: input, typeName: outerName, kind: kindAtThisLevel });
    }
    const args = splitTopLevel(generic.body, [","]);
    for (const arg of args) {
      collectRefs(arg, language, "generic-arg", out);
    }
    return;
  }

  // Plain identifier — for languages with `::` namespacing (Perl/C++) keep
  // the full qualified name; otherwise fall back to the last dotted segment
  // (Java `com.example.User` → `User`, Python `models.user.User` → `User`).
  if (PRESERVE_DOUBLE_COLON.has(language) && /::/.test(stripped)) {
    if (isQualifiedIdentifier(stripped) && !isBuiltinType(stripped, language)) {
      out.push({ rawType: input, typeName: stripped, kind: kindAtThisLevel });
      return;
    }
  }
  const ident = lastIdent(stripped);
  if (ident && isIdentifier(ident) && !isBuiltinType(ident, language)) {
    out.push({ rawType: input, typeName: ident, kind: kindAtThisLevel });
  }
}

/**
 * Languages where `::` is a meaningful namespace separator and class
 * identifiers retain the full path. Keeping the full qualified form
 * prevents `Catalyst::Controller` from collapsing to `Catalyst` (a
 * different, unrelated namespace).
 */
const PRESERVE_DOUBLE_COLON = new Set<Language>(["perl"]);

const QUALIFIED_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:::[A-Za-z_$][A-Za-z0-9_$]*)*$/;

function isQualifiedIdentifier(s: string): boolean {
  return QUALIFIED_IDENT_RE.test(s);
}

/**
 * Remove syntactic decoration that wraps a real type identifier:
 *   - leading/trailing whitespace
 *   - leading `*` / `&` / `&mut ` / `&'a ` / `mut ` (Rust)
 *   - leading `*const ` / `*mut ` (Rust raw pointers)
 *   - trailing `?` (nullability)
 *   - trailing `[]` (array)
 *   - trailing `*` (C-style pointer)
 *   - leading `[]` (Go slice) and `map[...]` (Go map — strip key, keep value)
 *   - leading `chan ` (Go channel)
 *   - leading `dyn ` / `impl ` (Rust trait objects)
 *
 * Exported so language plugins can reuse the same modifier-stripping logic
 * instead of maintaining their own variant.
 */
export function stripTypeModifiers(input: string, language: Language): string {
  return stripDecoration(input, language);
}

/**
 * Simple class name of a raw type annotation: `List<Account>` → "List",
 * `a.b.Foo?` → "Foo". Null when what remains isn't a plain identifier.
 * The one shared normalizer for declared-type strings — the symbol linker
 * compares `FunctionInfo.localTypes` entries (produced by plugins) against
 * its class catalog, so both ends MUST normalize identically.
 */
export function simpleTypeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bare = raw.split("<")[0]!.replace(/\?/g, "").trim();
  const simple = bare.split(".").pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(simple) ? simple : null;
}

function stripDecoration(input: string, _language: Language): string {
  let s = input.trim();
  if (!s) return "";

  // Repeat until stable.
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.trim();

    // Go map[Key]Value → Value
    const goMap = /^map\s*\[[^\]]*\]\s*(.+)$/.exec(s);
    if (goMap) { s = goMap[1]!; continue; }

    // Go slice []Type → Type
    if (s.startsWith("[]")) { s = s.slice(2).trim(); continue; }

    // Go channel `chan T` / `<-chan T` / `chan<- T`
    if (s.startsWith("<-chan ")) { s = s.slice(7).trim(); continue; }
    if (s.startsWith("chan<- ")) { s = s.slice(7).trim(); continue; }
    if (s.startsWith("chan ")) { s = s.slice(5).trim(); continue; }

    // Rust trait objects
    if (s.startsWith("dyn ")) { s = s.slice(4).trim(); continue; }
    if (s.startsWith("impl ")) { s = s.slice(5).trim(); continue; }

    // Rust references
    const refMatch = /^&(?:'\w+\s+)?(?:mut\s+)?(.+)$/.exec(s);
    if (refMatch) { s = refMatch[1]!; continue; }
    if (s.startsWith("mut ")) { s = s.slice(4).trim(); continue; }

    // Rust raw pointers
    if (s.startsWith("*const ")) { s = s.slice(7).trim(); continue; }
    if (s.startsWith("*mut ")) { s = s.slice(5).trim(); continue; }

    // C/C++/Go pointer prefix `*User`
    if (s.startsWith("*") && s.length > 1 && /^[A-Za-z_]/.test(s.slice(1))) {
      s = s.slice(1).trim(); continue;
    }

    // Trailing `?` (nullable)
    if (s.endsWith("?")) { s = s.slice(0, -1).trim(); continue; }

    // Trailing array brackets `[]`
    if (s.endsWith("[]")) { s = s.slice(0, -2).trim(); continue; }

    // Trailing C-style pointer `User*` / `User&`
    if (/[*&]+$/.test(s)) { s = s.replace(/[*&]+$/, "").trim(); continue; }

    // Surrounding parentheses
    if (s.startsWith("(") && s.endsWith(")") && bracketsBalanced(s.slice(1, -1))) {
      s = s.slice(1, -1).trim(); continue;
    }
  }
  return s;
}

/** Match `Name<args>` or `Name[args]` (Python). Returns null if not a generic shape. */
function matchGeneric(input: string): { name: string; body: string; close: "angle" | "bracket" } | null {
  const open = firstUnescapedOpen(input);
  if (open === -1) return null;
  const opener = input[open]!;
  const closer = opener === "<" ? ">" : "]";
  const close = matchClose(input, open, opener, closer);
  if (close === -1) return null;
  // Must be the final character (or have only whitespace after).
  if (input.slice(close + 1).trim() !== "") return null;
  const name = input.slice(0, open).trim();
  const body = input.slice(open + 1, close).trim();
  return { name, body, close: opener === "<" ? "angle" : "bracket" };
}

function firstUnescapedOpen(s: string): number {
  // Find the first `<` or `[` after at least one non-space character.
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<" || c === "[") return i;
  }
  return -1;
}

function matchClose(s: string, openIdx: number, opener: string, closer: string): number {
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const c = s[i]!;
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Split `s` on any top-level occurrence of `seps`. Respects nesting of
 * `<>`, `[]`, `()` and `{}` so commas inside generics don't trigger.
 */
function splitTopLevel(s: string, seps: readonly string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<" || c === "[" || c === "(" || c === "{") depth++;
    else if (c === ">" || c === "]" || c === ")" || c === "}") depth--;
    else if (depth === 0 && seps.includes(c)) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter((x) => x.length > 0);
}

function bracketsBalanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "(" || c === "<" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === ">" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isIdentifier(s: string): boolean {
  return IDENT_RE.test(s);
}

/** For dotted names like `Models.User` or `com.example.User`, return the last segment. */
function lastIdent(s: string): string {
  const cleaned = s.trim();
  const lastDot = cleaned.lastIndexOf(".");
  const last = lastDot >= 0 ? cleaned.slice(lastDot + 1) : cleaned;
  // Also strip any trailing whitespace + remaining decorators we missed.
  return last.replace(/[^A-Za-z0-9_$].*$/, "").trim();
}

function dedup(refs: ParsedTypeRef[]): ParsedTypeRef[] {
  const seen = new Set<string>();
  const out: ParsedTypeRef[] = [];
  for (const r of refs) {
    const key = `${r.typeName}::${r.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
