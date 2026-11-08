import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, Language } from "../types/analysis.js";
import type { ClassRef, ProjectContext } from "../types/project.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { pluginFor } from "../extractors/registry.js";

type ApiCall = DataSourceInfo & { filePath: string };

/** A hole reading one member of a local: `${item.entityType}`. */
const MEMBER_HOLE = /\$\{\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\}/g;
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
    if (!urls.some((u) => /\$\{\s*[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\}/.test(u))) continue;
    const holeValues = (receiver: string, member: string): string[] | null => {
      const key = `${call.filePath}:${call.line}:${receiver}.${member}`;
      if (!memo.has(key)) memo.set(key, memberValues(file, call.line, receiver, member, byFile, ctx));
      return memo.get(key)!;
    };
    let expanded: string[] = [];
    let touched = false;
    for (const url of urls) {
      let variants = [url];
      for (const m of [...url.matchAll(MEMBER_HOLE)]) {
        const values = holeValues(m[1]!, m[2]!);
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

/** The strings `receiver.member` can be inside the function enclosing `line`, or null when not a closed set. */
function memberValues(
  file: FileAnalysis,
  line: number,
  receiver: string,
  member: string,
  byFile: ReadonlyMap<string, FileAnalysis>,
  ctx: ProjectContext,
): string[] | null {
  const written = declaredTypeOf(file, line, receiver);
  const hooks = pluginFor(file.language as Language)?.requestSchema;
  const typeName = written ? receiverTypeName(hooks ? hooks.unwrapNullable(written).type : written, file.language as Language) : null;
  if (!typeName || !/^[A-Za-z_$][\w$.]*$/.test(typeName)) return null;
  const owner = ctx.classes.resolve(file.filePath, typeName);
  if (!owner || owner.cls.kind === "enum") return null;
  for (const c of [owner, ...ctx.classes.ancestors(owner).flatMap((s) => (s.ref ? [s.ref] : []))]) {
    const prop = c.cls.properties.find((p) => p.name === member && !p.isStatic);
    if (!prop) continue;
    return prop.type ? typeValues(prop.type, c, byFile, ctx, 0) : null;
  }
  return null;
}

/**
 * The type a local is declared with where `line` reads it: a parameter of the innermost function around the
 * line that declares one of that name, or a typed local of it (`localTypes`, a stated type only).
 */
function declaredTypeOf(file: FileAnalysis, line: number, name: string): string | null {
  const around: FunctionInfo[] = [];
  const visit = (fns: readonly FunctionInfo[]): void => {
    for (const fn of fns) if (fn.line <= line && line <= fn.endLine) around.push(fn);
  };
  visit(file.functions);
  for (const cls of file.classes) visit(cls.methods);
  around.sort((a, b) => a.endLine - a.line - (b.endLine - b.line));
  for (const fn of around) {
    const local = fn.localTypes?.find((t) => t.name === name && !t.from && !t.element && !t.destructured);
    if (local) return local.type || null;
    const param = fn.params.find((p) => p.name === name);
    if (param) return param.type;
  }
  return null;
}

/**
 * The strings a field type admits, read where the type is written (`at`'s file): an enum of string values,
 * a literal union the plugin's `describeType` reads as a string enum, or an alias of either.
 */
function typeValues(written: string, at: ClassRef, byFile: ReadonlyMap<string, FileAnalysis>, ctx: ProjectContext, hops: number): string[] | null {
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
