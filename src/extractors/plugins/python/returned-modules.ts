import type { Node } from "web-tree-sitter";

/** Nodes of other scopes (a nested def, a class body, a lambda) bind names of their own. */
const OTHER_SCOPES = new Set(["function_definition", "class_definition", "lambda"]);

/** `import a` / `import a.b as c` / `from a import b`: local name → the module path as written. */
function importedModules(scope: Node, out: Map<string, string>): void {
  for (const c of scope.namedChildren) {
    if (!c) continue;
    if (c.type === "import_statement") {
      for (const n of c.namedChildren) {
        if (n.type === "aliased_import") {
          const name = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text;
          if (name && alias) out.set(alias, name);
        } else if (n.type === "dotted_name" && !n.text.includes(".")) out.set(n.text, n.text);
      }
    } else if (c.type === "import_from_statement") {
      // `from league import club` (a module of the package, when a file of that name exists; the linker checks).
      const from = c.childForFieldName("module_name");
      if (from?.type !== "dotted_name") continue;
      for (const n of c.namedChildren) {
        if (n.id === from.id) continue;
        if (n.type === "aliased_import") {
          const name = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text;
          if (name && alias && !name.includes(".")) out.set(alias, `${from.text}.${name}`);
        } else if (n.type === "dotted_name" && !n.text.includes(".")) out.set(n.text, `${from.text}.${n.text}`);
      }
    }
  }
}

/** How often the body binds each name (assignment, loop, walrus, `with`/`except … as`, tuple targets); nested scopes excluded. */
function bindingCounts(body: Node): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (name: string): void => void out.set(name, (out.get(name) ?? 0) + 1);
  for (const a of body.descendantsOfType(["assignment", "augmented_assignment", "for_statement", "named_expression", "as_pattern"])) {
    let other = false;
    for (let p = a.parent; p && p.id !== body.id; p = p.parent) if (OTHER_SCOPES.has(p.type)) other = true;
    if (other) continue;
    const left = a.type === "named_expression" ? a.childForFieldName("name") : a.type === "as_pattern" ? a.childForFieldName("alias") : a.childForFieldName("left");
    if (!left) continue;
    if (left.type === "identifier") bump(left.text);
    else for (const id of left.descendantsOfType("identifier")) bump(id.text);
  }
  return out;
}

/**
 * `def load_backend(): import backend; return backend`: the module every `return` of the function hands back,
 * as the import states it (`backend`, `a.b` for `import a.b as x`) — a module-level import is read too, a
 * function's own first. Null when a return states anything else, or the name is bound again in the body.
 */
export function returnedModule(body: Node, paramNames: ReadonlySet<string>): string | null {
  const returns: Node[] = [];
  const visit = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (!c || OTHER_SCOPES.has(c.type)) continue;
      if (c.type === "return_statement") returns.push(c);
      visit(c);
    }
  };
  visit(body);
  if (returns.length === 0) return null;
  let name: string | null = null;
  for (const r of returns) {
    const v = r.namedChild(0);
    if (v?.type !== "identifier" || (name !== null && name !== v.text)) return null;
    name = v.text;
  }
  if (!name || paramNames.has(name) || bindingCounts(body).has(name)) return null;
  const local = new Map<string, string>();
  const collect = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (!c || OTHER_SCOPES.has(c.type)) continue;
      if (c.type === "import_statement") importedModules(n, local);
      else collect(c);
    }
  };
  importedModules(body, local);
  collect(body);
  if (local.has(name)) return local.get(name)!;
  const top = new Map<string, string>();
  importedModules(body.tree.rootNode, top);
  return top.get(name) ?? null;
}

/**
 * `m = importlib.import_module("other")` (a plain string literal; `import_module(name)` states nothing): local
 * name → module, for a name the body binds exactly once and never as a parameter.
 */
export function importedModuleLocals(body: Node, paramNames: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of body.descendantsOfType("assignment")) {
    let other = false;
    for (let p = a.parent; p && p.id !== body.id; p = p.parent) if (OTHER_SCOPES.has(p.type)) other = true;
    const left = a.childForFieldName("left");
    const right = a.childForFieldName("right");
    if (other || left?.type !== "identifier" || right?.type !== "call" || right.childForFieldName("function")?.text !== "importlib.import_module") continue;
    const args = right.childForFieldName("arguments")?.namedChildren ?? [];
    const arg = args[0];
    if (args.length !== 1 || arg?.type !== "string" || arg.namedChildren.some((c) => c.type === "interpolation")) continue;
    const text = /^(["'])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\1$/.exec(arg.text)?.[2];
    if (text) out.set(left.text, text);
  }
  const bindings = bindingCounts(body);
  for (const name of [...out.keys()]) if ((bindings.get(name) ?? 0) !== 1 || paramNames.has(name)) out.delete(name);
  return out;
}
