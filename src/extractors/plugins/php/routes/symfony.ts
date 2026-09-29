import type { Node } from "web-tree-sitter";
import type { ParamInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { applyRouteMeta, boundParam, inferredParam, pathParamNames, type GuardAttr } from "../../../shared/route-metadata.js";
import { extractPhpRequestAccess, isServiceType, requestReceivers } from "../request-access.js";

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
 *
 * Guards: `#[IsGranted('ROLE_X')]` on the class is inherited by every action,
 * on the method it is the action's own; a `ROLE_`-prefixed subject is a role,
 * any other subject (`'view'`, an `Expression`) and `#[Security("…")]` are
 * policies. Parameters: the Symfony 6.3+ mapping attributes
 * (`#[MapRequestPayload]` → body, `#[MapQueryString]`/`#[MapQueryParameter]`
 * → query, `#[MapEntity]` → route, `#[CurrentUser]` → services), injected
 * types (`Request`, `UserInterface`, …) → services, a name the path declares
 * → route (the ParamConverter / entity-value-resolver rule), else unknown.
 * Fields the body reads through the request bags (`$request->query->get('q')`)
 * are appended as inferred params.
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

/** A single named argument's string value (`name: 'q'`), null if absent or not a string. */
function namedArgString(attr: Node, label: string): string | null {
  const args = findChildByType(attr, "arguments");
  if (!args) return null;
  for (const arg of args.children) {
    if (arg.type !== "argument") continue;
    if (arg.childForFieldName("name")?.text !== label) continue;
    const s = arg.children.find((c) => c.type === "string" || c.type === "encapsed_string");
    return s ? unquote(s) : null;
  }
  return null;
}

/** Every string literal anywhere under the attribute's arguments, in order. */
function allStrings(attr: Node): string[] {
  const args = findChildByType(attr, "arguments");
  if (!args) return [];
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === "string" || n.type === "encapsed_string") {
      out.push(unquote(n));
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(args);
  return out;
}

function attributeText(attr: Node): string {
  return attr.text.replace(/^\\/, "").replace(/\s+/g, " ");
}

// ─── Guards: #[IsGranted] / #[Security] ─────────────────────────────────────

/**
 * A security attribute as a guard, or null for anything else.
 *   #[IsGranted('ROLE_ADMIN')]                          → role
 *   #[IsGranted('view', 'post')] / IsGranted(new Expression("…")) → policy
 *   #[Security("is_granted('ROLE_ADMIN')")]             → policy (the expression)
 */
function guardOf(attr: Node): GuardAttr | null {
  const name = attributeName(attr);
  const text = attributeText(attr);
  if (name === "IsGranted") {
    const strings = allStrings(attr);
    const subject = strings[0] ?? null;
    const isExpression = /\bExpression\b/.test(attr.text);
    if (subject && /^ROLE_/.test(subject) && !isExpression) return { text, roles: [subject] };
    // `new Expression("is_granted('ROLE_A') or …")` — the expression is the
    // policy; a voter attribute with its subject (`'view', 'post'`) reads as
    // `view,post`, the same shape as Laravel's `can:view,post`.
    const policy = isExpression && subject ? subject : strings.join(",");
    return { text, policies: [policy || text] };
  }
  if (name === "Security") {
    const expr = positionalString(attr) ?? allStrings(attr)[0] ?? null;
    return { text, policies: expr ? [expr] : [text] };
  }
  return null;
}

function guardsOn(decl: Node): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const attr of attributesOf(decl)) {
    const g = guardOf(attr);
    if (g) out.push(g);
  }
  return out;
}

// ─── Parameters ─────────────────────────────────────────────────────────────

/** Symfony's argument-mapping attributes (6.3+). */
const BINDING_ATTRIBUTES: Record<string, RouteParamBinding> = {
  MapRequestPayload: "body",
  MapQueryString: "query",
  MapQueryParameter: "query",
  MapEntity: "route",
  MapUploadedFile: "form",
  MapRequestHeader: "header",
  CurrentUser: "services",
  Autowire: "services",
  ValueResolver: "services",
};

function parametersOf(method: Node): Array<ParamInfo & { attrs: Node[] }> {
  const out: Array<ParamInfo & { attrs: Node[] }> = [];
  const list = method.childForFieldName("parameters") ?? findChildByType(method, "formal_parameters");
  for (const p of list?.children ?? []) {
    if (p.type !== "simple_parameter" && p.type !== "variadic_parameter" && p.type !== "property_promotion_parameter") continue;
    const varNode = findChildByType(p, "variable_name");
    const name = varNode?.text.replace(/^\$/, "");
    if (!name) continue;
    const typeNode = p.children.find((c) => /_type$/.test(c.type));
    const type = typeNode ? typeNode.text.replace(/^\?/, "").replace(/^\\/, "").replace(/.*\\/, "").trim() : null;
    out.push({ name, type, defaultValue: p.childForFieldName("default_value")?.text ?? null, attrs: attributesOf(p) });
  }
  return out;
}

/**
 * The action's parameters with their bindings: a mapping attribute is
 * explicit; otherwise the path-token rule, then the injected-type rule, then
 * nothing. `#[MapQueryParameter(name: 'q')]` renames the wire field.
 */
/** A user class (not a scalar, not `array`/`mixed`), as the entity value resolver would load. */
function isEntityLike(type: string | null): boolean {
  return !!type && /^[A-Z]/.test(type) && !/^(Request|Response|DateTime\w*|Carbon\w*|Uuid\w*|Closure|Stringable)$/.test(type);
}

function routeParams(method: Node, path: string, body: Node | null): RouteParamInfo[] {
  const params = parametersOf(method);
  const out: RouteParamInfo[] = [];
  for (const p of params) {
    let bound: RouteParamInfo | null = null;
    for (const attr of p.attrs) {
      const binding = BINDING_ATTRIBUTES[attributeName(attr) ?? ""];
      if (!binding) continue;
      const wire = namedArgString(attr, "name") ?? positionalString(attr) ?? p.name;
      bound = boundParam(wire || p.name, p.type, binding);
      break;
    }
    if (!bound) {
      // No mapping attribute: the path-token rule, then injected types, then
      // the entity value resolver — a class-typed argument on a route with
      // path parameters is loaded by them (`show(User $user)` on `/{id}`).
      const fallback: RouteParamBinding | null = isServiceType(p.type)
        ? "services"
        : isEntityLike(p.type) && pathParamNames(path).size > 0 ? "route" : null;
      bound = inferredParam(p.name, p.type, path, fallback);
    }
    out.push(bound);
  }
  if (body) {
    const seen = new Set(out.map((p) => `${p.binding}:${p.name}`));
    for (const acc of extractPhpRequestAccess(body.text, requestReceivers(params))) {
      const key = `${acc.binding}:${acc.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...acc, inferred: true });
    }
  }
  return out;
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
      const inherited = guardsOn(node);
      const body = node.childForFieldName("body") ?? findChildByType(node, "declaration_list");
      if (body) {
        for (const member of body.children) {
          if (member.type === "method_declaration") emitMethodRoutes(member, prefix, inherited, routes);
        }
      }
      return; // class handled; no nested classes in PHP
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
}

function emitMethodRoutes(method: Node, prefix: string, inheritedGuards: GuardAttr[], routes: RouteInfo[]): void {
  const handler = method.childForFieldName("name")?.text ?? null;
  const body = method.childForFieldName("body");
  const calls = body ? extractCalls(body, "php") : [];
  const guards = guardsOn(method);
  const emit = (r: RouteInfo): void => {
    routes.push(applyRouteMeta(r, { inheritedGuards, guards, params: routeParams(method, r.path, body) }));
  };

  for (const attr of attributesOf(method)) {
    const name = attributeName(attr);
    if (!name) continue;

    if (name === "Route") {
      const path = joinPath(prefix, positionalString(attr) ?? "");
      const methods = namedArgStrings(attr, "methods").map((m) => m.toUpperCase());
      for (const m of methods.length > 0 ? methods : [null]) {
        emit({
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
      emit({
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
