import type { Node, Tree } from "web-tree-sitter";
import { subscriptionOf } from "./component-subscriptions.js";
import { reactiveCallbackName } from "./reactive-cells.js";

/**
 * Function values written in place and handed on to run later — each a function of its own
 * (`CallExtractionHooks.heldFunction`), so whatever joins a later run to it lands on the function
 * itself, never on the whole function that wrote it:
 *
 *   - a callback subscribed to a dialog's output or outcome:
 *     `ref.componentInstance.saved.subscribe(() => this.reload())` → `<ClubEditDialog@saved@12>`;
 *   - an `on[A-Z]…` option of a component the script opens:
 *     `modal.open(ConfirmBox, { onConfirm: () => removeClub() })` → `<ConfirmBox:onConfirm@14>`;
 *   - a member assigned a function inside a function: `toast.action = () => reload()` → `<toast.action@17>`;
 *   - a member of an object in a declared array: `const items = [{ run: () => sell() }]` → `<items[].run@3>`;
 *   - a watcher or effect callback a write in the file re-runs (`reactive-cells.ts`):
 *     `watch(query, () => search())` with `query.value = q` in a handler → `<watch@21>`.
 *
 * The function that wrote it hands it on (`passed: "argument"`), so whatever reached the writer's
 * calls still reaches them, one `passes` hop further.
 */

const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression"]);
/** Wrappers a declared array may sit in: `ref([…])`, `computed(() => […])`. */
const ARRAY_WRAPPERS = /^(?:ref|shallowRef|reactive|shallowReactive|readonly|computed|signal|useState|useMemo|useRef)$/;
/** Object keys a component's options hand its props under (`open(Box, { props: { onConfirm } })`). */
const PROPS_KEYS: ReadonlySet<string> = new Set(["props", "componentProps", "propsData", "attrs"]);
/** Keys of a declared array's objects that hold no callback the template runs, but a lazily loaded module or a nested route. */
const NOT_CALLBACK_KEYS: ReadonlySet<string> = new Set(["component", "components", "loader", "lazy", "loadChildren", "loadComponent", "children", "redirect", "redirectTo", "resolve", "canActivate", "canDeactivate", "beforeEnter"]);

let memoTree: Tree | null = null;
let memo = new Map<number, string>();
let memoNodes: Array<{ name: string; node: Node }> = [];

/** The held functions of a tree: function node id → its name. Read once per tree. */
export function heldFunctionsOf(tree: Tree): ReadonlyMap<number, string> {
  if (tree === memoTree) return memo;
  memoTree = tree;
  memo = new Map();
  memoNodes = [];
  let imported: Set<string> | null = null;
  const taken = new Set<string>();
  // One native query for the function expressions, in source order; each is judged by its parents alone.
  for (const n of tree.rootNode.descendantsOfType([...FUNCTION_VALUES])) {
    if (!n) continue;
    let name = heldName(n, () => (imported ??= importedNames(tree.rootNode)));
    if (!name) continue;
    // Two in one line under one key (`[{ run: () => a() }, { run: () => b() }]`): each keeps its own name.
    for (let i = 2; taken.has(name); i++) name = name.replace(/(?:#\d+)?>$/, `#${i}>`);
    taken.add(name);
    memo.set(n.id, name);
    memoNodes.push({ name, node: n });
  }
  return memo;
}

/** The held function's name for a function node, or null when it is no held function. */
export function heldFunction(node: Node): string | null {
  if (!FUNCTION_VALUES.has(node.type)) return null;
  return heldFunctionsOf(node.tree).get(node.id) ?? null;
}

/** Every held function of a tree, with its node, in source order. */
export function heldFunctionNodes(tree: Tree): ReadonlyArray<{ name: string; node: Node }> {
  heldFunctionsOf(tree);
  return memoNodes;
}

function heldName(fn: Node, imported: () => ReadonlySet<string>): string | null {
  const line = fn.startPosition.row + 1;
  const parent = fn.parent;
  if (!parent) return null;
  const reactive = parent.type === "arguments" ? reactiveCallbackName(fn) : null;
  if (reactive) return reactive;
  // `x.subscribe(() => …)`, `x.subscribe({ next: () => … })`, `ref.result.then((r) => …)`.
  const call = parent.type === "arguments" ? parent.parent : parent.type === "pair" && parent.childForFieldName("key")?.text === "next" ? parent.parent?.parent?.parent : null;
  if (call?.type === "call_expression" && firstArgument(call)?.id === (parent.type === "arguments" ? fn.id : parent.parent!.id)) {
    const sub = subscriptionOf(call);
    if (sub) return `<${sub.component.replace(/^this\./, "")}@${sub.event}@${line}>`;
  }
  if (parent.type === "pair") return pairName(parent, line, imported);
  // `toast.action = () => …` inside a function: what runs when the holder's member is called.
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === fn.id) {
    const left = parent.childForFieldName("left");
    const path = left?.type === "member_expression" ? left.text.replace(/\s+/g, "") : "";
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(path) || /^(?:this|module|exports|window|globalThis)\./.test(path) || path.includes(".prototype.")) return null;
    return insideFunction(parent) ? `<${path}@${line}>` : null;
  }
  return null;
}

/** An option callback of a component the script opens, or a callback of an object in a declared array. */
function pairName(pair: Node, line: number, imported: () => ReadonlySet<string>): string | null {
  const key = keyText(pair.childForFieldName("key"));
  const object = pair.parent;
  if (!key || object?.type !== "object") return null;
  if (/^on[A-Z]\w*$/.test(key)) {
    let options: Node = object;
    const outer = object.parent;
    if (outer?.type === "pair" && PROPS_KEYS.has(keyText(outer.childForFieldName("key")) ?? "") && outer.parent?.type === "object") options = outer.parent;
    const args = options.parent;
    const first = args?.type === "arguments" ? args.namedChildren.filter((a) => a?.type !== "comment") : [];
    if (first.length >= 2 && first[1]!.id === options.id && first[0]!.type === "identifier" && /^[A-Z]/.test(first[0]!.text) && imported().has(first[0]!.text)) {
      return `<${first[0]!.text}:${key}@${line}>`;
    }
  }
  if (object.parent?.type !== "array" || NOT_CALLBACK_KEYS.has(key)) return null;
  const holder = arrayHolder(object.parent);
  return holder ? `<${holder}[].${key}@${line}>` : null;
}

/** The name a declared array is held under: `const items = […]`, `items = […]` (a field), `items: […]`, `computed(() => […])`, `items() { return […]; }`. */
function arrayHolder(array: Node): string | null {
  let at: Node = array;
  for (let hop = 0; hop < 6; hop++) {
    const p = at.parent;
    if (!p) return null;
    if (p.type === "variable_declarator" && p.childForFieldName("value")?.id === at.id) return identifierText(p.childForFieldName("name"));
    if ((p.type === "public_field_definition" || p.type === "field_definition") && p.childForFieldName("value")?.id === at.id) {
      return identifierText(p.childForFieldName("name") ?? p.childForFieldName("property"));
    }
    if (p.type === "pair" && p.childForFieldName("value")?.id === at.id) return keyText(p.childForFieldName("key"));
    if (p.type === "parenthesized_expression" || p.type === "as_expression" || p.type === "satisfies_expression") {
      at = p;
      continue;
    }
    if (p.type === "arguments") {
      const call = p.parent;
      const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
      if (callee?.type !== "identifier" || !ARRAY_WRAPPERS.test(callee.text)) return null;
      at = call!;
      continue;
    }
    // `computed(() => [...])`: the arrow's body is the array.
    if (p.type === "arrow_function" && p.childForFieldName("body")?.id === at.id) {
      at = p;
      continue;
    }
    // `items() { return [...]; }`, `get items() { return [...]; }`.
    if (p.type === "return_statement") {
      const block = p.parent;
      const method = block?.type === "statement_block" ? block.parent : null;
      if (method?.type === "method_definition") return keyText(method.childForFieldName("name"));
      if (method?.type === "arrow_function" || method?.type === "function_expression") {
        at = method;
        continue;
      }
      return null;
    }
    return null;
  }
  return null;
}

function firstArgument(call: Node): Node | null {
  return call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment") ?? null;
}

function keyText(key: Node | null | undefined): string | null {
  if (!key) return null;
  if (key.type === "property_identifier") return key.text;
  if (key.type === "string") {
    const t = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  }
  return null;
}

function identifierText(n: Node | null | undefined): string | null {
  return n && (n.type === "identifier" || n.type === "property_identifier") ? n.text : null;
}

/** Whether a node sits in a function's body, not at a script's own level or in an IIFE wrapping it. */
function insideFunction(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === "method_definition" || p.type === "function_declaration" || p.type === "generator_function_declaration") return true;
    if (p.type === "arrow_function" || p.type === "function_expression") {
      let callee: Node = p;
      while (callee.parent?.type === "parenthesized_expression") callee = callee.parent;
      return !(callee.parent?.type === "call_expression" && callee.parent.childForFieldName("function")?.id === callee.id);
    }
  }
  return false;
}

/** The names the file's top level imports. */
function importedNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const stmt of root.namedChildren) {
    if (stmt?.type !== "import_statement") continue;
    const clause = stmt.namedChildren.find((c) => c?.type === "import_clause");
    if (!clause) continue;
    for (const id of clause.descendantsOfType("identifier")) if (id) out.add(id.text);
  }
  return out;
}
