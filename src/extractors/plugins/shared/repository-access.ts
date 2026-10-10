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
 * field, bases — to the repository type, takes the entity-typed argument of
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
        found = written(cls.properties.find((p) => knobs.memberKey(p.name) === wanted)?.type);
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

  const resolveChain = (segments: string[], startType: string | null): string | null => {
    let type = startType;
    for (const seg of segments) {
      const owner = bare(type);
      if (!owner) return null;
      type = typeOfMember(owner, seg);
    }
    return type;
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
        const head = parts[0]!;
        let type: string | null;
        if (knobs.selfHeads.has(head)) {
          type = owner ? resolveChain(parts.slice(1, -1), owner.name) : null;
        } else {
          // A typed parameter or local, else a member of the enclosing class named without `this`.
          const start = written(fn.params.find((p) => p.name === head)?.type ?? fn.localTypes?.find((l) => l.name === head)?.type)
            ?? (owner ? typeOfMember(owner.name, head) : null);
          type = start ? resolveChain(parts.slice(1, -1), start) : null;
        }
        const entity = repoEntity(type);
        if (!entity) continue;
        const key = `${call.line}\0${call.name}`;
        const row: DataSourceInfo = {
          kind: "database",
          name: call.name,
          target: entity,
          entity,
          access: knobs.writeVerbs.test(leaf) ? "write" : "read",
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
