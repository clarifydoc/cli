import type { Node } from "web-tree-sitter";
import type { CallArgOrigin, DataSourceInfo } from "../../../types/analysis.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a C# call's arguments come from (`CallInfo.argOrigins`), for the
 * project pass that follows a route parameter to the column a query filters
 * on (`paramColumns`): a parameter of the enclosing member (`GetClub(clubId)`,
 * a named `GetClub(id: clubId)` by its name), a value of the request
 * (`Request.Query["q"]` → a query value, `RouteData.Values["id"]` → a route
 * parameter), a string literal. One conversion is unwrapped and named
 * (`int.Parse(id)`, `(long)id`). Reported only when one argument's origin is known.
 */
export function csharpArgOriginsOf(node: Node): CallArgOrigin[] | null {
  if (node.type !== "invocation_expression" && node.type !== "object_creation_expression") return null;
  const list = node.childForFieldName("arguments") ?? node.namedChildren.find((c) => c.type === "argument_list");
  const args = list?.namedChildren.filter((c) => c.type === "argument") ?? [];
  if (args.length === 0 || args.length > 12) return null;
  const out: CallArgOrigin[] = [];
  args.forEach((arg, index) => {
    const name = arg.childForFieldName("name")?.text;
    const raw = arg.namedChildren[arg.namedChildren.length - 1];
    if (!raw || raw === arg.childForFieldName("name")) return;
    const { node: v, transform } = unwrap(raw);
    const origin = valueOrigin(v);
    if (origin) out.push({ index, ...(name ? { param: name } : {}), origin, ...(transform ? { transform } : {}) });
  });
  return out.some((a) => a.origin.kind !== "literal") ? out : null;
}

function unwrap(n: Node): { node: Node; transform?: string } {
  if (n.type === "parenthesized_expression" && n.namedChildCount === 1) return unwrap(n.namedChild(0)!);
  if (n.type === "cast_expression") {
    const value = n.childForFieldName("value");
    if (value) return { node: value, transform: `(${n.childForFieldName("type")?.text ?? ""})` };
  }
  if (n.type === "invocation_expression") {
    // `int.Parse(id)`, `Guid.Parse(id)`, `Convert.ToInt32(id)`
    const fn = n.childForFieldName("function")?.text ?? "";
    const args = n.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
    if (/^(?:\w+\.(?:Parse|TryParse)|Convert\.To\w+)$/.test(fn) && args.length === 1) {
      const inner = args[0]!.namedChildren[args[0]!.namedChildren.length - 1];
      if (inner) return { node: inner, transform: fn };
    }
  }
  return { node: n };
}

const MEMBER_TYPES = new Set(["method_declaration", "constructor_declaration", "local_function_statement", "operator_declaration", "conversion_operator_declaration"]);

/** The member whose body `n` sits in, and whether a lambda between them declares `name` itself. */
function enclosingMember(n: Node, name: string): Node | null {
  for (let p = n.parent; p; p = p.parent) {
    if (MEMBER_TYPES.has(p.type)) return p;
    if (p.type === "lambda_expression" || p.type === "anonymous_method_expression") {
      const params = p.childForFieldName("parameters");
      if (params && (params.type === "implicit_parameter" ? params.text === name : params.namedChildren.some((c) => c.childForFieldName("name")?.text === name))) return null;
    }
    if (p.type === "class_declaration" || p.type === "record_declaration" || p.type === "struct_declaration") return null;
  }
  return null;
}

/** Index of `name` among the member's parameters, as `FunctionInfo.params` lists them (`params` arrays included). */
function paramIndex(member: Node, name: string): number {
  const list = member.childForFieldName("parameters");
  if (!list) return -1;
  let i = 0;
  const kids = list.children;
  for (let k = 0; k < kids.length; k++) {
    const p = kids[k]!;
    if (p.type === "params") {
      if (kids[k + 2]?.text === name) return i;
      i++;
      k += 2;
      continue;
    }
    if (p.type !== "parameter") continue;
    if (p.childForFieldName("name")?.text === name) return i;
    i++;
  }
  return -1;
}

/** A name the member assigns anywhere in its body (`id = …`, `id++`): no longer the value it was called with. */
function reassigned(member: Node, name: string): boolean {
  const body = member.childForFieldName("body");
  if (!body || !body.text.includes(name)) return false;
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if ((n.type === "assignment_expression" && n.childForFieldName("left")?.text === name)
      || ((n.type === "postfix_unary_expression" || n.type === "prefix_unary_expression") && /^(?:\+\+|--)?\s*\w+\s*(?:\+\+|--)?$/.test(n.text) && n.text.replace(/[+-]/g, "").trim() === name)) found = true;
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return found;
}

function valueOrigin(v: Node): Origin | null {
  if (v.type === "string_literal") {
    const content = v.namedChildren.filter((c) => c.type === "string_literal_content").map((c) => c.text).join("");
    return v.namedChildren.some((c) => c.type === "interpolation") ? null : { kind: "literal", value: content };
  }
  const request = requestValue(v);
  if (request) return request;
  if (v.type !== "identifier") return null;
  const member = enclosingMember(v, v.text);
  if (!member) return null;
  const index = paramIndex(member, v.text);
  return index >= 0 && !reassigned(member, v.text) ? { kind: "param", name: v.text, index } : null;
}

/** `Request.Query["q"]`, `HttpContext.Request.Query["q"]` → a query value; `RouteData.Values["id"]` → a route parameter. */
function requestValue(v: Node): Origin | null {
  if (v.type !== "element_access_expression") return null;
  const owner = v.childForFieldName("expression")?.text ?? "";
  const key = v.childForFieldName("subscript")?.namedChildren[0]?.namedChildren[0];
  if (key?.type !== "string_literal") return null;
  const name = key.namedChildren.filter((c) => c.type === "string_literal_content").map((c) => c.text).join("");
  if (!/^[A-Za-z_][\w-]*$/.test(name)) return null;
  if (/^(?:(?:HttpContext|_httpContextAccessor\.HttpContext|this)\.)?Request\.Query$/.test(owner)) return { kind: "query-param", name };
  if (/^(?:(?:HttpContext\.)?Request\.)?RouteValues$|^(?:this\.)?RouteData\.Values$/.test(owner)) return { kind: "route-param", name };
  return null;
}

/** LINQ operators taking a predicate over the set's rows. */
const PREDICATE_METHODS = new Set([
  "Where", "First", "FirstOrDefault", "FirstAsync", "FirstOrDefaultAsync", "Single", "SingleOrDefault", "SingleAsync",
  "SingleOrDefaultAsync", "Last", "LastOrDefault", "LastAsync", "LastOrDefaultAsync", "Any", "AnyAsync", "Count",
  "CountAsync", "LongCount", "LongCountAsync",
]);

/** Operators whose rows are no longer the set's (a join's pairs, a grouping's groups). */
const RESHAPING_METHODS = new Set(["Join", "GroupJoin", "SelectMany", "GroupBy", "Zip"]);

/**
 * The fields an EF / LINQ query filters on with a value of known origin
 * (`DataSourceInfo.whereFields`): the predicates of its `Where`, `First…`,
 * `Single…`, `Any`, `Count` operators down the chain —
 * `s => s.Id == seriesId` → `Id`, `s => s.Library.Id == libraryId && …` →
 * `Library.Id`, `s => ids.Contains(s.Id)` → `Id` — and of a local the chain
 * starts from (`var query = context.Clubs.Where(…)`). Literal comparisons are
 * left out. Null when there is none.
 */
export function csharpWhereFields(call: Node): DataSourceInfo["whereFields"] | null {
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
  const chain = (expr: Node, depth: number): void => {
    let cur: Node | null = expr;
    // Predicates outside a join or a grouping see the rows it makes, not the set's: dropped there.
    let outer: Array<{ field: string; value: Node }> = [];
    const collect = (field: string, value: Node) => outer.push({ field, value });
    while (cur) {
      if (cur.type === "await_expression" || cur.type === "parenthesized_expression") {
        cur = cur.namedChildren[cur.namedChildren.length - 1] ?? null;
        continue;
      }
      if (cur.type !== "invocation_expression") break;
      const fn = cur.childForFieldName("function");
      if (fn?.type !== "member_access_expression") break;
      const method = (fn.childForFieldName("name")?.text ?? "").replace(/<.*$/, "");
      if (RESHAPING_METHODS.has(method)) outer = [];
      if (PREDICATE_METHODS.has(method)) {
        for (const arg of cur.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? []) {
          const lambda = arg.namedChildren[arg.namedChildren.length - 1];
          if (lambda?.type === "lambda_expression") predicate(lambda, collect);
        }
      }
      cur = fn.childForFieldName("expression");
    }
    for (const o of outer) add(o.field, o.value);
    // The chain starts from a local the member narrows (`query = query.Where(…)`). Its first value,
    // a chain on the set (`var query = _context.Clubs.Where(…)`), is a statement row of its own.
    if (cur?.type === "identifier" && depth < 2) {
      const member = enclosingMember(cur, "");
      const name = cur.text;
      const local = (root: Node | null) => root?.type === "identifier" && (root.text === name || localValues(member!, root.text).length > 0);
      for (const value of member ? localValues(member, name) : []) if (local(chainRoot(value))) chain(value, depth + 1);
    }
  };
  chain(call, 0);
  return out.length > 0 ? out : null;
}

/** What a member-call chain starts from (`query` of `query.Where(…).Take(5)`). */
function chainRoot(n: Node): Node | null {
  let cur: Node | null = n;
  while (cur) {
    if (cur.type === "await_expression" || cur.type === "parenthesized_expression") cur = cur.namedChildren[cur.namedChildren.length - 1] ?? null;
    else if (cur.type === "invocation_expression") cur = cur.childForFieldName("function");
    else if (cur.type === "member_access_expression") cur = cur.childForFieldName("expression");
    else return cur;
  }
  return null;
}

/** The comparisons of a `row => …` predicate's body, `&&` and parentheses walked. */
function predicate(lambda: Node, add: (field: string, value: Node) => void): void {
  const params = lambda.childForFieldName("parameters");
  const row = params?.type === "implicit_parameter" ? params.text
    : params?.namedChildren.length === 1 ? params.namedChildren[0]!.childForFieldName("name")?.text ?? null : null;
  const body = lambda.childForFieldName("body");
  if (!row || !body) return;
  const column = (n: Node): string | null => {
    const parts = n.text.replace(/\s+/g, "").replace(/\?\./g, ".").split(".");
    return n.type === "member_access_expression" && parts[0] === row && parts.length >= 2 && parts.slice(1).every((p) => /^[A-Za-z_]\w*$/.test(p)) ? parts.slice(1).join(".") : null;
  };
  const visit = (n: Node): void => {
    if (n.type === "parenthesized_expression") {
      for (const c of n.namedChildren) visit(c);
      return;
    }
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator")?.type;
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (!left || !right) return;
      if (op === "&&") {
        visit(left);
        visit(right);
      } else if (op === "==") {
        const lc = column(left);
        const rc = column(right);
        if (lc && !rc) add(lc, right);
        else if (rc && !lc) add(rc, left);
      }
      return;
    }
    // `ids.Contains(s.Id)`
    if (n.type === "invocation_expression") {
      const fn = n.childForFieldName("function");
      const args = n.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
      if (fn?.type === "member_access_expression" && fn.childForFieldName("name")?.text === "Contains" && args.length === 1) {
        const col = column(args[0]!.namedChildren[args[0]!.namedChildren.length - 1]!);
        const owner = fn.childForFieldName("expression");
        if (col && owner) add(col, owner);
      }
    }
  };
  visit(body);
}

/** The values `member` gives the local `name`: its declaration's initializer and every assignment. */
function localValues(member: Node, name: string): Node[] {
  const body = member.childForFieldName("body");
  if (!body || !body.text.includes(name)) return [];
  const out: Node[] = [];
  const visit = (n: Node): void => {
    if (n.type === "local_function_statement" || n.type === "lambda_expression") return;
    if (n.type === "variable_declarator" && n.childForFieldName("name")?.text === name) {
      const value = n.namedChildren.find((c) => c.type !== "identifier" && c.type !== "bracketed_argument_list") ?? null;
      if (value) out.push(value.type === "equals_value_clause" ? value.namedChildren[0] ?? value : value);
    }
    if (n.type === "assignment_expression" && n.childForFieldName("left")?.text === name) {
      const right = n.childForFieldName("right");
      if (right) out.push(right);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return out;
}
