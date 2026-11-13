import type { Node, Tree } from "web-tree-sitter";
import type { ReactiveCells } from "../../../types/analysis.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import { withStoreWatchers, type StoreTrigger, type StoreWrite } from "./store-reads.js";
import { TEMPLATE_WRITE_MARK } from "./markup-expressions.js";
import { decodeTargets, type TemplateTarget } from "./template-targets.js";

/**
 * Reactive cells a component writes and the callbacks a write re-runs — the trigger a click
 * sets off without calling anything itself:
 *
 *   - Vue: a `ref`/`shallowRef`/`reactive`/`computed` written in a function (`picked.value.push(c)`,
 *     `query.value = q`, `filters.league = id`) and the `watch` / `watchEffect` / VueUse
 *     `watchDebounced` / `watchThrottled` / `whenever` reading it; `router.push({ query })` and a
 *     watcher on `route.query`;
 *   - React: a `useState` setter called in the component (`setClubId(7)`) and the `useEffect`
 *     listing the state among its deps (through a `useMemo`/`useCallback` dep built from it);
 *   - Angular: a signal field's `this.clubId.set(…)` / `.update(…)` and an `effect(() => …)` of the
 *     same class reading `this.clubId()` (through a `computed` field reading it).
 *
 * A cell is the declaration it resolves to lexically — the component function, the class, the
 * `<script setup>` — so a namesake in another component or class is another cell. A watcher callback
 * written in place whose cell something writes is a function of its own (`heldFunction`:
 * `<watchDebounced@40>`, `<useEffect@7>`, `<effect@15>`); a watcher handed a declared function
 * (`watch(query, loadPlayers)`) triggers that function.
 */

export const SCOPES: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "arrow_function", "method_definition", "generator_function"]);
const CLASSES: ReadonlySet<string> = new Set(["class_declaration", "class", "abstract_class_declaration"]);
/** Calls returning a cell: Vue's refs, a `defineModel` two-way prop, a ref onto a member, VueUse's stored refs. */
const VUE_CELLS: ReadonlySet<string> = new Set(["ref", "shallowRef", "customRef", "reactive", "shallowReactive", "computed", "defineModel", "toRef", "useVModel", "useStorage", "useLocalStorage", "useSessionStorage", "useTemplateRef"]);
export const VUE_SOURCES = /^(?:vue|@vue\/[\w-]+|@vueuse\/[\w-]+|#imports|nuxt\/app|#app)$/;
/** Watchers taking a source and a callback (`watch(src, cb)`), and those whose callback reads its own sources. */
export const VUE_WATCH = new Set(["watch", "watchDebounced", "watchThrottled", "watchImmediate", "watchDeep", "watchOnce", "watchPausable", "watchIgnorable", "watchTriggerable", "whenever", "debouncedWatch", "throttledWatch", "pausableWatch", "ignorableWatch"]);
export const VUE_EFFECT = new Set(["watchEffect", "watchPostEffect", "watchSyncEffect"]);
const REACT_EFFECT = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const REACT_DERIVED = new Set(["useMemo", "useCallback"]);
const REACT_SOURCES = /^(?:react|preact\/hooks|preact\/compat)$/;
const ANGULAR_CELLS = new Set(["signal", "computed", "model", "linkedSignal"]);
/** Array, Set and Map members that change the collection they are called on. */
export const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);

interface Cell {
  key: string;
  name: string;
  kind: "ref" | "reactive" | "computed" | "state" | "signal" | "route" | "derived";
  /** For a React state: its setter. */
  setter?: string;
  /** Only replacing the value is a change: a `shallowRef`, a ref holding a DOM element (`ref<HTMLInputElement>()`). */
  opaque?: boolean;
  /** Cells a computed or a memo reads, which re-run what reads it. */
  reads?: Set<string>;
}

/** A write: the statement's node, or — for a statement the template runs (`template`) — its line alone; the component's `<setup>` stands for it. */
interface Write { cell: string; node: Node | null; spelling: string; falsy?: boolean; line?: number; template?: true }
interface Trigger { cells: Set<string>; hook: string; callback: Node | null; callee: string | null; at: Node; immediate?: boolean }

/** A value only a switch-off writes: `false`, `null`, `undefined`, an empty string, `0`. */
export const FALSY = /^(?:false|null|undefined|''|""|``|0)$/;
/** Watchers that run their callback only when the source turns truthy (VueUse `whenever`). */
export const TRUTHY_ONLY = new Set(["whenever"]);
/** A ref's type argument naming a DOM node: what it holds is never made reactive. */
const DOM_TYPE = /\b(?:HTML\w*Element|SVG\w*Element|Element|Node|Document|Window)\b/;

export interface CellFacts {
  writes: Write[];
  triggers: Trigger[];
  held: Map<number, string>;
  /** Options API watcher callbacks (`watch: { page() {…} }`): callback node id → the function's name. */
  optionNames: Map<number, string>;
  propTriggers?: PropTrigger[];
  /** Callbacks written in place on a member of an injected project service (`this.leagueSvc.changes$.pipe(…).subscribe(cb)`), held so a `.next` in another class can run them. */
  subjectListens?: SubjectListen[];
  /** Watchers reading state a store holds (`watch(() => store.filters.league, …)`): the project pass joins them to the actions writing it. */
  storeTriggers?: StoreTrigger[];
  /** Writes a component makes to state a store holds (`page.value = 2` on a `storeToRefs` ref, `store.page = 2`, `store.$patch({ page })`), naming the store factory as written. */
  storeWrites?: StoreWrite[];
}

/** A subscription on `via.field` — a member of a service the class holds as `via` — whose callback is held as its own function. */
export interface SubjectListen { callback: Node; hook: string; via: string; field: string; at: Node; cls: Node }

/** A watcher whose source reads a prop of the component (`watch(() => props.query, …)`): a parent's write to the bound value runs it. */
export interface PropTrigger { props: string[]; hook: string; callback: Node | null; callee: string | null; at: Node; /** Held only because it reads a prop: the project pass reaches it from the function that sets it up. */ heldHere?: true }

let memoTree: Tree | null = null;
let memo: CellFacts | null = null;
const EMPTY: CellFacts = { writes: [], triggers: [], held: new Map(), optionNames: new Map() };

/** The cells, writes and triggers of a tree, read once per tree. */
export function reactiveCellsOf(tree: Tree): CellFacts {
  if (tree === memoTree) return memo!;
  memoTree = tree;
  const text = tree.rootNode.text;
  const template = templateWritesOf(tree, text);
  memo = withStoreWatchers(tree, withSubjectListeners(tree, withPropWatchers(tree, withOptionsApi(tree, read(tree, text, template), text, template), text), text), text, template);
  return memo;
}

function ownerClass(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (CLASSES.has(p.type)) return p;
  return null;
}

/** Whether a node sits in a class's constructor (where a parameter is a bare name). */
export function inConstructor(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (p.type === "method_definition") return p.childForFieldName("name")?.text === "constructor";
  return false;
}

/** The type a class member holding a service names, by member name: constructor parameters, typed fields, `inject(T)` fields. */
export function memberTypes(cls: Node): Map<string, string> {
  const out = new Map<string, string>();
  const simple = (t: Node | null | undefined): string | null => {
    const text = t?.text.replace(/^:\s*/, "").trim() ?? "";
    return /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
  };
  for (const p of cls.descendantsOfType(["required_parameter", "optional_parameter"])) {
    if (p?.parent?.parent?.type !== "method_definition" || p.parent.parent.childForFieldName("name")?.text !== "constructor" || ownerClass(p)?.id !== cls.id) continue;
    const name = p.childForFieldName("pattern") ?? p.childForFieldName("name");
    const type = simple(p.childForFieldName("type"));
    if (name?.type === "identifier" && type) out.set(name.text, type);
  }
  for (const d of cls.descendantsOfType(["public_field_definition", "field_definition"])) {
    if (!d) continue;
    const name = (d.childForFieldName("name") ?? d.childForFieldName("property"))?.text;
    if (!name || ownerClass(d)?.id !== cls.id) continue;
    let type = simple(d.childForFieldName("type"));
    const value = d.childForFieldName("value");
    if (!type && value?.type === "call_expression" && value.childForFieldName("function")?.text === "inject") {
      const arg = argumentsOf(value)[0];
      type = arg?.type === "identifier" ? arg.text : null;
    }
    if (type) out.set(name, type);
  }
  const members = new Set(out.keys());
  // A local a method sets to an injected service (`const svc = inject(ClubService)`); a member of the name wins, and a
  // name two methods set to different services is no one's.
  const conflicting = new Set<string>();
  for (const d of cls.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    const value = d?.childForFieldName("value");
    const arg = value?.type === "call_expression" && value.childForFieldName("function")?.text === "inject" ? argumentsOf(value)[0] : null;
    if (!d || name?.type !== "identifier" || arg?.type !== "identifier" || ownerClass(d)?.id !== cls.id || members.has(name.text)) continue;
    if (out.has(name.text) && out.get(name.text) !== arg.text) conflicting.add(name.text);
    else out.set(name.text, arg.text);
  }
  for (const name of conflicting) out.delete(name);
  return out;
}

/** Names of locals a class's methods set once to an injected service (`const svc = inject(ClubService)`). */
export function injectedLocals(cls: Node): Set<string> {
  const out = new Set<string>();
  for (const d of cls.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    const value = d?.childForFieldName("value");
    if (d && name?.type === "identifier" && value?.type === "call_expression" && value.childForFieldName("function")?.text === "inject" && ownerClass(d)?.id === cls.id) out.add(name.text);
  }
  return out;
}

/** Imports a subject-holding service can hardly come from: the framework and the observable library. */
const FRAMEWORK_SOURCE = /^(?:@angular\/|rxjs(?:\/|$))/;

function withSubjectListeners(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!text.includes(".subscribe(") || !/\b(?:Injectable|Component|Directive|Pipe|NgModule)\b|\binject\s*\(/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const declaredHere = new Set(tree.rootNode.descendantsOfType(["class_declaration", "abstract_class_declaration"]).map((c) => c?.childForFieldName("name")?.text ?? ""));
  const found: SubjectListen[] = [];
  const typesOf = new Map<number, Map<string, string>>();
  const localsOf = new Map<number, Set<string>>();
  const injectedLocalsOf = (n: Node): Set<string> | null => {
    const c = ownerClass(n);
    return c ? (localsOf.get(c.id) ?? localsOf.set(c.id, injectedLocals(c)).get(c.id)!) : null;
  };
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    if (!n) continue;
    const chain = subscribeChain(n);
    if (!chain) continue;
    // `this.leagueSvc.changes$` or, in a constructor, `leagueSvc.changes$`.
    const root = chain.root;
    if (root.type !== "member_expression") continue;
    const holder = root.childForFieldName("object");
    const via = holder?.type === "member_expression" && holder.childForFieldName("object")?.type === "this" ? holder.childForFieldName("property")?.text : holder?.type === "identifier" && (inConstructor(n) || injectedLocalsOf(n)?.has(holder.text)) ? holder.text : null;
    const fieldName = root.childForFieldName("property")?.text;
    const cls = ownerClass(n);
    if (!via || !fieldName || !cls) continue;
    const types = typesOf.get(cls.id) ?? typesOf.set(cls.id, memberTypes(cls)).get(cls.id)!;
    const type = types.get(via);
    const source = type ? sources.get(type) : undefined;
    // A service imported from the project, or declared in this file; never the framework's or the observable library's.
    if (!type || (source ? FRAMEWORK_SOURCE.test(source) : !declaredHere.has(type))) continue;
    const first = callbackOf(argumentsOf(n)[0]).callback;
    const sub = first && first.descendantsOfType("call_expression").length > 0 ? first : null;
    for (const cb of [...chain.operatorCallbacks.map((c) => ({ c, hook: "pipe" })), ...(sub ? [{ c: sub, hook: "subscribe" }] : [])]) {
      found.push({ callback: cb.c, hook: cb.hook, via, field: fieldName, at: n, cls });
    }
  }
  if (found.length === 0) return facts;
  const held = new Map(facts.held);
  const used = new Map<string, number>();
  for (const name of held.values()) used.set(name.replace(/#\d+>$/, ">"), (used.get(name.replace(/#\d+>$/, ">")) ?? 0) + 1);
  for (const l of found) {
    if (held.has(l.callback.id)) continue;
    const base = `<${l.hook}@${l.callback.startPosition.row + 1}>`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    held.set(l.callback.id, n > 1 ? base.replace(/>$/, `#${n}>`) : base);
  }
  return { ...facts, held, subjectListens: found };
}

/** The function name of an Options API watcher callback (`watch: { page() {…} }`), null for any other node. */
export function optionsWatcherName(node: Node): string | null {
  return reactiveCellsOf(node.tree).optionNames.get(node.id) ?? null;
}

/**
 * Watchers reading the component's own props. The cell is the parent's, so nothing in this file writes it: a callback
 * written in place is held all the same (its own function, `<watch@12>`), and the trigger is kept for the project pass
 * that joins a parent's binding to it (`FileAnalysis.propFlows`).
 */
function withPropWatchers(tree: Tree, facts: CellFacts, text: string): CellFacts {
  if (!/\bdefineProps\b/.test(text) || !/\b(?:watch\w*|whenever|\w+Watch)\s*\(/.test(text)) return facts;
  const sources = importSources(tree.rootNode);
  const aliases = new Set<string>();
  const destructured = new Map<string, string>();
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    if (!d) continue;
    let value = d.childForFieldName("value");
    // `withDefaults(defineProps<…>(), {…})`
    if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "withDefaults") value = argumentsOf(value)[0] ?? null;
    if (value?.type !== "call_expression" || value.childForFieldName("function")?.text !== "defineProps") continue;
    const name = d.childForFieldName("name");
    if (name?.type === "identifier") aliases.add(name.text);
    else if (name?.type === "object_pattern") {
      for (const p of name.namedChildren) {
        if (p?.type === "shorthand_property_identifier_pattern") destructured.set(p.text, p.text);
        else if (p?.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier") destructured.set(p.childForFieldName("value")!.text, p.childForFieldName("key")?.text ?? "");
      }
    }
  }
  // `const { page } = toRefs(props)`, `const size = toRef(props, "size")`: a ref onto a prop.
  const propRefs = new Map<string, string>();
  if (aliases.size > 0) {
    for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
      const value = d?.childForFieldName("value");
      const name = d?.childForFieldName("name");
      if (!d || value?.type !== "call_expression" || value.childForFieldName("function")?.type !== "identifier") continue;
      const hook = value.childForFieldName("function")!.text;
      const args = argumentsOf(value);
      const from = sources.get(hook);
      if ((hook !== "toRefs" && hook !== "toRef") || (from !== undefined && !VUE_SOURCES.test(from)) || args[0]?.type !== "identifier" || !aliases.has(args[0].text)) continue;
      if (hook === "toRefs" && name?.type === "object_pattern") {
        for (const p of name.namedChildren) {
          if (p?.type === "shorthand_property_identifier_pattern") propRefs.set(p.text, p.text);
          else if (p?.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier") propRefs.set(p.childForFieldName("value")!.text, p.childForFieldName("key")?.text ?? "");
        }
      } else if (hook === "toRef" && name?.type === "identifier" && args[1]?.type === "string") propRefs.set(name.text, args[1].text.slice(1, -1));
    }
    for (const [local, prop] of propRefs) if (prop) destructured.set(local, prop);
  }
  if (aliases.size === 0 && destructured.size === 0) return facts;
  const propsRead = (expr: Node | null): string[] => {
    const out = new Set<string>();
    const visit = (n: Node): void => {
      if (n.type === "member_expression" && n.childForFieldName("object")?.type === "identifier" && aliases.has(n.childForFieldName("object")!.text)) {
        const prop = n.childForFieldName("property")?.text;
        if (prop) out.add(prop);
      } else if (n.type === "identifier" && destructured.has(n.text) && !(n.parent?.type === "member_expression" && n.parent.childForFieldName("property")?.id === n.id)) {
        out.add(destructured.get(n.text)!);
      }
      for (const c of n.namedChildren) if (c) visit(c);
    };
    if (expr) visit(expr);
    return [...out];
  };
  const fromVue = (name: string): boolean => {
    const src = sources.get(name);
    return src === undefined || VUE_SOURCES.test(src);
  };
  const found: PropTrigger[] = [];
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = n?.childForFieldName("function");
    if (!n || callee?.type !== "identifier" || !fromVue(callee.text)) continue;
    const args = argumentsOf(n);
    if (VUE_WATCH.has(callee.text) && args.length >= 2) {
      const sourceNodes = args[0]!.type === "array" ? args[0]!.namedChildren : [args[0]];
      const read = sourceNodes.flatMap((s) => (s && (s.type === "arrow_function" || s.type === "function_expression" || s.type === "function") ? propsRead(s.childForFieldName("body")) : s?.type === "identifier" && propRefs.get(s.text) ? [propRefs.get(s.text)!] : []));
      if (read.length > 0) found.push({ props: read, hook: callee.text, ...callbackOf(args[1]!), at: n });
    } else if (VUE_EFFECT.has(callee.text) && args[0]) {
      const read = propsRead(getterOf(args[0]));
      if (read.length > 0) found.push({ props: read, hook: callee.text, ...callbackOf(args[0]), at: n });
    }
  }
  if (found.length === 0) return facts;
  const held = holdCallbacks(facts.held, found);
  for (const t of found) if (t.callback && !facts.held.has(t.callback.id)) t.heldHere = true;
  return { ...facts, held, propTriggers: found };
}

/**
 * Holds each callback written in place that is not held yet — a watcher whose source another file feeds: its own
 * function, `<hook@row>`, `#n` after the first of one name.
 */
export function holdCallbacks(held: ReadonlyMap<number, string>, found: ReadonlyArray<{ hook: string; callback: Node | null }>): Map<number, string> {
  const out = new Map(held);
  const used = new Map<string, number>();
  const base = (name: string) => name.replace(/#\d+>$/, ">");
  for (const name of out.values()) used.set(base(name), (used.get(base(name)) ?? 0) + 1);
  for (const t of found) {
    if (!t.callback || out.has(t.callback.id)) continue;
    const name = `<${t.hook}@${t.callback.startPosition.row + 1}>`;
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    out.set(t.callback.id, n > 1 ? name.replace(/>$/, `#${n}>`) : name);
  }
  return out;
}

/** The held name of a watcher callback written in place whose cell the file writes, else null. */
export function reactiveCallbackName(node: Node): string | null {
  return reactiveCellsOf(node.tree).held.get(node.id) ?? null;
}

/** `FileAnalysis.reactiveCells`: each write named by the function it sits in, each trigger by its callback. */
export function reactiveCells(tree: Tree, _sourceText: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): ReactiveCells | null {
  const facts = reactiveCellsOf(tree);
  if (facts.held.size === 0 && facts.optionNames.size === 0 && !facts.triggers.some((t) => t.callee)) return null;
  const declared = new Set(functions.map((f) => f.name));
  const out: ReactiveCells = { writes: [], triggers: [] };
  const triggerFns = new Set<string>();
  /** Indexes into `out.triggers` of an Options API watcher run at setup. */
  const optionsImmediate = new Set<number>();
  for (const t of facts.triggers) {
    const name = t.callback ? facts.held.get(t.callback.id) ?? facts.optionNames.get(t.callback.id) : t.callee && declared.has(t.callee) ? t.callee : undefined;
    if (!name || !declared.has(name)) continue;
    triggerFns.add(name);
    if (t.immediate && t.callback && facts.optionNames.has(t.callback.id)) optionsImmediate.add(out.triggers.length);
    out.triggers.push({ cells: [...t.cells].sort(), function: name, line: t.at.startPosition.row + 1, ...(TRUTHY_ONLY.has(t.hook) ? { truthyOnly: true } : {}), ...(t.immediate ? { immediate: true } : {}) });
  }
  if (out.triggers.length === 0) return null;
  const atSetup = out.triggers.some((t) => t.immediate);
  const watched = out.triggers.flatMap((t) => t.cells);
  const seen = new Set<string>();
  for (const w of facts.writes) {
    if (!watched.some((c) => sameCell(w.cell, c))) continue;
    const line = w.line ?? w.node!.startPosition.row + 1;
    // A statement the template runs is the component's own, which its `<setup>` stands for.
    const fn = w.template ? "<setup>" : innermost(functions, line);
    if (!fn) continue;
    const id = `${w.cell}\0${fn}\0${line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.writes.push({ cell: w.cell, function: fn, line, spelling: w.spelling, ...(w.falsy ? { falsy: true } : {}) });
  }
  // The file's `<setup>` takes the template's writes and, in an Options API component, its `immediate` watchers.
  if (out.writes.some((w) => w.function === "<setup>") || out.triggers.some((t, i) => t.immediate && optionsImmediate.has(i))) out.component = true;
  return out.writes.length > 0 || atSetup ? out : null;
}

/** The innermost declared function holding a line: the narrowest, then the last to start. */
export function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}

/** What a statement the template runs writes (`@click="page = 2"`, `v-model="query"`), left in the parsed text as a comment by `withMarkupExpressions`. */
export interface TemplateStatement { line: number; targets: TemplateTarget[] }

function templateWritesOf(tree: Tree, text: string): TemplateStatement[] {
  if (!text.includes(TEMPLATE_WRITE_MARK)) return [];
  const out: TemplateStatement[] = [];
  for (const c of tree.rootNode.descendantsOfType("comment")) {
    if (!c?.text.startsWith(TEMPLATE_WRITE_MARK)) continue;
    const targets = decodeTargets(c.text.slice(TEMPLATE_WRITE_MARK.length, -2));
    if (targets.length > 0) out.push({ line: c.startPosition.row + 1, targets });
  }
  return out;
}

/** The members of a cell a write lands in, as path steps: a computed member and a mutation are the elements (`[]`). */
export function stepsPath(rest: ReadonlyArray<string | null>, mutated: boolean): string[] {
  const cut = rest.indexOf(null);
  const path = (cut < 0 ? rest : rest.slice(0, cut)).map((x) => x ?? "[]");
  if (cut >= 0 || mutated) path.push("[]");
  return path;
}

function read(tree: Tree, text: string, template: readonly TemplateStatement[]): CellFacts {
  const vue = /\b(?:ref|shallowRef|reactive|shallowReactive|computed|customRef|defineModel|toRefs?|useVModel|use(?:Local|Session)?Storage|useRoute)\s*(?:<[^>]*>)?\s*\(/.test(text) && /\b(?:watch\w*|whenever|\w+Watch)\s*\(/.test(text);
  const react = /\buse(?:Layout|Insertion)?Effect\s*\(/.test(text) && /\buseState\b/.test(text);
  const angular = /\b(?:effect|toObservable)\s*\(/.test(text) && /\b(?:signal|model|linkedSignal)\s*(?:<[^>]*>)?\s*\(/.test(text);
  if (!vue && !react && !angular) return EMPTY;
  const sources = importSources(tree.rootNode);
  const isFrom = (name: string, lib: RegExp, autoImported: boolean): boolean => {
    const src = sources.get(name);
    return src === undefined ? autoImported : lib.test(src);
  };

  // Declarations: scope node id → name → cell.
  const byScope = new Map<number, Map<string, Cell>>();
  const declare = (scope: Node, cell: Omit<Cell, "key"> & { key?: string }): Cell => {
    const full: Cell = { ...cell, key: cell.key ?? `${scope.startPosition.row + 1}:${cell.name}` };
    (byScope.get(scope.id) ?? byScope.set(scope.id, new Map()).get(scope.id)!).set(cell.name, full);
    return full;
  };
  const scopeOf = (n: Node): Node => {
    for (let p = n.parent; p; p = p.parent) if (SCOPES.has(p.type) || p.type === "program") return p;
    return n.tree.rootNode;
  };
  const resolve = (name: string, at: Node): Cell | undefined => {
    for (let p: Node | null = at; p; p = p.parent) {
      if (!SCOPES.has(p.type) && p.type !== "program") continue;
      const hit = byScope.get(p.id)?.get(name);
      if (hit) return hit;
    }
    return undefined;
  };
  const classOf = (n: Node): Node | null => {
    for (let p = n.parent; p; p = p.parent) if (CLASSES.has(p.type)) return p;
    return null;
  };
  const field = (cls: Node, name: string): Cell | undefined => byScope.get(cls.id)?.get(name);

  const routers = new Map<number, Set<string>>();
  const pendingDerived: Array<{ cell: Cell; body: Node | null; deps: Node | null; scope: Node; cls: Node | null }> = [];
  for (const d of tree.rootNode.descendantsOfType(["variable_declarator", "public_field_definition", "field_definition"])) {
    if (!d) continue;
    const value = d.childForFieldName("value");
    if (value?.type !== "call_expression") continue;
    const callee = value.childForFieldName("function");
    const hook = callee?.type === "identifier" ? callee.text : callee?.type === "member_expression" && callee.childForFieldName("object")?.text === "React" ? callee.childForFieldName("property")?.text ?? "" : "";
    const args = argumentsOf(value);
    if (d.type === "variable_declarator") {
      const nameNode = d.childForFieldName("name");
      const scope = scopeOf(d);
      // `const { page } = toRefs(state)`, `const size = toRef(state, "size")`: the same cell as `state.page`.
      if (vue && (hook === "toRefs" || hook === "toRef") && isFrom(hook, VUE_SOURCES, true)) {
        const source = args[0]?.type === "identifier" ? resolve(args[0].text, args[0]) : undefined;
        // A reactive object (not a ref, whose members are read below `.value`).
        const holds = source && !source.opaque && source.kind === "reactive";
        if (holds && hook === "toRefs" && nameNode?.type === "object_pattern") {
          for (const p of nameNode.namedChildren) {
            if (p?.type === "shorthand_property_identifier_pattern") declare(scope, { name: p.text, kind: "ref", key: `${source.key}.${p.text}` });
            else if (p?.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier") {
              const prop = p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
              if (prop) declare(scope, { name: p.childForFieldName("value")!.text, kind: "ref", key: `${source.key}.${prop}` });
            }
          }
          continue;
        }
        if (holds && hook === "toRef" && nameNode?.type === "identifier" && args[1]?.type === "string") {
          declare(scope, { name: nameNode.text, kind: "ref", key: `${source.key}.${args[1].text.slice(1, -1)}` });
          continue;
        }
      }
      if (vue && nameNode?.type === "identifier" && VUE_CELLS.has(hook) && isFrom(hook, VUE_SOURCES, true)) {
        const typeArgs = value.childForFieldName("type_arguments")?.text ?? "";
        const opaque = hook === "shallowRef" || hook === "useTemplateRef" || DOM_TYPE.test(typeArgs);
        const cell = declare(scope, { name: nameNode.text, kind: hook === "computed" ? "computed" : hook === "reactive" || hook === "shallowReactive" ? "reactive" : "ref", ...(opaque ? { opaque } : {}) });
        if (hook === "computed") pendingDerived.push({ cell, body: getterOf(args[0]), deps: null, scope, cls: null });
      } else if (vue && nameNode?.type === "identifier" && hook === "useRoute") {
        declare(scope, { name: nameNode.text, kind: "route" });
      } else if (vue && nameNode?.type === "identifier" && hook === "useRouter") {
        (routers.get(scope.id) ?? routers.set(scope.id, new Set()).get(scope.id)!).add(nameNode.text);
      } else if (react && nameNode?.type === "array_pattern" && hook === "useState" && isFrom(hook, REACT_SOURCES, callee?.type === "member_expression")) {
        const [state, setter] = nameNode.namedChildren;
        if (state?.type === "identifier") declare(scope, { name: state.text, kind: "state", ...(setter?.type === "identifier" ? { setter: setter.text } : {}) });
      } else if (react && nameNode?.type === "identifier" && REACT_DERIVED.has(hook) && isFrom(hook, REACT_SOURCES, callee?.type === "member_expression")) {
        const cell = declare(scope, { name: nameNode.text, kind: "derived" });
        pendingDerived.push({ cell, body: null, deps: args[1] ?? null, scope, cls: null });
      }
    } else if (angular) {
      const nameNode = d.childForFieldName("name") ?? d.childForFieldName("property");
      const cls = classOf(d);
      if (!cls || !nameNode || !ANGULAR_CELLS.has(hook) || !isFrom(hook, /^@angular\/core$/, false)) continue;
      const cell = declare(cls, { name: nameNode.text, kind: hook === "computed" ? "computed" : "signal" });
      if (hook === "computed") pendingDerived.push({ cell, body: getterOf(args[0]), deps: null, scope: cls, cls });
    }
  }
  if (byScope.size === 0) return EMPTY;

  // What a computed, a memo or a watcher source reads.
  const readsOf = (expr: Node | null, cls: Node | null): Set<string> => {
    const out = new Set<string>();
    if (!expr) return out;
    const add = (c: Cell | undefined, path: readonly string[] = [], deep = false) => {
      if (!c) return;
      out.add(cellPath(c.key, path) + (deep ? "*" : ""));
      for (const r of c.reads ?? []) out.add(r);
    };
    const visit = (n: Node): void => {
      if (n.type === "call_expression") {
        const callee = n.childForFieldName("function");
        // `untracked(() => this.club())` reads without tracking.
        if (callee?.type === "identifier" && callee.text === "untracked") return;
        // `this.clubId()`: a signal read.
        if (cls && callee?.type === "member_expression" && callee.childForFieldName("object")?.type === "this") {
          const f = field(cls, callee.childForFieldName("property")?.text ?? "");
          if (f && n.childForFieldName("arguments")?.namedChildCount === 0) add(f);
        }
      } else if (n.type === "identifier" && !cls) {
        const c = resolve(n.text, n);
        // A ref read in a getter is `x.value…`; a reactive object is read by any member; a route by `route.query…`.
        // What the body only hands back (`() => x.value.filters`) is read as it stands; a value used whole, iterated
        // or called on (`x.value.filter(…)`, `.length`) is read through.
        const read = c ? readPath(n) : { path: [], deep: false, returned: false };
        const { path } = read;
        if (c && (c.kind === "ref" || c.kind === "computed") && path[0] === "value") add(c, path.slice(1), read.deep || (path.length === 1 && !read.returned));
        else if (c && c.kind === "reactive") add(c, path, read.deep || (path.length === 0 && !read.returned));
        else if (c && c.kind === "route" && (path[0] === "query" || path[0] === "params")) add(c, path, read.deep);
        else if (c && (c.kind === "state" || c.kind === "derived")) add(c);
      }
      for (const ch of n.namedChildren) if (ch) visit(ch);
    };
    visit(expr);
    return out;
  };
  // A watcher's source: a cell itself (`watch(query, …)`), an array of them, or a getter reading them.
  const sourceCells = (src: Node | undefined): Set<string> => {
    const out = new Set<string>();
    if (!src) return out;
    const one = (n: Node) => {
      if (n.type === "identifier") {
        // `watch(query, …)` compares a ref's value (a member change inside it is no change), `watch(filters, …)` on a
        // reactive object reads it through.
        const c = resolve(n.text, n);
        if (c && c.kind !== "state" && c.kind !== "route") {
          out.add(c.key + (c.kind === "reactive" ? "*" : ""));
          for (const r of c.reads ?? []) out.add(r);
        }
      } else if (n.type === "arrow_function" || n.type === "function_expression" || n.type === "function") {
        for (const k of readsOf(n.childForFieldName("body"), null)) out.add(k);
      } else if (n.type === "member_expression") {
        // `route.query`, `state.settings`: the object a reactive member holds is watched through.
        for (const k of readsOf(n, null)) out.add(k.replace(/\*?$/, "*"));
      }
    };
    if (src.type === "array") for (const el of src.namedChildren) el && one(el);
    else one(src);
    return out;
  };
  // A memo's deps, or an effect's: identifiers naming state or memos.
  const depCells = (deps: Node | null): Set<string> => {
    const out = new Set<string>();
    if (deps?.type !== "array") return out;
    for (const el of deps.namedChildren) {
      let root: Node | null = el;
      while (root?.type === "member_expression") root = root.childForFieldName("object");
      if (root?.type !== "identifier") continue;
      const c = resolve(root.text, root);
      if (c && (c.kind === "state" || c.kind === "derived")) {
        out.add(c.key);
        for (const r of c.reads ?? []) out.add(r);
      }
    }
    return out;
  };
  for (const p of pendingDerived) p.cell.reads = p.deps ? depCells(p.deps) : readsOf(p.body, p.cls);

  const writes: Write[] = [];
  const triggers: Trigger[] = [];
  /**
   * The cell a write lands in: `x.value = …` replaces the ref's value (`12:x`), `x.value.items = …` a member
   * (`12:x.items`), `x.value[i] = …` an element (`12:x.[]`); `mutated` is a call changing what the target holds
   * (`x.value.push(c)` → `12:x.[]`, `filters.leagues.add(id)` → `12:filters.leagues.[]`).
   */
  const cellOfTarget = (target: Node | null, mutated: boolean): { cell: string; spelling: string } | null => {
    let n = target;
    const steps: Array<string | null> = [];
    while (n && (n.type === "member_expression" || n.type === "subscript_expression")) {
      steps.unshift(n.type === "member_expression" ? n.childForFieldName("property")?.text ?? null : null);
      n = n.childForFieldName("object");
    }
    if (n?.type !== "identifier") return null;
    const c = resolve(n.text, n);
    if (!c) return null;
    let rest: Array<string | null>;
    if ((c.kind === "ref" || c.kind === "computed") && steps[0] === "value") rest = steps.slice(1);
    else if (c.kind === "reactive" && (steps.length > 0 || mutated)) rest = steps;
    else return null;
    // A shallow ref, or one holding a DOM node, changes only when its value is replaced.
    if (c.opaque && (rest.length > 0 || mutated)) return null;
    return { cell: cellPath(c.key, stepsPath(rest, mutated)), spelling: c.name };
  };
  for (const n of tree.rootNode.descendantsOfType(["assignment_expression", "augmented_assignment_expression", "update_expression", "call_expression"])) {
    if (!n) continue;
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee?.type === "identifier") {
        const name = callee.text;
        // `setClubId(7)`: a state setter in scope.
        if (react) {
          for (let p: Node | null = n; p; p = p.parent) {
            if (!SCOPES.has(p.type) && p.type !== "program") continue;
            const cells = byScope.get(p.id);
            const hit = cells && [...cells.values()].find((c) => c.setter === name);
            if (hit) {
              const arg = argumentsOf(n);
              writes.push({ cell: hit.key, node: n, spelling: name, ...(arg.length === 1 && FALSY.test(arg[0]!.text) ? { falsy: true } : {}) });
              break;
            }
          }
        }
        const args = argumentsOf(n);
        if (vue && VUE_WATCH.has(name) && isFrom(name, VUE_SOURCES, true) && args.length >= 2) {
          // `{ deep: true }` reads every source through.
          const cells = sourceCells(args[0]);
          const immediate = name === "watchImmediate" || isOption(args[2], "immediate");
          triggers.push({ cells: isDeep(args[2]) ? new Set([...cells].map((c) => c.replace(/\*?$/, "*"))) : cells, hook: name, ...callbackOf(args[1]!), at: n, ...(immediate ? { immediate } : {}) });
        } else if (vue && VUE_EFFECT.has(name) && isFrom(name, VUE_SOURCES, true) && args[0]) {
          triggers.push({ cells: readsOf(getterOf(args[0]), null), hook: name, ...callbackOf(args[0]), at: n, immediate: true });
        } else if (react && REACT_EFFECT.has(name) && isFrom(name, REACT_SOURCES, false) && args.length >= 2) {
          triggers.push({ cells: depCells(args[1]!), hook: name, ...callbackOf(args[0]), at: n });
        } else if (angular && name === "effect" && isFrom(name, /^@angular\/core$/, false) && args[0]) {
          const cls = classOf(n);
          if (cls) triggers.push({ cells: readsOf(getterOf(args[0]), cls), hook: name, ...callbackOf(args[0]), at: n });
        }
        continue;
      }
      if (callee?.type !== "member_expression") continue;
      const method = callee.childForFieldName("property")?.text ?? "";
      const obj = callee.childForFieldName("object");
      // `toObservable(this.clubId).pipe(switchMap(() => this.load())).subscribe(cb)`: a write of the signal runs the
      // operators' callbacks and the subscriber's.
      if (angular && method === "subscribe" && isFrom("toObservable", /^@angular\/core\/rxjs-interop$/, false)) {
        const cls = classOf(n);
        const watched = cls ? toObservableSource(n, cls) : null;
        const f = cls && watched ? field(cls, watched.signal) : undefined;
        if (f && watched && f.kind !== "state") {
          const cells = new Set([f.key, ...(f.reads ?? [])]);
          for (const cb of watched.chain.operatorCallbacks) triggers.push({ cells, hook: "pipe", callback: cb, callee: null, at: n });
          const sub = callbackOf(argumentsOf(n)[0]);
          if (sub.callback) triggers.push({ cells, hook: "subscribe", callback: sub.callback, callee: null, at: n });
        }
        continue;
      }
      if (react && obj?.type === "identifier" && obj.text === "React" && REACT_EFFECT.has(method)) {
        const args = argumentsOf(n);
        if (args.length >= 2) triggers.push({ cells: depCells(args[1]!), hook: method, ...callbackOf(args[0]), at: n });
        continue;
      }
      // `this.clubId.set(7)`, `this.picked.update((xs) => …)`
      if (angular && (method === "set" || method === "update") && obj?.type === "member_expression" && obj.childForFieldName("object")?.type === "this") {
        const cls = classOf(n);
        const f = cls && field(cls, obj.childForFieldName("property")?.text ?? "");
        const arg = argumentsOf(n);
        if (f && f.kind === "signal") writes.push({ cell: f.key, node: n, spelling: f.name, ...(method === "set" && arg.length === 1 && FALSY.test(arg[0]!.text) ? { falsy: true } : {}) });
        continue;
      }
      // `router.push({ query: … })`: the route's query changes under the same page.
      if (vue && (method === "push" || method === "replace") && obj?.type === "identifier") {
        let isRouter = false;
        for (let p: Node | null = n; p && !isRouter; p = p.parent) if (routers.get(p.id)?.has(obj.text)) isRouter = true;
        const arg = argumentsOf(n)[0];
        if (isRouter && arg?.type === "object" && staysOnPage(arg)) {
          const route = routeCell(n, byScope);
          if (route) writes.push({ cell: cellPath(route.key, ["query"]), node: n, spelling: `${route.name}.query` });
        }
        continue;
      }
      // `picked.value.push(c)`, `filters.leagues.add(id)`
      if (vue && MUTATORS.has(method)) {
        const target = cellOfTarget(obj ?? null, true);
        if (target) writes.push({ cell: target.cell, node: n, spelling: target.spelling });
      }
      continue;
    }
    if (!vue) continue;
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    const target = cellOfTarget(left, false);
    const right = n.type === "assignment_expression" ? n.childForFieldName("right")?.text.trim() ?? "" : "";
    if (target) writes.push({ cell: target.cell, node: n, spelling: target.spelling, ...(FALSY.test(right) ? { falsy: true } : {}) });
  }

  // What the template writes: a ref is read without `.value` there, and only what `<script setup>` declares at its top is in scope.
  const top = byScope.get(tree.rootNode.id);
  if (vue && top) {
    for (const stmt of template) {
      for (const t of stmt.targets) {
        const c = top.get(t.root);
        if (!c || (c.kind !== "ref" && c.kind !== "computed" && c.kind !== "reactive")) continue;
        // A reactive object is changed through a member; a shallow ref or one holding a DOM node, only when replaced.
        if ((c.kind === "reactive" && t.steps.length === 0 && !t.mutated) || (c.opaque && (t.steps.length > 0 || t.mutated))) continue;
        writes.push({ cell: cellPath(c.key, stepsPath(t.steps, t.mutated)), node: null, line: stmt.line, template: true, spelling: c.name, ...(t.falsy ? { falsy: true } : {}) });
      }
    }
  }

  // A callback is held when a write elsewhere can re-run it.
  const held = new Map<number, string>();
  const written = (t: Trigger) => writes.some((w) => [...t.cells].some((c) => sameCell(w.cell, c)) && !(t.callback && w.node && within(w.node, t.callback)) && !(w.falsy && TRUTHY_ONLY.has(t.hook)));
  for (const t of triggers) {
    if (t.cells.size === 0 || !t.callback || !written(t)) continue;
    held.set(t.callback.id, `<${t.hook}@${t.callback.startPosition.row + 1}>`);
  }
  // Two on one line keep their own names.
  const taken = new Map<string, number>();
  for (const [id, name] of held) {
    const n = (taken.get(name) ?? 0) + 1;
    taken.set(name, n);
    if (n > 1) held.set(id, name.replace(/>$/, `#${n}>`));
  }
  return { writes, triggers: triggers.filter((t) => (t.cells.size > 0 || (t.immediate && t.callee)) && (t.callback ? held.has(t.callback.id) : t.callee)), held, optionNames: new Map() };
}

/** A cell and the members below it (`12:filters.league`). */
function cellPath(key: string, path: readonly string[]): string {
  return path.length > 0 ? `${key}.${path.join(".")}` : key;
}

/**
 * The members read below an identifier: `state.value.orderBy` → `["value", "orderBy"]`, up to a computed
 * member. `deep` when what is read is called on or measured (`items.value.filter(…)`, `items.value.length`,
 * `items.value[0]`) — that reads its contents; `returned` when it is all a getter's body is (`() => x.value`).
 */
export function readPath(id: Node): { path: string[]; deep: boolean; returned: boolean } {
  const path: string[] = [];
  let n: Node = id;
  let deep = false;
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (p.type === "subscript_expression" && p.childForFieldName("object")?.id === n.id) {
      deep = true;
      break;
    }
    if (p.type !== "member_expression" || p.childForFieldName("object")?.id !== n.id) break;
    const prop = p.childForFieldName("property")?.text;
    if (!prop) break;
    const call = p.parent;
    if ((call?.type === "call_expression" && call.childForFieldName("function")?.id === p.id) || prop === "length") {
      deep = true;
      break;
    }
    path.push(prop);
  }
  const returned = !deep && n.parent?.type === "arrow_function" && n.parent.childForFieldName("body")?.id === n.id;
  return { path, deep, returned };
}

/** A watch options object asking for `deep: true` (or a depth). */
export function isDeep(options: Node | undefined): boolean {
  return isOption(options, "deep");
}

/** An options object setting `name` to anything but `false`. */
export function isOption(options: Node | undefined, name: string): boolean {
  if (options?.type !== "object") return false;
  return options.namedChildren.some((p) => p?.type === "pair" && optionKey(p.childForFieldName("key")) === name && p.childForFieldName("value")?.text !== "false");
}

function optionKey(key: Node | null | undefined): string | null {
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  return key.type === "string" ? key.text.slice(1, -1) : null;
}

const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function"]);
/** Keys only a component's options object carries, besides `watch`. */
const OPTION_SIBLINGS = new Set(["data", "methods", "computed", "props", "setup", "created", "mounted", "components", "emits", "mixins", "template", "render"]);

interface WatchCallback { node: Node | null; name: string; callee?: string }

/**
 * The callbacks of one `watch: { … }` member of an Options API component:
 *
 *   page() {}                         → a function named `page` (the key names it, as every option member is)
 *   'filters.league'(n) {}            → `<watch@L>`
 *   page: { handler() {}, immediate: true }, page: [fnA, 'method'], page: 'loadPlayers'
 *
 * `path` is the dotted path watched, `deep`/`immediate` the options of the object form. A string names a method
 * (`callee`), not a function written in place.
 */
export interface Watch { member: Node; path: string; deep: boolean; immediate: boolean; callbacks: WatchCallback[] }

/** The member names a component's other option groups declare (`methods`, `computed`): a watcher of the same name must not share their function name. */
function ownMembers(options: Node): Set<string> {
  const out = new Set<string>();
  for (const m of options.namedChildren) {
    const group = m?.type === "pair" ? optionKey(m.childForFieldName("key")) : null;
    const value = m?.type === "pair" ? m.childForFieldName("value") : null;
    if ((group !== "methods" && group !== "computed") || value?.type !== "object") continue;
    for (const e of value.namedChildren) {
      const k = optionKey(e?.type === "pair" ? e.childForFieldName("key") : e?.type === "method_definition" ? e.childForFieldName("name") : null);
      if (k) out.add(k);
    }
  }
  return out;
}

function watchOf(member: Node, taken: ReadonlySet<string>): Watch[] {
  const key = optionKey(member.type === "pair" ? member.childForFieldName("key") : member.type === "method_definition" ? member.childForFieldName("name") : null);
  if (!key || !/^[\w$]+(?:\.[\w$]+)*$/.test(key)) return [];
  const named = /^[A-Za-z_$][\w$]*$/.test(key) && !taken.has(key);
  const callbackOfNode = (n: Node, direct: boolean): WatchCallback | null => {
    if (n.type === "method_definition" || FUNCTION_VALUES.has(n.type)) return { node: n, name: direct && named ? key : `<watch@${n.startPosition.row + 1}>` };
    if (n.type === "string") return { node: null, name: "", callee: n.text.slice(1, -1) };
    return null;
  };
  const out: Watch[] = [];
  const spec = (value: Node, direct: boolean): void => {
    if (value.type === "object") {
      const callbacks: WatchCallback[] = [];
      for (const p of value.namedChildren) {
        if (!p || optionKey(p.type === "pair" ? p.childForFieldName("key") : p.type === "method_definition" ? p.childForFieldName("name") : null) !== "handler") continue;
        const h = p.type === "pair" ? p.childForFieldName("value") : p;
        const c = h && callbackOfNode(h, false);
        if (c) callbacks.push(c);
      }
      if (callbacks.length > 0) out.push({ member, path: key, deep: isOption(value, "deep"), immediate: isOption(value, "immediate"), callbacks });
    } else if (value.type === "array") {
      for (const el of value.namedChildren) if (el) spec(el, false);
    } else {
      const c = callbackOfNode(value, direct);
      if (c) out.push({ member, path: key, deep: false, immediate: false, callbacks: [c] });
    }
  };
  if (member.type === "method_definition") out.push({ member, path: key, deep: false, immediate: false, callbacks: [{ node: member, name: named ? key : `<watch@${member.startPosition.row + 1}>` }] });
  else {
    const value = member.childForFieldName("value");
    if (value) spec(value, true);
  }
  return out;
}

/**
 * The watchers of an Options API component's `watch: { … }` group, with the function name each callback is
 * declared under. Two callbacks starting on one line are told apart (`<watch@12#2>`), as held callbacks are.
 */
export function optionsWatchers(options: Node): Watch[] {
  let group: Node | null = null;
  for (const m of options.namedChildren) {
    if (m?.type === "pair" && optionKey(m.childForFieldName("key")) === "watch" && m.childForFieldName("value")?.type === "object") group = m.childForFieldName("value");
  }
  if (!group) return [];
  const taken = ownMembers(options);
  const out = group.namedChildren.flatMap((m) => (m ? watchOf(m, taken) : []));
  const seen = new Map<string, number>();
  for (const w of out) {
    for (const cb of w.callbacks) {
      if (!cb.node) continue;
      const n = (seen.get(cb.name) ?? 0) + 1;
      seen.set(cb.name, n);
      if (n > 1) cb.name = cb.name.replace(/>$/, `#${n}>`);
    }
  }
  return out;
}

/** An Options API component's object (`export default { … }`, `defineComponent({ … })`) with a `watch` group. */
function optionsObjects(tree: Tree): Node[] {
  const out: Node[] = [];
  for (const o of tree.rootNode.descendantsOfType("object")) {
    if (!o) continue;
    let watch = false;
    let sibling = false;
    for (const m of o.namedChildren) {
      const k = optionKey(m?.type === "pair" ? m.childForFieldName("key") : m?.type === "method_definition" ? m.childForFieldName("name") : null);
      if (k === "watch" && m?.type === "pair" && m.childForFieldName("value")?.type === "object") watch = true;
      else if (k && OPTION_SIBLINGS.has(k)) sibling = true;
    }
    if (watch && sibling) out.push(o);
  }
  return out;
}

/** The bodies of an options object's `computed` group, by member name (a method, a function value, or `{ get() {…} }`). */
function computedMembers(options: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const m of options.namedChildren) {
    if (m?.type !== "pair" || optionKey(m.childForFieldName("key")) !== "computed" || m.childForFieldName("value")?.type !== "object") continue;
    for (const e of m.childForFieldName("value")!.namedChildren) {
      const key = optionKey(e?.type === "pair" ? e.childForFieldName("key") : e?.type === "method_definition" ? e.childForFieldName("name") : null);
      const body = e?.type === "method_definition" ? e.childForFieldName("body") : e?.type === "pair" ? getterOf(e.childForFieldName("value") ?? undefined) : null;
      if (key && body) out.set(key, body);
    }
  }
  return out;
}

/**
 * The cells a computed member reads — `this.page * this.size` → `<scope>:page`, `<scope>:size` — through the computed
 * members it reads in turn. A member used whole or measured (`this.rows.length`, `this.rows.filter(…)`) is read through.
 */
function computedReads(computed: ReadonlyMap<string, Node>, name: string, scope: number, seen: Set<string> = new Set()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const out = new Set<string>();
  for (const t of computed.get(name)?.descendantsOfType("this") ?? []) {
    if (!t || t.parent?.type !== "member_expression" || t.parent.childForFieldName("object")?.id !== t.id) continue;
    const { path, deep } = readPath(t);
    const first = path[0];
    // `$store`, `$route` and `$refs` are not the component's data; a method call (`this.helper()`) has no path.
    if (!first || first.startsWith("$")) continue;
    if (computed.has(first)) {
      for (const r of computedReads(computed, first, scope, seen)) out.add(r);
    } else out.add(cellPath(`${scope}:${first}`, path.slice(1)) + (deep ? "*" : ""));
  }
  return [...out];
}

/**
 * Options API watchers: `watch: { page() { … } }` re-runs when `this.page` is written (`this.page = n`, `this.page++`,
 * `this.filters.league = id`, a mutator call under `deep`) in a function of the same component. A cell is the
 * component's options object plus the name (`<line>:page`, members below it `<line>:filters.league`). An
 * `immediate: true` watcher runs when the component is set up.
 */
function withOptionsApi(tree: Tree, base: CellFacts, text: string, template: readonly TemplateStatement[]): CellFacts {
  if (!text.includes("watch")) return base;
  const components = optionsObjects(tree);
  if (components.length === 0) return base;
  const writes = [...base.writes];
  const triggers = [...base.triggers];
  const optionNames = new Map(base.optionNames);
  const optionsIds = new Set(components.map((c) => c.id));
  for (const options of components) {
    const scope = options.startPosition.row + 1;
    const computed = computedMembers(options);
    for (const w of optionsWatchers(options)) {
      const cell = `${scope}:${w.path}${w.deep ? "*" : ""}`;
      // A watcher on a computed runs when something it reads changes.
      const reads = computed.has(w.path) ? computedReads(computed, w.path, scope) : [];
      for (const cb of w.callbacks) {
        if (cb.node) optionNames.set(cb.node.id, cb.name);
        triggers.push({ cells: new Set([cell, ...reads]), hook: "watch", callback: cb.node, callee: cb.callee ?? null, at: w.member, ...(w.immediate ? { immediate: true } : {}) });
      }
    }
  }
  // `this` is the component in an option member (a method, or a function value of the options object or one of
  // its groups) and in an arrow inside one; any other function — a nested method, a plain function expression —
  // has a `this` of its own.
  const memberOf = (fn: Node): Node | null => {
    const holder = fn.type === "method_definition" ? fn.parent : fn.parent?.type === "pair" ? fn.parent.parent : null;
    if (holder?.type !== "object") return null;
    if (optionsIds.has(holder.id)) return holder;
    const group = holder.parent;
    return group?.type === "pair" && group.parent && optionsIds.has(group.parent.id) ? group.parent : null;
  };
  const componentOf = (n: Node): Node | null => {
    for (let p = n.parent; p; p = p.parent) {
      if (p.type === "arrow_function") continue;
      if (p.type === "method_definition" || p.type === "function_expression" || p.type === "function" || p.type === "function_declaration") return memberOf(p);
    }
    return null;
  };
  const cellOfThis = (target: Node | null, mutated: boolean): { cell: string; name: string } | null => {
    let n = target;
    const steps: Array<string | null> = [];
    while (n && (n.type === "member_expression" || n.type === "subscript_expression")) {
      steps.unshift(n.type === "member_expression" ? n.childForFieldName("property")?.text ?? null : null);
      n = n.childForFieldName("object");
    }
    if (n?.type !== "this" || steps.length === 0 || steps[0] === null) return null;
    const owner = target && componentOf(target);
    if (!owner) return null;
    const cut = steps.indexOf(null);
    const path = (cut < 0 ? steps : steps.slice(0, cut)).map((x) => x ?? "[]");
    if (cut >= 0 || mutated) path.push("[]");
    return { cell: cellPath(`${owner.startPosition.row + 1}:${path[0]}`, path.slice(1)), name: steps[0] };
  };
  for (const n of tree.rootNode.descendantsOfType(["assignment_expression", "augmented_assignment_expression", "update_expression", "call_expression"])) {
    if (!n) continue;
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee?.type !== "member_expression" || !MUTATORS.has(callee.childForFieldName("property")?.text ?? "")) continue;
      const t = cellOfThis(callee.childForFieldName("object"), true);
      if (t) writes.push({ cell: t.cell, node: n, spelling: t.name });
      continue;
    }
    const left = n.type === "update_expression" ? n.childForFieldName("argument") : n.childForFieldName("left");
    const t = cellOfThis(left, false);
    const right = n.type === "assignment_expression" ? n.childForFieldName("right")?.text.trim() ?? "" : "";
    if (t) writes.push({ cell: t.cell, node: n, spelling: t.name, ...(FALSY.test(right) ? { falsy: true } : {}) });
  }
  // `@click="page = 2"`, `v-model="term"`: the template reads the component's data by bare name, `this.page`.
  for (const stmt of template) {
    for (const t of stmt.targets) {
      for (const options of components) {
        writes.push({ cell: cellPath(`${options.startPosition.row + 1}:${t.root}`, stepsPath(t.steps, t.mutated)), node: null, line: stmt.line, template: true, spelling: t.root, ...(t.falsy ? { falsy: true } : {}) });
      }
    }
  }
  return { writes, triggers, held: base.held, optionNames };
}

/** `{ query }`, `{ query, name: route.name }`: a push that changes the query of the page it is on. */
function staysOnPage(arg: Node): boolean {
  let query = false;
  for (const pair of arg.namedChildren) {
    if (pair?.type === "shorthand_property_identifier" && pair.text === "query") query = true;
    if (pair?.type !== "pair") continue;
    const key = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
    if (key === "query") query = true;
    else if ((key === "name" || key === "path") && !/^(?:route|this\.\$route)\.(?:name|path)$/.test(pair.childForFieldName("value")?.text ?? "")) return false;
    else if (key === "params") return false;
  }
  return query;
}

/** The `useRoute()` binding in scope at a node. */
function routeCell(at: Node, byScope: Map<number, Map<string, Cell>>): Cell | undefined {
  for (let p: Node | null = at; p; p = p.parent) {
    const cells = byScope.get(p.id);
    const route = cells && [...cells.values()].find((c) => c.kind === "route");
    if (route) return route;
  }
  return undefined;
}

/**
 * The shape of `<source>.pipe(op(() => …), …).subscribe(cb)`: the receiver the operators hang on (a member chain or a
 * call), and the callbacks written in place — each operator call's function arguments that make a call themselves.
 */
export function subscribeChain(subscribe: Node): { root: Node; operatorCallbacks: Node[] } | null {
  const callee = subscribe.childForFieldName("function");
  if (callee?.type !== "member_expression" || callee.childForFieldName("property")?.text !== "subscribe") return null;
  let recv = callee.childForFieldName("object");
  const operatorCallbacks: Node[] = [];
  while (recv?.type === "call_expression") {
    const c = recv.childForFieldName("function");
    if (c?.type !== "member_expression" || c.childForFieldName("property")?.text !== "pipe") break;
    for (const op of argumentsOf(recv)) {
      if (op.type !== "call_expression") continue;
      for (const a of argumentsOf(op)) if ((a.type === "arrow_function" || a.type === "function_expression") && a.descendantsOfType("call_expression").length > 0) operatorCallbacks.push(a);
    }
    recv = c.childForFieldName("object");
  }
  return recv ? { root: recv, operatorCallbacks } : null;
}

/**
 * The signal name an Angular subscription listens to through `toObservable(this.sig)` — in place, or through a
 * field of the class holding it (`clubs$ = toObservable(this.clubId)`) — with the chain it hangs off.
 */
function toObservableSource(subscribe: Node, cls: Node): { signal: string; chain: NonNullable<ReturnType<typeof subscribeChain>> } | null {
  const chain = subscribeChain(subscribe);
  if (!chain) return null;
  let root: Node | null = chain.root;
  if (root.type === "member_expression" && root.childForFieldName("object")?.type === "this") {
    const name = root.childForFieldName("property")?.text;
    const decl = cls.descendantsOfType(["public_field_definition", "field_definition"]).find((d) => d && (d.childForFieldName("name") ?? d.childForFieldName("property"))?.text === name);
    root = decl?.childForFieldName("value") ?? null;
  }
  if (root?.type !== "call_expression" || root.childForFieldName("function")?.text !== "toObservable") return null;
  const source = argumentsOf(root)[0];
  if (source?.type !== "member_expression" || source.childForFieldName("object")?.type !== "this") return null;
  const signal = source.childForFieldName("property")?.text;
  return signal ? { signal, chain } : null;
}

export function within(n: Node, outer: Node): boolean {
  return n.startIndex >= outer.startIndex && n.endIndex <= outer.endIndex;
}

export function argumentsOf(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment");
}

/** The function a getter argument is: `() => a.value + b.value`, `computed({ get: () => … })`. */
export function getterOf(arg: Node | undefined): Node | null {
  if (!arg) return null;
  if (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function") return arg.childForFieldName("body");
  if (arg.type === "object") {
    for (const pair of arg.namedChildren) {
      if (pair?.type === "pair" && pair.childForFieldName("key")?.text === "get") return getterOf(pair.childForFieldName("value") ?? undefined);
      if (pair?.type === "method_definition" && pair.childForFieldName("name")?.text === "get") return pair.childForFieldName("body");
    }
  }
  return null;
}

/** A watcher's callback: written in place, or a function the file declares (`watch(query, loadPlayers)`). */
export function callbackOf(arg: Node | undefined): { callback: Node | null; callee: string | null } {
  if (arg && (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function")) return { callback: arg, callee: null };
  if (arg?.type === "identifier") return { callback: null, callee: arg.text };
  return { callback: null, callee: null };
}

/** Local name → module, for every name the file's top level imports. */
export function importSources(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of root.namedChildren) {
    if (stmt?.type !== "import_statement") continue;
    const source = stmt.childForFieldName("source")?.text.slice(1, -1);
    const clause = stmt.namedChildren.find((c) => c?.type === "import_clause");
    if (!source || !clause) continue;
    for (const id of clause.descendantsOfType("identifier")) if (id) out.set(id.text, source);
  }
  return out;
}
