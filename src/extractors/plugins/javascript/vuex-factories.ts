import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, FunctionInfo, ShapeEntry, ShapeExpr, ShapeFunction, StoreShapes } from "../../../types/analysis.js";
import { resolveTarget } from "../../shared/link-scoring.js";

/**
 * A Vuex module a project factory builds: `export default createStore({ name:
 * 'Club', API: ClubAPI })`, where the factory returns `{ actions: {
 * ...crudActions(API, types), ...extra } }` and `crudActions` returns `{ update:
 * updateRecord(types, API) }`. No `actions.update` is written anywhere; the
 * action is the function `updateRecord` returns, run with `API` bound to the
 * class the module passed.
 *
 * Per file (`extractStoreShapes` → `FileAnalysis.storeShapes`): module-level
 * values built by a call, and functions returning an object or a call, kept as
 * written. The project pass (`factoryActions`) evaluates a module's value
 * through those functions, binding each parameter to what the call passes, and
 * reads the `actions` object it ends up with: each key → the project function
 * that runs it and what that function's parameters are bound to.
 */

/** Deepest expression kept; deeper is unknown. */
const MAX_DEPTH = 6;
/** Most members of one object literal kept. */
const MAX_ENTRIES = 40;
/** A file's shapes larger than this (as JSON) are dropped: a store factory is small. */
const MAX_SHAPES_SIZE = 24_000;
/** Most function calls one evaluation follows. */
const MAX_CALL_DEPTH = 8;

const FUNCTION_TYPES = new Set(["arrow_function", "function_expression", "function", "function_declaration", "generator_function", "generator_function_declaration", "method_definition"]);
const WRAPPERS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "await_expression", "non_null_expression"]);

export function extractStoreShapes(tree: Tree, sourceText: string, filePath: string): StoreShapes | undefined {
  // A component file is never a store module.
  if (/\.(?:vue|svelte|jsx|tsx)$/.test(filePath) || !/\bexport\b|module\.exports/.test(sourceText)) return undefined;
  const values: Record<string, ShapeExpr> = {};
  const functions: Record<string, ShapeFunction> = {};
  const factoryFile = /actions/i.test(sourceText);
  const declarator = (d: Node) => {
    const name = d.childForFieldName("name");
    const value = unwrap(d.childForFieldName("value"));
    if (name?.type !== "identifier" || !value) return;
    if (FUNCTION_TYPES.has(value.type)) {
      if (factoryFile) addFunction(functions, name.text, value);
    } else if (value.type === "call_expression" && hasObjectArg(value)) {
      const s = shape(value, 0);
      if (s) values[name.text] = s;
    }
  };
  const statement = (st: Node) => {
    if (st.type === "lexical_declaration" || st.type === "variable_declaration") {
      for (const d of st.namedChildren) if (d?.type === "variable_declarator") declarator(d);
    } else if (st.type === "function_declaration" && factoryFile) {
      const name = st.childForFieldName("name");
      if (name) addFunction(functions, name.text, st);
    } else if (st.type === "export_statement") {
      const decl = st.childForFieldName("declaration");
      if (decl) return statement(decl);
      const value = unwrap(st.childForFieldName("value"));
      if (value?.type === "identifier" || (value?.type === "call_expression" && hasObjectArg(value))) {
        const s = shape(value, 0);
        if (s) values.default = s;
      }
    }
  };
  for (const st of tree.rootNode.namedChildren) if (st) statement(st);
  const out: StoreShapes = {};
  if (Object.keys(values).length > 0) out.values = values;
  if (Object.keys(functions).length > 0) out.functions = functions;
  if (!out.values && !out.functions) return undefined;
  return JSON.stringify(out).length > MAX_SHAPES_SIZE ? undefined : out;
}

function unwrap(n: Node | null | undefined): Node | null {
  while (n && WRAPPERS.has(n.type)) n = n.namedChildren.find((c) => c?.type !== "comment") ?? null;
  return n ?? null;
}

function hasObjectArg(call: Node): boolean {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).some((a) => a?.type === "object");
}

/** A function returning an object or a call, with at least one parameter: a factory candidate. */
function addFunction(out: Record<string, ShapeFunction>, name: string, fn: Node): void {
  const locals: Record<string, ShapeExpr | null> = {};
  const params: Array<string | null> = [];
  const single = fn.childForFieldName("parameter");
  if (single?.type === "identifier") params.push(single.text);
  const list = fn.childForFieldName("parameters")?.namedChildren.filter((p): p is Node => !!p && p.type !== "comment") ?? [];
  list.forEach((p, i) => {
    const pattern = p.childForFieldName("pattern") ?? p;
    const target = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
    if (target?.type === "identifier") params.push(target.text);
    else if (target?.type === "object_pattern") {
      params.push(`$${i}`);
      bindPattern(target, { ref: `$${i}` }, locals);
    } else params.push(null);
  });
  if (params.length === 0) return;
  const returns: Array<ShapeExpr | null> = [];
  const body = fn.childForFieldName("body");
  if (body && body.type !== "statement_block") returns.push(shape(body, 0));
  else if (body) {
    const walk = (n: Node) => {
      for (const c of n.namedChildren) {
        if (!c || FUNCTION_TYPES.has(c.type) || c.type === "class_declaration" || c.type === "class") continue;
        if (c.type === "return_statement") returns.push(shape(c.namedChildren.find((x) => x?.type !== "comment") ?? null, 0));
        else if (c.type === "variable_declarator") {
          const n2 = c.childForFieldName("name");
          const v = shape(c.childForFieldName("value"), 0);
          if (n2?.type === "identifier") locals[n2.text] = v;
          else if (n2?.type === "object_pattern" && v) bindPattern(n2, v, locals);
          continue;
        }
        walk(c);
      }
    };
    walk(body);
  }
  if (!returns.some((r) => r && ("object" in r || "call" in r))) return;
  out[name] = { params, ...(Object.keys(locals).length ? { locals } : {}), returns };
}

/** `{ API, actions: custom, type = 'vuex' } = options` → API = options.API, custom = options.actions, type = options.type. */
function bindPattern(pattern: Node, of: ShapeExpr, locals: Record<string, ShapeExpr | null>): void {
  for (const p of pattern.namedChildren) {
    if (!p) continue;
    if (p.type === "shorthand_property_identifier_pattern") locals[p.text] = { member: of, key: p.text };
    else if (p.type === "object_assignment_pattern") {
      const left = p.childForFieldName("left");
      if (left?.type === "shorthand_property_identifier_pattern") locals[left.text] = { member: of, key: left.text };
    } else if (p.type === "pair_pattern") {
      const key = keyName(p.childForFieldName("key"));
      let value = p.childForFieldName("value");
      if (value?.type === "assignment_pattern") value = value.childForFieldName("left");
      if (key && value?.type === "identifier") locals[value.text] = { member: of, key };
    }
  }
}

function keyName(key: Node | null | undefined): string | null {
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  if (key.type === "string") return key.text.slice(1, -1);
  return null;
}

function shape(node: Node | null | undefined, depth: number): ShapeExpr | null {
  const n = unwrap(node);
  if (!n || depth > MAX_DEPTH) return null;
  switch (n.type) {
    case "identifier":
      return { ref: n.text };
    case "member_expression": {
      const key = n.childForFieldName("property");
      return key?.type === "property_identifier" ? { member: shape(n.childForFieldName("object"), depth + 1), key: key.text } : null;
    }
    case "call_expression": {
      const callee = unwrap(n.childForFieldName("function"));
      if (!callee || (callee.type !== "identifier" && callee.type !== "member_expression")) return null;
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment");
      return { call: shape(callee, depth + 1), args: args.map((a) => (a.type === "spread_element" ? null : shape(a, depth + 1))) };
    }
    case "object": {
      const entries: ShapeEntry[] = [];
      for (const e of n.namedChildren) {
        if (!e || entries.length >= MAX_ENTRIES) continue;
        if (e.type === "pair") {
          const key = keyName(e.childForFieldName("key"));
          if (key) entries.push({ key, value: shape(e.childForFieldName("value"), depth + 1) });
        } else if (e.type === "shorthand_property_identifier") entries.push({ key: e.text, value: { ref: e.text } });
        else if (e.type === "method_definition") {
          const key = keyName(e.childForFieldName("name"));
          if (key) entries.push({ key, value: { fn: e.startPosition.row + 1, end: e.endPosition.row + 1 } });
        } else if (e.type === "spread_element") entries.push({ spread: shape(e.namedChildren[0], depth + 1) });
      }
      return { object: entries };
    }
    case "arrow_function":
    case "function_expression":
    case "function": {
      const body = n.childForFieldName("body");
      // An expression body is what the function returns (`types => ({ … })`).
      const returns = body && body.type !== "statement_block" ? [shape(body, depth + 1)] : undefined;
      return { fn: n.startPosition.row + 1, end: n.endPosition.row + 1, ...(returns ? { returns } : {}) };
    }
    case "ternary_expression":
      return { either: [shape(n.childForFieldName("consequence"), depth + 1), shape(n.childForFieldName("alternative"), depth + 1)] };
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.text;
      if (op === "??" || op === "||") return { either: [shape(n.childForFieldName("left"), depth + 1), shape(n.childForFieldName("right"), depth + 1)] };
      if (op === "&&") return { either: [shape(n.childForFieldName("right"), depth + 1)] };
      return null;
    }
    default:
      return null;
  }
}

// ── Evaluation ────────────────────────────────────────────────────────────

/** A value a store factory works with. */
type Val =
  | { k: "name"; file: FileAnalysis; name: string }
  | { k: "object"; entries: ShapeEntry[]; scope: Scope }
  | { k: "fn"; line: number; end?: number; returns?: Array<ShapeExpr | null>; scope: Scope }
  | { k: "helper"; file: FileAnalysis; fn: FunctionInfo; args: Val[][] };

interface Scope {
  file: FileAnalysis;
  env: Map<string, Val[]>;
  locals: Record<string, ShapeExpr | null>;
  depth: number;
}

/** What one action of a factory-built module runs. */
export type FactoryAction =
  /** A project function's returned function: `updateRecord(types, API)`, its parameters bound. */
  | { helper: { file: FileAnalysis; fn: FunctionInfo }; bound: Map<string, Array<{ file: FileAnalysis; name: string }>> }
  /** A function written in place (`{ update: async () => … }`), or one named (`{ update: saveClub }`). */
  | { fn: { file: FileAnalysis; fn: FunctionInfo } }
  /** A function written in place that is no function of its own (a callback's calls are its caller's): its lines. */
  | { inline: { file: FileAnalysis; line: number; end: number } }
  /** Something else: the action exists, but what it runs is not known. */
  | { unknown: true };

export interface FactoryContext {
  byPath: ReadonlyMap<string, FileAnalysis>;
  filePathMap: Map<string, string>;
}

/**
 * The actions of the module `value` builds in `file`: action name → what it
 * runs (several when branches of the factory disagree). Empty when the value is
 * not a factory call whose result has `actions`.
 */
export function factoryActions(file: FileAnalysis, value: ShapeExpr, ctx: FactoryContext): Map<string, FactoryAction[]> {
  const table = new Map<string, FactoryAction[]>();
  const root: Scope = { file, env: new Map(), locals: {}, depth: 0 };
  for (const built of evaluate(value, root, ctx, new Set())) {
    if (built.k !== "object") continue;
    // A branch building a module: its `actions` object, members in order, later ones overriding.
    const own = new Map<string, FactoryAction>();
    for (const entry of built.entries) {
      if (!("key" in entry) || entry.key !== "actions") continue;
      for (const actions of evaluate(entry.value, built.scope, ctx, new Set())) if (actions.k === "object") collect(actions, own, ctx, 0);
    }
    for (const [key, action] of own) (table.get(key) ?? table.set(key, []).get(key)!).push(action);
  }
  return table;
}

function collect(obj: Extract<Val, { k: "object" }>, into: Map<string, FactoryAction>, ctx: FactoryContext, depth: number): void {
  if (depth > 4) return;
  for (const entry of obj.entries) {
    if ("spread" in entry) {
      for (const v of evaluate(entry.spread, obj.scope, ctx, new Set())) if (v.k === "object") collect(v, into, ctx, depth + 1);
      continue;
    }
    const vals = evaluate(entry.value, obj.scope, ctx, new Set());
    into.set(entry.key, vals.length === 1 ? actionOf(vals[0]!, ctx) : { unknown: true });
  }
}

function actionOf(v: Val, ctx: FactoryContext): FactoryAction {
  if (v.k === "helper") {
    const bound = new Map<string, Array<{ file: FileAnalysis; name: string }>>();
    v.fn.params.forEach((p, i) => {
      const names = (v.args[i] ?? []).flatMap((a) => (a.k === "name" ? [{ file: a.file, name: a.name }] : []));
      if (names.length > 0) bound.set(p.name, names);
    });
    return { helper: { file: v.file, fn: v.fn }, bound };
  }
  if (v.k === "fn") {
    const fn = v.scope.file.functions.find((f) => f.line === v.line && f.name !== "<setup>");
    if (fn) return { fn: { file: v.scope.file, fn } };
    return v.end ? { inline: { file: v.scope.file, line: v.line, end: v.end } } : { unknown: true };
  }
  if (v.k === "name") {
    const hit = functionNamed(v.file, v.name, ctx);
    return hit ? { fn: hit } : { unknown: true };
  }
  return { unknown: true };
}

function union(parts: Val[][]): Val[] {
  return parts.flat();
}

function evaluate(e: ShapeExpr | null | undefined, scope: Scope, ctx: FactoryContext, resolving: Set<string>): Val[] {
  if (!e || scope.depth > MAX_CALL_DEPTH) return [];
  if ("ref" in e) {
    const bound = scope.env.get(e.ref);
    if (bound) return bound;
    if (e.ref in scope.locals) {
      const key = `${scope.depth}\0${e.ref}`;
      if (resolving.has(key)) return [];
      resolving.add(key);
      const out = evaluate(scope.locals[e.ref], scope, ctx, resolving);
      resolving.delete(key);
      return out;
    }
    return [{ k: "name", file: scope.file, name: e.ref }];
  }
  if ("member" in e) {
    const out: Val[] = [];
    for (const v of evaluate(e.member, scope, ctx, resolving)) {
      if (v.k !== "object") continue;
      // The last member of that name wins, as in the object it builds.
      const entry = [...v.entries].reverse().find((x) => "key" in x && x.key === e.key);
      if (entry && "key" in entry) out.push(...evaluate(entry.value, v.scope, ctx, new Set()));
    }
    return out;
  }
  if ("call" in e) {
    const args = e.args.map((a) => evaluate(a, scope, ctx, resolving));
    const out: Val[] = [];
    for (const callee of evaluate(e.call, scope, ctx, resolving)) {
      if (callee.k === "name") {
        const factory = shapeFunctionNamed(callee.file, callee.name, ctx);
        if (factory) {
          const env = new Map<string, Val[]>();
          factory.shape.params.forEach((p, i) => p && env.set(p, args[i] ?? []));
          const inner: Scope = { file: factory.file, env, locals: factory.shape.locals ?? {}, depth: scope.depth + 1 };
          out.push(...union(factory.shape.returns.map((r) => evaluate(r, inner, ctx, new Set()))));
          continue;
        }
        const fn = functionNamed(callee.file, callee.name, ctx);
        if (fn) out.push({ k: "helper", file: fn.file, fn: fn.fn, args });
      } else if (callee.k === "fn" && callee.returns) {
        const inner: Scope = { ...callee.scope, depth: scope.depth + 1 };
        out.push(...union(callee.returns.map((r) => evaluate(r, inner, ctx, new Set()))));
      }
    }
    return out;
  }
  if ("object" in e) return [{ k: "object", entries: e.object, scope }];
  if ("fn" in e) return [{ k: "fn", line: e.fn, ...(e.end ? { end: e.end } : {}), ...(e.returns ? { returns: e.returns } : {}), scope }];
  if ("either" in e) return union(e.either.map((x) => evaluate(x, scope, ctx, resolving)));
  return [];
}

/** The file and exported name an identifier of `file` is imported as, else null. */
export function importedName(file: FileAnalysis, name: string, ctx: FactoryContext): { file: FileAnalysis; name: string } | null {
  const imp = file.imports.find((i) => i.specifiers.includes(name) && !i.isType);
  if (!imp || imp.isNamespace) return null;
  const path = resolveTarget(imp.source, file.filePath, ctx.filePathMap);
  const target = path ? ctx.byPath.get(path) : undefined;
  if (!target) return null;
  return { file: target, name: imp.aliases?.[name] ?? (imp.isDefault ? "default" : name) };
}

/** A local name for an exported one: `export default createStore` → createStore. */
function localName(file: FileAnalysis, exported: string): string {
  const exp = file.exports.find((x) => x.name === exported && !x.source);
  return exp?.sourceName ?? exported;
}

function shapeFunctionNamed(file: FileAnalysis, name: string, ctx: FactoryContext): { file: FileAnalysis; shape: ShapeFunction } | null {
  for (let hop = 0, f = file, n = name; hop < 3; hop++) {
    const own = f.storeShapes?.functions?.[n];
    if (own) return { file: f, shape: own };
    if (f.functions.some((x) => x.name === n)) return null;
    const imp = importedName(f, n, ctx);
    if (!imp) return null;
    f = imp.file;
    n = localName(imp.file, imp.name);
  }
  return null;
}

/** The project function a name of `file` stands for: its own, or the one it imports. */
export function functionNamed(file: FileAnalysis, name: string, ctx: FactoryContext): { file: FileAnalysis; fn: FunctionInfo } | null {
  for (let hop = 0, f = file, n = name; hop < 3; hop++) {
    const own = f.functions.find((x) => x.name === n);
    if (own) return { file: f, fn: own };
    const imp = importedName(f, n, ctx);
    if (!imp) return null;
    f = imp.file;
    n = localName(imp.file, imp.name);
  }
  return null;
}
