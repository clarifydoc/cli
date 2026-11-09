import { readFileSync } from "fs";
import { join } from "path";
import { FOREIGN_BINDING_READERS } from "../extractors/registry.js";
import type { FileAnalysis, ForeignBindingRule, FunctionInfo, SubProject, SymbolLink } from "../types/analysis.js";

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
  fn: FunctionInfo;
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
function boundName(fn: FunctionInfo, rule: ForeignBindingRule): string | null {
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
 * Links from each call through a bound module to the function it runs. A name two implementing files bind in
 * one module joins neither.
 */
export function foreignBindingLinks(analyses: readonly FileAnalysis[], rules: readonly ForeignBindingRule[]): SymbolLink[] {
  if (rules.length === 0) return [];
  // module path → bound name → function (null when two bind it).
  const modules = new Map<string, { rule: ForeignBindingRule; names: Map<string, Bound | null> }>();
  for (const rule of rules) {
    for (const a of analyses) {
      const mod = moduleOf(a.filePath, rule);
      if (mod === null) continue;
      const entry = modules.get(mod) ?? modules.set(mod, { rule, names: new Map() }).get(mod)!;
      for (const fn of a.functions) {
        const name = boundName(fn, rule);
        if (!name) continue;
        const prior = entry.names.get(name);
        entry.names.set(name, prior === undefined ? { file: a.filePath, fn } : prior && prior.file === a.filePath && prior.fn === fn ? prior : null);
      }
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
    for (const imp of a.imports) {
      const mod = moduleNamed(a.filePath, imp.source);
      if (!mod) continue;
      const names = modules.get(mod)!.names;
      if (imp.inScope) scopes.push({ mod, ...(imp.inScope.names ? { names: imp.inScope.names } : {}), ...(imp.inScope.except ? { except: imp.inScope.except } : {}) });
      for (const spec of imp.specifiers) {
        const exported = imp.aliases?.[spec] ?? spec;
        // A name the module binds is that function; any other name an import binds is the module's prefix.
        if (!imp.isNamespace && !imp.isDefault && names.has(exported)) named.set(spec, { mod, exported });
        else if (imp.isNamespace || (!imp.inScope && !imp.isDefault && /^[a-z_]/.test(spec))) prefixes.set(spec, mod);
      }
    }
    if (prefixes.size === 0 && named.size === 0 && scopes.length === 0) continue;
    const own = new Set(a.functions.map((f) => f.name));
    const target = (callName: string): Bound | null => {
      const dot = callName.indexOf(".");
      if (dot > 0) {
        const mod = prefixes.get(callName.slice(0, dot));
        const member = callName.slice(dot + 1);
        return mod && !member.includes(".") ? modules.get(mod)!.names.get(member) ?? null : null;
      }
      const hit = named.get(callName);
      if (hit) return modules.get(hit.mod)!.names.get(hit.exported) ?? null;
      if (own.has(callName)) return null;
      const found = scopes
        .filter((s) => (!s.names || s.names.includes(callName)) && !s.except?.includes(callName))
        .map((s) => modules.get(s.mod)!.names.get(callName))
        .filter((b): b is Bound => !!b);
      return found.length === 1 ? found[0]! : null;
    };
    const callers: Array<{ symbol: string; fn: FunctionInfo }> = [
      ...a.functions.map((fn) => ({ symbol: fn.name, fn })),
      ...a.classes.flatMap((c) => c.methods.map((fn) => ({ symbol: `${c.name}.${fn.name}`, fn }))),
    ];
    for (const { symbol, fn } of callers) {
      for (const call of fn.calls) {
        const hit = target(call.name);
        if (!hit) continue;
        links.push({
          sourceFile: a.filePath,
          sourceSymbol: symbol,
          sourceLine: call.line,
          callName: call.name,
          targetFile: hit.file,
          targetSymbol: hit.fn.name,
          targetLine: hit.fn.line,
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
