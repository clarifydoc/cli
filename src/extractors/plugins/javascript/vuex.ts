import type { Node, Tree } from "web-tree-sitter";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, Language, PropBinding, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";
import { factoryActions, importedName, type FactoryAction, type FactoryContext } from "./vuex-factories.js";
import { autoImportedComponents, globalComponentFiles, tagKey } from "./dispatch.js";

export { extractStoreShapes } from "./vuex-factories.js";

/**
 * Vuex: `store.dispatch('contacts/get')` runs the `get` action of the store
 * module registered as `contacts`. The two sides share only that string, so a
 * click whose handler dispatches stopped one hop short of the action — and of
 * the API call and the route and table behind it.
 *
 * Facts, per file:
 *   - `CallInfo.key` on a dispatch: its name, every name a name computed from
 *     literals can take, `/`-prefixed with `{ root: true }` (`dispatchKeyOfArgs`);
 *   - `FileAnalysis.storeModules` for `modules: { contacts, articles: helpCenterArticles }`
 *     in `createStore({…})` / `new Vuex.Store({…})` or in a module's own definition;
 *   - `FileAnalysis.storeShapes` for a module a project factory builds and for
 *     modules declaring `namespaced: true` (vuex-factories.ts).
 *
 * The join walks the namespace from the root store: `a/b/act` → the root's
 * module `a` (its import) → that file's module `b` → action `act`, defined as
 * `actions.act` in the module file or a file it imports (`import { actions } from
 * './actions'`), else named by the `actions` object the module's factory returns.
 * A key without a namespace names a root action or one of a module that is not
 * namespaced. Inside a module, an action context's `dispatch('act')` names the
 * module's own action first. A dispatch of a prop (`dispatch(props.fetchKey)`,
 * `this.$store.dispatch(this.actionName)`: `CallInfo.argOrigins`) names whatever
 * each user binds it to (`fetch-key="squad/fetchPlayers"`, `FileAnalysis.propBindings`
 * with a literal origin, through users handing their own prop on): one link per
 * name, kept to that binding (`viaUsage`). Where several root stores answer differently, the
 * one the caller's app mounts decides; it joins only when exactly one action is left.
 */

const STORE_FACTORY_RE = /\b(?:createStore|Vuex\.Store|Store)\s*\(/;

export function extractStoreModules(tree: Tree, sourceText: string): Array<{ name: string; ref: string; line: number }> {
  if (!sourceText.includes("modules")) return [];
  const out: Array<{ name: string; ref: string; line: number }> = [];
  for (const pair of tree.rootNode.descendantsOfType("pair")) {
    if (keyText(pair) !== "modules") continue;
    const value = pair.childForFieldName("value");
    if (value?.type !== "object") continue;
    if (!isStoreDefinition(pair.parent)) continue;
    for (const entry of value.namedChildren) {
      if (entry.type === "shorthand_property_identifier") {
        out.push({ name: entry.text, ref: entry.text, line: entry.startPosition.row + 1 });
      } else if (entry.type === "pair") {
        const name = keyText(entry);
        const ref = entry.childForFieldName("value");
        if (name && ref?.type === "identifier") out.push({ name, ref: ref.text, line: entry.startPosition.row + 1 });
      }
    }
  }
  return out;
}

/** The object holding `modules:` is a store (`createStore({…})`) or a module (`{ namespaced, state, actions, … }`). */
function isStoreDefinition(obj: Node | null): boolean {
  if (obj?.type !== "object") return false;
  const call = obj.parent?.type === "arguments" ? obj.parent.parent : null;
  if (call && (call.type === "call_expression" || call.type === "new_expression")) {
    const callee = (call.childForFieldName("function") ?? call.childForFieldName("constructor"))?.text ?? "";
    if (STORE_FACTORY_RE.test(`${callee}(`)) return true;
  }
  const keys = new Set(obj.namedChildren.map((c) => (c.type === "pair" ? keyText(c) : c.type === "shorthand_property_identifier" ? c.text : null)));
  return keys.has("namespaced") || (keys.has("state") && (keys.has("actions") || keys.has("mutations") || keys.has("getters")));
}

function keyText(pair: Node): string | null {
  const key = pair.childForFieldName("key");
  return key ? key.text.replace(/^['"]|['"]$/g, "") : null;
}

/** Several action names one dispatch may stand for, in one `CallInfo.key`. */
export const DISPATCH_KEY_SEPARATOR = "|";

/** A dispatch made with `{ root: true }`: the name is global even inside a module. */
export const ROOT_KEY_PREFIX = "/";

/** A bare `dispatch` (or `context.dispatch`) is the action context's: local to its module. */
const CONTEXT_DISPATCH = /^(?:dispatch|context\.dispatch)$/;

/** Most action names one computed dispatch name may stand for. */
const MAX_NAMES = 6;
const SCOPE_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition", "program"]);

/**
 * The key of `dispatch(name, payload, options)`: the action name; for a name
 * computed from literals, each one it can take, joined by `|`
 * (`` `categories/${action}` ``, `'categories/' + action` with `const action = editing ? 'update' : 'create'`,
 * `` `articles/${draft ?? 'update'}` `` — the fallback —, a parameter's literal
 * default, `ACTIONS[kind]` over a map of literals); prefixed `/` with
 * `{ root: true }`. Null when the name is not known.
 */
export function dispatchKeyOfArgs(args: readonly Node[]): string | null {
  const names = args[0] ? actionNames(args[0], 0) : null;
  if (!names || names.length === 0 || names.length > MAX_NAMES) return null;
  const options = args[2];
  const root = options?.type === "object" && options.namedChildren.some((p) => p?.type === "pair" && keyText(p) === "root" && p.childForFieldName("value")?.type === "true");
  return [...new Set(names)].map((n) => (root ? ROOT_KEY_PREFIX + n : n)).join(DISPATCH_KEY_SEPARATOR);
}

function actionNames(node: Node | null | undefined, depth: number): string[] | null {
  let n = node ?? null;
  while (n?.type === "parenthesized_expression") n = n.namedChildren[0] ?? null;
  if (!n || depth > 4) return null;
  switch (n.type) {
    case "string":
      return n.text.length > 2 ? [n.text.slice(1, -1)] : null;
    case "template_string": {
      let out = [""];
      for (const c of n.namedChildren) {
        if (!c) continue;
        if (c.type !== "template_substitution") {
          out = out.map((p) => p + c.text);
          continue;
        }
        const inner = actionNames(c.namedChildren[0], depth + 1);
        if (!inner) return null;
        out = out.flatMap((p) => inner.map((i) => p + i));
        if (out.length > MAX_NAMES) return null;
      }
      return out.every(Boolean) ? out : null;
    }
    case "ternary_expression": {
      const a = actionNames(n.childForFieldName("consequence"), depth + 1);
      const b = actionNames(n.childForFieldName("alternative"), depth + 1);
      return a && b ? [...a, ...b] : null;
    }
    case "binary_expression": {
      // `draft ?? 'update'`: the fallback is one name it takes, whatever the left side is.
      const op = n.childForFieldName("operator")?.text;
      if (op === "+") {
        // `'clubs/' + action`
        const left = actionNames(n.childForFieldName("left"), depth + 1);
        const right = left ? actionNames(n.childForFieldName("right"), depth + 1) : null;
        return left && right && left.length * right.length <= MAX_NAMES ? left.flatMap((l) => right.map((r) => l + r)) : null;
      }
      if (op !== "??" && op !== "||") return null;
      const fallback = actionNames(n.childForFieldName("right"), depth + 1);
      return fallback ? [...(actionNames(n.childForFieldName("left"), depth + 1) ?? []), ...fallback] : null;
    }
    case "identifier":
      return valuesOfName(n, depth);
    case "member_expression": {
      // `ACTIONS.FETCH_CLUBS` over a map the file declares (`const ACTIONS = { FETCH_CLUBS: 'clubs/fetchAll' }`).
      const obj = n.childForFieldName("object");
      const prop = n.childForFieldName("property")?.text;
      const map = obj?.type === "identifier" && prop ? declaredValue(obj) : null;
      if (map?.type !== "object") return null;
      const pair = map.namedChildren.find((p) => p?.type === "pair" && keyText(p) === prop);
      return pair ? actionNames(pair.childForFieldName("value"), depth + 1) : null;
    }
    case "subscript_expression": {
      // `ACTIONS[kind]` over a map whose every value is a literal name.
      const obj = n.childForFieldName("object");
      const map = obj?.type === "identifier" ? declaredValue(obj) : null;
      if (map?.type !== "object") return null;
      const out: string[] = [];
      for (const p of map.namedChildren) {
        const v = p?.type === "pair" ? actionNames(p.childForFieldName("value"), depth + 1) : null;
        if (!v) return null;
        out.push(...v);
      }
      return out.length > 0 ? out : null;
    }
    default:
      return null;
  }
}

/** The names a variable can hold: its declaration's value and every value assigned to it, or its parameter default. */
function valuesOfName(id: Node, depth: number): string[] | null {
  const decl = declaredValue(id);
  if (decl) {
    const out = actionNames(decl, depth + 1);
    if (!out) return null;
    // `let action = 'create'; if (editing) action = 'update';`
    const scope = scopeOf(id);
    for (const asg of scope?.descendantsOfType("assignment_expression") ?? []) {
      if (asg?.childForFieldName("left")?.text !== id.text) continue;
      const more = actionNames(asg.childForFieldName("right"), depth + 1);
      if (!more) return null;
      out.push(...more);
    }
    return out;
  }
  // A parameter with a literal default (`(value, action = 'update')`).
  for (let s = scopeOf(id); s; s = scopeOf(s)) {
    for (const p of s.childForFieldName("parameters")?.namedChildren ?? []) {
      const pattern = p?.childForFieldName("pattern") ?? p;
      if (pattern?.type === "assignment_pattern" && pattern.childForFieldName("left")?.text === id.text) return actionNames(pattern.childForFieldName("right"), depth + 1);
    }
  }
  return null;
}

/** The value `const name = …` gives the name, in the innermost scope declaring it once. */
function declaredValue(id: Node): Node | null {
  for (let s = scopeOf(id); s; s = scopeOf(s)) {
    const decls = s.descendantsOfType("variable_declarator").filter((d) => d?.childForFieldName("name")?.text === id.text && scopeOf(d)?.id === s.id);
    if (decls.length === 1) return decls[0]!.childForFieldName("value");
    if (decls.length > 1) return null;
    // A parameter of that name shadows any outer declaration.
    const params = s.childForFieldName("parameters")?.text ?? s.childForFieldName("parameter")?.text ?? "";
    if (s.type !== "program" && (params.match(/[\w$]+/g) ?? ([] as string[])).includes(id.text)) return null;
  }
  return null;
}

function scopeOf(n: Node): Node | null {
  let p = n.parent;
  while (p && !SCOPE_NODES.has(p.type)) p = p.parent;
  return p;
}

type Target = { file: string; symbol: string; line: number; viaType?: string; viaTypeFile?: string };
/** An action: the function it is (unless written in place in a call), and what else it reaches. */
type Hit = { file: FileAnalysis; fn?: FunctionInfo; also?: Target[] };
type Module = { file: FileAnalysis; exported: string };

export class VuexDispatchResolver implements DispatchResolver {
  readonly id = "vuex-action";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 31;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const registering = analyses.filter((a) => a.storeModules?.length);
    if (registering.length === 0) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const ctx: FactoryContext = { byPath, filePathMap };
    const imported = (a: FileAnalysis, i: { source: string }) => {
      const f = resolveTarget(i.source, a.filePath, filePathMap);
      return f ? byPath.get(f) ?? null : null;
    };

    /** `name` registered in `a` → the module file, and the name it exports the module under. */
    const moduleOf = (a: FileAnalysis, name: string): Module | null => {
      const reg = a.storeModules?.find((m) => m.name === name);
      const imp = reg ? importedName(a, reg.ref, ctx) : null;
      return imp ? { file: imp.file, exported: imp.name } : null;
    };
    // Module files: registered by someone. Root stores: register modules but nobody registers them.
    const registered = new Set<string>();
    for (const a of registering) for (const m of a.storeModules!) {
      const f = moduleOf(a, m.name);
      if (f) registered.add(f.file.filePath);
    }
    const roots = registering.filter((a) => !registered.has(a.filePath));

    /** The files a module's actions may be written in: its own, and those it imports. */
    const filesOf = (mod: FileAnalysis): FileAnalysis[] => [mod, ...mod.imports.flatMap((i) => imported(mod, i) ?? [])];

    // Each root's modules by namespace (`a/b`), and for each file of a module, the modules it belongs to.
    const trees = new Map<FileAnalysis, Map<string, Module>>();
    const ownerOf = new Map<string, Array<{ root: FileAnalysis; ns: string }>>();
    for (const root of roots) {
      const tree = new Map<string, Module>();
      const walk = (file: FileAnalysis, prefix: string, depth: number) => {
        for (const m of file.storeModules ?? []) {
          const mod = moduleOf(file, m.name);
          const ns = prefix ? `${prefix}/${m.name}` : m.name;
          if (!mod || tree.has(ns)) continue;
          tree.set(ns, mod);
          for (const f of filesOf(mod.file)) (ownerOf.get(f.filePath) ?? ownerOf.set(f.filePath, []).get(f.filePath)!).push({ root, ns });
          if (depth < 6) walk(mod.file, ns, depth + 1);
        }
      };
      walk(root, "", 0);
      trees.set(root, tree);
    }

    // Modules declaring `namespaced: true`: their actions answer only their namespace.
    const namespacedFiles = new Set<FileAnalysis>();
    for (const tree of trees.values()) for (const m of tree.values()) {
      if (m.file.storeShapes?.namespaced?.some((n) => n === m.exported || n === localName(m.file, m.exported))) namespacedFiles.add(m.file);
    }

    // Whether any store names an action by a constant: the whole-name lookup below is only worth making then.
    const hasComputedActions = analyses.some((a) => a.functions.some((f) => COMPUTED_ACTION.test(f.name)));

    /** The action a module file (or a file it imports) declares under a constant whose value `test` accepts. */
    const computedAction = (mod: FileAnalysis, test: (value: string) => boolean): Hit | null => {
      for (const f of filesOf(mod)) {
        if (f !== mod && registered.has(f.filePath)) continue;
        for (const fn of f.functions) {
          const ref = COMPUTED_ACTION.exec(fn.name)?.[1];
          const value = ref ? constantValue(f, ref, ctx) : null;
          if (value !== null && test(value)) return { file: f, fn };
        }
      }
      return null;
    };

    /** The `actions.<act>` a module file defines, there or in a file it imports. */
    const literalAction = (mod: FileAnalysis, act: string): Hit | null => {
      // A module file it imports (to register under `modules:`) holds that module's actions, not its own.
      for (const f of filesOf(mod)) {
        if (f !== mod && registered.has(f.filePath)) continue;
        const fn = f.functions.find((x) => x.name === `actions.${act}` || x.name.endsWith(`.actions.${act}`));
        if (fn) return { file: f, fn };
      }
      // `[ACTIONS.FETCH_CLUBS]() {…}`: an action named by a constant, read in the module that declares it.
      const named = computedAction(mod, (v) => v === act);
      if (named) return named;
      // `actions = { …, ...readActions }`: the object an import names (`export const readActions = {…}`,
      // or the file's `export default {…}`), or one the file declares itself.
      for (const f of filesOf(mod)) {
        if (f !== mod && registered.has(f.filePath)) continue;
        for (const name of f.storeShapes?.spreads?.actions ?? []) {
          const from = importedName(f, name, ctx);
          const file = from?.file ?? f;
          const held = from ? localName(from.file, from.name) : name;
          const fn = file.functions.find((x) => x.name === `${held}.${act}`)
            ?? (from?.name === "default" && file.exports.some((e) => e.name === "default" && !e.sourceName && !e.source) ? file.functions.find((x) => x.name === act || x.name === `default.${act}`) : undefined);
          if (fn) return { file, fn };
        }
      }
      return null;
    };

    /** A module a project factory builds: the action its `actions` object names (vuex-factories.ts). */
    const tables = new Map<string, Map<string, FactoryAction[]>>();
    const factoryAction = (mod: Module, act: string): Hit | null => {
      const values = mod.file.storeShapes?.values;
      if (!values) return null;
      const memoKey = `${mod.file.filePath}\0${mod.exported}`;
      let table = tables.get(memoKey);
      if (!table) {
        let value = values[mod.exported] ?? values[localName(mod.file, mod.exported)];
        if (value && "ref" in value && values[value.ref]) value = values[value.ref];
        table = value ? factoryActions(mod.file, value, ctx) : new Map();
        tables.set(memoKey, table);
      }
      const hits = distinct((table.get(act) ?? []).map((a) => hitOfAction(a)));
      return hits.length === 1 && hits[0] ? hits[0] : null;
    };
    const hitOfAction = (a: FactoryAction): Hit | null => {
      if ("fn" in a) return { file: a.fn.file, fn: a.fn.fn };
      if ("inline" in a) {
        // Its calls are those its enclosing function makes on its lines: the methods it calls on a class.
        const { file, line, end } = a.inline;
        const calls = file.functions
          .filter((f) => f.name === "<setup>" || (f.line <= line && f.endLine >= end))
          .flatMap((f) => f.calls.filter((c) => c.line >= line && c.line <= end));
        const also = methodsCalled(calls, (head) => (file.imports.some((i) => i.specifiers.includes(head)) || file.classes.some((c) => c.name === head) ? [{ file, name: head }] : []));
        return also.length > 0 ? { file, also } : null;
      }
      if (!("helper" in a)) return null;
      // The helper's calls on a parameter the module bound to a class: that class's method.
      const also = methodsCalled(a.helper.fn.calls, (head) => a.bound.get(head) ?? []);
      return { file: a.helper.file, fn: a.helper.fn, ...(also.length ? { also } : {}) };
    };
    const methodsCalled = (calls: readonly CallInfo[], namesFor: (head: string) => Array<{ file: FileAnalysis; name: string }>): Target[] => {
      const out: Target[] = [];
      for (const c of calls) {
        const [head, member, ...rest] = c.name.split(".");
        if (!head || !member || rest.length > 0) continue;
        for (const n of namesFor(head)) {
          const m = methodOf(n.file, n.name, member, ctx);
          if (m && !out.some((x) => x.file === m.file && x.symbol === m.symbol)) out.push(m);
        }
      }
      return out;
    };
    const actionIn = (mod: Module, act: string): Hit | null => literalAction(mod.file, act) ?? factoryAction(mod, act);

    /** The distinct actions `key` names under the given root stores. */
    const hitsFor = (key: string, among: readonly FileAnalysis[]): Hit[] => {
      const parts = key.split("/").filter(Boolean);
      const act = parts.pop();
      if (!act) return [];
      // `[FETCH_CLUBS]() {…}` with `FETCH_CLUBS = 'clubs/fetch'` in a store that is not namespaced: the whole name is the action's.
      const whole = parts.length > 0 && hasComputedActions ? distinct(among.flatMap((root) => [root, ...(trees.get(root)?.values() ?? [])].map((m) => {
        const file = "exported" in m ? m.file : m;
        return namespacedFiles.has(file) ? null : computedAction(file, (v) => v === key);
      }))) : [];
      if (whole.length > 0) return whole;
      if (parts.length === 0) {
        // Un-namespaced: a root action, or one of a module that is not namespaced.
        const files = new Set<FileAnalysis>();
        for (const root of among) {
          files.add(root);
          for (const m of trees.get(root)?.values() ?? []) files.add(m.file);
        }
        return distinct([...files].filter((f) => !namespacedFiles.has(f)).map((f) => literalAction(f, act)));
      }
      return distinct(among.map((root) => {
        const mod = trees.get(root)?.get(parts.join("/"));
        return mod ? actionIn(mod, act) : null;
      }));
    };

    // The root store the caller's app uses: the one the app's entry (its mount) reaches through
    // imports and whose closure holds the caller, else the one whose directory the caller shares.
    const mounts = analyses.filter((a) => a.appMount);
    const closures = new Map<FileAnalysis, Set<string>>();
    const closureOf = (entry: FileAnalysis): Set<string> => {
      let seen = closures.get(entry);
      if (seen) return seen;
      seen = new Set([entry.filePath]);
      const queue = [entry];
      while (queue.length > 0) {
        const a = queue.pop()!;
        for (const i of a.imports) {
          if (i.isType) continue;
          const f = imported(a, i);
          if (f && !seen.has(f.filePath)) {
            seen.add(f.filePath);
            queue.push(f);
          }
        }
      }
      closures.set(entry, seen);
      return seen;
    };
    const mountRoots = (entry: FileAnalysis): FileAnalysis[] => {
      const direct = roots.filter((r) => entry.imports.some((i) => imported(entry, i) === r));
      return direct.length > 0 ? direct : roots.filter((r) => closureOf(entry).has(r.filePath));
    };
    const preferredMemo = new Map<string, FileAnalysis[]>();
    const preferred = (caller: string): FileAnalysis[] => {
      let out = preferredMemo.get(caller);
      if (out) return out;
      const byMount = new Set(mounts.filter((m) => closureOf(m).has(caller)).flatMap(mountRoots));
      if (byMount.size > 0) out = [...byMount];
      else {
        const shared = roots.map((r) => commonDirs(caller, r.filePath));
        const best = Math.max(0, ...shared);
        out = best > 0 && shared.filter((x) => x === best).length === 1 ? [roots[shared.indexOf(best)]!] : [];
      }
      preferredMemo.set(caller, out);
      return out;
    };

    const allMemo = new Map<string, Hit[]>();
    const pick = (key: string, caller: string, local: boolean): Hit | null => {
      // Inside a module, an action context's dispatch names the module's own action first.
      if (local) {
        const own = distinct((ownerOf.get(caller) ?? []).flatMap(({ root, ns }) => hitsFor(`${ns}/${key}`, [root])));
        if (own.length === 1) return own[0]!;
      }
      let all = allMemo.get(key);
      if (!all) allMemo.set(key, (all = hitsFor(key, roots)));
      if (all.length <= 1) return all[0] ?? null;
      // Several root stores answer: the caller's app's own.
      const pref = preferred(caller);
      if (pref.length === 0 || pref.length === roots.length) return null;
      const hits = hitsFor(key, pref);
      return hits.length === 1 ? hits[0]! : null;
    };

    // `store.dispatch(props.fetchKey)`: the names the component's users bind the prop to (`fetch-key="squad/fetchPlayers"`).
    let propKeys: ((child: string, prop: string) => Map<string, Usage[]>) | null = null;

    const links: SymbolLink[] = [];
    for (const a of analyses) {
      const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls) {
          const emit = (written: string, usage?: Usage[]) => {
            const root = written.startsWith(ROOT_KEY_PREFIX);
            const key = root ? written.slice(ROOT_KEY_PREFIX.length) : written;
            const hit = pick(key, a.filePath, !root && CONTEXT_DISPATCH.test(call.name));
            if (!hit) return;
            const link = (t: Target): SymbolLink => ({
              sourceFile: a.filePath,
              sourceSymbol: fn.name,
              sourceLine: call.line,
              callName: `dispatch:${key}`,
              targetFile: t.file,
              targetSymbol: t.symbol,
              targetLine: t.line,
              confidence: "INFERRED",
              ...(t.viaType ? { viaType: t.viaType, viaTypeFile: t.viaTypeFile } : {}),
              ...(usage ? { viaUsage: usage } : {}),
            });
            if (hit.fn) links.push(link({ file: hit.file.filePath, symbol: hit.fn.name, line: hit.fn.line }));
            for (const t of hit.also ?? []) links.push(link(t));
          };
          if (!call.key) {
            // The action a prop names: one link per name a user binds, kept to that user (`viaUsage`).
            const prop = !call.passed && !call.read && /(?:^|\.)dispatch$/.test(call.name) ? propNamedAction(call) : null;
            if (!prop) {
              // `store.dispatch(ACTIONS.FETCH_CLUBS)`: the constant another file declares.
              const ref = !call.passed && !call.read && /(?:^|\.)dispatch$/.test(call.name) ? call.args?.[0] : undefined;
              const named = ref ? constantValue(a, ref, ctx) : null;
              if (named) emit(named);
              continue;
            }
            propKeys ??= propLiterals(analyses, filePathMap, byPath, ctx);
            for (const [key, usage] of propKeys(a.filePath, prop)) emit(key, usage);
            continue;
          }
          // `this.send()` carries a key when `mapActions` bound it (call-hooks.ts).
          // `this['clubs/update']()` likewise (`this.clubs/update`).
          if (!/(?:^|\.)dispatch$|^this\.[\w$/]+$/.test(call.name)) continue;
          for (const written of call.key.split(DISPATCH_KEY_SEPARATOR)) emit(written);
        }
      }
    }
    return links;
  }
}

/** Where a user binds a prop of the component: its file and the tag's line (`SymbolLink.viaUsage`). */
export type Usage = { file: string; line: number };

/** The prop a dispatch names its action by: `dispatch(props.fetchKey)`, `this.$store.dispatch(this.actionName, …)`. */
function propNamedAction(call: CallInfo): string | null {
  const first = call.argOrigins?.find((o) => o.index === 0);
  return first?.origin.kind === "prop" && !first.field && !first.transform && !first.derivation ? first.origin.name : null;
}

/**
 * The names each component's users bind a prop to, as literals (`FileAnalysis.propBindings`, origin `literal`):
 * child file + prop → name → the binding sites. A user handing on a prop of its own (`:fetch-key="fetchKey"`)
 * hands on what its own users bind, four levels up, kept to the binding on the child's tag.
 */
export function propLiterals(analyses: FileAnalysis[], filePathMap: Map<string, string>, byPath: Map<string, FileAnalysis>, ctx: FactoryContext): (child: string, prop: string) => Map<string, Usage[]> {
  const globals = globalComponentFiles(analyses, filePathMap);
  const autoImported = autoImportedComponents(analyses);
  const bound = new Map<string, Array<{ parent: string; binding: PropBinding }>>();
  for (const parent of analyses) {
    if (!parent.propBindings?.length) continue;
    const subByKey = new Map<string, string>([...(autoImported.get(parent.projectId ?? "") ?? []), ...globals]);
    for (const sub of parent.subComponents ?? []) if (sub.importSource && !sub.global) subByKey.set(tagKey(sub.name), sub.importSource);
    for (const b of parent.propBindings) {
      if (b.origin.kind !== "literal" && b.origin.kind !== "prop" && b.origin.kind !== "constant") continue;
      const src = subByKey.get(tagKey(b.component));
      const child = src ? resolveTarget(src, parent.filePath, filePathMap) : null;
      if (!child || !byPath.has(child)) continue;
      const k = `${child}\0${b.prop}`;
      (bound.get(k) ?? bound.set(k, []).get(k)!).push({ parent: parent.filePath, binding: b });
    }
  }
  const walk = (child: string, prop: string, depth: number, seen: Set<string>, out: Map<string, Usage[]>, via?: Usage): void => {
    const k = `${child}\0${prop}`;
    if (depth > 4 || seen.has(k)) return;
    seen.add(k);
    for (const { parent, binding } of bound.get(k) ?? []) {
      const usage = via ?? { file: parent, line: binding.line };
      if (binding.origin.kind === "prop") walk(parent, binding.origin.name, depth + 1, seen, out, usage);
      else if (binding.origin.kind === "literal" || binding.origin.kind === "constant") {
        // A constant (`:kind="Kind.Club"`) is the value the module declaring it gives.
        const value = binding.origin.kind === "literal" ? binding.origin.value : constantValue(byPath.get(parent)!, binding.origin.ref, ctx);
        if (value === null) continue;
        const list = out.get(value) ?? out.set(value, []).get(value)!;
        if (!list.some((u) => u.file === usage.file && u.line === usage.line)) list.push(usage);
      }
    }
  };
  return (child, prop) => {
    const out = new Map<string, Usage[]>();
    walk(child, prop, 0, new Set(), out);
    return out;
  };
}

function distinct(hits: Array<Hit | null>): Hit[] {
  const seen = new Map<string, Hit>();
  for (const h of hits) if (h) seen.set(h.fn ? `${h.file.filePath}#${h.fn.name}#${h.fn.line}` : `${h.file.filePath}#${(h.also ?? []).map((t) => `${t.file}#${t.symbol}`).join(",")}`, h);
  return [...seen.values()];
}

/** How many leading directories two paths share. */
function commonDirs(a: string, b: string): number {
  const x = a.split("/").slice(0, -1);
  const y = b.split("/").slice(0, -1);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** An action declared under a constant: `actions.[ACTIONS.FETCH_CLUBS]` (`functions-classes.ts` `actionKeyName`). */
const COMPUTED_ACTION = /(?:^|\.)actions\.\[([^\]]+)\]$/;

/**
 * The string a module-level name stands for, read where it is declared (`FileAnalysis.stringConstants`): in `file`
 * itself, else in the module its head is imported from — a named import, an alias, a namespace import
 * (`types.ACTIONS.FETCH_CLUBS`) — followed through re-exports. Null when the name is not a plain constant of a
 * project module; two same-named constants of other modules are never mixed up, the import chooses.
 */
export function constantValue(file: FileAnalysis, ref: string, ctx: FactoryContext, depth = 0): string | null {
  const own = file.stringConstants?.[ref];
  if (own !== undefined) return own;
  if (depth > 3) return null;
  const dot = ref.indexOf(".");
  const head = dot < 0 ? ref : ref.slice(0, dot);
  const rest = dot < 0 ? "" : ref.slice(dot + 1);
  const imp = file.imports.find((i) => !i.isType && !i.executes && i.specifiers.includes(head));
  if (!imp) return null;
  const path = resolveTarget(imp.source, file.filePath, ctx.filePathMap);
  const target = path ? ctx.byPath.get(path) : undefined;
  if (!target) return null;
  let key: string;
  if (imp.isNamespace) {
    if (!rest) return null;
    key = rest;
  } else {
    const exported = imp.aliases?.[head] ?? (imp.isDefault ? "default" : head);
    key = rest ? `${exported}.${rest}` : exported;
  }
  return declaredConstant(target, key, ctx, depth + 1);
}

/** `key` in `file`'s own constants, else behind one of its re-exports. */
function declaredConstant(file: FileAnalysis, key: string, ctx: FactoryContext, depth: number): string | null {
  const own = file.stringConstants?.[key];
  if (own !== undefined) return own;
  if (depth > 3) return null;
  const head = key.includes(".") ? key.slice(0, key.indexOf(".")) : key;
  const rest = key.includes(".") ? key.slice(key.indexOf(".")) : "";
  for (const e of file.exports) {
    if (!e.source || (e.name !== head && e.name !== "*")) continue;
    const path = resolveTarget(e.source, file.filePath, ctx.filePathMap);
    const target = path ? ctx.byPath.get(path) : undefined;
    if (!target) continue;
    const found = declaredConstant(target, e.name === "*" ? key : `${e.sourceName ?? head}${rest}`, ctx, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** A local name for an exported one: `export default createStore` → createStore. */
function localName(file: FileAnalysis, exported: string): string {
  return file.exports.find((x) => x.name === exported && !x.source)?.sourceName ?? exported;
}

/**
 * The method `method` of the class a name of `file` stands for — an imported
 * instance (`export default new Clubs()`) or class, or the file's own class —
 * declared there or on a base class, followed through `extends` four deep. On a
 * base class, the link names the receiver's class (`viaType`), so a request the
 * HTTP pass resolved per subclass moves onto it.
 */
function methodOf(file: FileAnalysis, name: string, method: string, ctx: FactoryContext): Target | null {
  const classNamed = (f: FileAnalysis, n: string): { file: FileAnalysis; cls: ClassInfo } | null => {
    const own = f.classes.find((c) => c.name === n);
    if (own) return { file: f, cls: own };
    const imp = importedName(f, n, ctx);
    if (!imp) return null;
    const exp = imp.file.exports.find((x) => x.name === imp.name && !x.source);
    const local = exp?.instanceOf ?? localName(imp.file, imp.name);
    const cls = imp.file.classes.find((c) => c.name === local);
    return cls ? { file: imp.file, cls } : null;
  };
  const start = classNamed(file, name);
  let at = start;
  for (let depth = 0; at && depth < 5; depth++) {
    const m = at.cls.methods.find((x) => x.name === method && !x.isConstructor);
    if (m) {
      const inherited = at !== start;
      return {
        file: at.file.filePath,
        symbol: `${at.cls.name}.${method}`,
        line: m.line,
        ...(inherited ? { viaType: start!.cls.name, viaTypeFile: start!.file.filePath } : {}),
      };
    }
    at = at.cls.extends ? classNamed(at.file, at.cls.extends) : null;
  }
  return null;
}
