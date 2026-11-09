import type { Node, Tree } from "web-tree-sitter";
import type { ReactiveCells } from "../../../types/analysis.js";
import { sameCell } from "../../../core/reactive-triggers.js";

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

const SCOPES: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "arrow_function", "method_definition", "generator_function"]);
const CLASSES: ReadonlySet<string> = new Set(["class_declaration", "class", "abstract_class_declaration"]);
/** Calls returning a cell: Vue's refs, a `defineModel` two-way prop, a ref onto a member, VueUse's stored refs. */
const VUE_CELLS: ReadonlySet<string> = new Set(["ref", "shallowRef", "customRef", "reactive", "shallowReactive", "computed", "defineModel", "toRef", "useVModel", "useStorage", "useLocalStorage", "useSessionStorage", "useTemplateRef"]);
const VUE_SOURCES = /^(?:vue|@vue\/[\w-]+|@vueuse\/[\w-]+|#imports|nuxt\/app|#app)$/;
/** Watchers taking a source and a callback (`watch(src, cb)`), and those whose callback reads its own sources. */
const VUE_WATCH = new Set(["watch", "watchDebounced", "watchThrottled", "watchImmediate", "watchDeep", "watchOnce", "watchPausable", "watchIgnorable", "watchTriggerable", "whenever", "debouncedWatch", "throttledWatch", "pausableWatch", "ignorableWatch"]);
const VUE_EFFECT = new Set(["watchEffect", "watchPostEffect", "watchSyncEffect"]);
const REACT_EFFECT = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const REACT_DERIVED = new Set(["useMemo", "useCallback"]);
const REACT_SOURCES = /^(?:react|preact\/hooks|preact\/compat)$/;
const ANGULAR_CELLS = new Set(["signal", "computed", "model", "linkedSignal"]);
/** Array, Set and Map members that change the collection they are called on. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);

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

interface Write { cell: string; node: Node; spelling: string; falsy?: boolean }
interface Trigger { cells: Set<string>; hook: string; callback: Node | null; callee: string | null; at: Node }

/** A value only a switch-off writes: `false`, `null`, `undefined`, an empty string, `0`. */
const FALSY = /^(?:false|null|undefined|''|""|``|0)$/;
/** Watchers that run their callback only when the source turns truthy (VueUse `whenever`). */
const TRUTHY_ONLY = new Set(["whenever"]);
/** A ref's type argument naming a DOM node: what it holds is never made reactive. */
const DOM_TYPE = /\b(?:HTML\w*Element|SVG\w*Element|Element|Node|Document|Window)\b/;

export interface CellFacts { writes: Write[]; triggers: Trigger[]; held: Map<number, string> }

let memoTree: Tree | null = null;
let memo: CellFacts | null = null;
const EMPTY: CellFacts = { writes: [], triggers: [], held: new Map() };

/** The cells, writes and triggers of a tree, read once per tree. */
export function reactiveCellsOf(tree: Tree): CellFacts {
  if (tree === memoTree) return memo!;
  memoTree = tree;
  memo = read(tree);
  return memo;
}

/** The held name of a watcher callback written in place whose cell the file writes, else null. */
export function reactiveCallbackName(node: Node): string | null {
  return reactiveCellsOf(node.tree).held.get(node.id) ?? null;
}

/** `FileAnalysis.reactiveCells`: each write named by the function it sits in, each trigger by its callback. */
export function reactiveCells(tree: Tree, _sourceText: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): ReactiveCells | null {
  const facts = reactiveCellsOf(tree);
  if (facts.held.size === 0 && !facts.triggers.some((t) => t.callee)) return null;
  const declared = new Set(functions.map((f) => f.name));
  const out: ReactiveCells = { writes: [], triggers: [] };
  const triggerFns = new Set<string>();
  for (const t of facts.triggers) {
    const name = t.callback ? facts.held.get(t.callback.id) : t.callee && declared.has(t.callee) ? t.callee : undefined;
    if (!name || !declared.has(name)) continue;
    triggerFns.add(name);
    out.triggers.push({ cells: [...t.cells].sort(), function: name, line: t.at.startPosition.row + 1, ...(TRUTHY_ONLY.has(t.hook) ? { truthyOnly: true } : {}) });
  }
  if (out.triggers.length === 0) return null;
  const watched = out.triggers.flatMap((t) => t.cells);
  const seen = new Set<string>();
  for (const w of facts.writes) {
    if (!watched.some((c) => sameCell(w.cell, c))) continue;
    const line = w.node.startPosition.row + 1;
    const fn = innermost(functions, line);
    if (!fn) continue;
    const id = `${w.cell}\0${fn}\0${line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.writes.push({ cell: w.cell, function: fn, line, spelling: w.spelling, ...(w.falsy ? { falsy: true } : {}) });
  }
  return out.writes.length > 0 ? out : null;
}

/** The innermost declared function holding a line: the narrowest, then the last to start. */
function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}

function read(tree: Tree): CellFacts {
  const text = tree.rootNode.text;
  const vue = /\b(?:ref|shallowRef|reactive|shallowReactive|computed|customRef|defineModel|toRef|useVModel|use(?:Local|Session)?Storage|useRoute)\s*(?:<[^>]*>)?\s*\(/.test(text) && /\b(?:watch\w*|whenever|\w+Watch)\s*\(/.test(text);
  const react = /\buse(?:Layout|Insertion)?Effect\s*\(/.test(text) && /\buseState\b/.test(text);
  const angular = /\beffect\s*\(/.test(text) && /\b(?:signal|model|linkedSignal)\s*(?:<[^>]*>)?\s*\(/.test(text);
  if (!vue && !react && !angular) return EMPTY;
  const sources = importSources(tree.rootNode);
  const isFrom = (name: string, lib: RegExp, autoImported: boolean): boolean => {
    const src = sources.get(name);
    return src === undefined ? autoImported : lib.test(src);
  };

  // Declarations: scope node id → name → cell.
  const byScope = new Map<number, Map<string, Cell>>();
  const declare = (scope: Node, cell: Omit<Cell, "key">): Cell => {
    const full: Cell = { ...cell, key: `${scope.startPosition.row + 1}:${cell.name}` };
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
    const cut = rest.indexOf(null);
    const path = (cut < 0 ? rest : rest.slice(0, cut)).map((x) => x ?? "[]");
    if (cut >= 0 || mutated) path.push("[]");
    return { cell: cellPath(c.key, path), spelling: c.name };
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
          triggers.push({ cells: isDeep(args[2]) ? new Set([...cells].map((c) => c.replace(/\*?$/, "*"))) : cells, hook: name, ...callbackOf(args[1]!), at: n });
        } else if (vue && VUE_EFFECT.has(name) && isFrom(name, VUE_SOURCES, true) && args[0]) {
          triggers.push({ cells: readsOf(getterOf(args[0]), null), hook: name, ...callbackOf(args[0]), at: n });
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

  // A callback is held when a write elsewhere can re-run it.
  const held = new Map<number, string>();
  const written = (t: Trigger) => writes.some((w) => [...t.cells].some((c) => sameCell(w.cell, c)) && !(t.callback && within(w.node, t.callback)) && !(w.falsy && TRUTHY_ONLY.has(t.hook)));
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
  return { writes, triggers: triggers.filter((t) => t.cells.size > 0 && (t.callback ? held.has(t.callback.id) : t.callee)), held };
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
function readPath(id: Node): { path: string[]; deep: boolean; returned: boolean } {
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
function isDeep(options: Node | undefined): boolean {
  if (options?.type !== "object") return false;
  return options.namedChildren.some((p) => p?.type === "pair" && p.childForFieldName("key")?.text === "deep" && p.childForFieldName("value")?.text !== "false");
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

function within(n: Node, outer: Node): boolean {
  return n.startIndex >= outer.startIndex && n.endIndex <= outer.endIndex;
}

function argumentsOf(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment");
}

/** The function a getter argument is: `() => a.value + b.value`, `computed({ get: () => … })`. */
function getterOf(arg: Node | undefined): Node | null {
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
function callbackOf(arg: Node | undefined): { callback: Node | null; callee: string | null } {
  if (arg && (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function")) return { callback: arg, callee: null };
  if (arg?.type === "identifier") return { callback: null, callee: arg.text };
  return { callback: null, callee: null };
}

/** Local name → module, for every name the file's top level imports. */
function importSources(root: Node): Map<string, string> {
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
