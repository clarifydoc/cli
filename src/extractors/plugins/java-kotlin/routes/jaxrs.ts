import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { findChildByType, getNameFromNode } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import {
  isAnnotationNode,
  annotationSimpleName,
  annotationArgsNode,
  extractAnnotationPath,
  mergePrefix,
  declarationHasAnnotation,
} from "./spring.js";
import { applyRouteMeta, type GuardAttr } from "../../../shared/route-metadata.js";
import { guardsOn, routeParamsOf } from "./meta-annotations.js";

/**
 * JAX-RS (Jersey / RESTEasy / Quarkus) and Micronaut inbound routes.
 *
 * JAX-RS splits the declaration Spring merges into one annotation:
 *
 *   @Path("/users")            // class-level prefix
 *   public class UserResource {
 *     @GET                     // verb is a MARKER (never takes arguments)
 *     @Path("{id}")            // optional method-level subpath
 *     public User get(...) {}
 *   }
 *
 * Micronaut uses Spring-like verbs with Micronaut casing:
 *
 *   @Controller("/users")
 *   class UserController {
 *     @Get("/{id}") fun get(...) { }
 *   }
 *
 * The argument-less requirement on JAX-RS verbs is load-bearing: Retrofit
 * declares OUTBOUND calls with the same names but always passes the path as an
 * argument (`@GET("users/{id}")`), so requiring a marker keeps client
 * interfaces from minting phantom inbound routes. MicroProfile REST-client
 * interfaces (`@RegisterRestClient`) are outbound too and skipped wholesale.
 */

const JAXRS_VERBS: ReadonlySet<string> = new Set([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
]);
const MICRONAUT_VERBS: ReadonlySet<string> = new Set([
  "Get", "Post", "Put", "Delete", "Patch", "Head", "Options",
]);

/** All annotations on a declaration — direct children plus the `modifiers` block. */
function annotationsOf(decl: Node): Node[] {
  const out: Node[] = [];
  for (const child of decl.children) {
    if (isAnnotationNode(child)) out.push(child);
    if (child.type === "modifiers") {
      for (const mod of child.children) if (isAnnotationNode(mod)) out.push(mod);
    }
  }
  return out;
}

/** Path argument of an annotation (`@Path("x")` / `@Get("/x")`), null if none. */
function annotationPath(ann: Node): string | null {
  const args = annotationArgsNode(ann);
  return args ? extractAnnotationPath(args) : null;
}

const CLASS_TYPES = new Set(["class_declaration", "class_definition", "interface_declaration"]);
const METHOD_TYPES = new Set(["method_declaration", "function_declaration"]);

export function extractJaxrsMicronautRoutes(root: Node, routes: RouteInfo[]): void {
  walk(root, routes, "", "none", [], packageOf(root));
}

/** The file's package (`package com.acme.api;`, Kotlin `package com.acme.api`), "" for the default package. */
function packageOf(root: Node): string {
  for (const child of root.children) {
    if (child.type !== "package_declaration" && child.type !== "package_header") continue;
    const m = /package\s+([\w.]+)/.exec(child.text);
    if (m) return m[1]!;
  }
  return "";
}

type Flavor = "none" | "jaxrs" | "micronaut";

function walk(
  node: Node,
  routes: RouteInfo[],
  classPrefix: string,
  flavor: Flavor,
  classGuards: readonly GuardAttr[],
  /** Qualified name of the enclosing type (the package, outside any type). */
  owner: string,
): void {
  if (CLASS_TYPES.has(node.type)) {
    // Outbound-client interfaces reuse the same annotations — never routes.
    if (
      declarationHasAnnotation(node, "RegisterRestClient") ||
      declarationHasAnnotation(node, "Client") // Micronaut @Client("...")
    ) {
      return;
    }
    let prefix = classPrefix;
    let childFlavor = flavor;
    for (const ann of annotationsOf(node)) {
      const name = annotationSimpleName(ann);
      if (name === "Path") {
        prefix = annotationPath(ann) ?? prefix;
        childFlavor = "jaxrs";
      } else if (name === "Controller") {
        // Micronaut carries the prefix in @Controller("/x"); Spring MVC's
        // bare @Controller has no path and its methods use *Mapping names
        // that this walk never matches, so claiming it here is harmless.
        prefix = annotationPath(ann) ?? prefix;
        childFlavor = "micronaut";
      }
    }
    const guards = [...classGuards, ...guardsOn(node)];
    const name = node.childForFieldName("name")?.text ?? findChildByType(node, "type_identifier")?.text;
    const type = name ? (owner ? `${owner}.${name}` : name) : owner;
    for (const child of node.children) walk(child, routes, prefix, childFlavor, guards, type);
    return;
  }

  if (METHOD_TYPES.has(node.type)) {
    emitMethodRoutes(node, routes, classPrefix, flavor, classGuards, owner);
    // Fall through: Kotlin nests local declarations inside function bodies.
  }

  for (const child of node.children) walk(child, routes, classPrefix, flavor, classGuards, owner);
}

function emitMethodRoutes(
  method: Node,
  routes: RouteInfo[],
  classPrefix: string,
  flavor: Flavor,
  classGuards: readonly GuardAttr[],
  owner: string,
): void {
  let verb: string | null = null;
  let subPath: string | null = null;
  let micronautLine = 0;

  for (const ann of annotationsOf(method)) {
    const name = annotationSimpleName(ann);
    if (!name) continue;

    // JAX-RS: verb is a marker — an argument means Retrofit-style outbound.
    if (JAXRS_VERBS.has(name) && !annotationArgsNode(ann)) {
      verb = name;
      micronautLine = ann.startPosition.row + 1;
      continue;
    }
    if (name === "Path") {
      subPath = annotationPath(ann);
      continue;
    }
    // Micronaut: @Get / @Get("/x") — only inside an @Controller class.
    if (flavor === "micronaut" && MICRONAUT_VERBS.has(name)) {
      verb = name.toUpperCase();
      subPath = annotationPath(ann) ?? subPath;
      micronautLine = ann.startPosition.row + 1;
    }
  }

  if (!verb) return;
  // A JAX-RS verb outside any @Path context is not evidence of a resource.
  if (flavor === "none" && !classPrefix && subPath === null) return;

  const lang = method.type === "function_declaration" ? ("kotlin" as const) : ("java" as const);
  const body =
    method.childForFieldName("body") ??
    findChildByType(method, "function_body") ??
    findChildByType(method, "block");

  const merged = mergePrefix(classPrefix, subPath ?? "/");
  const path = merged.startsWith("/") ? merged : "/" + merged;
  const handler = getNameFromNode(method);
  const route: RouteInfo = {
    path,
    httpMethod: verb,
    kind: "api",
    handler,
    // The typed operation this route is: what a client proxy of the same
    // interface invokes, wherever the resource is mounted.
    ...(handler && owner ? { contract: { type: owner, method: handler } } : {}),
    calls: body ? extractCalls(body, lang) : [],
    middleware: [],
    line: micronautLine || method.startPosition.row + 1,
  };
  applyRouteMeta(route, {
    inheritedGuards: classGuards,
    guards: guardsOn(method),
    params: routeParamsOf(method, path, flavor === "micronaut" ? "micronaut" : "jaxrs"),
  });
  routes.push(route);
}
