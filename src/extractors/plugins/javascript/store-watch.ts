import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, StoreWatch, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import { piniaStoreOf, type PiniaStore } from "./functions-classes.js";
import { FALSY, MUTATORS, argumentsOf, innermost, reactiveCellsOf } from "./reactive-cells.js";
import { homeOf, type Files } from "./prop-flows.js";

/**
 * Store state watched in one file and written in another (`FileAnalysis.storeWatch`):
 *
 *   - a component's `watch(() => store.filters.league, …)`, a `storeToRefs` ref or a computed over store state is a
 *     watcher (`store-reads.ts`), naming the store factory as written;
 *   - a Pinia store file's actions write its state — option store `this.filters.league = x`, `this.picked.push(c)`,
 *     `this.$patch({ filters })`, setup store `filters.value = x` on a ref it returns — each write named by the
 *     function it sits in, on the store class the binding returns (`ClubStore`).
 *
 * `JsStoreWatchResolver` joins them by store — the file and class the factory resolves to, never the state's name: an
 * action of another store writing a `filters` of its own, and a component's own ref of that name, run nothing here.
 */
export function storeWatch(tree: Tree, sourceText: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): StoreWatch | null {
  const out: StoreWatch = {};
  const facts = reactiveCellsOf(tree);
  if (facts.storeTriggers?.length) {
    const declared = new Set(functions.map((f) => f.name));
    const watchers: NonNullable<StoreWatch["watchers"]> = [];
    for (const t of facts.storeTriggers) {
      const name = t.callback ? facts.held.get(t.callback.id) : t.callee && declared.has(t.callee) ? t.callee : undefined;
      if (!name || !declared.has(name)) continue;
      const line = t.at.startPosition.row + 1;
      if (!watchers.some((w) => w.function === name && w.line === line)) watchers.push({ reads: t.reads, function: name, line, ...(t.immediate ? { immediate: true } : {}), ...(t.truthyOnly ? { truthyOnly: true } : {}) });
    }
    if (watchers.length > 0) out.watchers = watchers;
  }
  if (sourceText.includes("defineStore")) {
    const writes = storeWrites(tree, functions);
    if (writes.length > 0) out.writes = writes;
  }
  return out.watchers || out.writes ? out : null;
}

type Write = NonNullable<StoreWatch["writes"]>[number];
type Fn = { name: string; line: number; endLine: number };

const FUNCTION_NODES: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "method_definition", "generator_function"]);
const REF_CELLS = new Set(["ref", "shallowRef", "customRef", "useStorage", "useLocalStorage", "useSessionStorage"]);
const REACTIVE_CELLS = new Set(["reactive", "shallowReactive"]);

/** Writes to the state of each Pinia store a file defines. */
function storeWrites(tree: Tree, functions: readonly Fn[]): Write[] {
  const out: Write[] = [];
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const store = d ? piniaStoreOf(d) : null;
    if (!store) continue;
    if (store.options) optionStoreWrites(store, functions, out);
    else if (store.setup) setupStoreWrites(store, functions, out);
  }
  return out;
}

/** What a write target names: the first member below the root and the path (`filters.league`, an element `picked.[]`). */
interface Target { path: string[]; root: string }

/** Whether `n` is the root a store's state hangs off: `this`, or one of the identifiers naming it. */
type RootTest = (n: Node) => string | null;

function targetOf(node: Node | null, rootOf: RootTest, mutated: boolean): Target | null {
  let n = node;
  const steps: Array<string | null> = [];
  while (n && (n.type === "member_expression" || n.type === "subscript_expression")) {
    steps.unshift(n.type === "member_expression" ? n.childForFieldName("property")?.text ?? null : null);
    n = n.childForFieldName("object");
  }
  const root = n ? rootOf(n) : null;
  if (root === null) return null;
  const cut = steps.indexOf(null);
  const path = (cut < 0 ? steps : steps.slice(0, cut)).map((x) => x ?? "[]");
  if (cut >= 0 || mutated) path.push("[]");
  return { path, root };
}

/** Visits `body` without entering a function that has a `this` or locals of its own (an arrow keeps both). */
function walk(body: Node, visit: (n: Node) => void): void {
  const go = (n: Node): void => {
    visit(n);
    for (const c of n.namedChildren) if (c && !FUNCTION_NODES.has(c.type)) go(c);
  };
  go(body);
}

function pushWrite(out: Write[], functions: readonly Fn[], node: Node, store: string, path: readonly string[], falsy: boolean): void {
  const line = node.startPosition.row + 1;
  const fn = innermost(functions, line);
  if (!fn) return;
  const joined = path.join(".");
  const id = `${store}\0${joined}\0${fn}\0${line}`;
  if (out.some((w) => `${w.store}\0${w.path}\0${w.function}\0${w.line}` === id)) return;
  out.push({ store, path: joined, function: fn, line, spelling: path.find((p) => p !== "[]") ?? "", ...(falsy ? { falsy: true } : {}) });
}

/** The writes of one function body, given what names the state there. */
function writesIn(body: Node, rootOf: RootTest, emit: (node: Node, path: string[], falsy: boolean) => void, patchParam: (fn: Node) => void): void {
  walk(body, (n) => {
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression" || n.type === "update_expression") {
      const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
      const t = targetOf(left, rootOf, false);
      if (t && t.path.length > 0) emit(n, t.path, n.type === "assignment_expression" && FALSY.test(n.childForFieldName("right")?.text.trim() ?? ""));
      return;
    }
    if (n.type !== "call_expression") return;
    const callee = n.childForFieldName("function");
    if (callee?.type !== "member_expression") return;
    const method = callee.childForFieldName("property")?.text ?? "";
    const object = callee.childForFieldName("object");
    // `this.$patch({ filters })` / `this.$patch((state) => { state.filters.league = x })` / `this.$reset()`
    if (object && rootOf(object) !== null && (method === "$patch" || method === "$reset")) {
      const arg = argumentsOf(n)[0];
      if (method === "$reset" || !arg) emit(n, [], false);
      else if (arg.type === "object") {
        for (const p of arg.namedChildren) {
          const key = p?.type === "shorthand_property_identifier" ? p.text : p?.type === "pair" ? p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "") : null;
          if (key) emit(p!, [key], false);
          else emit(n, [], false);
        }
      } else if (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function") patchParam(arg);
      else emit(n, [], false);
      return;
    }
    if (!MUTATORS.has(method)) return;
    const t = targetOf(object ?? null, rootOf, true);
    if (t && t.path.length > 0 && t.path[0] !== "[]") emit(n, t.path, false);
  });
}

function optionStoreWrites(store: PiniaStore, functions: readonly Fn[], out: Write[]): void {
  const actions: Node[] = [];
  for (const member of store.options!.namedChildren) {
    const key = member?.type === "pair" ? member.childForFieldName("key")?.text : null;
    const value = member?.type === "pair" ? member.childForFieldName("value") : null;
    if (key !== "actions" || value?.type !== "object") continue;
    for (const a of value.namedChildren) {
      if (a?.type === "method_definition") actions.push(a);
      else if (a?.type === "pair" && a.childForFieldName("value") && FUNCTION_NODES.has(a.childForFieldName("value")!.type)) actions.push(a.childForFieldName("value")!);
    }
  }
  const emit = (node: Node, path: string[], falsy: boolean) => pushWrite(out, functions, node, store.className, path, falsy);
  for (const fn of actions) {
    const body = fn.childForFieldName("body");
    if (!body) continue;
    const params = new Set<string>();
    const rootOf: RootTest = (n) => (n.type === "this" ? "this" : n.type === "identifier" && params.has(n.text) ? n.text : null);
    const patchParam = (cb: Node): void => {
      const p = cb.childForFieldName("parameters")?.namedChildren[0] ?? cb.childForFieldName("parameter");
      const cbBody = cb.childForFieldName("body");
      if (p?.type !== "identifier" || !cbBody) return;
      params.add(p.text);
      writesIn(cbBody, rootOf, emit, patchParam);
      params.delete(p.text);
    };
    writesIn(body, rootOf, emit, patchParam);
  }
}

function setupStoreWrites(store: PiniaStore, functions: readonly Fn[], out: Write[]): void {
  const body = store.setup!.childForFieldName("body");
  if (body?.type !== "statement_block") return;
  // The refs and reactive objects the setup declares, and the key the returned object gives each.
  const cells = new Map<string, { reactive: boolean; opaque: boolean }>();
  const exposed = new Map<string, string>();
  for (const stmt of body.namedChildren) {
    if (stmt?.type === "lexical_declaration" || stmt?.type === "variable_declaration") {
      for (const d of stmt.namedChildren) {
        const value = d?.type === "variable_declarator" ? d.childForFieldName("value") : null;
        const name = d?.childForFieldName("name");
        if (value?.type !== "call_expression" || name?.type !== "identifier") continue;
        const hook = value.childForFieldName("function")?.text ?? "";
        if (REF_CELLS.has(hook)) cells.set(name.text, { reactive: false, opaque: hook === "shallowRef" || hook === "customRef" });
        else if (REACTIVE_CELLS.has(hook)) cells.set(name.text, { reactive: true, opaque: hook === "shallowReactive" });
      }
    } else if (stmt?.type === "return_statement") {
      let ret = stmt.namedChild(0);
      while (ret?.type === "parenthesized_expression") ret = ret.namedChild(0);
      for (const e of ret?.type === "object" ? ret.namedChildren : []) {
        if (e?.type === "shorthand_property_identifier") exposed.set(e.text, e.text);
        else if (e?.type === "pair" && e.childForFieldName("value")?.type === "identifier") {
          const key = e.childForFieldName("key")?.text;
          if (key) exposed.set(e.childForFieldName("value")!.text, key);
        }
      }
    }
  }
  for (const local of [...cells.keys()]) if (!exposed.has(local)) cells.delete(local);
  if (cells.size === 0) return;
  // The setup body writes through a ref's `.value`, and through a reactive object's members; nested functions are walked
  // too — the actions are functions of the setup.
  const visitAll = (root: Node): void => {
    const go = (n: Node): void => {
      if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression" || n.type === "update_expression" || n.type === "call_expression") one(n);
      for (const c of n.namedChildren) if (c) go(c);
    };
    go(root);
  };
  const rootOf: RootTest = (n) => (n.type === "identifier" && cells.has(n.text) ? n.text : null);
  const emitFor = (node: Node, t: Target, mutated: boolean, falsy: boolean): void => {
    const cell = cells.get(t.root)!;
    let path = t.path;
    if (!cell.reactive) {
      if (path[0] !== "value") return;
      path = path.slice(1);
    } else if (path.length === 0 && !mutated) return;
    // A shallow ref changes only when its value is replaced, a shallow reactive object when one of its own members is.
    if (cell.opaque && (cell.reactive ? path.length > 1 || mutated : path.length > 0 || mutated)) return;
    pushWrite(out, functions, node, store.className, [exposed.get(t.root)!, ...path], falsy);
  };
  const one = (n: Node): void => {
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee?.type !== "member_expression" || !MUTATORS.has(callee.childForFieldName("property")?.text ?? "")) return;
      const t = targetOf(callee.childForFieldName("object"), rootOf, true);
      if (t) emitFor(n, t, true, false);
      return;
    }
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    const t = targetOf(left, rootOf, false);
    if (t) emitFor(n, t, false, n.type === "assignment_expression" && FALSY.test(n.childForFieldName("right")?.text.trim() ?? ""));
  };
  visitAll(body);
}

/**
 * Joins a watcher to the actions writing the state it reads: an INFERRED `dispatch` link from the function writing to
 * the callback (`dispatch:store-watch`), `callName` the member written. The store is the file and class the watcher's
 * factory resolves to — through the import, else the one project function of that name.
 */
export class JsStoreWatchResolver implements DispatchResolver {
  readonly id = "store-watch";
  readonly languages = ["typescript", "javascript"] as FileAnalysis["language"][];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    if (!analyses.some((a) => a.storeWatch?.watchers?.length) || !analyses.some((a) => a.storeWatch?.writes?.length)) return [];
    const files: Files = { byPath: new Map(analyses.map((a) => [a.filePath, a])), filePathMap: buildFilePathMap(analyses) };
    const writesByStore = new Map<string, Array<{ file: FileAnalysis; write: Write }>>();
    for (const a of analyses) {
      for (const w of a.storeWatch?.writes ?? []) {
        const key = `${a.filePath}#${w.store}`;
        (writesByStore.get(key) ?? writesByStore.set(key, []).get(key)!).push({ file: a, write: w });
      }
    }
    /** The file declaring `name` below a module that only forwards it (`export { useClubStore } from './club-store'`, `export * from`). */
    const forwarded = (module: FileAnalysis, name: string, hops: number): { file: FileAnalysis; name: string } | null => {
      if (module.functions.some((f) => f.name === name)) return { file: module, name };
      if (hops <= 0) return null;
      for (const e of module.exports) {
        if (!e.source || (e.name !== name && e.name !== "*")) continue;
        const target = resolveTarget(e.source, module.filePath, files.filePathMap);
        const at = target ? files.byPath.get(target) : undefined;
        const hit = at ? forwarded(at, e.name === "*" ? name : e.sourceName ?? name, hops - 1) : null;
        if (hit) return hit;
      }
      return null;
    };
    // Nuxt auto-imports a store from `stores/` with no import line: the one project function of that name.
    let byName: Map<string, FileAnalysis[]> | null = null;
    const declaring = (factory: string): FileAnalysis[] => {
      if (!byName) {
        byName = new Map();
        for (const a of analyses) for (const f of a.functions) if (f.returnType) (byName.get(f.name) ?? byName.set(f.name, []).get(f.name)!).push(a);
      }
      return byName.get(factory) ?? [];
    };
    const stores = new Map<string, string | null>();
    const storeOf = (file: FileAnalysis, factory: string): string | null => {
      const memo = `${file.filePath}\0${factory}`;
      if (stores.has(memo)) return stores.get(memo)!;
      let home = homeOf(file, factory, "function", files);
      const imp = file.imports.find((i) => i.specifiers.includes(factory));
      if (!home && imp) {
        const target = resolveTarget(imp.source, file.filePath, files.filePathMap);
        const at = target ? files.byPath.get(target) : undefined;
        if (at) home = forwarded(at, imp.aliases?.[factory] ?? factory, 4);
      } else if (!home) {
        const all = declaring(factory);
        if (all.length === 1) home = { file: all[0]!, name: factory };
      }
      const fn = home?.file.functions.find((f) => f.name === home!.name);
      const cls = fn?.returnType ? home!.file.classes.find((c) => c.name === fn.returnType) : undefined;
      const key = home && cls ? `${home.file.filePath}#${cls.name}` : null;
      stores.set(memo, key);
      return key;
    };
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of analyses) {
      const watchers = a.storeWatch?.watchers;
      if (!watchers) continue;
      const immediateInFile = new Set((a.reactiveCells?.triggers ?? []).filter((t) => t.immediate).map((t) => t.function));
      for (const w of watchers) {
        const target = a.functions.find((f) => f.name === w.function) ?? a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` }))).find((f) => f.name === w.function);
        if (!target) continue;
        if (w.immediate && w.function !== "<setup>" && !immediateInFile.has(w.function) && a.functions.some((f) => f.name === "<setup>")) {
          const id = `<setup>\0${a.filePath}\0${w.line}\0${w.function}`;
          if (!seen.has(id)) {
            seen.add(id);
            links.push({ sourceFile: a.filePath, sourceSymbol: "<setup>", sourceLine: w.line, callName: "immediate", targetFile: a.filePath, targetSymbol: w.function, targetLine: target.line, confidence: "INFERRED", strategy: "dispatch:store-watch", relation: "dispatch" });
          }
        }
        for (const read of w.reads) {
          const key = storeOf(a, read.factory);
          for (const { file, write } of (key ? writesByStore.get(key) : undefined) ?? []) {
            if (file === a && write.function === w.function) continue;
            if (w.truthyOnly && write.falsy) continue;
            if (write.path !== "" && read.path !== "*" && !sameCell(`s:${write.path}`, `s:${read.path}`)) continue;
            const id = `${file.filePath}\0${write.function}\0${write.line}\0${a.filePath}\0${w.function}`;
            if (seen.has(id)) continue;
            seen.add(id);
            links.push({
              sourceFile: file.filePath,
              sourceSymbol: write.function,
              sourceLine: write.line,
              callName: write.spelling || read.path.replace(/\*$/, ""),
              targetFile: a.filePath,
              targetSymbol: w.function,
              targetLine: target.line,
              confidence: "INFERRED",
              strategy: "dispatch:store-watch",
              relation: "dispatch",
            });
          }
        }
      }
    }
    return links;
  }
}
