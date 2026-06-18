import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import type { RouteExtractor } from "../../../routes/base.js";

/**
 * ASP.NET attribute routing.
 *
 * A controller's full route is the **class-level** template merged with the
 * **method-level** template, with the `[controller]`/`[action]` tokens resolved
 * and route constraints stripped:
 *
 *   [Route("api/[controller]")]      class AccessReportController
 *     [HttpGet("roles/{roleId:guid}/holders")] GetRoleHolders
 *   ->  GET /api/AccessReport/roles/{roleId}/holders
 *
 * Earlier this extractor walked only `method_declaration` and read the path via
 * `attr.childForFieldName("arguments")` — but tree-sitter-c-sharp exposes the
 * argument list as a plain `attribute_argument_list` child, not an `arguments`
 * field, so the lookup always returned null and *every* route collapsed to "/".
 * It also never combined the class prefix, so the endpoint path was unusable
 * for the frontend→API join. Both are fixed here.
 */

const CSHARP_HTTP_ATTRIBUTES: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpPatch: "PATCH",
  HttpDelete: "DELETE",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};

/** C#: [HttpGet("path")] / [Route("path")] with class-level prefix merging. */
export function extractAspnetRoutes(root: Node, routes: RouteInfo[]): void {
  walkForCsharpRoutes(root, routes, null, null);
}

function walkForCsharpRoutes(
  node: Node,
  routes: RouteInfo[],
  classPrefix: string | null,
  controllerName: string | null,
) {
  if (node.type === "class_declaration") {
    const name = node.childForFieldName("name")?.text ?? null;
    // ASP.NET strips the conventional "Controller" suffix for the [controller] token.
    const resolvedController = name ? name.replace(/Controller$/, "") : controllerName;
    const prefix = classRoutePrefix(node) ?? classPrefix;
    for (const child of node.children) {
      walkForCsharpRoutes(child, routes, prefix, resolvedController);
    }
    return;
  }

  if (node.type === "method_declaration") {
    parseMethodRoutes(node, routes, classPrefix, controllerName);
    return;
  }

  for (const child of node.children) {
    walkForCsharpRoutes(child, routes, classPrefix, controllerName);
  }
}

/** First `[Route("…")]` template on a class declaration (raw, tokens unresolved). */
function classRoutePrefix(classNode: Node): string | null {
  for (const child of classNode.children) {
    if (child.type !== "attribute_list") continue;
    for (const attr of child.children) {
      if (attr.type === "attribute" && attributeName(attr) === "Route") {
        const tmpl = attributeRouteTemplate(attr);
        if (tmpl !== null) return tmpl;
      }
    }
  }
  return null;
}

/** Emit a RouteInfo for each HTTP-verb attribute on a method. */
function parseMethodRoutes(
  methodNode: Node,
  routes: RouteInfo[],
  classPrefix: string | null,
  controllerName: string | null,
) {
  const methodName = methodNode.childForFieldName("name")?.text ?? null;

  // First pass: a method-level [Route("…")] supplies the template for an
  // [HttpGet] that carries no template of its own (`[HttpGet][Route("x")]`).
  let routeAttrTemplate: string | null = null;
  const verbAttrs: { verb: string; template: string | null; line: number }[] = [];

  for (const child of methodNode.children) {
    if (child.type !== "attribute_list") continue;
    for (const attr of child.children) {
      if (attr.type !== "attribute") continue;
      const name = attributeName(attr);
      if (name === "Route") {
        routeAttrTemplate ??= attributeRouteTemplate(attr);
      } else if (name && CSHARP_HTTP_ATTRIBUTES[name]) {
        verbAttrs.push({
          verb: CSHARP_HTTP_ATTRIBUTES[name]!,
          template: attributeRouteTemplate(attr),
          line: attr.startPosition.row + 1,
        });
      }
    }
  }

  for (const { verb, template, line } of verbAttrs) {
    routes.push({
      path: buildPath(classPrefix, template ?? routeAttrTemplate, controllerName, methodName),
      httpMethod: verb,
      kind: "api",
      handler: methodName,
      calls: [],
      middleware: [],
      line,
    });
  }
}

/** Simple (last-segment) name of a C# attribute, e.g. `Mvc.HttpGet` -> `HttpGet`. */
function attributeName(attr: Node): string | null {
  const name = attr.childForFieldName("name")?.text ?? null;
  if (!name) return null;
  return name.replace(/.*\./, "");
}

/**
 * The route template from an attribute: the first **positional** string
 * argument. Named arguments (`Name = "…"`, `Order = 2`) are wrapped in an
 * `assignment_expression`, so a positional template is the `attribute_argument`
 * whose child is a bare `string_literal`.
 */
function attributeRouteTemplate(attr: Node): string | null {
  const argList = findChildByType(attr, "attribute_argument_list");
  if (!argList) return null;
  for (const arg of argList.children) {
    if (arg.type !== "attribute_argument") continue;
    const str = findChildByType(arg, "string_literal")
      ?? findChildByType(arg, "verbatim_string_literal");
    if (str) return stringLiteralText(str);
  }
  return null;
}

/** Inner text of a C# string literal (handles the `string_literal_content` child + `@"…"`). */
function stringLiteralText(str: Node): string {
  const content = findChildByType(str, "string_literal_content");
  if (content) return content.text;
  return str.text.replace(/^@?"/, "").replace(/"$/, "");
}

/** Resolve `[controller]`/`[action]` tokens in a template segment. */
function substituteTokens(
  s: string,
  controllerName: string | null,
  methodName: string | null,
): string {
  let out = s;
  if (controllerName) out = out.replace(/\[controller\]/gi, controllerName);
  if (methodName) out = out.replace(/\[action\]/gi, methodName);
  return out;
}

/** Strip route constraints/defaults/catch-all markers: `{id:guid}` / `{id?}` / `{*slug}` -> `{id}`/`{slug}`. */
function stripConstraints(path: string): string {
  return path.replace(/\{\*{0,2}([^}:=?]+)[^}]*\}/g, "{$1}");
}

/** Build the full, normalized endpoint path for one route. */
function buildPath(
  classPrefix: string | null,
  template: string | null,
  controllerName: string | null,
  methodName: string | null,
): string {
  const prefix = substituteTokens(classPrefix ?? "", controllerName, methodName);
  const tmpl = substituteTokens(template ?? "", controllerName, methodName);

  // A template starting with "/" or "~/" is absolute — it ignores the prefix.
  let merged: string;
  if (tmpl.startsWith("/") || tmpl.startsWith("~/")) {
    merged = tmpl.replace(/^~/, "");
  } else if (!prefix) {
    merged = tmpl;
  } else if (!tmpl) {
    merged = prefix;
  } else {
    merged = prefix.replace(/\/+$/, "") + "/" + tmpl.replace(/^\/+/, "");
  }

  let path = stripConstraints(merged);
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const csharpRouteExtractor: RouteExtractor = {
  languages: ["csharp"],
  extractRoutes(tree, _sourceText) {
    const routes: RouteInfo[] = [];
    extractAspnetRoutes(tree.rootNode, routes);
    return routes;
  },
};
