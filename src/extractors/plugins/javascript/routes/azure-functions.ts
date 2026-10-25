import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { collectCallNames } from "../../../routes/base.js";
import { azureFunctionPath, azureMethods } from "../../shared/azure-functions.js";
import { handlerParamNames, inlineHandlerParams } from "./express.js";
import { responsesOf } from "../responses.js";

/**
 * Azure Functions v4 programming model: `app.http("getCar", { methods: ["GET"], route: "cars/{id}",
 * authLevel: "anonymous", handler })`. The route defaults to the function's name and the methods to
 * any; host.json's route prefix is the project's route base (see plugins/shared/azure-functions.ts).
 */

export function mayDeclareAzureFunctions(sourceText: string): boolean {
  return sourceText.includes("@azure/functions") && sourceText.includes(".http(");
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function"]);

export function visitAzureFunction(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "call_expression") return;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "http") return;
  const [nameNode, options] = node.childForFieldName("arguments")?.namedChildren ?? [];
  if (nameNode?.type !== "string" || options?.type !== "object") return;
  const pairs = new Map<string, Node>();
  for (const pair of options.namedChildren) {
    const key = pair.type === "pair" ? pair.childForFieldName("key") : null;
    const value = pair.type === "pair" ? pair.childForFieldName("value") : null;
    if (key && value) pairs.set(stripQuotes(key.text), value);
  }
  const handlerNode = pairs.get("handler");
  if (!handlerNode) return;
  const name = stripQuotes(nameNode.text);
  const routeNode = pairs.get("route");
  const route = routeNode?.type === "string" ? stripQuotes(routeNode.text) : null;
  if (routeNode && route === null) return;
  const methodsNode = pairs.get("methods");
  const verbs = methodsNode?.type === "array" ? methodsNode.namedChildren.filter((n) => n.type === "string").map((n) => stripQuotes(n.text)) : [];
  const methods = verbs.length > 0 ? azureMethods(verbs) : ["ALL"];
  const path = azureFunctionPath(route, name);
  const inline = FUNCTION_TYPES.has(handlerNode.type);
  const handler = inline ? null : handlerNode.type === "identifier" || handlerNode.type === "member_expression" ? handlerNode.text : null;
  if (!inline && !handler) return;
  const level = pairs.get("authLevel");
  const levelText = level?.type === "string" ? stripQuotes(level.text) : null;
  for (const method of methods) {
    const row: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler,
      calls: inline ? collectCallNames(handlerNode) : [],
      middleware: levelText ? [`authLevel: ${levelText}`] : [],
      line: node.startPosition.row + 1,
      name,
    };
    if (inline) {
      const params = inlineHandlerParams(path, handlerNode, []);
      if (params.length > 0) row.params = params;
      const responses = responsesOf(handlerParamNames(handlerNode), handlerNode.childForFieldName("body"));
      if (responses) row.responses = responses;
    }
    if (levelText) {
      row.auth = levelText === "anonymous"
        ? { policies: [], roles: [], schemes: [], anonymous: true, inherited: false }
        : { policies: [], roles: [], schemes: [`function-key:${levelText}`], anonymous: false, inherited: false };
    }
    routes.push(row);
  }
}
