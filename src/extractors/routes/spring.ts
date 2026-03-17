import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";
import { stripQuotes, findChildByType } from "../node-helpers.js";

/** Spring Boot mapping annotations */
const SPRING_MAPPING_ANNOTATIONS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: null, // Method determined by `method` attribute
};

/** Java / Kotlin: Spring Boot @GetMapping, @PostMapping, @RequestMapping */
export function extractSpringRoutes(root: Node, routes: RouteInfo[]): void {
  walkForJavaKotlinRoutes(root, routes);
}

function walkForJavaKotlinRoutes(node: Node, routes: RouteInfo[]) {
  if (
    node.type === "method_declaration" ||
    node.type === "function_declaration"
  ) {
    const methodName = node.childForFieldName("name")?.text ?? null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (
        child.type === "annotation" ||
        child.type === "marker_annotation" ||
        child.type === "single_element_annotation"
      ) {
        const route = parseSpringAnnotation(child, methodName);
        if (route) routes.push(route);
      }
      if (child.type === "modifiers") {
        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j)!;
          if (
            mod.type === "annotation" ||
            mod.type === "marker_annotation" ||
            mod.type === "single_element_annotation"
          ) {
            const route = parseSpringAnnotation(mod, methodName);
            if (route) routes.push(route);
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForJavaKotlinRoutes(node.child(i)!, routes);
  }
}

function parseSpringAnnotation(
  node: Node,
  handler: string | null,
): RouteInfo | null {
  let annotationName: string | null = null;
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    annotationName = nameNode.text;
  } else {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "identifier" || child.type === "scoped_identifier") {
        annotationName = child.text;
        break;
      }
    }
  }
  if (!annotationName) return null;

  const httpMethod = SPRING_MAPPING_ANNOTATIONS[annotationName];
  if (httpMethod === undefined) return null;

  let path = "/";
  const argsNode =
    node.childForFieldName("arguments") ??
    findChildByType(node, "annotation_argument_list");

  if (argsNode) {
    for (let i = 0; i < argsNode.childCount; i++) {
      const arg = argsNode.child(i)!;
      if (arg.type === "string" || arg.type === "string_literal") {
        path = stripQuotes(arg.text);
        break;
      }
      if (arg.type === "element_value_pair" || arg.type === "assignment_expression") {
        const key = arg.childForFieldName("key") ?? arg.child(0);
        const value = arg.childForFieldName("value") ?? arg.child(2);
        if (key && (key.text === "value" || key.text === "path") && value) {
          path = stripQuotes(value.text);
        }
      }
    }
  }

  let resolvedMethod = httpMethod;
  if (httpMethod === null) {
    if (argsNode) {
      for (let i = 0; i < argsNode.childCount; i++) {
        const arg = argsNode.child(i)!;
        if (arg.type === "element_value_pair" || arg.type === "assignment_expression") {
          const key = arg.childForFieldName("key") ?? arg.child(0);
          const value = arg.childForFieldName("value") ?? arg.child(2);
          if (key?.text === "method" && value) {
            resolvedMethod = value.text.replace(/.*\./, "");
          }
        }
      }
    }
    if (!resolvedMethod) resolvedMethod = "GET";
  }

  return {
    path,
    httpMethod: resolvedMethod,
    kind: "api",
    handler,
    calls: [],
    middleware: [],
    line: node.startPosition.row + 1,
  };
}
