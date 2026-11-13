import type { Tree } from "web-tree-sitter";
import type { ClassInfo, FileAnalysis, FunctionInfo, PropFlows, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { attributesAfter } from "./prop-bindings.js";
import { reactiveCellsOf } from "./reactive-cells.js";
import { autoImportedComponents, globalComponentFiles, spansOf, tagKey, type SymbolSpan } from "./dispatch.js";

/**
 * How a prop's value moves between components, from both sides (`FileAnalysis.propFlows`):
 *
 *   - the child's callbacks reading `props.<prop>` — a `watch(() => props.query, …)` source, a `watchEffect` body: they
 *     run when a parent changes the value (`watchers`, named as the linker names the callback);
 *   - a Vue parent's tag binding a prop (`<ClubList :query="passedQuery" :api="clubApi" />`): the plain local it names
 *     and the functions writing that local (`passedQuery.value = x`); any other value is kept as a binding without a
 *     local, because a prop's type is the parent's value only when EVERY binding of it agrees (`bindings`).
 *
 * `JsPropFlowResolver` joins them: the parent's write → the child's watcher (a dispatch link), and a call through a
 * prop (`props.api.load()`) → the member of the value every parent hands down.
 */
export function propFlows(tree: Tree, _sourceText: string, rawSource: string, filePath: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): PropFlows | null {
  const out: PropFlows = {};
  const facts = reactiveCellsOf(tree);
  const declared = new Set(functions.map((f) => f.name));
  const watchers: NonNullable<PropFlows["watchers"]> = [];
  for (const t of facts.propTriggers ?? []) {
    const name = t.callback ? facts.held.get(t.callback.id) : t.callee && declared.has(t.callee) ? t.callee : undefined;
    if (!name || !declared.has(name)) continue;
    const line = t.at.startPosition.row + 1;
    const registeredBy = t.heldHere ? { function: innermost(functions.filter((f) => !/^<\w+@\d+/.test(f.name)), line) ?? "<setup>", hook: t.hook } : undefined;
    for (const prop of t.props) if (!watchers.some((w) => w.prop === prop && w.function === name)) watchers.push({ prop, function: name, line, ...(registeredBy ? { registeredBy } : {}) });
  }
  if (watchers.length > 0) out.watchers = watchers;
  if (filePath.endsWith(".vue")) {
    const bindings = vueValueBindings(tree, rawSource, functions);
    if (bindings.length > 0) out.bindings = bindings;
  }
  return out.watchers || out.bindings ? out : null;
}

const NOT_PROPS: ReadonlySet<string> = new Set(["key", "ref", "class", "style", "is", "id", "slot"]);

function vueValueBindings(tree: Tree, raw: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): NonNullable<PropFlows["bindings"]> {
  const start = raw.search(/<template\b/i);
  const end = raw.lastIndexOf("</template>");
  if (start < 0 || end < start) return [];
  const template = raw.slice(start, end);
  const lineAt = (offset: number) => raw.slice(0, start + offset).split("\n").length;
  const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const out: NonNullable<PropFlows["bindings"]> = [];
  const scoped = templateScopeNames(template);
  const writesOf = new Map<string, NonNullable<PropFlows["bindings"]>[number]["writes"]>();
  for (const tag of template.matchAll(/<([A-Z][\w]*|[a-z][\w]*-[\w-]*)(?=[\s/>])/g)) {
    for (const a of attributesAfter(template, tag.index! + tag[0].length)) {
      const bound = /^(?::|v-bind:)([\w-]+)$/.exec(a.name);
      if (!bound) continue;
      const prop = camel(bound[1]!);
      if (NOT_PROPS.has(prop)) continue;
      const value = a.value.trim();
      const line = lineAt(a.offset);
      if (!/^[A-Za-z_$][\w$]*$/.test(value) || scoped.has(value)) {
        out.push({ component: tag[1]!, prop, line, local: "", writes: [] });
        continue;
      }
      let writes = writesOf.get(value);
      if (!writes) writesOf.set(value, (writes = refWrites(tree, value, functions)));
      out.push({ component: tag[1]!, prop, line, local: value, writes });
    }
  }
  return out;
}

/** Names the template itself declares (`v-for="club in clubs"`, `#default="{ club }"`, `slot-scope`): not the script's locals. */
function templateScopeNames(template: string): Set<string> {
  const out = new Set<string>();
  const declare = (expr: string) => {
    for (const m of expr.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
  };
  for (const m of template.matchAll(/\bv-for\s*=\s*"([^"]*?)\s+(?:in|of)\s/g)) declare(m[1]!);
  for (const m of template.matchAll(/(?:\s#[\w-]+|\bv-slot(?::[\w-]+)?|\bslot-scope)\s*=\s*"([^"]*)"/g)) declare(m[1]!);
  return out;
}

/** The functions assigning a ref's value (`passedQuery.value = x`, `passedQuery.value += 1`), by the function around the write. */
function refWrites(tree: Tree, local: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): NonNullable<PropFlows["bindings"]>[number]["writes"] {
  const out: NonNullable<PropFlows["bindings"]>[number]["writes"] = [];
  for (const n of tree.rootNode.descendantsOfType(["assignment_expression", "augmented_assignment_expression", "update_expression"])) {
    if (!n) continue;
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    if (left?.type !== "member_expression" || left.childForFieldName("property")?.text !== "value") continue;
    const object = left.childForFieldName("object");
    if (object?.type !== "identifier" || object.text !== local) continue;
    const line = n.startPosition.row + 1;
    const fn = innermost(functions, line);
    if (fn && !out.some((w) => w.function === fn && w.line === line)) out.push({ function: fn, line, spelling: local });
  }
  return out;
}

function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}

type Binding = NonNullable<PropFlows["bindings"]>[number];

/** A value's type as its file knows it: a class, or the factory whose result it is (`const clubApi = useClubApi()`). */
export interface TypedValue {
  file: FileAnalysis;
  /** The class declaring the members, or the function returning them. */
  owner: { kind: "class"; cls: ClassInfo } | { kind: "factory"; fn: FunctionInfo };
  id: string;
}

export type Files = { byPath: Map<string, FileAnalysis>; filePathMap: Map<string, string> };

/** The file declaring a class or function: `file` itself, or the module its import of `name` resolves to (under the exported name). */
export function homeOf(file: FileAnalysis, name: string, kind: "class" | "function", files: Files): { file: FileAnalysis; name: string } | null {
  const declares = (a: FileAnalysis, n: string) => (kind === "class" ? a.classes.some((c) => c.name === n) : a.functions.some((f) => f.name === n));
  if (declares(file, name)) return { file, name };
  const imp = file.imports.find((i) => i.specifiers.includes(name));
  if (!imp) return null;
  let exported = imp.aliases?.[name] ?? name;
  const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
  const at = target ? files.byPath.get(target) : undefined;
  // A default import is whatever the module exports by default (`export default function useClubApi`).
  if (at && exported === "default") exported = at.exports.find((e) => e.kind === "default" && e.name !== "default")?.name ?? exported;
  return at && declares(at, exported) ? { file: at, name: exported } : null;
}

/** The typed value a factory call or a local stands for, or null when it is not one a single fact settles. */
export function typedValueOf(file: FileAnalysis, ref: { factory?: string; local?: string }, files: Files): TypedValue | null {
  let factory = ref.factory;
  let type: string | undefined;
  if (ref.local) {
    const entries = file.functions.flatMap((f) => (f.localTypes ?? []).filter((l) => l.name === ref.local));
    if (entries.length !== 1) return null;
    const e = entries[0]!;
    if (e.destructured || e.element || e.iterator || e.member || e.field || e.aliasOf) return null;
    if (e.type) type = e.type;
    else {
      const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e.from ?? "");
      if (!m) return null;
      factory = m[1];
    }
  }
  if (type && /^[A-Za-z_$][\w$]*$/.test(type)) {
    const home = homeOf(file, type, "class", files);
    const cls = home?.file.classes.find((c) => c.name === home.name);
    return home && cls ? { file: home.file, owner: { kind: "class", cls }, id: `${home.file.filePath}#${home.name}` } : null;
  }
  if (!factory) return null;
  const home = homeOf(file, factory, "function", files);
  const fns = home?.file.functions.filter((f) => f.name === home.name) ?? [];
  return home && fns.length === 1 ? { file: home.file, owner: { kind: "factory", fn: fns[0]! }, id: `${home.file.filePath}#${home.name}` } : null;
}

/** The member `member` of a typed value: a class method, or the function a factory returns under that key. */
export function memberOf(value: TypedValue, member: string): { file: FileAnalysis; span: SymbolSpan } | null {
  const spans = spansOf(value.file);
  const owner = value.owner;
  if (owner.kind === "class") {
    const span = spans.find((sp) => sp.symbol === `${owner.cls.name}.${member}`);
    return span ? { file: value.file, span } : null;
  }
  const fn = owner.fn;
  const entry = fn.returnedMembers?.find((m) => m.key === member && m.kind === "function" && m.local);
  if (!entry?.local) return null;
  const named = spans.filter((sp) => sp.symbol === entry.local);
  const span = named.find((sp) => sp.line >= fn.line && sp.endLine <= fn.endLine) ?? null;
  return span ? { file: value.file, span } : null;
}

/** The files that render a component, by tag, and the child file each tag names. */
function childFileOf(parent: FileAnalysis, component: string, ctx: { globals: Map<string, string>; autoImported: Map<string, Map<string, string>>; files: Files }): FileAnalysis | null {
  const byKey = new Map<string, string>([...(ctx.autoImported.get(parent.projectId ?? "") ?? []), ...ctx.globals]);
  for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) byKey.set(tagKey(sub.name), sub.importSource);
  const src = byKey.get(tagKey(component));
  const file = src ? resolveTarget(src, parent.filePath, ctx.files.filePathMap) : null;
  return file ? ctx.files.byPath.get(file) ?? null : null;
}

/**
 * A prop's value across components, from `FileAnalysis.propFlows`:
 *
 *   - a parent function writing the ref bound to a prop (`passedQuery.value = x`) runs the callbacks of the child watching
 *     that prop: a `dispatch:prop-trigger` link from the writing function to the child's watcher;
 *   - a call through a prop (`props.api.load()`) is a call on the value every parent binds to it (`const clubApi =
 *     useClubApi()`): one link to the member of that value. A prop bound by one parent to something else, to anything the
 *     file cannot type, or to a different type is left untyped.
 */
export class JsPropFlowResolver implements DispatchResolver {
  readonly id = "prop-flow";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 34;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const push = (link: SymbolLink) => {
      const id = `${link.sourceFile}\0${link.sourceSymbol}\0${link.sourceLine}\0${link.callName}\0${link.targetFile}\0${link.targetSymbol}`;
      if (!seen.has(id)) (seen.add(id), links.push(link));
    };
    // A watcher split out of its component's function for the props it reads is still run by the function that registers it.
    for (const a of analyses) {
      for (const w of a.propFlows?.watchers ?? []) {
        if (!w.registeredBy) continue;
        push({
          sourceFile: a.filePath,
          sourceSymbol: w.registeredBy.function,
          sourceLine: w.line,
          callName: w.registeredBy.hook,
          targetFile: a.filePath,
          targetSymbol: w.function,
          targetLine: a.functions.find((f) => f.name === w.function)?.line ?? w.line,
          confidence: "INFERRED",
          strategy: "dispatch:prop-watcher",
          relation: "dispatch",
        });
      }
    }
    if (!analyses.some((a) => a.propFlows?.bindings?.length)) return links;
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    const ctx = { globals: globalComponentFiles(analyses, files.filePathMap), autoImported: autoImportedComponents(analyses), files };
    // child file → prop → the parents' bindings of it.
    const bound = new Map<string, Map<string, Array<{ parent: FileAnalysis; binding: Binding }>>>();
    for (const parent of analyses) {
      for (const b of parent.propFlows?.bindings ?? []) {
        const child = childFileOf(parent, b.component, ctx);
        if (!child || child === parent) continue;
        const byProp = bound.get(child.filePath) ?? bound.set(child.filePath, new Map()).get(child.filePath)!;
        (byProp.get(b.prop) ?? byProp.set(b.prop, []).get(b.prop)!).push({ parent, binding: b });
      }
    }
    for (const child of analyses) {
      const byProp = bound.get(child.filePath);
      if (!byProp) continue;
      const lineOf = (name: string) => child.functions.find((f) => f.name === name)?.line;
      for (const w of child.propFlows?.watchers ?? []) {
        const target = lineOf(w.function);
        if (target === undefined) continue;
        for (const { parent, binding } of byProp.get(w.prop) ?? []) {
          for (const write of binding.writes) {
            push({
              sourceFile: parent.filePath,
              sourceSymbol: write.function,
              sourceLine: write.line,
              callName: write.spelling,
              targetFile: child.filePath,
              targetSymbol: w.function,
              targetLine: target,
              confidence: "INFERRED",
              strategy: "dispatch:prop-trigger",
              relation: "dispatch",
            });
          }
        }
      }
      // `props.api.load()` where `const props = defineProps<…>()`.
      const aliases = new Set(child.functions.flatMap((f) => (f.localTypes ?? []).filter((l) => /^(?:withDefaults\(\s*)?defineProps\b/.test(l.from ?? "")).map((l) => l.name)));
      if (aliases.size === 0) continue;
      const fns: FunctionInfo[] = [...child.functions, ...child.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      const typedProp = new Map<string, TypedValue | null>();
      for (const fn of fns) {
        for (const call of fn.calls) {
          const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(call.name);
          if (!m || !aliases.has(m[1]!) || call.boundLocally) continue;
          const prop = m[2]!;
          if (!typedProp.has(prop)) {
            const values = (byProp.get(prop) ?? []).map(({ parent, binding }) => (binding.local ? typedValueOf(parent, { local: binding.local }, files) : null));
            typedProp.set(prop, values.length > 0 && values.every((v) => v && v.id === values[0]!.id) ? values[0]! : null);
          }
          const value = typedProp.get(prop);
          const member = value ? memberOf(value, m[3]!) : null;
          if (!member) continue;
          push({
            sourceFile: child.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: member.file.filePath,
            targetSymbol: member.span.symbol,
            targetLine: member.span.line,
            confidence: "INFERRED",
            strategy: "dispatch:prop-type",
            relation: "dispatch",
          });
        }
      }
    }
    return links;
  }
}


/**
 * Vue's provide/inject by TYPE: `provide(LeagueKey, useLeague())` in an ancestor, `const league = inject(LeagueKey)` below it,
 * `league.relegate()` — a call on the value the key carries, so it links to that member. The key is a literal or an imported
 * symbol (resolved to its declaration, so two modules' `Key` are two keys); the provided value is a factory called in place or
 * a local typed by its initializer. Providers of one key that disagree about the value, or that no fact types, give no type.
 */
export class JsContextTypeResolver implements DispatchResolver {
  readonly id = "provide-inject-typed";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.contextValues?.some((v) => v.kind === "inject-typed"))) return [];
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    const keyOf = (a: FileAnalysis, v: { key: string; keyRef?: true }): string | null => {
      if (!v.keyRef) return `${a.projectId ?? ""}\0str:${v.key}`;
      const home = declarationOf(a, v.key, files);
      return home ? `${a.projectId ?? ""}\0${home}` : null;
    };
    // key → what each provider hands on (null: nothing typed).
    const providers = new Map<string, Array<{ file: FileAnalysis; value: TypedValue | null }>>();
    for (const a of analyses) {
      for (const v of a.contextValues ?? []) {
        if (v.kind !== "provide-typed") continue;
        const key = keyOf(a, v);
        if (!key) continue;
        const value = typedValueOf(a, v.factory ? { factory: v.name } : { local: v.name }, files);
        (providers.get(key) ?? providers.set(key, []).get(key)!).push({ file: a, value });
      }
    }
    if (providers.size === 0) return [];
    const links: SymbolLink[] = [];
    for (const a of analyses) {
      for (const v of a.contextValues ?? []) {
        if (v.kind !== "inject-typed") continue;
        const key = keyOf(a, v);
        const candidates = (key ? providers.get(key) ?? [] : []).filter((p) => p.file !== a);
        const first = candidates[0]?.value;
        if (!first || candidates.some((p) => p.value?.id !== first.id)) continue;
        const fns: FunctionInfo[] = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
        const prefix = `${v.name}.`;
        const done = new Set<string>();
        const link = (symbol: string, line: number, callName: string, member: string) => {
          const hit = memberOf(first, member);
          const id = `${symbol}\0${line}\0${callName}`;
          if (!hit || done.has(id)) return;
          done.add(id);
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: symbol,
            sourceLine: line,
            callName,
            targetFile: hit.file.filePath,
            targetSymbol: hit.span.symbol,
            targetLine: hit.span.line,
            confidence: "INFERRED",
            strategy: "dispatch:provide-inject-type",
            relation: "dispatch",
          });
        };
        let inFunctions = false;
        for (const fn of fns) {
          for (const call of fn.calls) {
            if (call.boundLocally || !call.name.startsWith(prefix)) continue;
            const member = call.name.slice(prefix.length);
            if (!/^[A-Za-z_$][\w$]*$/.test(member)) continue;
            inFunctions = true;
            link(fn.name, call.line, call.name, member);
          }
        }
        // Only the markup calls it (`@click="league.relegate()"`).
        if (inFunctions) continue;
        const inMarkup = new RegExp(`^(?:void\\s+|await\\s+)?${v.name.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`);
        for (const el of a.interactiveElements ?? []) {
          const m = el.handler ? inMarkup.exec(el.handler.trim()) : null;
          if (m) link("<template>", el.line, `${v.name}.${m[1]}`, m[1]!);
        }
      }
    }
    return links;
  }
}

/** The declaration a name used as a key stands for: `<file>#<exported name>`, in the file declaring it or the module it imports it from. */
function declarationOf(file: FileAnalysis, name: string, files: Files): string | null {
  const imp = file.imports.find((i) => i.specifiers.includes(name));
  if (!imp) return `${file.filePath}#${name}`;
  const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
  return target ? `${target}#${imp.aliases?.[name] ?? name}` : null;
}
