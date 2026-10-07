import type { ClassInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { restoreHeldCalls } from "../extractors/shared/call-graph.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";

/** Receiver heads that name the current instance (VB spells it `Me`). */
export const SELF_HEADS: ReadonlySet<string> = new Set(["this", "self", "Self", "$this", "cls", "Me", "me"]);

/** Method names that construct an instance of their class. */
const CTOR_NAMES: ReadonlySet<string> = new Set(["constructor", "__init__", "__construct", "New", "new", "init", "initialize"]);

/** Is `method` a constructor of `cls` (named one, or Java/C#-style class-named)? */
export function isConstructor(method: FunctionInfo, cls: ClassInfo): boolean {
  return CTOR_NAMES.has(method.name) || method.name === cls.name;
}

/**
 * Put back the member calls `extractCalls` held as noise (`repo.find(…)`,
 * `notifier.send(…)` — see `restoreHeldCalls`) whose receiver has a DECLARED
 * object type in scope: a parameter, a typed local, or a field of the
 * enclosing class (own, promoted constructor parameter, or inherited from a
 * base class in the same file). On such a receiver the leaf is a method of a
 * class, not `Array#find` or `res.send`, and the linker can follow it.
 *
 * Run once per file, after extraction and before call classification. Calls
 * whose receiver type is unknown stay dropped — exactly the old behaviour —
 * so untyped code (plain JS, Ruby) sees no new noise.
 */
export function restoreTypedReceiverCalls(analysis: FileAnalysis, caseInsensitive = false): void {
  const language = analysis.language;
  const fold = (n: string): string => (caseInsensitive ? n.toLowerCase() : n);
  const declared = (type: string | null | undefined): boolean => receiverTypeName(type, language) !== null;
  const classByName = new Map(analysis.classes.map((c) => [c.name, c]));

  const membersOf = (cls: ClassInfo): Set<string> => {
    const names = new Set<string>();
    const seen = new Set<string>();
    for (let c: ClassInfo | undefined = cls; c && !seen.has(c.name); c = c.extends ? classByName.get(c.extends) : undefined) {
      seen.add(c.name);
      for (const p of c.properties) if (declared(p.type) || p.qualifier) names.add(fold(p.name));
      for (const m of c.methods) {
        if (!isConstructor(m, c)) continue;
        for (const p of m.params) if (declared(p.type) || p.qualifier) names.add(fold(p.name));
      }
    }
    return names;
  };

  const scopeOf = (fn: FunctionInfo, members: ReadonlySet<string>): Set<string> => {
    const names = new Set(members);
    for (const p of fn.params) if (declared(p.type) || p.qualifier) names.add(fold(p.name));
    for (const l of fn.localTypes ?? []) if (declared(l.type) || l.qualifier) names.add(fold(l.name));
    return names;
  };

  const restore = (fn: FunctionInfo, members: ReadonlySet<string>): void => {
    const scope = scopeOf(fn, members);
    restoreHeldCalls(fn.calls, (call) => receiverIn(call.name, scope, fold));
  };

  const none: ReadonlySet<string> = new Set();
  for (const fn of analysis.functions) restore(fn, none);
  for (const cls of analysis.classes) {
    const members = membersOf(cls);
    for (const m of cls.methods) restore(m, members);
  }
}

/** `repo.find` / `this.repo.find` / `self.repo.find` with `repo` in scope. */
function receiverIn(callName: string, scope: ReadonlySet<string>, fold: (n: string) => string): boolean {
  const parts = callName.split(".");
  if (parts.length < 2) return false;
  // `x?.find`, `x!.find`, `x!!.find` and a line-broken chain all call through `x`.
  let receiver = parts.slice(0, -1).map((seg) => seg.replace(/\s+/g, "").replace(/(?:\?|!+)$/, ""));
  if (receiver.length === 2 && SELF_HEADS.has(receiver[0]!)) receiver = receiver.slice(1);
  return receiver.length === 1 && scope.has(fold(receiver[0]!));
}

/**
 * The supertypes a class DECLARES — its base class and implemented
 * interfaces/protocols/traits/mixins. Entity extractors also list a model's
 * relation targets in `implements` (an EF `License` "implements" `Owner`
 * because it navigates to one); those are associations, not supertypes, and
 * are left out.
 */
export function declaredSupertypes(cls: ClassInfo, analysis: FileAnalysis): string[] {
  const related = new Set<string>();
  for (const r of analysis.entityRelations ?? []) if (r.fromEntity === cls.name) related.add(r.toEntity);
  const out: string[] = [];
  if (cls.extends) out.push(cls.extends);
  for (const i of cls.implements) if (!related.has(bareSupertypeName(i))) out.push(i);
  return out;
}

/** `Base<T>` / `App.Domain.IRepo` / `\\App\\Repo\\IRepo` / `Mod::Name` → the simple name. */
export function bareSupertypeName(raw: string | null | undefined): string {
  if (!raw) return "";
  const noGenerics = raw.replace(/[<[(].*$/s, "").trim();
  return noGenerics.split(/\\|::|\./).filter(Boolean).pop() ?? "";
}

/**
 * Could code in file `a` (language `langA`) name a type defined in file `b`?
 * Same language family by extension, or — where a format has no family
 * (`.prisma`, `.graphql`) — the same language. A Ruby model and a Prisma
 * model of the same name are unrelated.
 */
export function sameTypeSpace(a: string, langA: string, b: string, langB: string): boolean {
  const fa = extensionFamily(a);
  const fb = extensionFamily(b);
  if (fa && fb) return fa === fb;
  return langA === langB;
}
