import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintSpec } from "../shared/handler-taint.js";

/**
 * Request input followed through PHP request handling (see `handlerTaint`):
 * a controller action (a public method of a `…Controller` class, or any
 * function taking a `Request`), whose route parameters and request object
 * are input, and a plain script's top level reading the superglobals
 * (`$_GET`, `$_POST`, …). `$request->input('q')` and friends are request
 * input; a double-quoted string's `$var` interpolations carry taint, a
 * single-quoted string never does.
 */

const INJECTED_TYPE = /(?:Service|Repository|Manager|Logger|Interface|Factory|Provider|Client)$|^(?:EntityManagerInterface|Connection|PDO)$/;
const SUPERGLOBAL = /\$_(?:GET|POST|REQUEST|COOKIE|FILES|SERVER)\b/;

function enclosingClassName(n: Node): string | null {
  for (let p = n.parent; p; p = p.parent) if (p.type === "class_declaration") return p.childForFieldName("name")?.text ?? null;
  return null;
}

const spec: TaintSpec = {
  functionTypes: new Set(["program", "function_definition", "method_declaration"]),
  handler(fn) {
    // A script: its own top level, when it reads the superglobals.
    if (fn.type === "program") return SUPERGLOBAL.test(fn.text) ? { taintedParams: [] } : null;
    const params = (fn.childForFieldName("parameters")?.namedChildren ?? []).filter((p) => p.type === "simple_parameter");
    const typed = (p: Node) => p.childForFieldName("type")?.text.replace(/^\?/, "").split("\\").pop() ?? "";
    const takesRequest = params.some((p) => /^(?:Request|\w+Request|ServerRequestInterface)$/.test(typed(p)));
    const isAction = fn.type === "method_declaration" && /Controller$/.test(enclosingClassName(fn) ?? "") && !/\bprivate\b|\bprotected\b/.test(fn.children.filter((c) => c.type === "visibility_modifier").map((c) => c.text).join(" "));
    if (!takesRequest && !isAction && !SUPERGLOBAL.test(fn.text)) return null;
    // Route parameters (`show($id)`, `show(Post $post)` model binding) are input; injected services are not.
    const tainted = params
      .filter((p) => !/^(?:Request|\w+Request|ServerRequestInterface)$/.test(typed(p)) && !INJECTED_TYPE.test(typed(p)))
      .map((p) => p.childForFieldName("name")?.text)
      .filter((n): n is string => !!n);
    return { taintedParams: isAction || takesRequest ? tainted : [] };
  },
  source: /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b|\$\w*[Rr]equest->(?:input|get|query|post|all|only|cookie|header|json|route|string|integer|str|file|getContent|request|query->get|request->get)\b|\brequest\(\)->(?:input|get|query|all)\b|\bRequest::(?:input|get|query|all)\s*\(|\$\w*[Rr]equest->(?:query|request|cookies|headers)->get\s*\(/,
  assignment(node) {
    if (node.type !== "assignment_expression" && node.type !== "augmented_assignment_expression") return null;
    const left = node.childForFieldName("left");
    const value = node.childForFieldName("right");
    return value && left?.type === "variable_name" ? { names: [left.text], value } : null;
  },
  call(node) {
    if (node.type === "function_call_expression") {
      const fn = node.childForFieldName("function")?.text;
      return fn ? { callee: fn.replace(/^\\/, ""), args: argsOf(node) } : null;
    }
    if (node.type === "member_call_expression" || node.type === "nullsafe_member_call_expression") {
      const obj = node.childForFieldName("object")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      return { callee: `${obj}->${name}`, args: argsOf(node) };
    }
    if (node.type === "scoped_call_expression") {
      const scope = node.childForFieldName("scope")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      return { callee: `${scope.split("\\").pop()}::${name}`, args: argsOf(node) };
    }
    return null;
  },
  sanitizer: /^\s*(?:intval|floatval|boolval|\(int\)|\(float\)|htmlspecialchars|htmlentities|strip_tags|escapeshellarg|escapeshellcmd|basename|filter_var|filter_input|urlencode|rawurlencode|addslashes|mysqli_real_escape_string|pg_escape_string|\$\w+->quote|e)\s*\(/,
  propagator: /^(?:sprintf|vsprintf|implode|join|str_replace|trim|ltrim|rtrim|strtolower|strtoupper|substr|urldecode|rawurldecode|base64_decode|json_decode|.+->(?:trim|lower|upper|toString))$/,
  ifTypes: new Set(["if_statement"]),
  stringTypes: new Set(["encapsed_string", "heredoc", "nowdoc"]),
  interpolationTypes: new Set(["variable_name", "member_access_expression", "subscript_expression", "dynamic_variable_name"]),
  sinks: [
    // SQL text to a connection (PDO, mysqli, Laravel's DB, Doctrine's EntityManager)…
    { callee: /^(?:\$\w*(?:pdo|db|conn|connection|mysqli|dbh|database|em|entityManager)\w*|DB|\$this->(?:db|pdo|connection|conn|em|entityManager))(?:->|::)(?:query|exec|prepare|select|insert|update|delete|statement|unprepared|executeQuery|executeStatement|createQuery|createNativeQuery)$/i, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    // …or a query builder's raw fragment on any receiver.
    { callee: /->(?:whereRaw|orWhereRaw|selectRaw|orderByRaw|havingRaw|groupByRaw)$|^DB::raw$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:mysqli_query|mysql_query|sqlite_query|mysqli_multi_query)$/, arg: 1, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^pg_query$/, arg: 1, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:exec|shell_exec|system|passthru|popen|proc_open|pcntl_exec)$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
    { callee: /^(?:file_get_contents|fopen|readfile|file|unlink|file_put_contents|fpassthru|parse_ini_file|show_source|highlight_file)$|^(?:Storage|File)::(?:get|put|delete|download)$|^response\(\)->(?:download|file)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
    { callee: /^(?:curl_init|fsockopen|get_headers)$|^Http::(?:get|post|put|patch|delete|send)$|^\$\w*(?:client|http|guzzle)\w*->(?:request|get|post|put|patch|delete)$/i, category: "ssrf", cwe: "CWE-918", what: "the URL" },
    { callee: /^redirect$|^redirect\(\)->(?:to|away)$|^Redirect::(?:to|away)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    { callee: /^(?:eval|assert|create_function|unserialize)$/, category: "eval-exec", cwe: "CWE-95", what: "the code" },
  ],
};

function argsOf(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument").map((a) => a.namedChildren[a.namedChildren.length - 1] ?? a);
}

/** Request input reaching a sink in a PHP controller action, request-taking function or script. */
export function phpTaint(tree: Tree, _sourceText: string, filePath: string): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath);
}
