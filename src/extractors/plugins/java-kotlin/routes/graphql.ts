import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { annotationName, annotationNodes, annotationValues } from "../di-annotations.js";
import { graphqlFieldRoute } from "../../shared/graphql-code-first.js";

/**
 * GraphQL controllers on the JVM, as the root fields they serve
 * (`POST /graphql/<field>`, see `shared/graphql-code-first.ts`):
 *
 *   @QueryMapping Book bookById(@Argument String id)                 // Spring for GraphQL
 *   @MutationMapping(name = "addBook") Book add(@Argument BookInput input)
 *   @SchemaMapping(typeName = "Query", field = "authors") …
 *   @DgsQuery(field = "shows") List<Show> shows(@InputArgument String titleFilter)   // Netflix DGS
 *   @DgsData(parentType = "Mutation", field = "addShow") …
 *
 * Spring and DGS are schema-first: the `.graphqls` beside the code gives the
 * same rows, which pair with these as a contract and its implementing code.
 * `@Argument`/`@InputArgument` parameters are the field's arguments (a typed
 * input keeps its type); `@PreAuthorize`/`@Secured`/`@RolesAllowed` its guards.
 */

const ROOT_MAPPINGS: Record<string, string> = {
  QueryMapping: "Query", MutationMapping: "Mutation", SubscriptionMapping: "Subscription",
  DgsQuery: "Query", DgsMutation: "Mutation", DgsSubscription: "Subscription",
};
const GUARDS = new Set(["PreAuthorize", "Secured", "RolesAllowed", "PermitAll"]);
export const GRAPHQL_GATE_RE = /@(?:QueryMapping|MutationMapping|SubscriptionMapping|SchemaMapping|DgsQuery|DgsMutation|DgsSubscription|DgsData)\b/;

const nameOf = (decl: Node): string | null =>
  decl.childForFieldName("name")?.text ?? decl.namedChildren.find((c) => c.type === "simple_identifier" || c.type === "type_identifier")?.text ?? null;

function rootField(anns: readonly Node[], method: string): { field: string; guards: string[] } | null {
  let field: string | null = null;
  const guards: string[] = [];
  for (const ann of anns) {
    const name = annotationName(ann) ?? "";
    if (ROOT_MAPPINGS[name]) {
      field = (annotationValues(ann, name.startsWith("Dgs") ? ["field", "value"] : ["name", "value"], !name.startsWith("Dgs")) ?? annotationValues(ann, ["field", "name", "value"]))?.[0] ?? method;
    } else if (name === "SchemaMapping" || name === "BatchMapping" || name === "DgsData") {
      const parent = annotationValues(ann, name === "DgsData" ? ["parentType"] : ["typeName"], false)?.[0];
      if (parent && /^(?:Query|Mutation|Subscription)$/.test(parent)) field = annotationValues(ann, ["field", "value"], false)?.[0] ?? method;
    } else if (GUARDS.has(name)) {
      guards.push(ann.text.replace(/^@/, ""));
    }
  }
  return field ? { field, guards } : null;
}

/** `@Argument String id` / `@InputArgument("filter") ShowFilter f`: the field's arguments. */
function fieldArgs(decl: Node): Array<{ name: string; type: string | null }> {
  const params = decl.childForFieldName("parameters") ?? decl.namedChildren.find((c) => c.type === "function_value_parameters");
  const out: Array<{ name: string; type: string | null }> = [];
  for (const p of params?.namedChildren ?? []) {
    if (p.type !== "formal_parameter" && p.type !== "parameter") continue;
    const ann = annotationNodes(p).find((a) => /^(?:Argument|InputArgument|Arguments)$/.test(annotationName(a) ?? ""));
    if (!ann) continue;
    const pname = p.childForFieldName("name")?.text ?? p.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? "arg";
    const type = p.childForFieldName("type")?.text ?? p.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text ?? null;
    out.push({ name: annotationValues(ann, ["name", "value"])?.[0] ?? pname, type });
  }
  return out;
}

export function extractJvmGraphqlRoutes(root: Node, routes: RouteInfo[]): void {
  const language = root.type === "source_file" ? "kotlin" : "java";
  const visit = (n: Node, cls: string | null): void => {
    if (n.type === "class_declaration" || n.type === "object_declaration") {
      const name = nameOf(n);
      for (const c of n.namedChildren) visit(c, name ?? cls);
      return;
    }
    if ((n.type === "method_declaration" || n.type === "function_declaration") && cls) {
      const method = nameOf(n);
      const root = method ? rootField(annotationNodes(n), method) : null;
      if (method && root) {
        const body = n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "function_body") ?? null;
        routes.push(graphqlFieldRoute(root.field, `${cls}.${method}`, n.startPosition.row + 1, {
          args: fieldArgs(n),
          calls: body ? extractCalls(body, language) : [],
          guards: root.guards.map((g) => ({ text: g, policies: [g] })),
        }));
      }
      return;
    }
    for (const c of n.namedChildren) visit(c, cls);
  };
  visit(root, null);
}
