import type { Node } from "web-tree-sitter";
import type { CallArgOrigin, DataSourceInfo } from "../../../types/analysis.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a PHP call's arguments come from (`CallInfo.argOrigins`) and which
 * columns an Eloquent / query-builder statement filters on with them
 * (`DataSourceInfo.whereFields`), for the project pass that follows a route
 * parameter to the column it selects (`paramColumns`):
 *
 *   public function show(Request $request, string $id) {
 *       $club = $this->clubs->find((int) $id);                  ← argument 0 is parameter 1
 *       $season = $request->route('season');                    ← a route parameter, by name
 *       Fixture::where('club_id', $id)->where('season', $season)->get();   ← filters club_id, season
 *   }
 *
 * A value is a parameter of the enclosing function, a request read
 * (`$request->route('id')` → a route parameter; `$request->query('q')` → a
 * query value; `$request->input('q')` / `->get('q')` / `request('q')` → a
 * request value of either), a string literal, or a local the function assigns
 * once from one of those; `(int)` / `intval()` are conversions it passes through.
 */

const FUNCTION_TYPES = /^(?:method_declaration|function_definition|anonymous_function|anonymous_function_creation_expression|arrow_function)$/;
const CONVERSIONS = new Set(["intval", "strval", "floatval", "trim", "strtolower"]);

function enclosingFunction(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (FUNCTION_TYPES.test(p.type)) return p;
  return null;
}

/** The function's parameter names, `$` kept, in order. */
function paramNames(fn: Node): string[] {
  return (fn.childForFieldName("parameters")?.namedChildren ?? [])
    .filter((p): p is Node => !!p && /parameter/.test(p.type))
    .map((p) => p.childForFieldName("name")?.text ?? "");
}

/** Whether the request object is what `obj` names: `$request`, `$this->request`, `request()`. */
const isRequest = (obj: Node): boolean => /^(?:\$request|\$req|\$this->request|\\?request\(\s*\))$/.test(obj.text);

function stringText(n: Node | null | undefined): string | null {
  if (!n || (n.type !== "string" && n.type !== "encapsed_string")) return null;
  if (n.namedChildren.some((c) => c && /variable|expression/.test(c.type))) return null;
  return n.text.replace(/^['"]|['"]$/g, "");
}

/** The expression an `argument` node holds, and the name a PHP 8 named argument gives it. */
function argValue(arg: Node): { value: Node | null; name?: string } {
  const name = arg.childForFieldName("name")?.text;
  const value = arg.namedChildren.filter((c): c is Node => !!c && c.type !== "name").pop() ?? null;
  return name ? { value, name } : { value };
}

const argsOf = (call: Node): Node[] => (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => a?.type === "argument");

/** `$request->route('id')` and friends → the request value read. */
function requestRead(v: Node): Origin | null {
  let verb: string | undefined;
  let key: Node | undefined;
  if (v.type === "member_call_expression" && isRequest(v.childForFieldName("object")!)) {
    verb = v.childForFieldName("name")?.text;
    key = argsOf(v)[0]?.namedChildren[0] ?? undefined;
  } else if (v.type === "function_call_expression" && /^\\?request$/.test(v.childForFieldName("function")?.text ?? "")) {
    verb = "input";
    key = argsOf(v)[0]?.namedChildren[0] ?? undefined;
  }
  const name = stringText(key);
  if (!verb || !name || !/^[\w-]+$/.test(name)) return null;
  if (verb === "route") return { kind: "route-param", name };
  if (verb === "query") return { kind: "query-param", name };
  if (/^(?:input|get|string|integer|str|boolean|date|post)$/.test(verb)) return { kind: "request-param", name };
  return null;
}

/** Every value the function assigns to `$name` (`$name = v`, `$name ??= v`, a `list(...)` / `[...] =` target). */
function assignmentsOf(fn: Node, name: string): Array<Node | null> {
  const out: Array<Node | null> = [];
  const body = fn.childForFieldName("body");
  if (!body || !body.text.includes(name)) return out;
  const visit = (n: Node): void => {
    if (FUNCTION_TYPES.test(n.type) && n !== fn) return;
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") {
      const left = n.childForFieldName("left");
      if (left?.text === name) out.push(n.type === "assignment_expression" ? n.childForFieldName("right") : null);
      else if (left && (left.type === "list_literal" || left.type === "array_creation_expression") && new RegExp(`\\${name}\\b`).test(left.text)) out.push(null);
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(body);
  return out;
}

function unwrap(v: Node): { node: Node; transform?: string } {
  if (v.type === "cast_expression") {
    const value = v.childForFieldName("value") ?? v.namedChildren[v.namedChildCount - 1];
    const type = v.childForFieldName("type")?.text ?? v.namedChildren[0]?.text;
    if (value) return { node: value, ...(type ? { transform: `(${type.replace(/[()\s]/g, "")})` } : {}) };
  }
  if (v.type === "function_call_expression" && CONVERSIONS.has(v.childForFieldName("function")?.text ?? "")) {
    const a = argsOf(v);
    const inner = a.length >= 1 ? argValue(a[0]!).value : null;
    if (inner) return { node: inner, transform: v.childForFieldName("function")!.text };
  }
  if (v.type === "parenthesized_expression" && v.namedChildCount === 1) return unwrap(v.namedChild(0)!);
  return { node: v };
}

/** The origin of one value; null when unknown. */
export function phpValueOrigin(raw: Node, depth = 0): { origin: Origin; transform?: string } | null {
  const { node: v, transform } = unwrap(raw);
  const lit = stringText(v);
  if (lit !== null) return { origin: { kind: "literal", value: lit } };
  const read = requestRead(v);
  if (read) return { origin: read, ...(transform ? { transform } : {}) };
  if (v.type !== "variable_name" || v.text === "$this") return null;
  const fn = enclosingFunction(v);
  if (!fn) return null;
  const assigned = assignmentsOf(fn, v.text);
  const index = paramNames(fn).indexOf(v.text);
  if (index >= 0) return assigned.length === 0 ? { origin: { kind: "param", name: v.text.slice(1), index }, ...(transform ? { transform } : {}) } : null;
  if (depth >= 2 || assigned.length !== 1 || !assigned[0]) return null;
  const inner = phpValueOrigin(assigned[0], depth + 1);
  if (!inner || inner.origin.kind === "literal") return null;
  const t = inner.transform ?? transform;
  return { origin: inner.origin, ...(t ? { transform: t } : {}) };
}

/** Declared types a column can be compared with: scalars, arrays of them, unions of those. */
const SCALAR_TYPE = /^(?:(?:int|string|float|bool|array|mixed|null|iterable)\s*\|?\s*)+$/i;

/** `calls.argOriginsOf` for PHP. */
export function phpArgOriginsOf(node: Node): CallArgOrigin[] | null {
  const args = argsOf(node);
  if (args.length === 0 || args.length > 12) return null;
  const out: CallArgOrigin[] = [];
  args.forEach((arg, index) => {
    if (arg.text.startsWith("...")) return;
    const { value, name } = argValue(arg);
    if (!value) return;
    const o = phpValueOrigin(value);
    // Only what a statement can compare a column with: no literal (a server's literal names no
    // request value), no object handed on whole (a model, the request, a container).
    if (!o || o.origin.kind === "literal") return;
    if (o.origin.kind === "param") {
      const fn = enclosingFunction(node);
      const p = (fn?.childForFieldName("parameters")?.namedChildren ?? []).filter((x): x is Node => !!x && /parameter/.test(x.type))[o.origin.index];
      const type = p?.childForFieldName("type")?.text.replace(/^\?/, "") ?? "";
      if (type && !SCALAR_TYPE.test(type)) return;
    }
    out.push({ index, ...(name ? { param: name } : {}), origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
  });
  return out.length > 0 ? out : null;
}

// ─── Eloquent / query-builder filter fields ──────────────────────────────

const OPERATORS = /^(?:=|==|<>|!=|>|<|>=|<=|like|ilike|not like)$/i;

/** The calls of a fluent chain, from its root to `top`. */
function chainCalls(top: Node): Node[] {
  const out: Node[] = [];
  for (let n: Node | null = top; n; ) {
    if (n.type === "member_call_expression" || n.type === "nullsafe_member_call_expression") {
      out.unshift(n);
      n = n.childForFieldName("object");
    } else if (n.type === "scoped_call_expression") {
      out.unshift(n);
      break;
    } else break;
  }
  return out;
}

/** The builder's own `where…` methods (`whereBelongsTo`, `whereHas`, `whereIn`…), which no dynamic column is named after. */
const BUILDER_WHERES = /^(?:In|NotIn|Null|NotNull|Has|Doesnt|Between|NotBetween|Raw|Exists|NotExists|Column|Date|Year|Month|Day|Time|Json|Like|Key|Not|BelongsTo|Relation|Morph|Any|All|None|Fulltext|Integer|Nested|Attached|Today|Past|Future|Before|After|Now|Valued)/;

/** Fields one chain step filters on, each with the value node it compares with. */
function stepFilters(call: Node): Array<[string, Node]> {
  const verb = call.childForFieldName("name")?.text ?? "";
  const args = argsOf(call).map((a) => argValue(a).value);
  if (/^(?:find|findOrFail|findOrNew|findMany|whereKey|findOr)$/.test(verb)) return args[0] && args[0].type !== "array_creation_expression" ? [["id", args[0]]] : [];
  if (/^(?:where|orWhere|firstWhere|whereIn|whereNotIn|whereStrict|andWhere)$/.test(verb)) {
    const col = stringText(args[0]);
    if (col !== null) {
      const op = stringText(args[1]);
      const value = args.length >= 3 && op !== null && OPERATORS.test(op) ? args[2] : args[1];
      return value ? [[col, value]] : [];
    }
    // `where(['club_id' => $id, 'season' => $season])`.
    if (args[0]?.type === "array_creation_expression") {
      const out: Array<[string, Node]> = [];
      for (const el of args[0].namedChildren) {
        if (el?.type !== "array_element_initializer" || el.namedChildCount !== 2) continue;
        const key = stringText(el.namedChild(0));
        if (key !== null) out.push([key, el.namedChild(1)!]);
      }
      return out;
    }
  }
  // Dynamic `whereSlug($slug)`.
  const dynamic = /^where([A-Z]\w*)$/.exec(verb);
  if (dynamic && args.length === 1 && args[0] && !BUILDER_WHERES.test(dynamic[1]!)) {
    return [[dynamic[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(), args[0]]];
  }
  return [];
}

/** Filter fields of the statement whose outermost call is `top`, with a value of known origin. */
export function phpWhereFields(top: Node): DataSourceInfo["whereFields"] | undefined {
  const fields: NonNullable<DataSourceInfo["whereFields"]> = [];
  for (const call of chainCalls(top)) {
    for (const [field, value] of stepFilters(call)) {
      const o = phpValueOrigin(value);
      if (!o || o.origin.kind === "literal" || fields.some((f) => f.field === field)) continue;
      fields.push({ field, origin: o.origin, ...(o.transform ? { transform: o.transform } : {}) });
    }
  }
  return fields.length > 0 ? fields : undefined;
}
