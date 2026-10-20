import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintSpec } from "../shared/handler-taint.js";

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
export function javaTaint(tree: Tree, _sourceText: string, filePath: string): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath);
}
