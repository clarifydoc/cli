import { readFileSync } from "fs";
import { join } from "path";
import { FOREIGN_BINDING_READERS } from "../extractors/registry.js";
import type { ClassInfo, FileAnalysis, ForeignBindingRule, FunctionInfo, SubProject, SymbolLink } from "../types/analysis.js";

/**
 * Calls across a generated language bridge: a module a code generator writes
 * in one language (flutter_rust_bridge's `lib/src/rust/api/clubs.dart`,
 * wasm-pack's `pkg/club_wasm.js` — usually gitignored, so absent) exports
 * functions of another language's files under names of its own, and a call
 * through an import of that module runs that function:
 *
 *     import 'package:club/src/rust/api/contracts.dart' as contracts;   // Dart
 *     await contracts.renewContract(clubId: id);                          // → renew_contract in src/api/contracts.rs
 *
 * The plugins read the generators' configuration (`foreignBindings` →
 * `ForeignBindingRule`); this joins every call naming a function of a bound
 * module — through the import's prefix, or a name the import brings into
 * scope — to the implementing function the rule names so, and nothing else:
 * a namesake elsewhere in the project is not what the generated module calls,
 * so the guesses the linker made for those calls are dropped.
 */

export const FOREIGN_BINDING_STRATEGY = "dispatch:foreign-binding" as const;

const READ_LIMIT = 256 * 1024;

/** Each sub-project root's generator rules, as the plugins read them. */
export function collectForeignBindingRules(projectRoot: string, subProjects: readonly Pick<SubProject, "root">[], analyses: readonly FileAnalysis[]): ForeignBindingRule[] {
  if (FOREIGN_BINDING_READERS.length === 0) return [];
  const files = new Set(analyses.map((a) => a.filePath));
  const read = (path: string): string | undefined => {
    if (path.startsWith("..") || path.startsWith("/")) return undefined;
    try {
      const text = readFileSync(join(projectRoot, path), "utf8");
      return text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) : text;
    } catch {
      return undefined;
    }
  };
  const roots = new Set(["", ...subProjects.map((p) => p.root.replace(/\\/g, "/").replace(/\/+$/, ""))]);
  const out: ForeignBindingRule[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const reader of FOREIGN_BINDING_READERS) {
      let rules: ForeignBindingRule[];
      try {
        rules = reader(root, read, files);
      } catch {
        continue; // a malformed configuration says nothing
      }
      for (const r of rules) {
        const key = `${r.tool}\0${r.source}\0${r.output}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(r);
        }
      }
    }
  }
  return out;
}

interface Bound {
  file: string;
  symbol: string;
  line: number;
}

/** A generated class (`#[wasm_bindgen] struct`): what constructing it runs, and the methods its `impl` exports. */
interface BoundClass {
  self: Bound;
  ctor: Bound | null;
  methods: Map<string, Bound | null>;
}

interface BoundModule {
  rule: ForeignBindingRule;
  names: Map<string, Bound | null>;
  classes: Map<string, BoundClass | null>;
}

const sameBound = (a: Bound, b: Bound) => a.file === b.file && a.symbol === b.symbol && a.line === b.line;

/** `map[name]` = `bound`, or null once two different declarations bind the name. */
function setBound<T extends Bound | BoundClass>(map: Map<string, T | null>, name: string, bound: T, same: (a: T, b: T) => boolean): void {
  const prior = map.get(name);
  map.set(name, prior === undefined ? bound : prior && same(prior, bound) ? prior : null);
}

const camel = (name: string) => name.replace(/^_+/, "").replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `wasm_bindgen(js_name = renewContract)` → `{ name: "wasm_bindgen", args: { js_name: "renewContract" }, flags: [] }`. */
function decoratorArgs(written: string): { name: string; named: Map<string, string>; flags: Set<string> } {
  const m = /^\s*([\w:]+)\s*(?:\((.*)\))?\s*$/s.exec(written);
  const named = new Map<string, string>();
  const flags = new Set<string>();
  for (const part of (m?.[2] ?? "").split(",")) {
    const kv = /^\s*(\w+)\s*=\s*"?([^"]*?)"?\s*$/.exec(part);
    if (kv) named.set(kv[1]!, kv[2]!);
    else if (part.trim()) flags.add(part.trim());
  }
  return { name: m?.[1]?.split("::").pop() ?? "", named, flags };
}

/** The name a rule binds a function under, or null when it binds none. */
function boundName(fn: Pick<FunctionInfo, "name" | "isExported" | "decorators">, rule: ForeignBindingRule): string | null {
  if (!fn.isExported) return null;
  const spec = rule.decorator;
  let rename: string | undefined;
  if (spec) {
    const own = (fn.decorators ?? []).map(decoratorArgs).filter((d) => d.name === spec.name);
    if (spec.required && own.length === 0) return null;
    for (const d of own) {
      if (spec.skipArgument && d.flags.has(spec.skipArgument)) return null;
      if (spec.renameArgument) rename ??= d.named.get(spec.renameArgument);
    }
  }
  if (rename) return rename;
  return rule.rename === "camel" ? camel(fn.name) : fn.name;
}

/** True when the function carries the generator's attribute with the constructor flag (`#[wasm_bindgen(constructor)]`). */
function isConstructor(fn: Pick<FunctionInfo, "decorators">, rule: ForeignBindingRule): boolean {
  const spec = rule.decorator;
  if (!spec?.constructorArgument) return false;
  return (fn.decorators ?? []).map(decoratorArgs).some((d) => d.name === spec.name && d.flags.has(spec.constructorArgument!));
}

/** The class a type names, without its generics or an async wrapper: `Promise<SquadIndex>`, `SquadIndex | null`, `w.SquadIndex`. */
function typeLeaf(type: string): string | null {
  const unwrapped = type.replace(/^\s*(?:Promise|Awaited)<(.*)>\s*$/s, "$1");
  return /^\s*([\w$]+(?:\.[\w$]+)*)\s*(?:<.*>)?\s*(?:\|\s*(?:null|undefined)\s*)*$/s.exec(unwrapped)?.[1] ?? null;
}

/** The generated module (path without extension) each implementing file is written to under `rule`, or null. */
function moduleOf(file: string, rule: ForeignBindingRule): string | null {
  if (!file.endsWith(rule.sourceExtension)) return null;
  const stem = file.slice(0, -rule.sourceExtension.length);
  if (rule.single) return stem === rule.source || file.startsWith(`${rule.source}/`) ? rule.output : null;
  if (stem === rule.source) return rule.output;
  if (!file.startsWith(`${rule.source}/`)) return null;
  const rel = file.slice(rule.source.length + 1);
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  // `clubs/mod.rs` is the module `clubs`; the root's own `lib.rs` is the output itself.
  if (rule.indexFiles?.includes(base)) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    return dir ? `${rule.output}/${dir}` : rule.output;
  }
  return `${rule.output}/${rel.slice(0, -rule.sourceExtension.length)}`;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * The classes a file declares that the generator binds (a `#[wasm_bindgen] struct`), each with its constructor and
 * the methods carrying the attribute — those of the struct's `impl` blocks, in this file or another. A class's
 * `impl` in a file apart from the struct (`ClassInfo.extension`) adds its methods to the class bound by that name.
 */
function bindClasses(a: FileAnalysis, rule: ForeignBindingRule, entry: BoundModule, extensions: boolean): void {
  const methodsOf = (cls: ClassInfo, into: BoundClass): void => {
    for (const m of cls.methods) {
      const bound: Bound = { file: a.filePath, symbol: `${cls.name}.${m.name}`, line: m.line };
      if (isConstructor(m, rule)) {
        if (m.isExported) into.ctor = into.ctor === null ? bound : into.ctor;
        continue;
      }
      const name = boundName(m, rule);
      if (name) setBound(into.methods, name, bound, sameBound);
    }
  };
  if (extensions) {
    for (const cls of a.classes) {
      if (!cls.extension) continue;
      for (const bound of entry.classes.values()) if (bound && bound.self.symbol === cls.name && bound.self.file !== a.filePath) methodsOf(cls, bound);
    }
    return;
  }
  for (const cls of a.classes) {
    if (cls.extension) continue;
    const name = boundName(cls, rule);
    if (!name) continue;
    const bound: BoundClass = { self: { file: a.filePath, symbol: cls.name, line: cls.line }, ctor: null, methods: new Map() };
    methodsOf(cls, bound);
    setBound(entry.classes, name, bound, (x, y) => x.self.file === y.self.file && x.self.line === y.self.line);
  }
}

/**
 * Links from each call through a bound module to the function it runs. A name two implementing files bind in
 * one module joins neither.
 */
export function foreignBindingLinks(analyses: readonly FileAnalysis[], rules: readonly ForeignBindingRule[]): SymbolLink[] {
  if (rules.length === 0) return [];
  // module path → bound name → function (null when two bind it).
  const modules = new Map<string, BoundModule>();
  for (const rule of rules) {
    for (const a of analyses) {
      const mod = moduleOf(a.filePath, rule);
      if (mod === null) continue;
      const entry = modules.get(mod) ?? modules.set(mod, { rule, names: new Map(), classes: new Map() }).get(mod)!;
      for (const fn of a.functions) {
        const name = boundName(fn, rule);
        if (name) setBound(entry.names, name, { file: a.filePath, symbol: fn.name, line: fn.line }, sameBound);
      }
      if (rule.decorator?.classes && rule.decorator.required) bindClasses(a, rule, entry, false);
    }
  }
  // An `impl` apart from its struct's file, then the name each class answers to: its constructor, else the class.
  for (const rule of rules) {
    if (!rule.decorator?.classes || !rule.decorator.required) continue;
    for (const a of analyses) {
      const mod = moduleOf(a.filePath, rule);
      if (mod !== null && a.classes.some((c) => c.extension)) bindClasses(a, rule, modules.get(mod)!, true);
    }
  }
  for (const entry of modules.values()) {
    for (const [name, cls] of entry.classes) {
      const prior = entry.names.get(name);
      entry.names.set(name, cls === null || prior !== undefined ? null : cls.ctor ?? cls.self);
    }
  }
  if (modules.size === 0) return [];
  const spelled = new Map<string, string>();
  for (const [mod, { rule }] of modules) {
    if (!rule.importPrefix) continue;
    const rel = mod === rule.output ? "" : mod.slice(rule.output.length + 1);
    spelled.set(`${rule.importPrefix}${rel ? `/${rel}` : ""}${rule.outputExtension}`, mod);
  }
  /** The bound module an import names: by its package spelling, or a relative path with or without the extension. */
  const moduleNamed = (importer: string, source: string): string | null => {
    const bySpelling = spelled.get(source);
    if (bySpelling) return bySpelling;
    if (!source.startsWith(".")) return null;
    const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
    const path = normalize(`${dir}/${source}`);
    if (modules.has(path)) return path;
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : null;
    return stem !== null && modules.has(stem) && path.slice(dot) === modules.get(stem)!.rule.outputExtension ? stem : null;
  };

  const links: SymbolLink[] = [];
  for (const a of analyses) {
    if (!a.imports?.length) continue;
    // Prefixes (`as contracts`, `* as club`) and names in scope, each to its module.
    const prefixes = new Map<string, string>();
    const named = new Map<string, { mod: string; exported: string }>();
    const scopes: Array<{ mod: string; names?: string[]; except?: string[] }> = [];
    // The modules this file imports, and the names its other imports bring in (a namesake class is theirs).
    const boundMods = new Set<string>();
    const foreignNames = new Set<string>();
    let bound = false;
    for (const imp of a.imports) {
      const mod = moduleNamed(a.filePath, imp.source);
      if (!mod) {
        for (const spec of imp.specifiers) foreignNames.add(spec);
        continue;
      }
      bound = true;
      boundMods.add(mod);
      const names = modules.get(mod)!.names;
      if (imp.inScope) scopes.push({ mod, ...(imp.inScope.names ? { names: imp.inScope.names } : {}), ...(imp.inScope.except ? { except: imp.inScope.except } : {}) });
      for (const spec of imp.specifiers) {
        const exported = imp.aliases?.[spec] ?? spec;
        // A name the module binds is that function; any other name an import binds is the module's prefix.
        if (!imp.isNamespace && !imp.isDefault && names.has(exported)) named.set(spec, { mod, exported });
        else if (imp.isNamespace || (!imp.inScope && !imp.isDefault && /^[a-z_]/.test(spec))) prefixes.set(spec, mod);
      }
    }
    if (!bound) continue;
    // A call of a module's member where the module is loaded in place (`(await import("./pkg/club")).listClubs()`)
    // names the module as its `target`.
    const loaded = (call: { name: string; target?: string | null }): Bound | null => {
      if (!call.target || call.name.includes(".")) return null;
      const mod = moduleNamed(a.filePath, call.target);
      return mod ? modules.get(mod)!.names.get(call.name) ?? null : null;
    };
    const own = new Set([...a.functions.map((f) => f.name), ...a.classes.filter((c) => !c.extension).map((c) => c.name)]);
    /** The generated class a type names where this file reads it: imported by name, through a namespace, or the one a bound module it loads declares. */
    const classNamed = (type: string | null | undefined): BoundClass | null => {
      const leaf = type ? typeLeaf(type) : null;
      if (!leaf) return null;
      const dot = leaf.lastIndexOf(".");
      if (dot > 0) {
        const mod = prefixes.get(leaf.slice(0, dot));
        return mod ? modules.get(mod)!.classes.get(leaf.slice(dot + 1)) ?? null : null;
      }
      const hit = named.get(leaf);
      if (hit) return modules.get(hit.mod)!.classes.get(hit.exported) ?? null;
      if (own.has(leaf) || foreignNames.has(leaf)) return null;
      const found = new Set<BoundClass>();
      for (const mod of boundMods) {
        const cls = modules.get(mod)!.classes.get(leaf);
        if (cls) found.add(cls);
      }
      return found.size === 1 ? [...found][0]! : null;
    };
    /** The type a function states for a local or parameter (one type only). */
    const typeOfLocal = (fn: FunctionInfo, name: string): string | null => {
      const types = new Set<string>();
      for (const l of fn.localTypes ?? []) if (l.name === name && l.type) types.add(l.type);
      for (const p of fn.params ?? []) if (p.name === name && p.type) types.add(p.type);
      return types.size === 1 ? [...types][0]! : null;
    };
    const target = (written: string, fn: FunctionInfo, owner: ClassInfo | null): Bound | null => {
      // `(await this.index).search()`: the member of what a promised receiver settles to.
      const awaited = /^\(await\s+([\w$]+(?:\.[\w$]+)*)\)\.([\w$]+)$/.exec(written);
      const callName = awaited ? `${awaited[1]}.${awaited[2]}` : written;
      const parts = callName.split(".");
      if (parts.length === 2 || parts.length === 3) {
        const [head, second, third] = parts as [string, string, string | undefined];
        const mod = prefixes.get(head);
        // `club.listClubs()` of a namespace import; `club.SquadIndex.create()` of one of its classes.
        if (mod && third === undefined) return modules.get(mod)!.names.get(second) ?? null;
        if (mod && third !== undefined) return modules.get(mod)!.classes.get(second)?.methods.get(third) ?? null;
        if (third === undefined) {
          // `SquadIndex.create()` (static) or `idx.search()` on a local the file types.
          const hit = named.get(head);
          const cls = hit ? classNamed(head) : classNamed(typeOfLocal(fn, head));
          return cls?.methods.get(second) ?? null;
        }
        // `this.index.search()` on a field the class types.
        if (head === "this" && owner) return classNamed(owner.properties.find((p) => p.name === second)?.type)?.methods.get(third) ?? null;
        return null;
      }
      if (parts.length > 1) return null;
      const hit = named.get(callName);
      if (hit) return modules.get(hit.mod)!.names.get(hit.exported) ?? null;
      if (own.has(callName)) return null;
      const found = scopes
        .filter((s) => (!s.names || s.names.includes(callName)) && !s.except?.includes(callName))
        .map((s) => modules.get(s.mod)!.names.get(callName))
        .filter((b): b is Bound => !!b);
      return found.length === 1 ? found[0]! : null;
    };
    const callers: Array<{ symbol: string; fn: FunctionInfo; owner: ClassInfo | null }> = [
      ...a.functions.map((fn) => ({ symbol: fn.name, fn, owner: null })),
      ...a.classes.flatMap((c) => c.methods.map((fn) => ({ symbol: `${c.name}.${fn.name}`, fn, owner: c }))),
    ];
    for (const { symbol, fn, owner } of callers) {
      for (const call of fn.calls) {
        const hit = loaded(call) ?? target(call.name, fn, owner);
        if (!hit) continue;
        links.push({
          sourceFile: a.filePath,
          sourceSymbol: symbol,
          sourceLine: call.line,
          callName: call.name,
          targetFile: hit.file,
          targetSymbol: hit.symbol,
          targetLine: hit.line,
          confidence: "EXTRACTED",
          strategy: FOREIGN_BINDING_STRATEGY,
          relation: "calls",
        });
      }
    }
  }
  return links;
}

/**
 * `links` with the bridge's links in place of what the linker guessed for the same calls (a namesake method of
 * an unrelated class, a same-named function elsewhere): the generated module states what each call runs.
 */
export function withForeignBindingLinks(links: SymbolLink[], bridged: readonly SymbolLink[]): SymbolLink[] {
  if (bridged.length === 0) return links;
  const key = (l: SymbolLink) => `${l.sourceFile}\0${l.sourceLine}\0${l.callName}`;
  const calls = new Set(bridged.map(key));
  return [...links.filter((l) => !calls.has(key(l))), ...bridged];
}
