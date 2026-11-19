import type { Node } from "web-tree-sitter";

/**
 * Block scope for a call site (`CallExtractionHooks.boundAt`): which declarations of the function body hide a name
 * at one site. The call walk's function-wide set cannot tell `{ const save = make(); save(); } save();` apart.
 *
 * A name is bound at a site when a `let`/`const`/`class` of an enclosing block (the function's own body included)
 * declares it, a `var` anywhere in the function does, or an enclosing `for` / `catch` binds it. A declarator whose
 * value is a function is no value binding: the plugin extracts that function as a symbol of its own, and the linker
 * answers the call from it. Parameters are not read here — the linker holds them against a bare call itself.
 */

/** Where a function's own scope ends: a block directly under one of these is the function's body. */
const FUNCTION_BOUNDARIES: ReadonlySet<string> = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "generator_function",
  "arrow_function", "method_definition", "class_body", "program",
]);
/** Stops the walk upward: a function that is a symbol of its own (an inline callback is not). */
const SYMBOL_BOUNDARIES: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "method_definition", "class_body", "program"]);
const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "generator_function", "class"]);

let cache: { tree: unknown; blocks: Map<number, Set<string>>; vars: Map<number, Set<string>> } | null = null;
const memo = (node: Node) => {
  if (cache?.tree !== node.tree) cache = { tree: node.tree, blocks: new Map(), vars: new Map() };
  return cache;
};

function patternNames(pattern: Node | null | undefined, into: Set<string>): void {
  if (!pattern) return;
  if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") {
    into.add(pattern.text);
    return;
  }
  if (pattern.type === "type_annotation") return;
  for (const child of pattern.namedChildren) {
    if (child.type === "pair_pattern") patternNames(child.childForFieldName("value"), into);
    else if (child.type === "assignment_pattern") patternNames(child.childForFieldName("left"), into);
    else patternNames(child, into);
  }
}

function declaratorNames(decl: Node, into: Set<string>): void {
  for (const d of decl.namedChildren) {
    if (d.type !== "variable_declarator") continue;
    const value = d.childForFieldName("value");
    if (value && FUNCTION_VALUES.has(value.type)) continue;
    patternNames(d.childForFieldName("name"), into);
  }
}

/** The names the statements directly in `block` declare. */
function declaredIn(block: Node): Set<string> {
  const m = memo(block);
  const hit = m.blocks.get(block.id);
  if (hit) return hit;
  const out = new Set<string>();
  const read = (stmt: Node): void => {
    if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") declaratorNames(stmt, out);
    else if (stmt.type === "class_declaration" || stmt.type === "abstract_class_declaration") {
      const name = stmt.childForFieldName("name");
      if (name) out.add(name.text);
    } else if (stmt.type === "switch_case" || stmt.type === "switch_default") for (const s of stmt.namedChildren) read(s);
  };
  for (const stmt of block.namedChildren) read(stmt);
  m.blocks.set(block.id, out);
  return out;
}

/** The `var` names a function declares anywhere in its body (hoisted), not entering nested functions. */
function varsOf(fn: Node): Set<string> {
  const m = memo(fn);
  const hit = m.vars.get(fn.id);
  if (hit) return hit;
  const out = new Set<string>();
  const walk = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (FUNCTION_BOUNDARIES.has(c.type)) continue;
      if (c.type === "variable_declaration") declaratorNames(c, out);
      walk(c);
    }
  };
  walk(fn);
  m.vars.set(fn.id, out);
  return out;
}

/** Whether the loop head or catch clause `p` binds `name` for its body. */
function headBinds(p: Node, name: string): boolean {
  const out = new Set<string>();
  if (p.type === "for_statement") {
    const init = p.childForFieldName("initializer");
    if (init?.type === "lexical_declaration") declaratorNames(init, out);
  } else if (p.type === "for_in_statement") {
    patternNames(p.childForFieldName("left"), out);
  } else if (p.type === "catch_clause") {
    patternNames(p.childForFieldName("parameter"), out);
  }
  return out.has(name);
}

/** The names a function's parameter list binds. */
export function parameterNames(fn: Node): Set<string> {
  const out = new Set<string>();
  const list = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!list) return out;
  if (list.type === "identifier") out.add(list.text);
  else for (const p of list.namedChildren) patternNames(p.childForFieldName("pattern") ?? p, out);
  return out;
}

/** True where a binding of `name` made inside the function (not its parameters) is in scope at `site`. */
export function boundInFunctionAt(site: Node, name: string): boolean {
  for (let p = site.parent; p; p = p.parent) {
    if (p.type === "program") return false;
    if (p.type === "statement_block" || p.type === "switch_body") {
      if (declaredIn(p).has(name)) return true;
    } else if (p.type === "for_statement" || p.type === "for_in_statement" || p.type === "catch_clause") {
      if (headBinds(p, name)) return true;
    } else if (FUNCTION_BOUNDARIES.has(p.type)) {
      if (varsOf(p).has(name)) return true;
      if (SYMBOL_BOUNDARIES.has(p.type) || p.parent?.type === "variable_declarator") return false;
    }
  }
  return false;
}

/**
 * True where `site` reads a parameter `name` of its function that a NESTED block's own declaration hides: the
 * binding is in a block that is not the function's body, and it states no value type a receiver could read
 * (`let v = make()`). The call's receiver is then that local, never the parameter.
 */
export function parameterShadowedAt(site: Node, name: string): boolean {
  let shadowed = false;
  for (let p = site.parent; p; p = p.parent) {
    if (p.type === "program") return false;
    if (p.type === "statement_block" && p.parent && !FUNCTION_BOUNDARIES.has(p.parent.type)) {
      if (declaredIn(p).has(name)) shadowed = true;
    } else if (p.type === "for_statement" || p.type === "for_in_statement" || p.type === "catch_clause") {
      if (headBinds(p, name)) shadowed = true;
    } else if (FUNCTION_BOUNDARIES.has(p.type)) {
      if (parameterNames(p).has(name)) return shadowed;
      if (SYMBOL_BOUNDARIES.has(p.type) || p.parent?.type === "variable_declarator") return false;
    }
  }
  return false;
}

/** The hook: a bare name by the function's own bindings at the site; a dotted one by its head, a parameter shadowed. */
export function boundAtSite(site: Node, name: string): boolean {
  const dot = name.indexOf(".");
  if (dot < 0) return boundInFunctionAt(site, name);
  const head = name.slice(0, dot).replace(/[?!]$/, "");
  return /^[A-Za-z_$][\w$]*$/.test(head) && parameterShadowedAt(site, head);
}

/**
 * Where the nearest binding of a name is at a site: a scope below the top level, the module's own, or none. With
 * `stop`, the walk ends at that node (exclusive) and answers "inner" or "none" only.
 */
function bindingScopeAt(site: Node, name: string, stop?: Node): "inner" | "module" | "none" {
  for (let p = site.parent; p; p = p.parent) {
    if (stop && p.id === stop.id) return "none";
    if (p.type === "program") return topLevelNames(p).has(name) ? "module" : "none";
    if (p.type === "statement_block" || p.type === "switch_body") {
      if (declaredIn(p).has(name)) return "inner";
    } else if (p.type === "for_statement" || p.type === "for_in_statement" || p.type === "catch_clause") {
      if (headBinds(p, name)) return "inner";
    } else if (FUNCTION_BOUNDARIES.has(p.type)) {
      if (varsOf(p).has(name) || parameterNames(p).has(name)) return "inner";
    }
  }
  return "none";
}

/**
 * True where `name` at `site` is a binding of the module itself: no enclosing block, loop, catch or function
 * (parameters included) between the site and the top level binds it, and the top level declares or imports it.
 */
export function moduleBindingAt(site: Node, name: string): boolean {
  return bindingScopeAt(site, name) === "module";
}

/**
 * True where a parameter, local, loop or catch binding of an enclosing scope hides `name` at `site`
 * (`CallExtractionHooks.receiverReboundAt`): a call through it is on that binding, never on a module's namesake.
 */
export function reboundBelowModuleAt(site: Node, name: string): boolean {
  return bindingScopeAt(site, name) === "inner";
}

/** Whether an object literal (through `as`/`satisfies`) holds `key`: a pair, a method or a shorthand member. */
function objectHasKey(value: Node | null, key: string): boolean {
  let v = value;
  while (v && (v.type === "as_expression" || v.type === "satisfies_expression" || v.type === "parenthesized_expression")) v = v.namedChildren[0] ?? null;
  if (v?.type !== "object") return false;
  return v.namedChildren.some((m) => {
    if (m.type === "shorthand_property_identifier") return m.text === key;
    if (m.type !== "pair" && m.type !== "method_definition") return false;
    const k = m.childForFieldName("key") ?? m.childForFieldName("name");
    return !!k && (k.type === "string" ? k.text.slice(1, -1) : k.text) === key;
  });
}

/**
 * True where the nearest binding of `head` below the module is a `const`/`let`/`var` whose initializer is an object
 * literal holding `key`: a call `head.key(…)` there is that object's own member, not a rebound value.
 */
export function ownMemberObjectAt(site: Node, head: string, key: string): boolean {
  for (let p = site.parent; p; p = p.parent) {
    if (p.type === "program") return false;
    if (p.type === "statement_block" || p.type === "switch_body") {
      if (!declaredIn(p).has(head)) continue;
      for (const stmt of p.namedChildren) {
        if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
        for (const d of stmt.namedChildren) {
          if (d.type === "variable_declarator" && d.childForFieldName("name")?.text === head) return objectHasKey(d.childForFieldName("value"), key);
        }
      }
      return false;
    } else if (p.type === "for_statement" || p.type === "for_in_statement" || p.type === "catch_clause") {
      if (headBinds(p, head)) return false;
    } else if (FUNCTION_BOUNDARIES.has(p.type)) {
      if (varsOf(p).has(head) || parameterNames(p).has(head)) return false;
    }
  }
  return false;
}

/** The names a program's top level declares, exports or imports. */
function topLevelNames(program: Node): Set<string> {
  const out = new Set(declaredIn(program));
  for (const stmt of program.namedChildren) {
    if (stmt.type === "export_statement") {
      const decl = stmt.childForFieldName("declaration");
      if (decl?.type === "lexical_declaration" || decl?.type === "variable_declaration") declaratorNames(decl, out);
    } else if (stmt.type === "import_statement") {
      const clause = stmt.namedChildren.find((c) => c.type === "import_clause");
      for (const id of clause?.descendantsOfType("identifier") ?? []) if (id) out.add(id.text);
    }
  }
  return out;
}

/** True where a parameter of a function enclosing `site` binds `name`: a value handed in. */
export function boundByParameterAt(site: Node, name: string): boolean {
  for (let p = site.parent; p && p.type !== "program"; p = p.parent) if (FUNCTION_BOUNDARIES.has(p.type) && parameterNames(p).has(name)) return true;
  return false;
}

/** True where an enclosing scope strictly between `site` and `scope` (a block or function body) rebinds `name`. */
export function reboundBefore(site: Node, name: string, scope: Node): boolean {
  return bindingScopeAt(site, name, scope) === "inner";
}
