import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo } from "../../../../types/analysis.js";
import { stripQuotes, findChildByType, getNameFromNode } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta, type GuardAttr } from "../../../shared/route-metadata.js";
import { guardsOn, routeParamsOf } from "./meta-annotations.js";

/** Spring Boot mapping annotations */
const SPRING_MAPPING_ANNOTATIONS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
  RequestMapping: null, // Method determined by `method` attribute
};

/** HTTP verbs as written in `@RequestMapping(method = ...)` (RequestMethod.GET etc.). */
const HTTP_VERB_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/g;

// ─── Grammar-agnostic annotation parsing (Java + Kotlin) ──────────────────
//
// The Java and Kotlin tree-sitter grammars model annotations differently, so
// every accessor below understands both shapes:
//
//   Java   @GetMapping("/x")  ->  (annotation name: (identifier)
//                                              arguments: (annotation_argument_list (string_literal)))
//   Java   @GetMapping({"/x"})->  ... (annotation_argument_list (element_value_array_initializer (string_literal)))
//   Java   @RestController    ->  (marker_annotation name: (identifier))
//   Kotlin @RestController     ->  (annotation (user_type (type_identifier)))
//   Kotlin @GetMapping("/x")   ->  (annotation (constructor_invocation
//                                     (user_type (type_identifier))
//                                     (value_arguments (value_argument (string_literal)))))
//   Kotlin named/array arg     ->  (value_argument (simple_identifier) "=" (collection_literal (string_literal)))
//
// Before this, the parser only understood the Java shape, so Kotlin Spring
// controllers (annotation name nested under constructor_invocation/user_type)
// produced zero routes.

export function isAnnotationNode(node: Node): boolean {
  return (
    node.type === "annotation" ||
    node.type === "marker_annotation" ||
    node.type === "single_element_annotation"
  );
}

/** Last `.`-segment of a (possibly qualified) name: `web.bind.GetMapping` -> `GetMapping`. */
function lastSegment(text: string): string {
  return text.replace(/.*\./, "").trim();
}

/** Resolve an annotation's simple name across both grammars (e.g. "GetMapping"). */
export function annotationSimpleName(node: Node): string | null {
  // Java: dedicated `name` field.
  const nameField = node.childForFieldName("name");
  if (nameField) return lastSegment(nameField.text);

  for (const child of node.children) {
    // Java fallback: a bare identifier / scoped_identifier child.
    if (child.type === "identifier" || child.type === "scoped_identifier") {
      return lastSegment(child.text);
    }
    // Kotlin, no args: annotation > user_type > type_identifier.
    if (child.type === "user_type") {
      const ti = findChildByType(child, "type_identifier");
      if (ti) return lastSegment(ti.text);
    }
    // Kotlin, with args: annotation > constructor_invocation > user_type > type_identifier.
    if (child.type === "constructor_invocation") {
      const ut = findChildByType(child, "user_type");
      const ti = ut ? findChildByType(ut, "type_identifier") : null;
      if (ti) return lastSegment(ti.text);
    }
  }
  return null;
}

/** The annotation's argument-list node, across both grammars (null if none). */
export function annotationArgsNode(node: Node): Node | null {
  // Java
  const argField = node.childForFieldName("arguments");
  if (argField) return argField;
  const javaArgs = findChildByType(node, "annotation_argument_list");
  if (javaArgs) return javaArgs;
  // Kotlin: annotation > constructor_invocation > value_arguments
  const ctor = findChildByType(node, "constructor_invocation");
  if (ctor) return findChildByType(ctor, "value_arguments");
  return null;
}

/** First string literal anywhere under `node` (descends array/value_argument/collection wrappers). */
function firstStringLiteral(node: Node): string | null {
  if (node.type === "string" || node.type === "string_literal") {
    return stripQuotes(node.text);
  }
  for (const child of node.children) {
    const found = firstStringLiteral(child);
    if (found !== null) return found;
  }
  return null;
}

/** For a Kotlin `value_argument`, its key when it's `key = value`, else null (positional). */
function kotlinArgKey(valueArg: Node): string | null {
  const kids = valueArg.children;
  // named form: simple_identifier "=" <value>
  if (kids.length >= 2 && kids[1]?.type === "=") return kids[0]?.text ?? null;
  return null;
}

/**
 * The route path from an annotation's args: a named `value`/`path` attribute if
 * present, otherwise the first positional string. Handles Java positional
 * strings, brace-arrays (`{"/x"}`), and element_value_pairs, plus Kotlin
 * value_arguments (positional, named, array-wrapped `value = ["/x"]`).
 */
export function extractAnnotationPath(argsNode: Node): string | null {
  let positional: string | null = null;
  let named: string | null = null;

  for (const arg of argsNode.children) {
    switch (arg.type) {
      case "string":
      case "string_literal": // Java positional, single string
        positional ??= stripQuotes(arg.text);
        break;
      case "element_value_array_initializer": // Java positional brace-array `{"/x", "/y"}`
        positional ??= firstStringLiteral(arg);
        break;
      case "value_argument": {
        // Kotlin: positional or `key = value`
        const key = kotlinArgKey(arg);
        const str = firstStringLiteral(arg);
        if (str === null) break;
        if (key === null) positional ??= str;
        else if (key === "value" || key === "path") named ??= str;
        break;
      }
      case "element_value_pair":
      case "assignment_expression": {
        // Java: `value = "/x"` / `path = "/x"` (value may itself be a brace-array)
        const key = (arg.childForFieldName("key") ?? arg.child(0))?.text;
        const valueNode = arg.childForFieldName("value") ?? arg.child(2);
        if ((key === "value" || key === "path") && valueNode) {
          const str = firstStringLiteral(valueNode);
          if (str !== null) named ??= str;
        }
        break;
      }
    }
  }
  return named ?? positional;
}

/**
 * Every HTTP method named in a `@RequestMapping(method = ...)` attribute, across
 * both grammars and both single (`RequestMethod.GET`) and array
 * (`[RequestMethod.GET, RequestMethod.POST]` / `{...}`) forms. Empty if absent.
 */
function extractAnnotationMethods(argsNode: Node): string[] {
  for (const arg of argsNode.children) {
    let valueText: string | null = null;
    if (arg.type === "value_argument") {
      // Kotlin
      if (kotlinArgKey(arg) === "method") valueText = arg.text;
    } else if (arg.type === "element_value_pair" || arg.type === "assignment_expression") {
      // Java
      const key = (arg.childForFieldName("key") ?? arg.child(0))?.text;
      if (key === "method") valueText = (arg.childForFieldName("value") ?? arg.child(2))?.text ?? null;
    }
    if (valueText) return [...valueText.matchAll(HTTP_VERB_RE)].map((m) => m[1]!);
  }
  return [];
}

/** Join a class-level prefix with a method-level path. */
export function mergePrefix(classPrefix: string, path: string): string {
  if (!classPrefix) return path;
  const prefix = classPrefix.endsWith("/") ? classPrefix.slice(0, -1) : classPrefix;
  if (path === "/") return prefix;
  return prefix + (path.startsWith("/") ? path : "/" + path);
}

/** True if a class/interface declaration carries the named annotation (e.g. "FeignClient"). */
export function declarationHasAnnotation(declNode: Node, name: string): boolean {
  for (const child of declNode.children) {
    if (isAnnotationNode(child) && annotationSimpleName(child) === name) return true;
    if (child.type === "modifiers") {
      for (const mod of child.children) {
        if (isAnnotationNode(mod) && annotationSimpleName(mod) === name) return true;
      }
    }
  }
  return false;
}

// ─── Walk ─────────────────────────────────────────────────────────────────

/** Java / Kotlin: Spring Boot @GetMapping, @PostMapping, @RequestMapping */
export function extractSpringRoutes(root: Node, routes: RouteInfo[]): void {
  walkForJavaKotlinRoutes(root, routes, "", false, []);
}

function walkForJavaKotlinRoutes(
  node: Node,
  routes: RouteInfo[],
  classPrefix: string,
  suppress: boolean,
  classGuards: readonly GuardAttr[],
) {
  // Check for class-level @RequestMapping to capture prefix
  if (node.type === "class_declaration" || node.type === "class_definition") {
    const prefix = extractClassRequestMappingPath(node);
    // @FeignClient methods are *outbound* HTTP calls, not inbound routes — skip them.
    const childSuppress = suppress || declarationHasAnnotation(node, "FeignClient");
    // Class-level @PreAuthorize/@Secured/@RolesAllowed guard every handler in the class.
    const guards = [...classGuards, ...guardsOn(node)];
    for (const child of node.children) {
      walkForJavaKotlinRoutes(child, routes, prefix || classPrefix, childSuppress, guards);
    }
    return;
  }

  if (
    !suppress &&
    (node.type === "method_declaration" || node.type === "function_declaration")
  ) {
    const methodName = getNameFromNode(node);
    // Kotlin uses function_declaration; Java uses method_declaration.
    const lang = node.type === "function_declaration" ? ("kotlin" as const) : ("java" as const);
    const body =
      node.childForFieldName("body") ??
      findChildByType(node, "function_body") ??
      findChildByType(node, "block");
    const bodyCalls = body ? extractCalls(body, lang) : [];
    const methodGuards = guardsOn(node);

    const emit = (ann: Node): void => {
      for (const route of parseSpringAnnotation(ann, methodName, bodyCalls, classPrefix)) {
        applyRouteMeta(route, {
          inheritedGuards: classGuards,
          guards: methodGuards,
          params: routeParamsOf(node, route.path, "spring"),
        });
        routes.push(route);
      }
    };
    for (const child of node.children) {
      if (isAnnotationNode(child)) emit(child);
      // Annotations live inside a `modifiers` block (Java and Kotlin both).
      if (child.type === "modifiers") {
        for (const mod of child.children) if (isAnnotationNode(mod)) emit(mod);
      }
    }
  }

  // WebFlux functional endpoints: `RouterFunctions.route().GET("/x", this::handle)`,
  // springdoc's `SpringdocRouteBuilder.route().GET("/x", this::handle, builder -> …)`,
  // nested under `.nest(path("/api"), b -> b.GET(…))` / `.path("/api", b -> …)`.
  // The handler is the method reference, or the lambda's calls when inline.
  // A predicate variable as the first argument (`GET(consolePagePredicate, …)`)
  // names no path and is skipped.
  if (!suppress && node.type === "method_invocation") {
    const verb = node.childForFieldName("name")?.text ?? "";
    // The verb is cheap and rare; the receiver text of a chain is the whole chain.
    if (FUNCTIONAL_VERBS.has(verb) && FUNCTIONAL_ROUTER_RE.test(node.childForFieldName("object")?.text ?? "")) {
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const path = args[0] ? firstStringLiteral(args[0]) : null;
      if (path !== null && args[0]!.type !== "lambda_expression") {
        const handlerArg = args[1];
        const ref = handlerArg?.type === "method_reference" ? handlerArg.text.split("::").pop() ?? null : null;
        const calls = handlerArg?.type === "lambda_expression" ? extractCalls(handlerArg, "java") : [];
        const route: RouteInfo = {
          path: mergePrefix(classPrefix, functionalNestPrefix(node) + (path.startsWith("/") ? path : "/" + path)),
          httpMethod: verb,
          kind: "api",
          handler: ref,
          calls,
          middleware: [],
          // The invocation node starts where its chain starts; the verb token is the route's line.
          line: (node.childForFieldName("name") ?? node).startPosition.row + 1,
        };
        applyRouteMeta(route, { inheritedGuards: classGuards });
        routes.push(route);
      }
    }
  }

  for (const child of node.children) {
    walkForJavaKotlinRoutes(child, routes, classPrefix, suppress, classGuards);
  }
}

const FUNCTIONAL_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** A file that builds functional endpoints: the gate the route index applies before walking. */
export const FUNCTIONAL_ROUTER_GATE_RE = /\broute\s*\(\s*\)|\bRouterFunctions\b|\bSpringdocRouteBuilder\b/;
/** A receiver chain rooted at a router builder, or a nest lambda's builder parameter. */
const FUNCTIONAL_ROUTER_RE = new RegExp(`${FUNCTIONAL_ROUTER_GATE_RE.source}|\\b(?:builder|b|r|router|routes)$`);

/** Path prefix from enclosing `.nest(path("/api"), b -> …)` / `.path("/api", b -> …)` calls, outermost first. */
function functionalNestPrefix(node: Node): string {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === "method_invocation") {
      const name = cur.childForFieldName("name")?.text;
      if (name === "nest" || name === "path") {
        const first = cur.childForFieldName("arguments")?.namedChildren[0];
        const prefix = first && first.type !== "lambda_expression" ? firstStringLiteral(first) : null;
        if (prefix) parts.unshift(prefix.startsWith("/") ? prefix : "/" + prefix);
      }
    }
    cur = cur.parent;
  }
  return parts.join("").replace(/\/+$/, "");
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
  if (!isAnnotationNode(node)) return null;
  if (annotationSimpleName(node) !== "RequestMapping") return null;
  const args = annotationArgsNode(node);
  return args ? extractAnnotationPath(args) : null;
}

/** One RouteInfo per HTTP method the annotation declares (≥1 for a mapping annotation, else none). */
function parseSpringAnnotation(
  node: Node,
  handler: string | null,
  calls: CallInfo[],
  classPrefix: string,
): RouteInfo[] {
  const annotationName = annotationSimpleName(node);
  if (!annotationName) return [];

  const httpMethod = SPRING_MAPPING_ANNOTATIONS[annotationName];
  if (httpMethod === undefined) return [];

  const args = annotationArgsNode(node);
  // `|| "/"` (not `??`) so an explicit empty path "" also falls back to the prefix.
  const path = mergePrefix(classPrefix, (args ? extractAnnotationPath(args) : null) || "/");

  let methods: string[];
  if (httpMethod === null) {
    // @RequestMapping: one route per declared method (default GET when unspecified).
    methods = args ? extractAnnotationMethods(args) : [];
    if (methods.length === 0) methods = ["GET"];
  } else {
    methods = [httpMethod];
  }

  return methods.map((m) => ({
    path,
    httpMethod: m,
    kind: "api" as const,
    handler,
    calls,
    middleware: [],
    line: node.startPosition.row + 1,
  }));
}

// ─── Regex fallback (degraded ASTs) ───────────────────────────────────────
//
// tree-sitter-kotlin (and occasionally tree-sitter-java) can *misparse* a
// valid file without flagging an error — function bodies get absorbed into
// bogus `prefix_expression`/`lambda_literal` nodes, so annotations are no
// longer attached to their `function_declaration`. The AST walk then finds
// nothing. When that happens we scan the raw source: Spring mapping
// annotations are regular enough that a line scan recovers the routes the
// broken tree lost. Only runs when the AST yielded zero routes, so it never
// duplicates AST results and is a no-op for files with no mappings.
//
// Annotation matches are anchored to the start of the line (`^\s*@`), so a
// mapping mentioned inside a `//`/`/* */` comment or a string literal is not
// mistaken for a real route.

const METHOD_ANNOTATION_RE = /^\s*@(Get|Post|Put|Delete|Patch)Mapping\b\s*(\([^)]*\))?/;
const REQUEST_MAPPING_RE = /^\s*@RequestMapping\b\s*(\([^)]*\))?/;

/** Path string from an annotation's argument text, preferring `value`/`path=` over positional. */
function pathFromArgText(argText: string): string | null {
  const named = argText.match(/(?:value|path)\s*=\s*[[{]?\s*"([^"]*)"/);
  if (named) return named[1]!;
  // Positional: a quoted string right after `(` (skips `produces=`/`consumes=`).
  const positional = argText.match(/^\(\s*[[{]?\s*"([^"]*)"/);
  return positional ? positional[1]! : null;
}

/** HTTP methods named in a regex-scanned `method = ...` attribute (default GET when absent). */
function methodsFromArgText(argText: string): string[] {
  const attr = argText.match(/method\s*=\s*(\[[^\]]*\]|\{[^}]*\}|[\w.]+)/);
  const verbs = attr ? [...attr[1]!.matchAll(HTTP_VERB_RE)].map((m) => m[1]!) : [];
  return verbs.length ? verbs : ["GET"];
}

export function extractSpringRoutesRegex(source: string, routes: RouteInfo[]): void {
  // @FeignClient files declare *outbound* calls with the same annotations — skip them.
  if (/^\s*@FeignClient\b/m.test(source)) return;

  const lines = source.split(/\r?\n/);
  const isMethodLine = (l: string) => /\bfun\s+\w/.test(l) || /\b(public|private|protected|internal)\b.*\(/.test(l);
  const isClassLine = (l: string) => /\b(class|interface)\s+\w/.test(l);

  // Class-level @RequestMapping prefix: the first one followed by a class/interface
  // declaration *before* any method (so a method-level @RequestMapping isn't mistaken for it).
  let classPrefix = "";
  for (let i = 0; i < lines.length && !classPrefix; i++) {
    const rm = lines[i]!.match(REQUEST_MAPPING_RE);
    if (!rm) continue;
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      if (j > i && isMethodLine(lines[j]!)) break; // method-level, not class-level
      if (isClassLine(lines[j]!)) {
        classPrefix = pathFromArgText(rm[1] ?? "") ?? "";
        break;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let methods: string[] | null = null;
    let argText = "";

    const m = line.match(METHOD_ANNOTATION_RE);
    if (m) {
      methods = [m[1]!.toUpperCase()];
      argText = m[2] ?? "";
    } else {
      const rm = line.match(REQUEST_MAPPING_RE);
      if (!rm) continue;
      // Only method-level @RequestMapping (a method follows before any class).
      let isMethod = false;
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        if (isMethodLine(lines[j]!)) { isMethod = true; break; }
        if (j > i && isClassLine(lines[j]!)) break;
      }
      if (!isMethod) continue;
      argText = rm[1] ?? "";
      methods = methodsFromArgText(argText);
    }

    const path = mergePrefix(classPrefix, pathFromArgText(argText) || "/");

    // Handler name: next `fun <name>` (Kotlin) or method signature, skipping stacked annotations.
    let handler: string | null = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (lines[j]!.trimStart().startsWith("@")) continue; // e.g. @PreAuthorize(...)
      const fm = lines[j]!.match(/\bfun\s+(\w+)/) ?? lines[j]!.match(/\b(\w+)\s*\(/);
      if (fm) { handler = fm[1]!; break; }
    }

    for (const httpMethod of methods) {
      routes.push({ path, httpMethod, kind: "api", handler, calls: [], middleware: [], line: i + 1 });
    }
  }
}

