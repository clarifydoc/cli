import type { Node } from "web-tree-sitter";
import { requiredSource } from "./imports-exports.js";

/**
 * `(await import("./x"))`, `await import("./x")`, `import("./x")`, `require("./x")` and `await loadClub()` where
 * `loadClub` is a module loader of the file (`moduleLoaders`) -> the module path; else null.
 */
function loadedSource(node: Node): string | null {
  let n: Node | null = node;
  let awaited = false;
  while (n && (n.type === "parenthesized_expression" || n.type === "await_expression")) {
    if (n.type === "await_expression") awaited = true;
    n = n.namedChildren[0] ?? null;
  }
  if (!n || n.type !== "call_expression") return null;
  const callee = n.childForFieldName("function");
  if (callee?.type === "import") return literalImport(n);
  // `(await loadClub()).f`: the loader's promise settled is the module (unawaited it is the promise).
  if (awaited && callee?.type === "identifier" && (n.childForFieldName("arguments")?.namedChildCount ?? 1) === 0) {
    return moduleLoaders(n.tree.rootNode).get(callee.text) ?? null;
  }
  return requiredSource(n);
}

/** `import("./x")` with a literal path -> the path; else null. */
function literalImport(importCall: Node): string | null {
  const arg = importCall.childForFieldName("arguments")?.namedChildren[0];
  return arg?.type === "string" ? arg.text.slice(1, -1) : null;
}

const LOADER_FUNCTIONS = new Set(["arrow_function", "function_expression", "function", "function_declaration"]);
const NESTED_SCOPES = new Set([...LOADER_FUNCTIONS, "generator_function", "generator_function_declaration", "method_definition", "class_body"]);

/**
 * The module a value is when it loads one: `import("./x")`, `await import("./x")`, or a cache filled by it —
 * `(cached ??= import("./x"))`, `cached ||= import("./x")`, `cached || (cached = import("./x"))`. Null otherwise.
 */
function loadedModuleOf(value: Node | null | undefined): string | null {
  let n = value ?? null;
  while (n && (n.type === "parenthesized_expression" || n.type === "await_expression")) n = n.namedChildren.find((c) => c.type !== "comment") ?? null;
  if (!n) return null;
  if (n.type === "call_expression") return n.childForFieldName("function")?.type === "import" ? literalImport(n) : null;
  if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") {
    const op = n.type === "assignment_expression" ? "=" : n.childForFieldName("operator")?.text;
    return op === "=" || op === "??=" || op === "||=" ? loadedModuleOf(n.childForFieldName("right")) : null;
  }
  if (n.type === "binary_expression") {
    const op = n.childForFieldName("operator")?.text;
    return (op === "??" || op === "||") && n.childForFieldName("left")?.type === "identifier" ? loadedModuleOf(n.childForFieldName("right")) : null;
  }
  return null;
}

/** The module every `return` of a function hands back (an expression body is its one return); null when one is anything else. */
function returnedModule(fn: Node): string | null {
  const body = fn.childForFieldName("body");
  if (!body) return null;
  if (body.type !== "statement_block") return loadedModuleOf(body);
  let found: string | null | undefined;
  const visit = (n: Node): void => {
    for (const child of n.namedChildren) {
      if (found === null) return;
      if (NESTED_SCOPES.has(child.type)) continue;
      if (child.type === "return_statement") {
        const source = loadedModuleOf(child.namedChildren.find((c) => c.type !== "comment"));
        found = source !== null && (found === undefined || found === source) ? source : null;
      } else visit(child);
    }
  };
  visit(body);
  return found ?? null;
}

const loaderMemo = new WeakMap<object, Map<string, string>>();

/**
 * The file's module loaders: a function whose result is a module loaded by a literal path —
 * `const loadClub = () => import("./club")`, `async function loadClub() { return import("./club"); }`,
 * `const loadClub = () => (cached ??= import("./club"))` — by name -> that path. Awaiting the call is the module,
 * so `(await loadClub()).f()` calls its member `f`. A name bound to two different loaders is none; a path held in
 * a variable (`(path) => import(path)`) names no module.
 */
export function moduleLoaders(root: Node): ReadonlyMap<string, string> {
  const memo = loaderMemo.get(root.tree);
  if (memo) return memo;
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  const visit = (n: Node, fn: Node | null): void => {
    if (n.type === "call_expression" && n.childForFieldName("function")?.type === "import" && fn) {
      const holder = fn.type === "function_declaration" ? fn : fn.parent?.type === "variable_declarator" ? fn.parent : null;
      const name = holder?.childForFieldName("name");
      const source = name?.type === "identifier" ? returnedModule(fn) : null;
      if (name && source !== null && !ambiguous.has(name.text)) {
        const prior = out.get(name.text);
        if (prior === undefined) out.set(name.text, source);
        else if (prior !== source) {
          out.delete(name.text);
          ambiguous.add(name.text);
        }
      }
    }
    const inner = LOADER_FUNCTIONS.has(n.type) ? n : NESTED_SCOPES.has(n.type) ? null : fn;
    for (const child of n.namedChildren) visit(child, inner);
  };
  if (root.text.includes("import(")) visit(root, null);
  loaderMemo.set(root.tree, out);
  return out;
}

/**
 * A call straight on a module loaded in place: `(await import("./rules")).promote()`,
 * `import("./rules").then(…)` aside, `require("./rules").promote()` — the member the module declares and
 * the path it comes from. Null for any other call.
 */
export function loadedMemberCall(call: Node): { source: string; name: string } | null {
  if (call.type !== "call_expression") return null;
  const callee = call.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  const source = object ? loadedSource(object) : null;
  // `import(…).then(…)` is the promise, not a member of the module.
  if (!source || property?.type !== "property_identifier" || (object!.type === "call_expression" && object!.childForFieldName("function")?.type === "import" && property.text === "then")) return null;
  return { source, name: property.text };
}

/**
 * The path of an `import("./x")` whose module is used for its default export: the body or returned value of a
 * function (a lazy loader, `() => import("./ClubPage.vue")`), or read as `(await import("./x")).default`. Null for
 * a destructured, `.then`-bound or member-called import, and for a non-literal path.
 */
export function loadedDefaultSource(importCall: Node): string | null {
  const arg = importCall.childForFieldName("arguments")?.namedChildren[0];
  if (arg?.type !== "string") return null;
  let up: Node | null = importCall.parent;
  while (up && (up.type === "parenthesized_expression" || up.type === "await_expression")) up = up.parent;
  if (!up) return null;
  const isDefaultRead = up.type === "member_expression" && up.childForFieldName("property")?.text === "default";
  const isLoaderBody = up.type === "arrow_function" || up.type === "return_statement";
  return isDefaultRead || isLoaderBody ? arg.text.slice(1, -1) : null;
}
