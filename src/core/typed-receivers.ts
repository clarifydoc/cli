import type { ClassInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { restoreHeldCalls } from "../extractors/shared/call-graph.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { manifestFor, pluginFor } from "../extractors/registry.js";

/** Receiver heads that name the current instance (VB spells it `Me`). */
export const SELF_HEADS: ReadonlySet<string> = new Set(["this", "self", "Self", "$this", "cls", "Me", "me"]);

/** Method names that construct an instance of their class. */
const CTOR_NAMES: ReadonlySet<string> = new Set(["constructor", "__init__", "__construct", "New", "new", "init", "initialize"]);

/** Is `method` a constructor of `cls` (named one, or Java/C#-style class-named)? */
export function isConstructor(method: FunctionInfo, cls: ClassInfo): boolean {
  // A nested class named by its path (`Paddock::Iterator`) is constructed by its own name.
  return CTOR_NAMES.has(method.name) || method.name === cls.name || method.name === cls.name.slice(cls.name.lastIndexOf("::") + 2);
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
 * so untyped code (plain JS, Ruby) sees no new noise. A call of the enclosing
 * class's own method (`this.send(…)`, and a bare `send(…)` where members need
 * no `this.`) — declared by it or a base class in the same file — comes back too.
 */
export function restoreTypedReceiverCalls(analysis: FileAnalysis, caseInsensitive = false): void {
  const language = analysis.language;
  const bareIsMember = pluginFor(language)?.explicitSelfMembers !== true;
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

  const methodsOf = (cls: ClassInfo): Set<string> => {
    const names = new Set<string>();
    const seen = new Set<string>();
    for (let c: ClassInfo | undefined = cls; c && !seen.has(c.name); c = c.extends ? classByName.get(c.extends) : undefined) {
      seen.add(c.name);
      for (const m of c.methods) if (!isConstructor(m, c)) names.add(fold(m.name));
    }
    return names;
  };

  // A class the file can name: one it declares, one an import binds (where imports name what a
  // module uses), or — where a package's types need no import — any name shaped like a type.
  const bindsNames = manifestFor(language)?.importsBindNames !== undefined;
  const imported = new Set<string>();
  for (const imp of analysis.imports) for (const n of [...imp.specifiers, ...Object.keys(imp.aliases ?? {})]) imported.add(fold(n));
  const namesClass = (head: string): boolean => {
    if (!TYPE_SHAPED.test(head) || receiverTypeName(head, language) === null) return false;
    return classByName.has(head) || imported.has(fold(head)) || !bindsNames;
  };

  const restore = (fn: FunctionInfo, members: ReadonlySet<string>, own: ReadonlySet<string>): void => {
    const scope = scopeOf(fn, members);
    restoreHeldCalls(
      fn.calls,
      (call) => receiverIn(call.name, scope, fold) || ownMethodCall(call.name, own, bareIsMember, fold) || classReceiver(call.name, scope, fold, namesClass),
    );
  };

  const none: ReadonlySet<string> = new Set();
  for (const fn of analysis.functions) restore(fn, none, none);
  for (const cls of analysis.classes) {
    const members = membersOf(cls);
    const own = methodsOf(cls);
    for (const m of cls.methods) restore(m, members, own);
  }
}

/** `send` / `this.send` naming a method of the enclosing class (a bare name only where members need no `this.`). */
function ownMethodCall(callName: string, own: ReadonlySet<string>, bareIsMember: boolean, fold: (n: string) => string): boolean {
  if (own.size === 0) return false;
  const parts = callName.split(".");
  if (parts.length === 1) return bareIsMember && own.has(fold(parts[0]!));
  return parts.length === 2 && SELF_HEADS.has(parts[0]!) && own.has(fold(parts[1]!));
}

/** A type's spelling: capitalized, with a lower-case letter (`ClubStore`, never a `LOG` constant). */
const TYPE_SHAPED = /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;

/**
 * `ClubStore.find(…)` — a static call on a class (no name in scope spells the
 * head): the leaf is the class's method, never `Array#find` or a logger's
 * `log`. Whether the project declares the class is the linker's to say.
 */
function classReceiver(callName: string, scope: ReadonlySet<string>, fold: (n: string) => string, namesClass: (head: string) => boolean): boolean {
  const parts = callName.split(".");
  return parts.length === 2 && !scope.has(fold(parts[0]!)) && namesClass(parts[0]!);
}

/**
 * `repo.find` / `this.repo.find` / `self.repo.find` with `repo` in scope; and a method on a chain whose head is
 * typed — a type's function (`Season.named().close`) or a member of a name in scope (`repo.find().close`) —
 * which the linker types step by step through declared return types.
 */
function receiverIn(callName: string, scope: ReadonlySet<string>, fold: (n: string) => string): boolean {
  const parts = callName.split(".");
  if (parts.length < 2) return false;
  const call = parts.findIndex((p) => p.endsWith("()"));
  if (call >= 0 && call < parts.length - 1) {
    const head = parts.slice(0, call + 1).map((p) => p.replace(/\(\)$/, ""));
    if (head.length >= 2 && /^[A-Z]/.test(head[0]!)) return true;
    const names = head.length >= 2 && SELF_HEADS.has(head[0]!) ? head.slice(1) : head;
    return names.length === 2 && scope.has(fold(names[0]!));
  }
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
