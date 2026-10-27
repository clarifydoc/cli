import type { Node } from "web-tree-sitter";
import type { CallArgOrigin, DataSourceInfo } from "../../../types/analysis.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a Python call's arguments come from (`CallInfo.argOrigins`), for the
 * project passes that follow a value along calls — a route parameter to the
 * column a query filters on (`paramColumns`):
 *
 *   a parameter of the enclosing function     `repo.get_club(slug)`, `repo.get_club(slug=slug)`
 *   a value of the request, by name           `request.args.get("q")` (Flask), `request.GET["q"]`,
 *                                             `request.query_params.get("q")` (DRF, Starlette) → a query value;
 *                                             `self.kwargs["pk"]` (Django class-based views),
 *                                             `request.view_args["id"]`, `request.path_params["id"]` → a route parameter
 *   a string literal
 *
 * A keyword argument carries its name (`param`): the callee's parameter of that
 * name receives it. One conversion is unwrapped and named (`int(club_id)`,
 * `UUID(x)`, `str(x)`). Reported only when one argument's origin is known.
 */
export function pythonArgOriginsOf(node: Node): CallArgOrigin[] | null {
  if (node.type !== "call") return null;
  const argsNode = node.childForFieldName("arguments");
  if (!argsNode || argsNode.type !== "argument_list") return null;
  const args = argsNode.namedChildren.filter((a) => a.type !== "comment");
  if (args.length === 0 || args.length > 12) return null;
  const out: CallArgOrigin[] = [];
  let splat = false;
  args.forEach((arg, index) => {
    if (arg.type === "list_splat" || arg.type === "dictionary_splat") {
      // Positions after `*xs` are unknown; keyword arguments still name their parameter.
      splat = true;
      return;
    }
    if (arg.type === "keyword_argument") {
      const name = arg.childForFieldName("name")?.text;
      const value = arg.childForFieldName("value");
      if (!name || !value) return;
      const { node: v, transform } = unwrap(value);
      const origin = valueOrigin(v);
      if (origin) out.push({ index, param: name, origin, ...(transform ? { transform } : {}) });
      return;
    }
    if (splat) return;
    const { node: v, transform } = unwrap(arg);
    const origin = valueOrigin(v);
    if (origin) out.push({ index, origin, ...(transform ? { transform } : {}) });
  });
  return out.some((a) => a.origin.kind !== "literal") ? out : null;
}

/** Conversions a value passes through on its way to a call or a filter. */
const CONVERSIONS = new Set(["int", "str", "float", "UUID", "uuid.UUID", "UUID4", "Decimal", "slugify"]);

function unwrap(n: Node): { node: Node; transform?: string } {
  if (n.type === "call") {
    const fn = n.childForFieldName("function")?.text ?? "";
    const args = n.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
    if (CONVERSIONS.has(fn) && args.length === 1 && args[0]!.type !== "keyword_argument") return { node: args[0]!, transform: fn };
  }
  if (n.type === "parenthesized_expression" && n.namedChildCount === 1) return unwrap(n.namedChild(0)!);
  return { node: n };
}

/** The origin of one value: a parameter of the enclosing function, a request value, a string literal, or a local assigned one of those. */
function valueOrigin(v: Node, depth = 0): Origin | null {
  if (v.type === "string") {
    const text = stringText(v);
    return text !== null ? { kind: "literal", value: text } : null;
  }
  const request = requestValue(v);
  if (request) return request;
  if (v.type !== "identifier") return null;
  const fn = enclosingDef(v);
  if (!fn) return null;
  const index = paramIndex(fn, v.text);
  if (index >= 0) return assignsTo(fn, v.text).length === 0 ? { kind: "param", name: v.text, index } : null;
  // A local the function assigns once from a request value or a parameter (`slug = self.kwargs["slug"]`).
  if (depth > 0) return null;
  const values = assignsTo(fn, v.text);
  if (values.length !== 1) return null;
  const { node: inner } = unwrap(values[0]!);
  const origin = valueOrigin(inner, depth + 1);
  return origin && origin.kind !== "literal" ? origin : null;
}

const QUERY_DICTS = /^(?:self\.)?request\.(?:args|GET|query_params|values)$/;
const ROUTE_DICTS = /^(?:self\.kwargs|(?:self\.)?request\.(?:view_args|path_params|match_info))$/;

/** `request.args.get("q")`, `request.GET["q"]`, `self.kwargs["pk"]`, … → the request value it reads. */
function requestValue(v: Node): Origin | null {
  let dict: string | null = null;
  let key: Node | null = null;
  if (v.type === "subscript") {
    dict = v.childForFieldName("value")?.text ?? null;
    key = v.childForFieldName("subscript");
  } else if (v.type === "call") {
    const fn = v.childForFieldName("function");
    if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "get") return null;
    dict = fn.childForFieldName("object")?.text ?? null;
    key = v.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment") ?? null;
  }
  if (!dict || key?.type !== "string") return null;
  const name = stringText(key);
  if (!name || !/^[A-Za-z_][\w-]*$/.test(name)) return null;
  if (QUERY_DICTS.test(dict)) return { kind: "query-param", name };
  if (ROUTE_DICTS.test(dict)) return { kind: "route-param", name };
  return null;
}

function stringText(n: Node): string | null {
  const content = n.namedChildren.filter((c) => c.type === "string_content");
  if (n.namedChildren.some((c) => c.type === "interpolation")) return null;
  return content.map((c) => c.text).join("");
}

function enclosingDef(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === "function_definition") return p;
    if (p.type === "lambda" || p.type === "class_definition") return null;
  }
  return null;
}

/** The parameter's place among the ones a caller passes (`self`/`cls`, separators and splats left out, as `FunctionInfo.params`). */
function paramIndex(fn: Node, name: string): number {
  let i = 0;
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    let n: string | null = null;
    if (p.type === "identifier") n = p.text;
    else if (p.type === "typed_parameter") {
      const first = p.namedChild(0);
      n = first?.type === "identifier" ? first.text : null;
    } else if (p.type === "default_parameter" || p.type === "typed_default_parameter") n = p.childForFieldName("name")?.text ?? null;
    else continue;
    if (!n || n === "self" || n === "cls") continue;
    if (n === name) return i;
    i++;
  }
  return -1;
}

/** Every value `fn` assigns to `name` in its own body (nested definitions aside). */
function assignsTo(fn: Node, name: string): Node[] {
  const out: Node[] = [];
  const body = fn.childForFieldName("body");
  if (!body || !body.text.includes(name)) return out;
  const visit = (n: Node): void => {
    if (n.type === "function_definition" || n.type === "class_definition" || n.type === "lambda") return;
    if ((n.type === "assignment" || n.type === "augmented_assignment") && n.childForFieldName("left")?.text === name) {
      const right = n.childForFieldName("right");
      out.push(right ?? n);
    } else if (n.type === "for_statement" && n.childForFieldName("left")?.text === name) out.push(n);
    for (const c of n.namedChildren) visit(c);
  };
  for (const c of body.namedChildren) visit(c);
  return out;
}

/** Django field lookups: `author__username__iexact` compares `author.username`. */
const DJANGO_LOOKUPS = new Set([
  "exact", "iexact", "in", "contains", "icontains", "startswith", "istartswith", "endswith", "iendswith",
  "gt", "gte", "lt", "lte", "range", "date", "year", "month", "day", "regex", "iregex",
]);
/** The calls of a query chain that filter it. */
const FILTER_METHODS = new Set(["filter", "filter_by", "where", "get", "get_or_none", "get_object_or_404"]);
const STATEMENT_LEAVES = new Set(["execute", "exec", "scalars", "scalar"]);

/**
 * The fields a Python ORM statement filters on with a value of known origin
 * (`DataSourceInfo.whereFields`):
 *
 *   SQLAlchemy  `select(Club).where(Club.slug == slug)`, `.filter(Club.id == club_id)`,
 *               `.filter_by(slug=slug)`, also through a local the session is handed
 *               (`stmt = select(Club).filter(…)` … `session.execute(stmt)`), `and_(…)`
 *   Django      `Club.objects.filter(slug=slug)`, `.get(pk=pk)`, `author__username=name` → `author.username`
 *
 * Literal comparisons are left out. Null when there is none.
 */
export function pythonWhereFields(call: Node): DataSourceInfo["whereFields"] | null {
  const out: NonNullable<DataSourceInfo["whereFields"]> = [];
  const seen = new Set<string>();
  const add = (field: string, value: Node): void => {
    const { node: v, transform } = unwrap(value);
    const origin = valueOrigin(v);
    if (!origin || origin.kind === "literal") return;
    const k = `${field}|${JSON.stringify(origin)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ field, origin, ...(transform ? { transform } : {}) });
  };
  const visited = new Set<number>();
  const chain = (expr: Node, depth: number): void => {
    let cur: Node | null = expr;
    while (cur?.type === "call") {
      if (visited.has(cur.id)) return;
      visited.add(cur.id);
      const fn = cur.childForFieldName("function");
      const leaf = fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text ?? "" : fn?.text ?? "";
      const args = cur.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
      if (FILTER_METHODS.has(leaf)) for (const a of args) filterArg(a, add);
      // The statement a session is handed: inline, or a local the function builds it in.
      if (STATEMENT_LEAVES.has(leaf) && depth < 2) {
        const first = args[0];
        if (first?.type === "call") chain(first, depth + 1);
        else if (first?.type === "identifier") {
          const fnDef = enclosingDef(first);
          // A local built with `filter_by(…)` is a statement row of its own, which reports its filter itself.
          for (const value of fnDef ? assignsTo(fnDef, first.text) : []) if (!/\.filter_by\s*\(/.test(value.text)) chain(value, depth + 1);
        }
      }
      cur = fn?.type === "attribute" ? fn.childForFieldName("object") : null;
    }
  };
  chain(call, 0);
  return out.length > 0 ? out : null;
}

/** One argument of a filter call: a keyword lookup, a column comparison, or `and_(…)` / `Q(…)` holding them. */
function filterArg(a: Node, add: (field: string, value: Node) => void): void {
  if (a.type === "keyword_argument") {
    const key = a.childForFieldName("name")?.text;
    const value = a.childForFieldName("value");
    if (!key || !value) return;
    const parts = key.split("__");
    while (parts.length > 1 && DJANGO_LOOKUPS.has(parts[parts.length - 1]!)) parts.pop();
    add(parts.join("."), value);
    return;
  }
  if (a.type === "comparison_operator") {
    // `Club.slug == slug` (either way round); `!=`, `<`, … are not lookups by the value.
    const ops = a.children.filter((c) => !c.isNamed).map((c) => c.type);
    if (ops.length !== 1 || ops[0] !== "==") return;
    const [left, right] = [a.namedChild(0), a.namedChild(1)];
    if (!left || !right) return;
    const lf = columnOf(left);
    const rf = columnOf(right);
    if (lf && !rf) add(lf, right);
    else if (rf && !lf) add(rf, left);
    return;
  }
  if (a.type === "call") {
    const fn = a.childForFieldName("function");
    const name = fn?.text ?? "";
    const args = a.childForFieldName("arguments")?.namedChildren.filter((x) => x.type !== "comment") ?? [];
    if (/^(?:(?:sa|sqlalchemy)\.)?and_$|^Q$/.test(name)) for (const x of args) filterArg(x, add);
    // `Club.id.in_(ids)`
    else if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "in_" && args.length === 1) {
      const col = columnOf(fn.childForFieldName("object")!);
      if (col) add(col, args[0]!);
    }
  }
}

/** `Club.slug`, `self.model.slug`, `clubs.c.slug`, `models.Club.slug` → `slug`; null for anything else. */
function columnOf(n: Node): string | null {
  if (n.type !== "attribute") return null;
  const parts = n.text.split(".");
  if (parts.length < 2 || !parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) return null;
  const owner = parts.slice(0, -1);
  const isModel = owner.some((p) => /^[A-Z]/.test(p)) || (owner[0] === "self" && owner[1] === "model") || owner[owner.length - 1] === "c";
  return isModel ? parts[parts.length - 1]! : null;
}
