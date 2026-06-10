import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo } from "../../../../types/analysis.js";
import { stripQuotes, findChildByType } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";

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
  walkForJavaKotlinRoutes(root, routes, "");
}

function walkForJavaKotlinRoutes(node: Node, routes: RouteInfo[], classPrefix: string) {
  // Check for class-level @RequestMapping to capture prefix
  if (node.type === "class_declaration" || node.type === "class_definition") {
    const prefix = extractClassRequestMappingPath(node);
    // Recurse into the class body with the prefix
    for (const child of node.children) {
      walkForJavaKotlinRoutes(child, routes, prefix || classPrefix);
    }
    return;
  }

  if (
    node.type === "method_declaration" ||
    node.type === "function_declaration"
  ) {
    const methodName = node.childForFieldName("name")?.text ?? null;
    const body = node.childForFieldName("body");
    // Guess language from context: Kotlin uses function_declaration, Java uses method_declaration
    const lang = node.type === "function_declaration" ? "kotlin" as const : "java" as const;
    const bodyCalls = extractCalls(body, lang);

    for (const child of node.children) {
      if (
        child.type === "annotation" ||
        child.type === "marker_annotation" ||
        child.type === "single_element_annotation"
      ) {
        const route = parseSpringAnnotation(child, methodName, bodyCalls, classPrefix);
        if (route) routes.push(route);
      }
      if (child.type === "modifiers") {
        for (const mod of child.children) {
          if (
            mod.type === "annotation" ||
            mod.type === "marker_annotation" ||
            mod.type === "single_element_annotation"
          ) {
            const route = parseSpringAnnotation(mod, methodName, bodyCalls, classPrefix);
            if (route) routes.push(route);
          }
        }
      }
    }
  }

  for (const child of node.children) {
    walkForJavaKotlinRoutes(child, routes, classPrefix);
  }
}

/**
 * Extract the path from a class-level @RequestMapping annotation.
 * Looks through class modifiers for @RequestMapping("/api/users") etc.
 */
function extractClassRequestMappingPath(classNode: Node): string | null {
  for (const child of classNode.children) {

    // Direct annotation on the class
    const path = extractRequestMappingPath(child);
    if (path) return path;

    // Annotations inside a modifiers node
    if (child.type === "modifiers") {
      for (const mod of child.children) {
        const modPath = extractRequestMappingPath(mod);
        if (modPath) return modPath;
      }
    }
  }
  return null;
}

/** Extract path from a @RequestMapping annotation node, or null if not a RequestMapping */
function extractRequestMappingPath(node: Node): string | null {
  if (
    node.type !== "annotation" &&
    node.type !== "marker_annotation" &&
    node.type !== "single_element_annotation"
  ) {
    return null;
  }

  let annotationName: string | null = null;
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    annotationName = nameNode.text;
  } else {
    for (const child of node.children) {
      if (child.type === "identifier" || child.type === "scoped_identifier") {
        annotationName = child.text;
        break;
      }
    }
  }

  if (annotationName !== "RequestMapping") return null;

  const argsNode =
    node.childForFieldName("arguments") ??
    findChildByType(node, "annotation_argument_list");

  if (argsNode) {
    for (const arg of argsNode.children) {
      if (arg.type === "string" || arg.type === "string_literal") {
        return stripQuotes(arg.text);
      }
      if (arg.type === "element_value_pair" || arg.type === "assignment_expression") {
        const key = arg.childForFieldName("key") ?? arg.child(0);
        const value = arg.childForFieldName("value") ?? arg.child(2);
        if (key && (key.text === "value" || key.text === "path") && value) {
          return stripQuotes(value.text);
        }
      }
    }
  }

  return null;
}

function parseSpringAnnotation(
  node: Node,
  handler: string | null,
  calls: CallInfo[],
  classPrefix: string,
): RouteInfo | null {
  let annotationName: string | null = null;
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    annotationName = nameNode.text;
  } else {
    for (const child of node.children) {
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
    for (const arg of argsNode.children) {
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

  // Merge class-level prefix with method-level path
  if (classPrefix) {
    const prefix = classPrefix.endsWith("/") ? classPrefix.slice(0, -1) : classPrefix;
    if (path === "/") {
      path = prefix;
    } else {
      const suffix = path.startsWith("/") ? path : "/" + path;
      path = prefix + suffix;
    }
  }

  let resolvedMethod = httpMethod;
  if (httpMethod === null) {
    if (argsNode) {
      for (const arg of argsNode.children) {
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
    calls,
    middleware: [],
    line: node.startPosition.row + 1,
  };
}
