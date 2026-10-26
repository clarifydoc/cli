import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, Language } from "../../../types/analysis.js";
import { receiverTypeName } from "../../shared/type-parser.js";

/**
 * The repository pattern over a generic base, as a project-level pass any
 * plugin can run from its entity extractor's `reconcileProject`:
 *
 *   C#      `IMovieRepository : IBasicRepository<Movie>` … `_movieRepository.Get(id)`
 *   Python  `RepositoryRecipes(HouseholdRepositoryGeneric[Recipe, RecipeModel])` …
 *           `self.repos.recipes.create(…)` through `repos: AllRepositories` and
 *           `@cached_property def recipes(self) -> RepositoryRecipes`
 *
 * The data access lives in a base class whose type parameter is unknown
 * there, so a call through the repository reached no entity. This walks the
 * typed member chain across files — property annotations, constructor
 * parameters, method return types, a memoizing property's `_name` backing
 * field, bases, a local initialized by a call (typed by what the callee
 * declares it returns) — to the repository type, takes the entity-typed argument of
 * its generic base (else the first argument that is a project class), and
 * puts it on every CRUD-shaped call through the chain. A row the per-file pass
 * already emitted at that call is upgraded in place. The knobs are what differs
 * between languages: how a generic is spelled, what `this` is called, how a
 * constructor is named, which verbs count.
 */
export interface RepositoryAccessKnobs {
  language: Language;
  /** Type arguments when `written` is a repository generic (`IBasicRepository<Movie>`, `Generic[A, B]`), else null. */
  genericArgs(written: string): string[] | null;
  /** Receiver heads that mean the enclosing instance (`this`, `self`). */
  selfHeads: ReadonlySet<string>;
  /** How a member is named at the call versus its declaration (`_movieRepository` ↔ `movieRepository`). */
  memberKey(name: string): string;
  isConstructor(method: FunctionInfo, cls: ClassInfo): boolean;
  /** Generic types an awaited call's result is wrapped in (`Task`, `ValueTask`). */
  asyncResultTypes?: readonly string[];
  /** CRUD-shaped leaf verbs, and the subset that writes. */
  verbs: RegExp;
  writeVerbs: RegExp;
}

export function attributeRepositoryAccesses(analyses: FileAnalysis[], knobs: RepositoryAccessKnobs): void {
  const own = analyses.filter((a) => a.language === knobs.language);
  // Every declaration of a name: a partial class, an interface redeclared per
  // service, a struct split across files — the member or base may be in any.
  const classes = new Map<string, ClassInfo[]>();
  const entities = new Set<string>();
  for (const a of own) {
    for (const cls of a.classes ?? []) {
      const list = classes.get(cls.name) ?? [];
      list.push(cls);
      classes.set(cls.name, list);
      if (cls.decorators?.includes("entity")) entities.add(cls.name);
    }
  }
  if (classes.size === 0) return;
  const functionsNamed = new Map<string, FunctionInfo[]>();
  for (const a of own) for (const f of a.functions ?? []) (functionsNamed.get(f.name) ?? functionsNamed.set(f.name, []).get(f.name)!).push(f);
  const bare = (type: string | null | undefined): string | null => receiverTypeName(type, knobs.language);
  const basesOf = (name: string): string[] =>
    (classes.get(name) ?? []).flatMap((cls) => [cls.extends ?? "", ...(cls.implements ?? [])]).filter(Boolean);

  const written = (type: string | null | undefined): string | null => {
    const t = type?.trim();
    return t && bare(t) ? t : null;
  };
  /** Declared type of `member` on `className` — as written, generics kept — through bases; memoized per pair. */
  const memberTypes = new Map<string, string | null>();
  const typeOfMember = (className: string, member: string, depth = 0): string | null => {
    const key = `${className}\0${member}`;
    if (memberTypes.has(key)) return memberTypes.get(key)!;
    memberTypes.set(key, null); // cycle guard
    let found: string | null = null;
    if (depth <= 6) {
      const wanted = knobs.memberKey(member);
      for (const cls of classes.get(className) ?? []) {
        const prop = cls.properties.find((p) => knobs.memberKey(p.name) === wanted);
        found = written(prop?.type);
        // A computed member typed by the chain it returns or is assigned (`return self.repos.tags`).
        if (!found && prop?.from) {
          const [head, ...rest] = prop.from.split(".");
          if (knobs.selfHeads.has(head!) && rest.every((s) => /^[\w$]+$/.test(s))) found = resolveChain(rest, className, depth + 1);
          // A chain on a function's result (`get_repositories().recipes`): from the class it returns.
          const fn = /^(\w+)\(\)$/.exec(head!)?.[1];
          if (fn && rest.every((s) => /^[\w$]+$/.test(s))) {
            const returns = [...new Set((functionsNamed.get(fn) ?? []).map((f) => written(f.returnType)).filter((t): t is string => !!t))];
            if (returns.length === 1) found = resolveChain(rest, returns[0]!, depth + 1);
          }
        }
        if (!found) {
          const method = cls.methods.find((m) => m.name === member);
          if (method) {
            found = written(method.returnType) ?? written(cls.properties.find((p) => p.name === `_${member}`)?.type);
          }
        }
        if (!found) {
          const ctor = cls.methods.find((m) => knobs.isConstructor(m, cls));
          found = written(ctor?.params.find((p) => knobs.memberKey(p.name) === wanted)?.type);
        }
        if (found) break;
      }
      if (!found) {
        for (const base of basesOf(className)) {
          found = typeOfMember(bare(base) ?? "", member, depth + 1);
          if (found) break;
        }
      }
    }
    memberTypes.set(key, found);
    return found;
  };

  /** The entity-typed argument of a repository generic as written, else the first argument that is a project class. */
  const entityArg = (type: string): string | null => {
    const args = knobs.genericArgs(type)?.map((x) => bare(x)).filter((x): x is string => !!x);
    return args ? (args.find((x) => entities.has(x)) ?? args.find((x) => classes.has(x)) ?? null) : null;
  };
  /** The entity a type works on: the generic's own argument (`IRepository<Order>`), else that of a base, through bases. */
  const repoEntities = new Map<string, string | null>();
  const repoEntity = (type: string | null): string | null => {
    if (!type) return null;
    if (repoEntities.has(type)) return repoEntities.get(type)!;
    repoEntities.set(type, null); // cycle guard
    let found = entityArg(type);
    for (const base of found ? [] : basesOf(bare(type) ?? "")) {
      found = repoEntity(base);
      if (found) break;
    }
    repoEntities.set(type, found);
    return found;
  };

  function resolveChain(segments: string[], startType: string | null, depth = 0): string | null {
    let type = startType;
    for (const seg of segments) {
      const owner = bare(type);
      if (!owner) return null;
      type = typeOfMember(owner, seg, depth);
    }
    return type;
  }

  const awaitedType = (type: string | null): string | null => {
    const m = type ? /^([\w.]+)\s*<(.+)>$/.exec(type.trim()) : null;
    return m && knobs.asyncResultTypes?.includes(m[1]!.slice(m[1]!.lastIndexOf(".") + 1)) ? m[2]!.trim() : type;
  };
  /** The type a receiver head names in `fn`: a typed parameter or local, a member of the enclosing class. */
  const headType = (head: string, fn: FunctionInfo, owner: ClassInfo | null, depth = 0): string | null => {
    if (knobs.selfHeads.has(head)) return owner?.name ?? null;
    const param = written(fn.params.find((p) => p.name === head)?.type);
    if (param) return param;
    const locals = (fn.localTypes ?? []).filter((l) => l.name === head);
    const typed = written(locals.find((l) => l.type)?.type);
    if (typed) return typed;
    // `var ctx = await GetContext(id)`: what the called member declares it
    // returns — every initializer must agree.
    if (locals.length > 0 && depth < 3 && locals.every((l) => l.from)) {
      const types = new Set(locals.map((l) => fromType(l.from!, l.awaited === true, fn, owner, depth + 1)));
      if (types.size === 1) return [...types][0]!;
      return null;
    }
    return owner ? typeOfMember(owner.name, head) : null;
  };
  /** What method `name` of `className` declares it returns, as written, through bases. */
  const returnTypeOf = (className: string | null, name: string, depth = 0): string | null => {
    if (!className || depth > 6) return null;
    for (const cls of classes.get(className) ?? []) {
      const declared = cls.methods.find((m) => m.name === name)?.returnType?.trim();
      if (declared) return declared;
    }
    for (const base of basesOf(className)) {
      const found = returnTypeOf(bare(base), name, depth + 1);
      if (found) return found;
    }
    return null;
  };
  /** The declared result of a call chain as `localTypes[].from` spells it (`a.b.Get()`). */
  const fromType = (from: string, awaited: boolean, fn: FunctionInfo, owner: ClassInfo | null, depth: number): string | null => {
    const parts = from.replace(/\(\)/g, "").split(".");
    if (parts.some((p) => !/^[\w$]+$/.test(p))) return null;
    const receiver = parts.length === 1 ? owner?.name ?? null : bare(resolveChain(parts.slice(1, -1), headType(parts[0]!, fn, owner, depth)));
    let declared = returnTypeOf(receiver, parts[parts.length - 1]!);
    // A free function (`db = get_repositories(session)`): what every declaration of that name returns.
    if (!declared && parts.length === 1) {
      const returns = [...new Set((functionsNamed.get(parts[0]!) ?? []).map((f) => written(f.returnType)).filter((t): t is string => !!t))];
      if (returns.length === 1) declared = returns[0]!;
    }
    return written(awaited ? awaitedType(declared) : declared);
  };

  /** The first declaration `pick` finds on `className`, through bases. */
  const findOn = <T>(className: string | null, pick: (cls: ClassInfo) => T | undefined, depth = 0): T | null => {
    if (!className || depth > 6) return null;
    for (const cls of classes.get(className) ?? []) {
      const found = pick(cls);
      if (found !== undefined) return found;
    }
    for (const base of basesOf(className)) {
      const found = findOn(bare(base), pick, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  /**
   * A wrapper handed the repository when it is built (`return HttpRepo(self.repo,
   * self.logger)`): its method `leaf` calls `self.repo.<verb>` on the field its
   * constructor takes under that name, so the call reaches the entity of the
   * argument the member was built with — resolved on `ownerType`, the instance
   * that reads the member, where a subclass names its own repository.
   */
  const wrappedAccess = (ownerType: string | null, member: string, leaf: string): { entity: string; write: boolean } | null => {
    const owner = bare(ownerType);
    const wanted = knobs.memberKey(member);
    const prop = findOn(owner, (cls) => cls.properties.find((p) => knobs.memberKey(p.name) === wanted && p.constructedWith?.length));
    const wrapper = bare(prop?.type);
    if (!prop || !wrapper || !owner) return null;
    const method = findOn(wrapper, (cls) => cls.methods.find((m) => m.name === leaf));
    const ctor = findOn(wrapper, (cls) => cls.methods.find((m) => knobs.isConstructor(m, cls)));
    if (!method || !ctor) return null;
    let entity: string | null = null;
    let write = false;
    for (const inner of method.calls ?? []) {
      const segs = inner.name.split(".");
      if (segs.length !== 3 || !knobs.selfHeads.has(segs[0]!) || !knobs.verbs.test(segs[2]!)) continue;
      const at = ctor.params.findIndex((p) => knobs.memberKey(p.name) === knobs.memberKey(segs[1]!));
      const arg = (at >= 0 ? prop.constructedWith![at] : undefined)?.split(".");
      if (!arg || !knobs.selfHeads.has(arg[0]!) || arg.some((x) => !/^[\w$]+$/.test(x))) continue;
      const found = repoEntity(resolveChain(arg.slice(1), owner));
      if (!found || (entity && found !== entity)) return null;
      entity = found;
      if (knobs.writeVerbs.test(segs[2]!)) write = true;
    }
    return entity ? { entity, write } : null;
  };

  for (const a of own) {
    let changed = false;
    const rows = [...(a.dataSources ?? [])];
    const index = new Map(rows.map((d, i) => [`${d.line}\0${d.name}`, i]));
    const visit = (fn: FunctionInfo, owner: ClassInfo | null): void => {
      for (const call of fn.calls ?? []) {
        if (!call.name.includes(".")) continue;
        const parts = call.name.split(".");
        if (parts.some((p) => /[^\w$]/.test(p))) continue;
        const leaf = parts[parts.length - 1]!;
        if (!knobs.verbs.test(leaf)) continue;
        // A typed parameter or local, else a member of the enclosing class named without `this`.
        const start = headType(parts[0]!, fn, owner);
        const type = start ? resolveChain(parts.slice(1, -1), start) : null;
        let entity = repoEntity(type);
        let write = knobs.writeVerbs.test(leaf);
        if (!entity && start && parts.length >= 3) {
          const wrapped = wrappedAccess(resolveChain(parts.slice(1, -2), start), parts[parts.length - 2]!, leaf);
          if (wrapped) ({ entity, write } = wrapped);
        }
        if (!entity) continue;
        const key = `${call.line}\0${call.name}`;
        const row: DataSourceInfo = {
          kind: "database",
          name: call.name,
          target: entity,
          entity,
          access: write ? "write" : "read",
          calls: [],
          line: call.line,
        };
        const at = index.get(key);
        if (at !== undefined) rows[at] = { ...rows[at]!, ...row };
        else { index.set(key, rows.length); rows.push(row); }
        changed = true;
      }
    };
    for (const fn of a.functions ?? []) visit(fn, null);
    for (const cls of a.classes ?? []) for (const m of cls.methods ?? []) visit(m, cls);
    if (changed) a.dataSources = rows.sort((x, y) => x.line - y.line);
  }
}

/** Top-level type arguments of `<…>` / `[…]` text: `A, Dict[str, B]` → `["A", "Dict[str, B]"]`. */
export function splitTypeArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "[" || c === "(") depth++;
    else if (c === ">" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}
