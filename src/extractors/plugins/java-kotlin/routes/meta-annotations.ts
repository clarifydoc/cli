import type { Node } from "web-tree-sitter";
import type { RouteParamBinding, RouteParamInfo } from "../../../../types/analysis.js";
import { findChildByType, stripQuotes } from "../../../shared/node-helpers.js";
import { inferredParam, type GuardAttr } from "../../../shared/route-metadata.js";
import { annotationSimpleName, annotationArgsNode, isAnnotationNode } from "./spring.js";

/**
 * The attribute layer of a JVM route — who may call it and where each
 * handler parameter binds from — read off Spring Security, Jakarta
 * (`jakarta.annotation.security`), JAX-RS and Micronaut annotations. Shared
 * by the Spring and JAX-RS/Micronaut extractors; grammar differences between
 * Java and Kotlin are absorbed by the accessors in `spring.ts`.
 */

/** All annotations on a declaration — direct children plus the `modifiers` block. */
export function annotationsOn(decl: Node): Node[] {
  const out: Node[] = [];
  for (const child of decl.children) {
    if (isAnnotationNode(child)) out.push(child);
    if (child.type === "modifiers" || child.type === "parameter_modifiers") {
      for (const mod of child.children) if (isAnnotationNode(mod)) out.push(mod);
    }
  }
  return out;
}

/** Every string literal under an annotation's arguments, in order. */
function annotationStrings(ann: Node): string[] {
  const args = annotationArgsNode(ann);
  if (!args) return [];
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === "string" || n.type === "string_literal") {
      out.push(stripQuotes(n.text));
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(args);
  return out;
}

/** The request value a binding annotation names: `@PathVariable("id")`, `@RequestParam(value = "q", required = false)`. */
function boundName(ann: Node): string | null {
  const text = annotationText(ann);
  const m = /^[\w.]+\s*\(\s*"([^"]+)"/.exec(text) ?? /[(,]\s*(?:value|name)\s*=\s*"([^"]+)"/.exec(text);
  return m && /^[A-Za-z_][\w.-]*$/.test(m[1]!) ? m[1]! : null;
}

function annotationText(ann: Node): string {
  return ann.text.replace(/^@/, "").replace(/\s+/g, " ");
}

/**
 * A security annotation as a guard, or null for anything else.
 *   Spring Security  @PreAuthorize("hasRole('ADMIN')") / @PostAuthorize → policy (the expression)
 *                    @Secured({"ROLE_A"})                              → roles
 *   Jakarta / JAX-RS @RolesAllowed("X") / @PermitAll / @DenyAll
 *   Micronaut        @Secured("isAuthenticated()") / @Secured({"ROLE_A"})
 */
export function guardOf(ann: Node): GuardAttr | null {
  const name = annotationSimpleName(ann);
  if (!name) return null;
  const text = annotationText(ann);
  switch (name) {
    case "PreAuthorize":
    case "PostAuthorize":
    case "PreFilter":
    case "PostFilter":
      return { text, policies: annotationStrings(ann) };
    case "Secured": {
      const values = annotationStrings(ann);
      // Micronaut spells rules as expressions (`isAuthenticated()`), Spring as role names.
      const roles = values.filter((v) => !v.includes("("));
      const policies = values.filter((v) => v.includes("("));
      return { text, roles, policies };
    }
    case "RolesAllowed":
      return { text, roles: annotationStrings(ann) };
    case "PermitAll":
    case "Anonymous": // Quarkus
      return { text, anonymous: true };
    case "DenyAll":
      return { text, policies: ["DenyAll"] };
    case "Authenticated": // Quarkus
      return { text, policies: ["Authenticated"] };
    default:
      return null;
  }
}

export function guardsOn(decl: Node): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const ann of annotationsOn(decl)) {
    const g = guardOf(ann);
    if (g) out.push(g);
  }
  return out;
}

// ─── Parameters ───────────────────────────────────────────────────────────

const BINDING_ANNOTATIONS: Record<string, RouteParamBinding> = {
  // Spring MVC / WebFlux
  RequestBody: "body",
  RequestParam: "query",
  PathVariable: "route",
  RequestHeader: "header",
  CookieValue: "header",
  ModelAttribute: "form",
  RequestPart: "form",
  RequestAttribute: "services",
  SessionAttribute: "services",
  AuthenticationPrincipal: "services",
  CurrentSecurityContext: "services",
  // JAX-RS
  PathParam: "route",
  QueryParam: "query",
  HeaderParam: "header",
  CookieParam: "header",
  FormParam: "form",
  MatrixParam: "query",
  BeanParam: "query",
  Context: "services",
  // Micronaut
  Body: "body",
  QueryValue: "query",
  Header: "header",
  Part: "form",
};

/** Types the framework injects rather than binds from the request. */
const FRAMEWORK_TYPES = new Set([
  "Principal", "Authentication", "HttpServletRequest", "HttpServletResponse", "HttpSession",
  "ServletRequest", "ServletResponse", "WebRequest", "NativeWebRequest", "ServerWebExchange",
  "ServerHttpRequest", "ServerHttpResponse", "Model", "ModelMap", "ModelAndView", "BindingResult",
  "Errors", "Locale", "TimeZone", "ZoneId", "UriComponentsBuilder", "RedirectAttributes",
  "SessionStatus", "HttpMethod", "InputStream", "OutputStream", "Reader", "Writer",
  "SecurityContext", "UriInfo", "HttpHeaders", "Request", "Response", "ContainerRequestContext",
  "Continuation", "CoroutineContext", "HttpRequest", "MutableHttpRequest",
]);

/** Simple (single-value) types that bind from the query/route, never the body. */
const SIMPLE_TYPES = new Set([
  "String", "CharSequence", "int", "Integer", "Int", "long", "Long", "short", "Short", "byte", "Byte",
  "double", "Double", "float", "Float", "boolean", "Boolean", "char", "Character", "Char",
  "BigDecimal", "BigInteger", "UUID", "LocalDate", "LocalDateTime", "LocalTime", "Instant", "Date",
  "ZonedDateTime", "OffsetDateTime", "Duration", "Period", "Year", "YearMonth", "URI", "URL",
]);

export type JvmFlavor = "spring" | "jaxrs" | "micronaut";

function isSimpleType(type: string | null): boolean {
  if (!type) return true;
  const bare = type.replace(/\?$/, "").replace(/^(java\.[\w.]+\.|kotlin\.)/, "");
  if (SIMPLE_TYPES.has(bare)) return true;
  const generic = bare.match(/^(?:Optional|List|Set|Collection|Iterable|Array|MutableList|ArrayList)<([\w.]+)\??>$/);
  if (generic && SIMPLE_TYPES.has(generic[1]!.replace(/^.*\./, ""))) return true;
  return /\[\]$/.test(bare) && SIMPLE_TYPES.has(bare.slice(0, -2));
}

/** Framework default binding for a parameter carrying no binding annotation. */
function defaultBinding(flavor: JvmFlavor, type: string | null): RouteParamBinding | null {
  if (flavor === "jaxrs") return "body"; // the unannotated parameter IS the entity
  if (flavor === "micronaut") return isSimpleType(type) ? "query" : "body";
  // Spring: simple values come from the query string; a complex type is an
  // implicit @ModelAttribute (form/query binding) — NOT the request body.
  return isSimpleType(type) ? "query" : "form";
}

interface JvmParam {
  name: string;
  type: string | null;
  annotations: Node[];
}

/** Java `formal_parameters` and Kotlin `function_value_parameters` in one shape. */
function parametersOf(method: Node): JvmParam[] {
  const out: JvmParam[] = [];
  const list =
    method.childForFieldName("parameters") ??
    findChildByType(method, "formal_parameters") ??
    findChildByType(method, "function_value_parameters");
  if (!list) return out;
  // Kotlin puts the annotations in a `parameter_modifiers` SIBLING before the
  // `parameter`; Java nests them under the parameter's `modifiers`.
  let pending: Node[] = [];
  for (const child of list.children) {
    if (child.type === "parameter_modifiers") {
      pending = annotationsOn(child);
      continue;
    }
    if (child.type === "formal_parameter" || child.type === "spread_parameter") {
      const name = child.childForFieldName("name")?.text ?? findChildByType(child, "identifier")?.text ?? "_";
      const type = child.childForFieldName("type")?.text ?? javaTypeText(child);
      out.push({ name, type, annotations: annotationsOn(child) });
    } else if (child.type === "parameter") {
      const name = findChildByType(child, "simple_identifier")?.text ?? "_";
      const typeNode = child.children.find((c) => c.type !== "simple_identifier" && c.type !== ":");
      out.push({ name, type: typeNode?.text ?? null, annotations: [...pending, ...annotationsOn(child)] });
      pending = [];
    }
  }
  return out;
}

function javaTypeText(param: Node): string | null {
  for (const c of param.children) {
    if (c.type === "modifiers" || c.type === "identifier" || c.type === "...") continue;
    if (/type|identifier/.test(c.type)) return c.text;
  }
  return null;
}

/** The route's handler parameters with their bindings. */
export function routeParamsOf(method: Node, path: string, flavor: JvmFlavor): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  for (const p of parametersOf(method)) {
    const bare = (p.type ?? "").replace(/<.*$/s, "").replace(/\?$/, "").replace(/^.*\./, "");
    let explicit: RouteParamBinding | null = null;
    let requestName: string | null = null;
    for (const ann of p.annotations) {
      const b = BINDING_ANNOTATIONS[annotationSimpleName(ann) ?? ""];
      if (b) {
        explicit = b;
        requestName = b === "route" || b === "query" ? boundName(ann) : null;
        break;
      }
    }
    if (explicit) {
      // `@PathVariable("id") Long clubId`: the request names it `id`, the handler `clubId`.
      out.push(requestName && requestName !== p.name ? { name: requestName, type: p.type, binding: explicit, variable: p.name } : { name: p.name, type: p.type, binding: explicit });
    } else if (FRAMEWORK_TYPES.has(bare)) {
      out.push({ name: p.name, type: p.type, binding: "services", inferred: true });
    } else {
      out.push(inferredParam(p.name, p.type, path, defaultBinding(flavor, p.type)));
    }
  }
  return out;
}
