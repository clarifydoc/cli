import type { Node } from "web-tree-sitter";
import type { CallArgOrigin, DataSourceInfo } from "../../../types/analysis.js";

type Origin = CallArgOrigin["origin"];

/**
 * Where a Java or Kotlin call's arguments come from (`CallInfo.argOrigins`),
 * for the project pass that follows a route parameter to the column a query
 * filters on (`paramColumns`): a parameter of the enclosing method
 * (`clubs.findBySlug(slug)`, Kotlin's named `find(slug = slug)` by its name), a
 * value of the servlet request (`request.getParameter("q")` → a query value),
 * a string literal. One conversion is unwrapped and named (`Long.valueOf(id)`,
 * `UUID.fromString(id)`). Reported only when one argument's origin is known.
 */
export function jvmArgOriginsOf(node: Node): CallArgOrigin[] | null {
  const args = argumentsOf(node);
  if (!args || args.length === 0 || args.length > 12) return null;
  const out: CallArgOrigin[] = [];
  args.forEach((a, index) => {
    const { node: v, transform } = unwrap(a.value);
    const origin = valueOrigin(v);
    if (origin) out.push({ index, ...(a.name ? { param: a.name } : {}), origin, ...(transform ? { transform } : {}) });
  });
  return out.some((a) => a.origin.kind !== "literal") ? out : null;
}

/** A call's arguments: Java `argument_list`, Kotlin `value_arguments` (a named one with its name). */
function argumentsOf(node: Node): Array<{ value: Node; name?: string }> | null {
  if (node.type === "method_invocation" || node.type === "object_creation_expression") {
    const list = node.childForFieldName("arguments");
    return list ? list.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment").map((value) => ({ value })) : null;
  }
  if (node.type === "call_expression") {
    const suffix = node.namedChildren.find((c) => c.type === "call_suffix");
    const list = suffix?.namedChildren.find((c) => c.type === "value_arguments");
    if (!list) return null;
    const out: Array<{ value: Node; name?: string }> = [];
    for (const a of list.namedChildren) {
      if (a.type !== "value_argument") continue;
      const named = a.children.some((c) => c.type === "=");
      const value = a.namedChildren[a.namedChildren.length - 1];
      if (!value) continue;
      out.push(named ? { value, name: a.namedChildren[0]!.text } : { value });
    }
    return out;
  }
  return null;
}

function unwrap(n: Node): { node: Node; transform?: string } {
  if (n.type === "parenthesized_expression" && n.namedChildCount === 1) return unwrap(n.namedChild(0)!);
  if (n.type === "cast_expression") {
    const value = n.childForFieldName("value");
    if (value) return { node: value, transform: `(${n.childForFieldName("type")?.text ?? ""})` };
  }
  if (n.type === "method_invocation") {
    const fn = `${n.childForFieldName("object")?.text ?? ""}.${n.childForFieldName("name")?.text ?? ""}`;
    const args = n.childForFieldName("arguments")?.namedChildren ?? [];
    if (/^(?:Long|Integer|Short|UUID|String|Objects)\.(?:valueOf|parseLong|parseInt|fromString|toString)$/.test(fn) && args.length === 1) return { node: args[0]!, transform: fn };
  }
  return { node: n };
}

const MEMBERS = new Set(["method_declaration", "constructor_declaration", "function_declaration", "secondary_constructor"]);

/** The method whose body `n` sits in, unless a lambda between them declares `name` itself. */
function enclosingMember(n: Node, name: string): Node | null {
  for (let p = n.parent; p; p = p.parent) {
    if (MEMBERS.has(p.type)) return p;
    if (p.type === "lambda_expression") {
      const params = p.childForFieldName("parameters");
      if (params && (params.type === "identifier" ? params.text === name : params.text.split(/[^\w$]+/).includes(name))) return null;
    }
    if (p.type === "lambda_literal") {
      const params = p.namedChildren.find((c) => c.type === "lambda_parameters");
      if (params ? params.text.split(/[^\w$]+/).includes(name) : name === "it") return null;
    }
    if (p.type === "class_body" || p.type === "class_declaration" || p.type === "object_declaration") return null;
  }
  return null;
}

/** Index of `name` among the member's parameters, in declaration order. */
function paramIndex(member: Node, name: string): number {
  const list = member.childForFieldName("parameters") ?? member.namedChildren.find((c) => c.type === "formal_parameters" || c.type === "function_value_parameters");
  if (!list) return -1;
  let i = 0;
  for (const p of list.namedChildren) {
    if (p.type === "formal_parameter" || p.type === "spread_parameter") {
      const id = p.childForFieldName("name") ?? p.namedChildren.filter((c) => c.type === "identifier").pop();
      if (id?.text === name) return i;
      i++;
    } else if (p.type === "parameter") {
      if (p.namedChildren.find((c) => c.type === "simple_identifier")?.text === name) return i;
      i++;
    }
  }
  return -1;
}

/** A name the member assigns in its body: no longer the value it was called with. */
function reassigned(member: Node, name: string): boolean {
  const body = member.childForFieldName("body") ?? member.namedChildren.find((c) => c.type === "function_body");
  if (!body || !body.text.includes(name)) return false;
  let found = false;
  const visit = (n: Node): void => {
    if (found) return;
    if ((n.type === "assignment_expression" && n.childForFieldName("left")?.text === name) || (n.type === "assignment" && n.namedChildren[0]?.text === name)) found = true;
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return found;
}

function valueOrigin(v: Node): Origin | null {
  if (v.type === "string_literal" || v.type === "string") {
    if (v.namedChildren.some((c) => /interpolat|template_expression/.test(c.type))) return null;
    return { kind: "literal", value: v.text.replace(/^"|"$/g, "") };
  }
  if (v.type === "method_invocation" && v.childForFieldName("name")?.text === "getParameter") {
    const key = v.childForFieldName("arguments")?.namedChildren[0];
    const owner = v.childForFieldName("object")?.text ?? "";
    if (key?.type === "string_literal" && /(?:^|\.)(?:request|req|httpRequest|servletRequest)$/.test(owner)) {
      const name = key.text.replace(/^"|"$/g, "");
      if (/^[A-Za-z_][\w-]*$/.test(name)) return { kind: "query-param", name };
    }
    return null;
  }
  if (v.type !== "identifier" && v.type !== "simple_identifier") return null;
  const member = enclosingMember(v, v.text);
  if (!member) return null;
  const index = paramIndex(member, v.text);
  return index >= 0 && !reassigned(member, v.text) ? { kind: "param", name: v.text, index } : null;
}

const DERIVED_QUERY = /^(?:find|read|get|query|search|stream|count|exists|delete|remove)(?:First\d*|Top\d*|Distinct|All)*By([A-Z]\w*)$/;
/** Comparison suffixes a derived-query criterion may end with, and how many arguments each takes. */
const OPERATORS: Array<[RegExp, number]> = [
  [/(?:IsNotNull|NotNull|IsNull|Null|IsTrue|True|IsFalse|False|IsEmpty|Empty|IsNotEmpty|NotEmpty)$/, 0],
  [/(?:IsBetween|Between)$/, 2],
  [/(?:IgnoreCase|AllIgnoreCase)$/, -1],
  [/(?:IsNot|Not|IsIn|In|NotIn|IsLike|Like|NotLike|IsContaining|Containing|Contains|IsStartingWith|StartingWith|StartsWith|IsEndingWith|EndingWith|EndsWith|IsLessThan|LessThan|IsLessThanEqual|LessThanEqual|IsGreaterThan|GreaterThan|IsGreaterThanEqual|GreaterThanEqual|IsBefore|Before|IsAfter|After|Is|Equals|Matches|Regex|Near|Within|Exists)$/, 1],
];

/**
 * A Spring Data derived query's criteria as filter fields, each with the
 * origin of the argument it takes (`findByClubIdAndSeason(clubId, season)` →
 * `clubId`, `season`; `IsNull` takes none, `Between` two): only plain
 * equality criteria are kept — and only when every argument is accounted for.
 */
export function derivedQueryWhereFields(method: string, call: Node): DataSourceInfo["whereFields"] | null {
  const m = DERIVED_QUERY.exec(method);
  if (!m) return null;
  const criteria = m[1]!.replace(/OrderBy[A-Z]\w*$/, "").split(/(?<=[a-z0-9])(?:And|Or)(?=[A-Z])/);
  const args = argumentsOf(call);
  if (!args) return null;
  const out: NonNullable<DataSourceInfo["whereFields"]> = [];
  let at = 0;
  for (let c of criteria) {
    let takes = 1;
    // A lookup by the value: plain equality (`ClubId`, `ClubIdIs`, `ClubIdEquals`) or membership (`ClubIdIn`).
    let lookup = true;
    c = c.replace(/(?:AllIgnoreCase|IgnoreCase)$/, "");
    for (const [re, n] of OPERATORS) {
      const hit = re.exec(c);
      if (n < 0 || !hit) continue;
      lookup = n === 1 && /^(?:Is|Equals|In|IsIn)$/.test(hit[0]);
      c = c.slice(0, hit.index);
      takes = n;
      break;
    }
    if (!c) return null;
    if (takes === 1) {
      const arg = args[at];
      if (!arg) return null;
      const { node: v, transform } = unwrap(arg.value);
      const origin = valueOrigin(v);
      if (lookup && origin && origin.kind !== "literal") out.push({ field: c[0]!.toLowerCase() + c.slice(1), origin, ...(transform ? { transform } : {}) });
    }
    at += takes;
  }
  // `Pageable` / `Sort` may follow the criteria; anything else means the name was misread.
  if (args.length > at && !args.slice(at).every((a) => /page|sort|limit/i.test(a.value.text))) return null;
  return out.length > 0 ? out : null;
}

/**
 * The filter fields of a repository method's annotated query (`@Query("… where
 * c.slug = :slug and c.season = ?2")`): each field compared with a named
 * (`:slug`, bound by `@Param("slug")` or the parameter's own name) or numbered
 * (`?2`) placeholder, with the parameter it takes. Null when there is none.
 */
export function annotatedQueryWhereFields(sql: string, method: Node | null): DataSourceInfo["whereFields"] | null {
  if (!method) return null;
  const params = methodParams(method);
  if (params.length === 0) return null;
  const where = sql.replace(/'(?:[^']|'')*'/g, "''").split(/\bWHERE\b/i).slice(1).join(" WHERE ");
  if (!where) return null;
  const out: NonNullable<DataSourceInfo["whereFields"]> = [];
  const add = (field: string, placeholder: string): void => {
    const index = /^\d+$/.test(placeholder) ? Number(placeholder) - 1 : params.findIndex((p) => p.bound === placeholder);
    const p = params[index];
    if (!p || out.some((w) => w.field === field && w.origin.kind === "param" && w.origin.index === index)) return;
    out.push({ field, origin: { kind: "param", name: p.name, index } });
  };
  for (const m of where.matchAll(/(?:\b\w+\.)?\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:=|\bIN\s*\(?)\s*(?::([A-Za-z_]\w*)|\?(\d+))/gi)) {
    if (!/^(?:AND|OR|NOT|WHERE)$/i.test(m[1]!)) add(m[1]!, m[2] ?? m[3]!);
  }
  return out.length > 0 ? out : null;
}

/** A method's parameters with the name a query binds each by (`@Param("slug") String s` → slug). */
function methodParams(method: Node): Array<{ name: string; bound: string }> {
  const list = method.childForFieldName("parameters") ?? method.namedChildren.find((c) => c.type === "formal_parameters" || c.type === "function_value_parameters");
  const out: Array<{ name: string; bound: string }> = [];
  let pending = "";
  for (const p of list?.children ?? []) {
    if (p.type === "parameter_modifiers") {
      pending = p.text;
      continue;
    }
    if (p.type !== "formal_parameter" && p.type !== "parameter" && p.type !== "spread_parameter") continue;
    const id = p.type === "parameter" ? p.namedChildren.find((c) => c.type === "simple_identifier") : p.childForFieldName("name") ?? p.namedChildren.filter((c) => c.type === "identifier").pop();
    const name = id?.text ?? "_";
    const bound = /@(?:\w+\.)*(?:Param|Bind|BindParam)\s*\(\s*(?:value\s*=\s*)?"(\w+)"/.exec(pending + p.text)?.[1] ?? name;
    out.push({ name, bound });
    pending = "";
  }
  return out;
}
