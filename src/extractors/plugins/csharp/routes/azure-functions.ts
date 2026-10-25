import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { azureFunctionPath, azureMethods } from "../../shared/azure-functions.js";

/**
 * Azure Functions HTTP triggers, isolated worker (`[Function("GetKit")]`) and in-process
 * (`[FunctionName("GetKit")]`):
 *
 *     [Function("GetKit")]
 *     public Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Function, "get", Route = "kits/{id}")] HttpRequestData req, string id)
 *
 * The route is `Route`, else the function's name; the methods are the string arguments, else any.
 * The host's `routePrefix` (`api` unless host.json says otherwise) is the project's route base,
 * put in front by core from the plugin's `routeBaseOf`.
 */

export const AZURE_FUNCTIONS_GATE = /\bHttpTrigger\b/;

function attributes(node: Node): Node[] {
  return node.namedChildren.filter((c) => c.type === "attribute_list").flatMap((l) => l.namedChildren.filter((a) => a.type === "attribute"));
}

function attributeName(attr: Node): string {
  const name = attr.childForFieldName("name") ?? attr.namedChildren[0];
  return (name?.text ?? "").replace(/^.*\./, "").replace(/Attribute$/, "");
}

/** `"x"` / `@"x"` → x; anything else → null. */
function stringOf(node: Node | undefined): string | null {
  if (!node || (node.type !== "string_literal" && node.type !== "verbatim_string_literal")) return null;
  return node.text.replace(/^@?"|"$/g, "");
}

/** An attribute's arguments: positional values and `Name = value` pairs. */
function argumentsOf(attr: Node): { positional: Node[]; named: Map<string, Node> } {
  const positional: Node[] = [];
  const named = new Map<string, Node>();
  const list = attr.namedChildren.find((c) => c.type === "attribute_argument_list");
  for (const arg of list?.namedChildren ?? []) {
    if (arg.type !== "attribute_argument") continue;
    const kids = arg.namedChildren;
    if (kids.length === 2 && kids[0]!.type === "identifier") named.set(kids[0]!.text, kids[1]!);
    else if (kids[0]) positional.push(kids[0]);
  }
  return { positional, named };
}

export function extractAzureFunctionRoutes(root: Node, routes: RouteInfo[]): void {
  const walk = (node: Node, className: string | null): void => {
    if (node.type === "class_declaration") className = node.childForFieldName("name")?.text ?? className;
    if (node.type === "method_declaration") {
      const fnAttr = attributes(node).find((a) => /^(?:Function|FunctionName)$/.test(attributeName(a)));
      const functionName = fnAttr ? stringOf(argumentsOf(fnAttr).positional[0]) : null;
      const params = node.childForFieldName("parameters")?.namedChildren ?? [];
      const trigger = params.flatMap((p) => attributes(p)).find((a) => attributeName(a) === "HttpTrigger");
      const methodName = node.childForFieldName("name")?.text ?? null;
      if (trigger && functionName && methodName) {
        const { positional, named } = argumentsOf(trigger);
        const level = positional.find((p) => /AuthorizationLevel\.\w+$/.test(p.text))?.text.replace(/^.*\./, "");
        const verbs = positional.map((p) => stringOf(p)).filter((s): s is string => s !== null);
        const methods = verbs.length > 0 ? azureMethods(verbs) : ["ALL"];
        const path = azureFunctionPath(stringOf(named.get("Route")), functionName);
        for (const method of methods) {
          const route: RouteInfo = {
            path,
            httpMethod: method,
            kind: "api",
            handler: methodName,
            calls: [],
            middleware: level ? [`AuthorizationLevel.${level}`] : [],
            line: node.startPosition.row + 1,
            name: functionName,
          };
          if (className) route.owner = className;
          if (level) {
            route.auth = level === "Anonymous"
              ? { policies: [], roles: [], schemes: [], anonymous: true, inherited: false }
              : { policies: [], roles: [], schemes: [`function-key:${level.toLowerCase()}`], anonymous: false, inherited: false };
          }
          routes.push(route);
        }
      }
    }
    for (const child of node.namedChildren) walk(child, className);
  };
  walk(root, null);
}
