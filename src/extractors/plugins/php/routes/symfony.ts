import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { findChildByType } from "../../../shared/node-helpers.js";

/**
 * Symfony PHP-8 attribute routing:
 *
 *   #[Route('/api/users', name: 'users_')]          // class-level prefix
 *   class UserController {
 *     #[Route('', name: 'list', methods: ['GET'])]  // one route per method verb
 *     public function list(): JsonResponse { ... }
 *   }
 *
 * The old regex-path spec understood these, but PHP parses via tree-sitter so
 * that code path is dormant — Symfony apps produced zero attribute routes.
 * Verb-named attributes (`#[Get('/x')]` — API Platform / Laminas style) are
 * also honored. A `methods:`-less Route dispatches every verb (httpMethod
 * null, the linker's wildcard).
 */

const VERB_ATTRIBUTES: ReadonlySet<string> = new Set([
  "Get", "Post", "Put", "Patch", "Delete", "Options", "Head",
]);

/** All `attribute` nodes on a declaration (attribute_list > attribute_group > attribute). */
function attributesOf(decl: Node): Node[] {
  const out: Node[] = [];
  for (const child of decl.children) {
    if (child.type !== "attribute_list") continue;
    for (const group of child.children) {
      if (group.type !== "attribute_group") continue;
      for (const attr of group.children) {
        if (attr.type === "attribute") out.push(attr);
      }
    }
  }
  return out;
}

/** Attribute's simple name (`Route`, possibly namespace-qualified). */
function attributeName(attr: Node): string | null {
  const name = attr.child(0);
  if (!name) return null;
  return name.text.split("\\").pop() ?? null;
}

function unquote(node: Node): string {
  return node.text.replace(/^['"]|['"]$/g, "");
}

/** First positional (label-less) string argument. May legitimately be "". */
function positionalString(attr: Node): string | null {
  const args = findChildByType(attr, "arguments");
  if (!args) return null;
  for (const arg of args.children) {
    if (arg.type !== "argument") continue;
    if (arg.childForFieldName("name")) return null; // named args from here on
    const s = arg.children.find((c) => c.type === "string" || c.type === "encapsed_string");
    return s ? unquote(s) : null;
  }
  return null;
}

/** String elements of a named argument's array value (`methods: ['GET', 'POST']`). */
function namedArgStrings(attr: Node, label: string): string[] {
  const args = findChildByType(attr, "arguments");
  if (!args) return [];
  for (const arg of args.children) {
    if (arg.type !== "argument") continue;
    if (arg.childForFieldName("name")?.text !== label) continue;
    const out: string[] = [];
    const collect = (n: Node): void => {
      if (n.type === "string" || n.type === "encapsed_string") out.push(unquote(n));
      for (const c of n.children) collect(c);
    };
    for (const c of arg.children) {
      if (c.type === "array_creation_expression") collect(c);
      else if (c.type === "string" || c.type === "encapsed_string") out.push(unquote(c));
    }
    return out;
  }
  return [];
}

function joinPath(prefix: string, path: string): string {
  const parts = (prefix + "/" + path).split("/").filter(Boolean);
  return "/" + parts.join("/");
}

export function extractSymfonyAttributeRoutes(root: Node, routes: RouteInfo[]): void {
  const visit = (node: Node): void => {
    if (node.type === "class_declaration") {
      let prefix = "";
      for (const attr of attributesOf(node)) {
        if (attributeName(attr) === "Route") prefix = positionalString(attr) ?? "";
      }
      const body = node.childForFieldName("body") ?? findChildByType(node, "declaration_list");
      if (body) {
        for (const member of body.children) {
          if (member.type === "method_declaration") emitMethodRoutes(member, prefix, routes);
        }
      }
      return; // class handled; no nested classes in PHP
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
}

function emitMethodRoutes(method: Node, prefix: string, routes: RouteInfo[]): void {
  const handler = method.childForFieldName("name")?.text ?? null;
  const body = method.childForFieldName("body");
  const calls = body ? extractCalls(body, "php") : [];

  for (const attr of attributesOf(method)) {
    const name = attributeName(attr);
    if (!name) continue;

    if (name === "Route") {
      const path = joinPath(prefix, positionalString(attr) ?? "");
      const methods = namedArgStrings(attr, "methods").map((m) => m.toUpperCase());
      for (const m of methods.length > 0 ? methods : [null]) {
        routes.push({
          path,
          httpMethod: m,
          kind: "api",
          handler,
          calls,
          middleware: [],
          line: attr.startPosition.row + 1,
        });
      }
    } else if (VERB_ATTRIBUTES.has(name)) {
      const path = positionalString(attr);
      if (path === null) continue;
      routes.push({
        path: joinPath(prefix, path),
        httpMethod: name.toUpperCase(),
        kind: "api",
        handler,
        calls,
        middleware: [],
        line: attr.startPosition.row + 1,
      });
    }
  }
}
