import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import { extractCalls } from "../../shared/call-graph.js";
import { camelCase, graphqlFieldRoute } from "../shared/graphql-code-first.js";

/**
 * Code-first GraphQL in Python, as root fields (`POST /graphql/<field>`, see
 * `shared/graphql-code-first.ts`):
 *
 *   @strawberry.type
 *   class Query:
 *       books: list[Book] = strawberry.field(resolver=get_books)   # field books → get_books
 *       @strawberry.field(name="topBook", permission_classes=[IsAuthenticated])
 *       def top_book(self, info, min_rating: int = 0) -> Book: …   # field topBook, arg minRating
 *
 *   class Query(graphene.ObjectType):
 *       all_users = graphene.List(UserType, first=graphene.Int())  # field allUsers → Query.resolve_all_users
 *       def resolve_all_users(root, info, first=None): …
 *   class Mutation(graphene.ObjectType):
 *       create_user = CreateUser.Field()                           # field createUser → CreateUser.mutate
 *
 * A root type is a class named `Query`/`Mutation`/`Subscription` or one a
 * `strawberry.Schema(…)`/`graphene.Schema(…)` in the file names. Both
 * libraries camelCase a field's Python name unless it states `name=`; the
 * field is that name, the arguments too.
 */

const CONVENTIONAL = new Set(["Query", "Mutation", "Subscription"]);
const STRAWBERRY_FIELD = /^strawberry(?:_django)?\.(?:field|mutation|subscription)$|^(?:field|mutation|subscription)$/;
const NOT_ARGS = new Set(["self", "info", "root", "cls", "parent", "_"]);

export const PY_GRAPHQL_GATE = /\b(?:strawberry|graphene)\b/;

const strOf = (n: Node | null | undefined): string | null => (n?.type === "string" ? n.text.replace(/^[rbuf]*("""|'''|"|')|("""|'''|"|')$/g, "") : null);
const kwarg = (argList: Node | null | undefined, key: string): Node | null =>
  argList?.namedChildren.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === key)?.childForFieldName("value") ?? null;

/** Classes the file's `…Schema(query=Q, mutation=M)` names as root types. */
function schemaRoots(root: Node): Set<string> {
  const out = new Set(CONVENTIONAL);
  const visit = (n: Node): void => {
    if (n.type === "call" && /(?:^|\.)Schema$/.test(n.childForFieldName("function")?.text ?? "")) {
      for (const key of ["query", "mutation", "subscription"]) {
        const v = kwarg(n.childForFieldName("arguments"), key);
        if (v?.type === "identifier") out.add(v.text);
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** A Strawberry resolver's arguments: its parameters but `self`/`info`/`root`, camelCased. */
function resolverArgs(fn: Node): Array<{ name: string; type: string | null }> {
  const out: Array<{ name: string; type: string | null }> = [];
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    const name = p.type === "identifier" ? p.text : (p.childForFieldName("name") ?? p.namedChildren.find((c) => c.type === "identifier"))?.text;
    if (!name || NOT_ARGS.has(name) || p.type === "list_splat_pattern" || p.type === "dictionary_splat_pattern") continue;
    const type = p.childForFieldName("type")?.text ?? null;
    if (type && /\bInfo\b/.test(type)) continue;
    out.push({ name: camelCase(name), type });
  }
  return out;
}

export function extractPythonGraphqlRoutes(root: Node, routes: RouteInfo[]): void {
  const roots = schemaRoots(root);
  const visit = (n: Node): void => {
    const cls = n.type === "class_definition" ? n : n.type === "decorated_definition" && n.childForFieldName("definition")?.type === "class_definition" ? n.childForFieldName("definition")! : null;
    if (cls) {
      const name = cls.childForFieldName("name")?.text ?? "";
      const bases = cls.childForFieldName("superclasses")?.text ?? "";
      const graphene = /\bObjectType\b/.test(bases);
      const decorated = n.type === "decorated_definition" && n.namedChildren.some((d) => d.type === "decorator" && /strawberry(?:_django)?\.type\b/.test(d.text));
      if (roots.has(name) && (graphene || decorated)) readRootClass(cls, name, graphene, routes);
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
}

function readRootClass(cls: Node, className: string, graphene: boolean, routes: RouteInfo[]): void {
  const body = cls.childForFieldName("body");
  if (!body) return;
  const methods = new Map<string, Node>();
  for (const m of body.namedChildren) {
    const fn = m.type === "function_definition" ? m : m.type === "decorated_definition" ? m.childForFieldName("definition") : null;
    if (fn?.type === "function_definition") methods.set(fn.childForFieldName("name")?.text ?? "", fn);
  }
  for (const member of body.namedChildren) {
    // `x = graphene.List(…)` / `x: T = strawberry.field(resolver=fn)` / `x = CreateUser.Field()`.
    const assign = member.type === "expression_statement" ? member.namedChildren[0] : null;
    if (assign?.type === "assignment") {
      const target = assign.childForFieldName("left")?.text;
      const value = assign.childForFieldName("right");
      if (!target || value?.type !== "call") continue;
      const callee = value.childForFieldName("function")?.text ?? "";
      const argList = value.childForFieldName("arguments");
      const explicit = strOf(kwarg(argList, "name"));
      if (graphene) {
        const mutation = /^(\w+)\.Field$/.exec(callee);
        if (!mutation && !/^graphene\.\w+$/.test(callee)) continue;
        const resolver = methods.get(`resolve_${target}`);
        const args = (argList?.namedChildren ?? []).filter((a) => a.type === "keyword_argument" && /^graphene\./.test(a.childForFieldName("value")?.text ?? "")).map((a) => ({ name: camelCase(a.childForFieldName("name")!.text), type: a.childForFieldName("value")!.text.replace(/^graphene\.|\(.*$/gs, "") }));
        const handler = mutation ? `${mutation[1]}.mutate` : resolver ? `${className}.resolve_${target}` : null;
        routes.push(graphqlFieldRoute(explicit ?? camelCase(target), handler, member.startPosition.row + 1, { args, calls: resolver ? extractCalls(resolver.childForFieldName("body"), "python") : [] }));
      } else if (STRAWBERRY_FIELD.test(callee)) {
        const resolver = kwarg(argList, "resolver");
        routes.push(graphqlFieldRoute(explicit ?? camelCase(target), resolver?.type === "identifier" || resolver?.type === "attribute" ? resolver.text : null, member.startPosition.row + 1, {
          guards: permissionGuards(argList),
        }));
      }
      continue;
    }
    // `@strawberry.field def x(self, …)`.
    if (!graphene && member.type === "decorated_definition") {
      const fn = member.childForFieldName("definition");
      const dec = member.namedChildren.find((d) => d.type === "decorator" && STRAWBERRY_FIELD.test((d.namedChildren[0]?.type === "call" ? d.namedChildren[0].childForFieldName("function")?.text : d.namedChildren[0]?.text) ?? ""));
      if (fn?.type !== "function_definition" || !dec) continue;
      const call = dec.namedChildren[0]?.type === "call" ? dec.namedChildren[0] : null;
      const method = fn.childForFieldName("name")!.text;
      routes.push(graphqlFieldRoute(strOf(kwarg(call?.childForFieldName("arguments"), "name")) ?? camelCase(method), `${className}.${method}`, member.startPosition.row + 1, {
        args: resolverArgs(fn),
        calls: extractCalls(fn.childForFieldName("body"), "python"),
        guards: permissionGuards(call?.childForFieldName("arguments")),
      }));
    }
  }
}

/** `permission_classes=[IsAuthenticated, IsAdmin]` → one guard per class. */
function permissionGuards(argList: Node | null | undefined): Array<{ text: string; policies: string[] }> {
  const list = kwarg(argList, "permission_classes");
  return (list?.namedChildren ?? []).map((c) => ({ text: c.text, policies: [c.text] }));
}
