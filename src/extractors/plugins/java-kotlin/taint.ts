import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";
import { annotationName, annotationNodes } from "./di-annotations.js";

/**
 * Request input followed through a Spring MVC / JAX-RS handler (see
 * `handlerTaint`). A handler is a method carrying a mapping annotation; its
 * request-bound parameters (`@RequestParam`, `@PathVariable`, `@RequestBody`,
 * `@RequestHeader`, `@CookieValue`, JAX-RS `@QueryParam`/`@PathParam`/
 * `@FormParam`/`@HeaderParam`, and Spring's unannotated simple parameters)
 * are tainted, as is anything read off a servlet request
 * (`request.getParameter("q")`). Java has no string interpolation: a
 * literal's text is data, `"…" + name` carries `name`.
 */

const MAPPING = /^(?:GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping|GET|POST|PUT|PATCH|DELETE|Path)$/;
const BOUND = /^(?:RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|RequestPart|ModelAttribute|QueryParam|PathParam|FormParam|HeaderParam|CookieParam|MatrixParam|BeanParam)$/;
/** Types Spring injects rather than binds from the request. */
const INJECTED = /^(?:HttpServletRequest|HttpServletResponse|ServletRequest|ServletResponse|HttpSession|Model|ModelMap|BindingResult|Principal|Authentication|Locale|Pageable|Sort|UriComponentsBuilder|RedirectAttributes|ServerWebExchange|WebRequest|Errors)$/;

const annotationNames = (n: Node): string[] =>
  (n.children.find((c) => c.type === "modifiers")?.namedChildren ?? [])
    .filter((c) => c.type === "annotation" || c.type === "marker_annotation")
    .map((c) => c.childForFieldName("name")?.text.split(".").pop() ?? "");

const spec: TaintSpec = {
  functionTypes: new Set(["method_declaration"]),
  handler(fn) {
    if (!annotationNames(fn).some((a) => MAPPING.test(a))) return null;
    const tainted: string[] = [];
    for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type !== "formal_parameter") continue;
      const name = p.childForFieldName("name")?.text;
      const type = p.childForFieldName("type")?.text.replace(/<.*$/, "") ?? "";
      if (!name) continue;
      // A number, UUID, date or flag carries no path, query or URL text.
      if (/^(?:int|long|short|byte|double|float|boolean|Integer|Long|Short|Byte|Double|Float|Boolean|BigDecimal|BigInteger|UUID|LocalDate|LocalDateTime|Instant|OffsetDateTime|ZonedDateTime)$/.test(type)) continue;
      const anns = annotationNames(p);
      if (anns.some((a) => BOUND.test(a)) || (anns.length === 0 && !INJECTED.test(type))) tainted.push(name);
    }
    return { taintedParams: tainted };
  },
  source: /\b\w*[Rr]equest\.(?:getParameter|getParameterValues|getParameterMap|getHeader|getHeaders|getQueryString|getCookies|getInputStream|getReader|getRequestURI|getPathInfo)\s*\(/,
  assignment(node) {
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      return value && name ? { names: [name], value } : null;
    }
    if (node.type === "assignment_expression") {
      const value = node.childForFieldName("right");
      const left = node.childForFieldName("left");
      return value && left?.type === "identifier" ? { names: [left.text], value } : null;
    }
    return null;
  },
  call(node) {
    if (node.type === "method_invocation") {
      const obj = node.childForFieldName("object")?.text;
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "line_comment" && a.type !== "block_comment");
      return { callee: (obj ? `${obj}.${name}` : name).replace(/\s+/g, ""), args };
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type")?.text;
      if (!type) return null;
      return { callee: `new ${type.replace(/<.*$/, "")}`, args: node.childForFieldName("arguments")?.namedChildren ?? [] };
    }
    return null;
  },
  sanitizer: /^\s*(?:Integer\.(?:parseInt|valueOf)|Long\.(?:parseLong|valueOf)|Double\.parseDouble|Boolean\.parseBoolean|UUID\.fromString|FilenameUtils\.getName|HtmlUtils\.htmlEscape|StringEscapeUtils\.escape\w*|Encode\.\w+|ESAPI\.encoder\(\)\.\w+|URLEncoder\.encode)\s*\(/,
  propagator: /^(?:String\.(?:format|join|valueOf)|Paths\.get|Path\.of|new File|new URL|URI\.create|new URI|.+\.(?:concat|replace|replaceAll|trim|strip|toLowerCase|toUpperCase|substring|formatted|resolve|toString|append))$/,
  ifTypes: new Set(["if_statement"]),
  stringTypes: new Set(["string_literal", "text_block"]),
  sinks: [
    // Verbs only a SQL API has, on any receiver…
    { callee: /\.(?:executeQuery|executeUpdate|executeLargeUpdate|addBatch|prepareStatement|prepareCall|createQuery|createNativeQuery|createSQLQuery|queryForList|queryForObject|queryForMap|queryForRowSet|batchUpdate)$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    // …and the generic ones on a JDBC / JPA / jOOQ-shaped receiver (`repository.update(dto)` is no SQL text).
    { callee: /^(?:this\.)?\w*(?:jdbc|Jdbc|[Tt]emplate|stmt|[Ss]tatement|conn|[Cc]onnection|entityManager|EntityManager|\bem|session|Session|dsl|DSL)\w*\.(?:query|update|execute)$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:Runtime\.getRuntime\(\)\.exec|\w*[Rr]untime\.exec|new ProcessBuilder)$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
    { callee: /^(?:new (?:File|FileInputStream|FileReader|FileOutputStream|FileWriter|RandomAccessFile)|Files\.(?:readAllBytes|readAllLines|readString|lines|newInputStream|newBufferedReader|newOutputStream|write|writeString|delete|deleteIfExists|copy|move))$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
    { callee: /\.(?:getForObject|getForEntity|postForObject|postForEntity|exchange|openConnection|openStream)$|^new URL$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
    { callee: /^\w*(?:[Rr]esponse|resp)\.sendRedirect$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    { callee: /^\w*(?:[Ee]ngine|[Ss]hell)\.eval$/, category: "eval-exec", cwe: "CWE-95", what: "the code" },
  ],
};

/** Request input reaching a sink inside a Spring / JAX-RS handler. */
export function javaTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath, facts);
}

// ─── Kotlin ─────────────────────────────────────────────────────────────────

const ktAnnotations = (n: Node): string[] => annotationNodes(n).map((a) => annotationName(a) ?? "");

/**
 * Kotlin: Spring handlers as in Java (the same annotations, sinks and
 * sanitizers), and Ktor routing — a function that serves routes reads its
 * request through `call` (`call.parameters["q"]`, `call.receiveText()`).
 * Strings interpolate: `"… $name"` and `"… ${expr}"` carry what they name.
 */
const kotlinSpec: TaintSpec = {
  ...spec,
  functionTypes: new Set(["function_declaration"]),
  handler(fn) {
    if (ktAnnotations(fn).some((a) => MAPPING.test(a))) {
      const tainted: string[] = [];
      const list = fn.namedChildren.find((c) => c.type === "function_value_parameters");
      for (const p of list?.namedChildren ?? []) {
        if (p.type !== "parameter") continue;
        const name = p.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        const type = (p.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text ?? "").replace(/[<?].*$/, "");
        if (!name) continue;
        if (/^(?:Int|Long|Short|Byte|Double|Float|Boolean|BigDecimal|BigInteger|UUID|LocalDate|LocalDateTime|Instant|OffsetDateTime|ZonedDateTime)$/.test(type)) continue;
        const anns = ktAnnotations(p);
        if (anns.some((a) => BOUND.test(a)) || (anns.length === 0 && !INJECTED.test(type))) tainted.push(name);
      }
      return { taintedParams: tainted };
    }
    // Ktor: a routing function reads the request off `call`.
    const body = fn.namedChildren.find((c) => c.type === "function_body")?.text ?? "";
    return /\brouting\s*\{|\b(?:get|post|put|patch|delete)\s*\(\s*"/.test(body) && /\bcall\./.test(body) ? { taintedParams: [] } : null;
  },
  source: /\b\w*[Rr]equest\.(?:getParameter|getParameterValues|getHeader|getQueryString|getInputStream|getReader|getRequestURI|getPathInfo)\s*\(|\bcall\.(?:parameters|request\.(?:queryParameters|headers|cookies)|receiveText|receiveParameters|receive)\b/,
  assignment(node) {
    if (node.type === "property_declaration") {
      const name = node.namedChildren.find((c) => c.type === "variable_declaration")?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const value = node.namedChildren[node.namedChildren.length - 1];
      return name && value && value.type !== "variable_declaration" ? { names: [name], value } : null;
    }
    if (node.type === "assignment") {
      const left = node.namedChildren[0];
      const value = node.namedChildren[node.namedChildren.length - 1];
      return left && value && /^\w+$/.test(left.text) ? { names: [left.text], value } : null;
    }
    return null;
  },
  call(node) {
    if (node.type !== "call_expression") return null;
    const head = node.child(0);
    if (!head || head.type === "call_expression") return null;
    const callee = head.text.replace(/\s+/g, "").replace(/\?\./g, ".");
    const args = (node.namedChildren.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? [])
      .map((a) => (a.type === "value_argument" ? a.namedChildren[a.namedChildren.length - 1] ?? a : a));
    // `ProcessBuilder(cmd)` / `File(path)`: Kotlin constructs without `new`.
    return { callee: /^(?:File|FileInputStream|FileReader|FileOutputStream|FileWriter|RandomAccessFile|ProcessBuilder|URL)$/.test(callee) ? `new ${callee}` : callee, args };
  },
  sanitizer: /^\s*(?:Integer\.(?:parseInt|valueOf)|Long\.(?:parseLong|valueOf)|UUID\.fromString|FilenameUtils\.getName|HtmlUtils\.htmlEscape|URLEncoder\.encode)\s*\(|\.(?:toInt|toLong|toDouble|toBoolean|toIntOrNull|toLongOrNull)\s*\(\s*\)\s*$/,
  propagator: /^(?:String\.format|Paths\.get|Path\.of|new File|new URL|URI\.create|.+\.(?:plus|replace|trim|lowercase|uppercase|substring|format|resolve|toString|joinToString))$|^(?:buildString|listOf|arrayOf)$/,
  ifTypes: new Set(["if_expression"]),
  condition: (n) => n.namedChildren[0] ?? null,
  stringTypes: new Set(["string_literal", "multiline_string_literal"]),
  interpolationTypes: new Set(["interpolated_identifier", "interpolated_expression"]),
  functionName: (fn) => fn.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null,
  paramNames: (fn) => (fn.namedChildren.find((c) => c.type === "function_value_parameters")?.namedChildren ?? []).filter((p) => p.type === "parameter").map((p) => p.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? "").filter(Boolean),
  returnTypes: new Set(["jump_expression"]),
};

/** Request input reaching a sink inside a Kotlin Spring handler or Ktor routing function. */
export function kotlinTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, kotlinSpec, filePath, facts);
}
