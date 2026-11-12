import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, Language } from "../types/analysis.js";
import type { ClassRef, ProjectContext } from "../types/project.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { pluginFor } from "../extractors/registry.js";

type ApiCall = DataSourceInfo & { filePath: string };

/** A hole reading a member path off a local or `this`: `${item.entityType}`, `${club.sponsor.tier}`, `${this.club.kind}`. */
const MEMBER_HOLE = /\$\{\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+)\s*\}/g;
/** The same, for testing one URL. */
const HAS_MEMBER_HOLE = new RegExp(MEMBER_HOLE.source);
/** URLs one call may stand for after expansion; past it the holes stay wildcards. */
const MAX_URLS = 16;
/** Type aliases and enum indirections followed for one field type. */
const MAX_HOPS = 4;

/**
 * A URL hole that reads a member of a typed local — `` `/api/v1/${item.entityType}/${item.id}` `` in a
 * function taking `item: Favorite` — names one of the values the member's declared type admits, when that
 * type is a closed set of strings: an enum whose members state string values (`ClassInfo.kind: "enum"` +
 * `fieldValues`), a union of string literals written in place (`entityType: 'clubs' | 'players'`), or a
 * type alias that stands for one (`type FavoriteKind = 'clubs' | 'players'`). Each value is a URL the call
 * may request, so the call carries them as `targetAlternatives` with `targetChoice`, and the route linker
 * links every route a value reaches AMBIGUOUS.
 *
 * The receiver may also be an inline object type (`item: { kind: Kind }`), the head of a nested path
 * (`${club.sponsor.tier}`: each step a declared property type), `this` (the enclosing class's field types) or a
 * loop / callback element of a collection chain the source types (`for (const c of this.clubs)`).
 *
 * Language-agnostic: the receiver's type comes from the enclosing function's parameters and typed locals,
 * the field from the class index, and what a type text admits from the plugin's `requestSchema` hooks
 * (`describeType` — the same reading the request-schema pass gives a body field). A call whose
 * alternatives are a helper's branches (no `targetChoice`) is left alone: they are first-hit, not a choice.
 * Mutates the aggregated rows; returns how many it expanded.
 */
export function expandTypedMemberHoles(calls: ApiCall[], analyses: readonly FileAnalysis[], ctx: ProjectContext): number {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  const memo = new Map<string, string[] | null>();
  let changed = 0;
  for (const call of calls) {
    if (call.kind !== "api-call" || !call.target) continue;
    if (call.targetAlternatives?.length && !call.targetChoice) continue;
    const file = byFile.get(call.filePath);
    if (!file) continue;
    const urls = [call.target, ...(call.targetAlternatives ?? [])];
    if (!urls.some((u) => HAS_MEMBER_HOLE.test(u))) continue;
    const holeValues = (path: string): string[] | null => {
      const key = `${call.filePath}:${call.line}:${path}`;
      if (!memo.has(key)) memo.set(key, memberValues(file, call.line, path.replace(/\?\./g, ".").split("."), byFile, ctx));
      return memo.get(key)!;
    };
    let expanded: string[] = [];
    let touched = false;
    for (const url of urls) {
      let variants = [url];
      for (const m of [...url.matchAll(MEMBER_HOLE)]) {
        const values = holeValues(m[1]!);
        if (!values || values.length === 0) continue;
        const next = variants.flatMap((v) => values.map((value) => v.split(m[0]).join(value)));
        if (next.length > MAX_URLS) continue;
        variants = next;
        touched = true;
      }
      expanded.push(...variants);
    }
    if (!touched) continue;
    expanded = [...new Set(expanded)];
    if (expanded.length > MAX_URLS) continue;
    const [first, ...rest] = expanded;
    call.target = first!;
    if (rest.length > 0) {
      call.targetAlternatives = rest;
      call.targetChoice = true;
    } else {
      delete call.targetAlternatives;
      delete call.targetChoice;
    }
    changed++;
  }
  return changed;
}

/** A type as written in one file, which is where its names resolve. */
interface Written {
  filePath: string;
  language: Language;
  type: string;
}

/**
 * The strings the member path `path` (`["item", "kind"]`, `["club", "sponsor", "tier"]`, `["this", "club",
 * "kind"]`) can be inside the function enclosing `line`, or null when not a closed set. Each step but the
 * last is a declared property type; the last one is read for its values.
 */
function memberValues(file: FileAnalysis, line: number, path: readonly string[], byFile: ReadonlyMap<string, FileAnalysis>, ctx: ProjectContext): string[] | null {
  const held = typeOfPath(file, line, path.slice(0, -1), ctx, 0);
  const last = held ? memberType(held, path[path.length - 1]!, ctx) : null;
  return last ? typeValues(last.type, last, byFile, ctx, 0) : null;
}

/**
 * The declared type of a path read inside the function around `line`: a typed parameter or local, the
 * enclosing class (`this`), a loop or callback element of a collection chain the source types, then one
 * declared property per further step.
 */
function typeOfPath(file: FileAnalysis, line: number, path: readonly string[], ctx: ProjectContext, depth: number): Written | null {
  if (path.length === 0 || depth > MAX_HOPS) return null;
  const [head, ...rest] = path;
  let held: Written | null;
  if (head === "this") {
    const owner = enclosingClass(file, line);
    held = owner ? { filePath: file.filePath, language: file.language as Language, type: owner.name } : null;
  } else {
    const found = declaredTypeOf(file, line, head!);
    if (!found) return null;
    if (typeof found === "string") held = { filePath: file.filePath, language: file.language as Language, type: found };
    else {
      // A loop or callback element of a field or member chain: the element of the collection that chain declares.
      const source = typeOfPath(file, line, found.from, ctx, depth + 1);
      const element = source ? pluginFor(source.language)?.collectionElementOf?.(source.type.trim()) : null;
      held = source && element ? { ...source, type: element } : null;
    }
  }
  for (const member of rest) {
    if (!held) return null;
    held = memberType(held, member, ctx);
  }
  return held;
}

/** The innermost class whose body contains `line`. */
function enclosingClass(file: FileAnalysis, line: number): ClassInfo | null {
  let best: ClassInfo | null = null;
  for (const cls of file.classes) {
    if (cls.line > line || line > cls.endLine) continue;
    if (!best || cls.endLine - cls.line < best.endLine - best.line) best = cls;
  }
  return best;
}

/** The type a member of `held` is declared with: a property of the class its type names (or an ancestor), or of an inline object type. */
function memberType(held: Written, member: string, ctx: ProjectContext): Written | null {
  const hooks = pluginFor(held.language)?.requestSchema;
  const bare = hooks ? hooks.unwrapNullable(held.type).type.trim() : held.type.trim();
  if (bare.startsWith("{")) {
    const type = inlineMembers(bare).get(member);
    return type ? { ...held, type } : null;
  }
  const typeName = receiverTypeName(bare, held.language);
  if (!typeName || !/^[A-Za-z_$][\w$.]*$/.test(typeName)) return null;
  const owner = ctx.classes.resolve(held.filePath, typeName);
  if (!owner || owner.cls.kind === "enum") return null;
  for (const c of [owner, ...ctx.classes.ancestors(owner).flatMap((s) => (s.ref ? [s.ref] : []))]) {
    const prop = c.cls.properties.find((p) => p.name === member && !p.isStatic);
    if (!prop) continue;
    return prop.type ? { filePath: c.filePath, language: c.language, type: prop.type } : null;
  }
  return null;
}

/**
 * The members an inline object type states: `{ kind: Kind; label?: string }` gives `kind` the type `Kind`.
 * Empty unless the text is ONE object type (not `{…}[]`, `{…} & Base`, a union of objects).
 */
function inlineMembers(text: string): Map<string, string> {
  const members = new Map<string, string>();
  const source = text.trim().replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  if (!source.startsWith("{") || !source.endsWith("}")) return members;
  let depth = 0;
  let quote = "";
  let start = 1;
  const flush = (end: number): void => {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([\s\S]+?)\s*$/.exec(source.slice(start, end));
    if (m) members.set(m[1]!, m[2]!);
    start = end + 1;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "[" || (ch === "<" && source[i - 1] !== "=")) depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || (ch === ">" && source[i - 1] !== "=")) {
      depth--;
      if (depth === 0) {
        // The object closes before the text ends: an intersection or union of objects.
        if (i !== source.length - 1) return new Map();
        flush(i);
      }
    } else if (depth === 1 && (ch === ";" || ch === ",")) flush(i);
    else if (depth === 1 && ch === "\n") {
      // A member wrapped over lines (a leading `|`, a trailing `:` or `|`) goes on.
      const soFar = source.slice(start, i).trim();
      const next = /\S/.exec(source.slice(i))?.[0] ?? "";
      if (soFar !== "" && !/[:|&]$/.test(soFar) && next !== "|" && next !== "&") flush(i);
    }
  }
  return depth === 0 ? members : new Map();
}

/**
 * What a name is declared as where `line` reads it: the type text of a parameter of the innermost function
 * around the line, or of a typed local (`localTypes`, a stated type only); or, for a loop or callback
 * variable over a field or member chain, that chain (`for (const c of this.clubs)`).
 */
function declaredTypeOf(file: FileAnalysis, line: number, name: string): string | { from: string[] } | null {
  const around: FunctionInfo[] = [];
  const visit = (fns: readonly FunctionInfo[]): void => {
    for (const fn of fns) if (fn.line <= line && line <= fn.endLine) around.push(fn);
  };
  visit(file.functions);
  for (const cls of file.classes) visit(cls.methods);
  around.sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
  for (const fn of around) {
    const named = fn.localTypes?.filter((t) => t.name === name) ?? [];
    const local = named.find((t) => !t.from && !t.element && !t.destructured);
    if (local) return local.type || null;
    if (named.length > 0) {
      // Only a loop element read off a plain chain; a call's result needs return types, which the linker reads.
      const only = named.every((t) => t.from === named[0]!.from && t.element === named[0]!.element) ? named[0]! : null;
      if (only?.element && only.from && !only.iterator && !only.awaited && /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(only.from)) return { from: only.from.replace(/\?\./g, ".").split(".") };
      return null;
    }
    const param = fn.params.find((p) => p.name === name);
    if (param) return param.type;
  }
  return null;
}

/**
 * The strings a field type admits, read where the type is written (`at`'s file): an enum of string values,
 * a literal union the plugin's `describeType` reads as a string enum, or an alias of either.
 */
function typeValues(written: string, at: Pick<ClassRef, "filePath" | "language">, byFile: ReadonlyMap<string, FileAnalysis>, ctx: ProjectContext, hops: number): string[] | null {
  if (hops > MAX_HOPS) return null;
  const hooks = pluginFor(at.language)?.requestSchema;
  const bare = hooks ? hooks.unwrapNullable(written).type : written.trim();
  const shape = hooks?.describeType(bare);
  if (shape?.kind === "scalar") return shape.schema.enum && shape.schema.enum.length > 0 ? [...new Set(shape.schema.enum)] : null;
  if (!/^[A-Za-z_$][\w$.]*$/.test(bare)) return null;
  const named = ctx.classes.resolve(at.filePath, bare);
  if (named) return named.cls.kind === "enum" ? enumValues(named.cls) : null;
  // `type FavoriteKind = 'clubs' | 'players'`: declared in this file or the one the name is imported from.
  const source = ctx.importIndex.localFor(at.filePath, bare) ?? at.filePath;
  const alias = byFile.get(source)?.typeAliases?.find((t) => t.name === bare);
  if (!alias) return null;
  const aliasFile = byFile.get(source)!;
  return typeValues(alias.type, { ...at, filePath: source, language: aliasFile.language as Language }, byFile, ctx, hops + 1);
}

/** An enum's members' string values, when every member states one. */
function enumValues(cls: ClassInfo): string[] | null {
  const members = cls.properties.filter((p) => p.isStatic || cls.fieldValues?.[p.name] !== undefined);
  if (members.length === 0) return null;
  const values = members.map((p) => cls.fieldValues?.[p.name]);
  if (!values.every((v): v is string => typeof v === "string" && v !== "" && !v.includes("${"))) return null;
  return [...new Set(values)];
}
