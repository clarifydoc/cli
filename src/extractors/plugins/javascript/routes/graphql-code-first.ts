import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { graphqlFieldRoute, type RootType } from "../../shared/graphql-code-first.js";

/**
 * Code-first GraphQL schemas in JS/TS, as the root fields they serve
 * (`POST /graphql/<field>`, see `shared/graphql-code-first.ts`):
 *
 *   @Resolver(() => User) class UserResolver {            // NestJS, TypeGraphQL
 *     @Query(() => [User], { name: "users" }) all(@Args("first") first: number) { … }
 *     @Mutation(() => User) createUser(@Args("input") input: NewUser) { … }
 *   }
 *   builder.queryField("me", (t) => t.field({ … }))         // Pothos
 *   builder.mutationFields((t) => ({ signUp: t.field({ … }) }))
 *   builder.queryType({ fields: (t) => ({ hello: t.string({ … }) }) })
 *   queryType({ definition(t) { t.list.field("users", { … }) } })   // Nexus
 *   extendType({ type: "Mutation", definition(t) { t.field("x", …) } })
 *   new GraphQLObjectType({ name: "Query", fields: { user: { type, resolve } } })  // graphql-js
 *
 * A decorated method is its field's handler (`UserResolver.all`), its
 * `@Args("x")`/`@Arg("x")` parameters the field's arguments (a typed input
 * keeps its type, for the request schema), `@UseGuards`/`@Authorized` its
 * guards. A builder's field carries the calls of its definition (its
 * `resolve`). Each form runs only in a file importing its library.
 */

/** The calls of a field definition, its nested `resolve` functions included (`extractCalls` stops at a closure). */
function deepCalls(node: Node): RouteInfo["calls"] {
  const out: RouteInfo["calls"] = [...extractCalls(node, "typescript")];
  const seen = new Set(out.map((c) => `${c.name}@${c.line}`));
  const visit = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (c.type === "arrow_function" || c.type === "function_expression" || c.type === "method_definition") {
        for (const call of extractCalls(c, "typescript")) {
          const key = `${call.name}@${call.line}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(call);
          }
        }
      }
      visit(c);
    }
  };
  visit(node);
  return out;
}

const ROOT_DECORATORS: Record<string, RootType> = { Query: "Query", Mutation: "Mutation", Subscription: "Subscription" };
const POTHOS: Record<string, RootType> = { queryField: "Query", queryFields: "Query", queryType: "Query", mutationField: "Mutation", mutationFields: "Mutation", mutationType: "Mutation", subscriptionField: "Subscription", subscriptionFields: "Subscription", subscriptionType: "Subscription" };
const NEXUS: Record<string, RootType> = { queryType: "Query", mutationType: "Mutation", subscriptionType: "Subscription", queryField: "Query", mutationField: "Mutation", subscriptionField: "Subscription" };

export function mayDefineGraphqlCode(sourceText: string): boolean {
  return /from\s+['"](?:@nestjs\/graphql|type-graphql|@pothos\/core|nexus|graphql)['"]|require\(\s*['"](?:graphql|nexus)['"]\s*\)/.test(sourceText);
}

const keyName = (k: Node | null): string | null => (k ? (k.type === "string" ? stripQuotes(k.text) : k.type === "property_identifier" || k.type === "identifier" ? k.text : null) : null);
const calleeOf = (call: Node): { recv: string | null; name: string } | null => {
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") return { recv: null, name: fn.text };
  if (fn?.type === "member_expression") return { recv: fn.childForFieldName("object")?.text ?? null, name: fn.childForFieldName("property")?.text ?? "" };
  return null;
};
const args = (call: Node): Node[] => call.childForFieldName("arguments")?.namedChildren ?? [];
const objectOf = (n: Node | undefined): Node | null => {
  let cur: Node | null | undefined = n;
  if (cur?.type === "arrow_function" || cur?.type === "function_expression") cur = cur.childForFieldName("body");
  while (cur?.type === "parenthesized_expression") cur = cur.namedChildren[0];
  return cur?.type === "object" ? cur : null;
};

/** NestJS / TypeGraphQL: `@Query()` methods of a class. */
function decoratedResolvers(classBody: Node, className: string, routes: RouteInfo[]): void {
  let pending: Node[] = [];
  for (const member of classBody.namedChildren) {
    if (member.type === "decorator") {
      pending.push(member);
      continue;
    }
    if (member.type !== "method_definition") {
      pending = [];
      continue;
    }
    const decorators = pending;
    pending = [];
    let root: RootType | null = null;
    let fieldName: string | null = null;
    const guards: Array<{ text: string; policies?: string[] }> = [];
    for (const d of decorators) {
      const call = d.namedChildren[0]?.type === "call_expression" ? d.namedChildren[0] : null;
      const name = call ? calleeOf(call)?.name : d.namedChildren[0]?.text;
      if (name && ROOT_DECORATORS[name]) {
        root = ROOT_DECORATORS[name]!;
        const opts = call ? args(call).find((a) => a.type === "object") : undefined;
        for (const p of opts?.namedChildren ?? []) if (p.type === "pair" && keyName(p.childForFieldName("key")) === "name" && p.childForFieldName("value")?.type === "string") fieldName = stripQuotes(p.childForFieldName("value")!.text);
      } else if (name === "UseGuards" || name === "Authorized" || name === "Roles") {
        guards.push({ text: d.text.replace(/^@/, ""), policies: [d.text.replace(/^@/, "")] });
      }
    }
    if (!root) continue;
    const method = member.childForFieldName("name")?.text;
    if (!method) continue;
    const params: Array<{ name: string; type: string | null }> = [];
    for (const p of member.childForFieldName("parameters")?.namedChildren ?? []) {
      const dec = p.namedChildren.find((c) => c.type === "decorator");
      const call = dec?.namedChildren[0]?.type === "call_expression" ? dec.namedChildren[0] : null;
      const dname = call ? calleeOf(call)?.name : null;
      if (dname !== "Args" && dname !== "Arg") continue;
      const explicit = call ? args(call).find((a) => a.type === "string") : undefined;
      const ident = p.childForFieldName("pattern") ?? p.namedChildren.find((c) => c.type === "identifier");
      const type = p.childForFieldName("type")?.namedChildren[0]?.text ?? null;
      params.push({ name: explicit ? stripQuotes(explicit.text) : ident?.text ?? "args", type });
    }
    routes.push(graphqlFieldRoute(fieldName ?? method, `${className}.${method}`, member.startPosition.row + 1, { args: params, guards }));
  }
}

/** The fields of a `(t) => ({ a: t.field(…), b: … })` object, each with the calls of its definition. */
function objectFields(obj: Node, routes: RouteInfo[]): void {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const name = keyName(pair.childForFieldName("key"));
    const value = pair.childForFieldName("value");
    if (name && value) routes.push(graphqlFieldRoute(name, null, pair.startPosition.row + 1, { calls: deepCalls(value) }));
  }
}

/** Nexus `definition(t) { t.list.field("users", …) }`: each call on `t` naming a field. */
function nexusDefinition(body: Node, t: string, routes: RouteInfo[]): void {
  const visit = (n: Node): void => {
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const first = args(n)[0];
      if (fn?.type === "member_expression" && fn.text.split(".")[0] === t && first?.type === "string") {
        routes.push(graphqlFieldRoute(stripQuotes(first.text), null, n.startPosition.row + 1, { calls: args(n)[1] ? deepCalls(args(n)[1]!) : [] }));
        return;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
}

export function extractGraphqlCodeFirst(root: Node, sourceText: string, routes: RouteInfo[]): void {
  const decorators = /@nestjs\/graphql|type-graphql/.test(sourceText);
  const pothos = /@pothos\/core/.test(sourceText);
  const nexus = /['"]nexus['"]/.test(sourceText);
  const graphqlJs = /\bGraphQLObjectType\b/.test(sourceText);
  const visit = (n: Node): void => {
    if (decorators && n.type === "class_declaration") {
      const body = n.childForFieldName("body");
      const name = n.childForFieldName("name")?.text;
      if (body && name) decoratedResolvers(body, name, routes);
    }
    if (n.type === "call_expression") {
      const callee = calleeOf(n);
      const a = args(n);
      if (pothos && callee?.recv && POTHOS[callee.name]) {
        // `builder.queryField("me", …)`, `builder.queryFields((t) => ({ … }))`, `builder.queryType({ fields: (t) => ({ … }) })`.
        if (a[0]?.type === "string") routes.push(graphqlFieldRoute(stripQuotes(a[0].text), null, n.startPosition.row + 1, { calls: a[1] ? deepCalls(a[1]) : [] }));
        else {
          const direct = objectOf(a[0]);
          const viaFields = a[0]?.type === "object" ? a[0].namedChildren.find((p) => p.type === "pair" && keyName(p.childForFieldName("key")) === "fields")?.childForFieldName("value") : undefined;
          const obj = callee.name.endsWith("Type") ? objectOf(viaFields ?? undefined) : direct;
          if (obj) objectFields(obj, routes);
        }
        return;
      }
      if (nexus && !callee?.recv && (NEXUS[callee?.name ?? ""] || callee?.name === "extendType")) {
        if ((callee!.name === "queryField" || callee!.name === "mutationField" || callee!.name === "subscriptionField") && a[0]?.type === "string") {
          routes.push(graphqlFieldRoute(stripQuotes(a[0].text), null, n.startPosition.row + 1, { calls: a[1] ? deepCalls(a[1]) : [] }));
          return;
        }
        const config = a[0]?.type === "object" ? a[0] : null;
        const typePair = config?.namedChildren.find((p) => p.type === "pair" && keyName(p.childForFieldName("key")) === "type");
        const extended = typePair?.childForFieldName("value")?.type === "string" ? stripQuotes(typePair.childForFieldName("value")!.text) : null;
        if (callee!.name !== "extendType" || (extended && /^(?:Query|Mutation|Subscription)$/.test(extended))) {
          const def = config?.namedChildren.find((p) => (p.type === "method_definition" && p.childForFieldName("name")?.text === "definition") || (p.type === "pair" && keyName(p.childForFieldName("key")) === "definition"));
          const fn = def?.type === "pair" ? def.childForFieldName("value") : def;
          const t = fn?.childForFieldName("parameters")?.namedChildren[0]?.text.split(":")[0]!.trim() ?? "t";
          const body = fn?.childForFieldName("body");
          if (body) nexusDefinition(body, t, routes);
        }
        return;
      }
    }
    if (graphqlJs && n.type === "new_expression" && n.childForFieldName("constructor")?.text === "GraphQLObjectType") {
      // `new GraphQLObjectType({ name: "Query", fields: { … } | () => ({ … }) })`.
      const config = n.childForFieldName("arguments")?.namedChildren[0];
      const pairs = config?.type === "object" ? config.namedChildren.filter((p) => p.type === "pair") : [];
      const name = pairs.find((p) => keyName(p.childForFieldName("key")) === "name")?.childForFieldName("value");
      const fields = objectOf(pairs.find((p) => keyName(p.childForFieldName("key")) === "fields")?.childForFieldName("value") ?? undefined);
      if (name?.type === "string" && /^(?:Query|Mutation|Subscription)$/.test(stripQuotes(name.text)) && fields) objectFields(fields, routes);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
}
