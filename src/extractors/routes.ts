import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo, Language } from "../types/analysis.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "use",
  "head",
  "options",
]);

/**
 * Extract routes and API endpoints from an AST.
 * Handles: Express-style (app.get/router.post), decorators (@Get, @HttpGet), React Router (<Route>).
 */
export function extractRoutes(
  tree: Tree,
  sourceText: string,
  language: Language,
): RouteInfo[] {
  const routes: RouteInfo[] = [];

  if (language === "typescript" || language === "javascript") {
    walkForRoutes(tree.rootNode, routes);
    walkForJsxRoutes(tree.rootNode, routes);
    walkForDecoratorRoutes(tree.rootNode, routes);
    walkForVueRouterConfig(tree.rootNode, routes);
  } else if (language === "python") {
    walkForPythonRoutes(tree.rootNode, routes);
  } else if (language === "csharp") {
    walkForCsharpRoutes(tree.rootNode, routes);
  } else if (language === "java" || language === "kotlin") {
    walkForJavaKotlinRoutes(tree.rootNode, routes);
  } else if (language === "pascal") {
    walkForPascalRoutes(tree.rootNode, routes);
  }

  return routes;
}

/** Collect function call names from within a function body (non-recursive into nested functions) */
function collectCallNames(fnNode: Node): string[] {
  const names: string[] = [];
  const visited = new Set<number>();

  function walk(n: Node) {
    if (visited.has(n.id)) return;
    visited.add(n.id);

    // Don't descend into nested function definitions
    if (
      n !== fnNode &&
      (n.type === "arrow_function" ||
        n.type === "function_expression" ||
        n.type === "function_declaration")
    ) {
      return;
    }

    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee) {
        const name =
          callee.type === "identifier"
            ? callee.text
            : callee.type === "member_expression"
              ? callee.childForFieldName("property")?.text ?? null
              : callee.type === "await_expression"
                ? collectCallNames(callee)[0] ?? null
                : null;
        if (name && !["then", "json", "send", "status", "catch"].includes(name)) {
          names.push(name);
        }
      }
    }

    // For await expressions wrapping calls: `await createUser(req.body)`
    if (n.type === "await_expression") {
      const child = n.child(1); // the expression after 'await'
      if (child?.type === "call_expression") {
        const callee = child.childForFieldName("function");
        if (callee?.type === "identifier") {
          if (!names.includes(callee.text)) {
            names.push(callee.text);
          }
        }
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }

  walk(fnNode);
  return [...new Set(names)];
}

// --- Express-style: app.get("/path", handler) ---

function walkForRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      const method = prop?.text?.toLowerCase();

      if (method && HTTP_METHODS.has(method)) {
        const args = node.childForFieldName("arguments");
        if (args) {
          const firstArg = args.child(1); // skip '('
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const path = stripQuotes(firstArg.text);
            // Find handler name (last argument before closing paren)
            let handler: string | null = null;
            const middleware: string[] = [];
            for (let i = 2; i < args.childCount - 1; i++) {
              const arg = args.child(i)!;
              if (arg.type === "," || arg.type === "(") continue;
              if (arg.type === "identifier" || arg.type === "member_expression") {
                if (handler) middleware.push(handler);
                handler = arg.text;
              }
            }

            // Scan inline function body for called functions
            let calls: string[] = [];
            const lastArg = args.child(args.childCount - 2); // last before ')'
            if (
              lastArg &&
              (lastArg.type === "arrow_function" ||
                lastArg.type === "function_expression" ||
                lastArg.type === "function")
            ) {
              calls = collectCallNames(lastArg);
            }

            routes.push({
              path,
              httpMethod: method === "use" ? null : method.toUpperCase(),
              kind: "api",
              handler,
              calls,
              middleware,
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForRoutes(node.child(i)!, routes);
  }
}

// --- React Router: <Route path="/dashboard" component={X} /> ---

function walkForJsxRoutes(node: Node, routes: RouteInfo[]) {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode?.text === "Route") {
      let path: string | null = null;
      let handler: string | null = null;

      for (let i = 0; i < node.childCount; i++) {
        const attr = node.child(i)!;
        if (attr.type === "jsx_attribute") {
          const attrName = attr.childForFieldName("name")?.text ?? attr.child(0)?.text;
          const attrValue = attr.child(2); // name = value
          if (attrName === "path" && attrValue) {
            path = stripQuotes(attrValue.text);
          } else if (
            (attrName === "component" || attrName === "element") &&
            attrValue
          ) {
            handler = attrValue.text.replace(/[{}< />]/g, "").trim();
          }
        }
      }

      if (path) {
        routes.push({
          path,
          httpMethod: null,
          kind: "frontend",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForJsxRoutes(node.child(i)!, routes);
  }
}

// --- NestJS-style decorators: @Get("/path"), @Post("/path") ---

function walkForDecoratorRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "decorator") {
    const expr = node.child(1);
    if (expr?.type === "call_expression") {
      const callee = expr.childForFieldName("function");
      const calleeName = callee?.text;

      if (calleeName && isHttpDecorator(calleeName)) {
        const args = expr.childForFieldName("arguments");
        let path = "/";
        if (args && args.childCount > 2) {
          const firstArg = args.child(1);
          if (firstArg) path = stripQuotes(firstArg.text);
        }

        // Find the method name that follows
        const parent = node.parent;
        let handler: string | null = null;
        if (parent) {
          for (let i = 0; i < parent.childCount; i++) {
            const sibling = parent.child(i)!;
            if (sibling.type === "method_definition") {
              handler = sibling.childForFieldName("name")?.text ?? null;
              break;
            }
          }
        }

        routes.push({
          path,
          httpMethod: calleeName.toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForDecoratorRoutes(node.child(i)!, routes);
  }
}

function isHttpDecorator(name: string): boolean {
  const decorators = new Set([
    "Get",
    "Post",
    "Put",
    "Patch",
    "Delete",
    "All",
    "Head",
    "Options",
  ]);
  return decorators.has(name);
}

// --- Python: @app.get("/path") ---

function walkForPythonRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "decorated_definition") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "decorator") {
        const call = child.child(1);
        if (call?.type === "call") {
          const fn = call.childForFieldName("function");
          if (fn?.type === "attribute") {
            const method = fn.childForFieldName("attribute")?.text;
            if (method && HTTP_METHODS.has(method.toLowerCase())) {
              const args = call.childForFieldName("arguments");
              let path = "/";
              if (args && args.childCount > 1) {
                const firstArg = args.child(1);
                if (firstArg) path = stripQuotes(firstArg.text);
              }

              // Find the function name
              let handler: string | null = null;
              for (let j = 0; j < node.childCount; j++) {
                const def = node.child(j)!;
                if (def.type === "function_definition") {
                  handler = def.childForFieldName("name")?.text ?? null;
                }
              }

              routes.push({
                path,
                httpMethod: method.toUpperCase(),
                kind: "api",
                handler,
                calls: [],
                middleware: [],
                line: node.startPosition.row + 1,
              });
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForPythonRoutes(node.child(i)!, routes);
  }
}

// --- C#: [HttpGet("path")], [Route("path")] ---

function walkForCsharpRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "method_declaration") {
    const methodName = node.childForFieldName("name")?.text ?? null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "attribute_list") {
        for (let j = 0; j < child.childCount; j++) {
          const attr = child.child(j)!;
          if (attr.type === "attribute") {
            const attrName = attr.childForFieldName("name")?.text ?? "";
            if (isCsharpHttpAttribute(attrName)) {
              let path = "/";
              const argList = attr.childForFieldName("arguments");
              if (argList && argList.childCount > 1) {
                const firstArg = argList.child(1);
                if (firstArg) path = stripQuotes(firstArg.text);
              }

              routes.push({
                path,
                httpMethod: attrName.replace("Http", "").toUpperCase(),
                kind: "api",
                handler: methodName,
                calls: [],
                middleware: [],
                line: attr.startPosition.row + 1,
              });
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForCsharpRoutes(node.child(i)!, routes);
  }
}

function isCsharpHttpAttribute(name: string): boolean {
  const attrs = new Set([
    "HttpGet",
    "HttpPost",
    "HttpPut",
    "HttpPatch",
    "HttpDelete",
    "HttpHead",
    "HttpOptions",
  ]);
  return attrs.has(name);
}

// --- Java / Kotlin: Spring Boot @GetMapping, @PostMapping, @RequestMapping, Ktor routing ---

/** Spring Boot mapping annotations */
const SPRING_MAPPING_ANNOTATIONS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: null, // Method determined by `method` attribute
};

function walkForJavaKotlinRoutes(node: Node, routes: RouteInfo[]) {
  // Look for methods with Spring mapping annotations
  if (
    node.type === "method_declaration" ||
    node.type === "function_declaration"
  ) {
    const methodName = node.childForFieldName("name")?.text ?? null;

    // Check annotations on this method
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
      // Java modifiers node wrapping annotations
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

  // Also check class-level @RequestMapping for base path
  // (handled implicitly — routes extracted per-method)

  for (let i = 0; i < node.childCount; i++) {
    walkForJavaKotlinRoutes(node.child(i)!, routes);
  }
}

function parseSpringAnnotation(
  node: Node,
  handler: string | null,
): RouteInfo | null {
  const annotationText = node.text.replace(/^@/, "");
  const annotationName = annotationText.split("(")[0].trim();

  const httpMethod = SPRING_MAPPING_ANNOTATIONS[annotationName];
  if (httpMethod === undefined) return null; // Not a mapping annotation

  // Extract path from annotation arguments
  let path = "/";
  const argsMatch = annotationText.match(/\(\s*["']([^"']+)["']/);
  if (argsMatch) {
    path = argsMatch[1];
  } else {
    // Try value= or path= attribute
    const valueMatch = annotationText.match(/(?:value|path)\s*=\s*["']([^"']+)["']/);
    if (valueMatch) path = valueMatch[1];
  }

  // For @RequestMapping, try to extract method
  let resolvedMethod = httpMethod;
  if (httpMethod === null) {
    const methodMatch = annotationText.match(/method\s*=\s*RequestMethod\.(\w+)/);
    resolvedMethod = methodMatch ? methodMatch[1] : "GET";
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

// --- Vue Router: routes array config ---

/**
 * Detect Vue Router route config objects: { path: "/foo", component: Bar }
 * Typically found in createRouter({ routes: [...] }) or export const routes = [...]
 */
function walkForVueRouterConfig(node: Node, routes: RouteInfo[]) {
  // Look for objects with a "path" property inside arrays
  if (node.type === "object") {
    let path: string | null = null;
    let handler: string | null = null;

    for (let i = 0; i < node.childCount; i++) {
      const prop = node.child(i)!;
      if (prop.type === "pair" || prop.type === "property_assignment") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const keyText = key?.text;

        if (keyText === "path" && value) {
          path = stripQuotes(value.text);
        } else if (
          (keyText === "component" || keyText === "name") &&
          value
        ) {
          handler = value.text;
        }
      }
    }

    if (path !== null) {
      routes.push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler,
        calls: [],
        middleware: [],
        line: node.startPosition.row + 1,
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkForVueRouterConfig(node.child(i)!, routes);
  }
}

// --- Pascal / Delphi: DataSnap and RAD Server route patterns ---

/** Delphi DataSnap/RAD Server method prefixes that map to HTTP methods */
const DELPHI_METHOD_PREFIXES: Record<string, string> = {
  accept: "GET",
  update: "PUT",
  cancel: "DELETE",
};

/**
 * Detect Delphi DataSnap-style server method conventions.
 * Only triggers for methods defined on classes (ClassName.MethodName in implementation)
 * with the specific DataSnap naming prefixes (accept/update/cancel).
 */
function walkForPascalRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "defProc") {
    const declProc = findFirstChildByType(node, "declProc");
    if (!declProc) { recurseRoutes(node, routes); return; }

    // Only consider class method implementations (genericDot = ClassName.Method)
    let className = "";
    let methodName = "";
    for (let i = 0; i < declProc.childCount; i++) {
      const child = declProc.child(i)!;
      if (child.type === "genericDot") {
        const parts: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          if (child.child(j)!.type === "identifier") parts.push(child.child(j)!.text);
        }
        if (parts.length >= 2) {
          className = parts[0];
          methodName = parts[parts.length - 1];
        }
      }
    }

    if (className && methodName) {
      const lowerName = methodName.toLowerCase();
      for (const [prefix, method] of Object.entries(DELPHI_METHOD_PREFIXES)) {
        if (lowerName.startsWith(prefix) && lowerName.length > prefix.length) {
          const path = "/" + methodName.slice(prefix.length);
          routes.push({
            path,
            httpMethod: method,
            kind: "api",
            handler: `${className}.${methodName}`,
            calls: [],
            middleware: [],
            line: node.startPosition.row + 1,
          });
          break;
        }
      }
    }
  }

  recurseRoutes(node, routes);
}

function recurseRoutes(node: Node, routes: RouteInfo[]) {
  for (let i = 0; i < node.childCount; i++) {
    walkForPascalRoutes(node.child(i)!, routes);
  }
}

function findFirstChildByType(node: Node, type: string): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === type) return node.child(i)!;
  }
  return null;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
