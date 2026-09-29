import type { Node } from "web-tree-sitter";
import type { RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * What a Flask / Django view body reads off the request object. Flask binds
 * nothing through the signature (only path converters), so the query, form,
 * header and body names a handler needs are visible only as `request.args
 * .get("q")`, `request.form["f"]`, `request.get_json()` … in its body. The
 * same shapes appear in Django (`request.GET`, `request.POST`, `request.FILES`)
 * and Django REST (`request.data`), so one scan serves all three.
 *
 * Used twice: the route extractor merges the result into a decorated view's
 * `params`, and the function extractor stores it as `FunctionInfo.requestAccess`
 * so a view referenced from `urls.py`/`add_url_rule` gets it through the core
 * handler join.
 */

/** `request.<member>` → what that member reads from. */
const MEMBER_BINDINGS: Record<string, RouteParamBinding> = {
  args: "query",
  values: "query",
  GET: "query",
  query_params: "query",
  form: "form",
  POST: "form",
  files: "form",
  FILES: "form",
  headers: "header",
  cookies: "header",
  COOKIES: "header",
  json: "body",
  data: "body",
};

/** `request.get_json()` / `request.json()` / `request.get_data()` — the whole body. */
const BODY_METHODS = new Set(["get_json", "json", "get_data", "body"]);

export function scanRequestAccess(body: Node | null): RouteParamInfo[] {
  if (!body) return [];
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, type: string | null, binding: RouteParamBinding) => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type, binding });
  };

  const visit = (node: Node): void => {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      if (fn?.type === "attribute") {
        const method = fn.childForFieldName("attribute")?.text ?? "";
        const target = fn.childForFieldName("object");
        // request.get_json() / await request.json()
        if (target && isRequest(target) && BODY_METHODS.has(method)) {
          add("body", null, "body");
          return;
        }
        // request.args.get("q", type=int) / request.json.get("x")
        if (method === "get" && target?.type === "attribute") {
          const member = requestMember(target);
          if (member) {
            const name = firstStringArg(args);
            if (name) add(name, keywordIdentifier(args, "type"), member);
            return;
          }
        }
      }
    } else if (node.type === "subscript") {
      // request.form["f"] / request.headers["Authorization"]
      const value = node.childForFieldName("value");
      const member = value ? requestMember(value) : null;
      if (member) {
        const key = node.namedChildren.find((c) => c !== value && c.type === "string");
        if (key) add(stripQuotes(key.text), null, member);
        return;
      }
    } else if (node.type === "attribute") {
      // A bare `request.json` / `request.data` read (not `.get`, not subscripted —
      // those were handled by the parent) means the whole body.
      const member = requestMemberName(node);
      if (member === "json" || member === "data") {
        add("body", null, "body");
        return;
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
  return out;
}

function requestMemberName(node: Node): string | null {
  const obj = node.childForFieldName("object");
  return obj && isRequest(obj) ? (node.childForFieldName("attribute")?.text ?? null) : null;
}

/** `request` or `self.request` (Django class-based views). */
function isRequest(node: Node): boolean {
  if (node.type === "identifier") return node.text === "request";
  if (node.type === "attribute") {
    return node.childForFieldName("object")?.text === "self" && node.childForFieldName("attribute")?.text === "request";
  }
  return false;
}

/** `request.args` → "query"; anything else → null. */
function requestMember(node: Node): RouteParamBinding | null {
  if (node.type !== "attribute") return null;
  const member = requestMemberName(node);
  return member ? (MEMBER_BINDINGS[member] ?? null) : null;
}

function firstStringArg(args: Node | null): string | null {
  const first = args?.namedChildren.find((c) => c.type !== "keyword_argument");
  return first?.type === "string" ? stripQuotes(first.text) : null;
}

/** `type=int` → "int". */
function keywordIdentifier(args: Node | null, name: string): string | null {
  for (const child of args?.namedChildren ?? []) {
    if (child.type !== "keyword_argument" || child.childForFieldName("name")?.text !== name) continue;
    const value = child.childForFieldName("value");
    return value?.type === "identifier" || value?.type === "attribute" ? value.text : null;
  }
  return null;
}
