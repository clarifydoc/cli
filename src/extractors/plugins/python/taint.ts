import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { boundIdentifiers, handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/** `@app.route(…)`, `@router.get(…)`, `@bp.post(…)`, `@api_view(…)`. */
const ROUTE_DECORATOR = /^@\s*[\w.]*\b(?:route|get|post|put|patch|delete|api_view|websocket)\s*\(/;
/** Parameters a framework fills from somewhere other than the request. */
const NOT_INPUT = /^(?:self|cls|request|req|response|db|session|background_tasks|current_user|user|settings|app)$/;
/**
 * Parameter annotations that leave the value free text: none, `str`, an
 * optional or union of `str`. Anything else is validated by the framework into
 * something narrower (int, UUID, an enum, a model).
 */
const FREE_TEXT_TYPE = /^(?:|str|Optional\[str\]|str\s*\|\s*None|None\s*\|\s*str|Annotated\[str\b.*)$/;

const spec: TaintSpec = {
  functionTypes: new Set(["function_definition"]),
  handler(fn) {
    const params = fn.childForFieldName("parameters")?.namedChildren ?? [];
    const names = params.map(paramName);
    const decorated = fn.parent?.type === "decorated_definition"
      ? fn.parent.namedChildren.filter((c) => c.type === "decorator").some((d) => ROUTE_DECORATOR.test(d.text))
      : false;
    // A view taking the request object (Django, Flask's `request` global is the source regex's).
    const takesRequest = names.includes("request") || names.includes("req");
    if (!decorated && !takesRequest) return null;
    if (!decorated) return { taintedParams: [] };
    // Route parameters and FastAPI query/body params: plain or str-typed, no Depends().
    const tainted: string[] = [];
    params.forEach((p, i) => {
      const n = names[i];
      if (!n || NOT_INPUT.test(n) || /Depends\s*\(|Security\s*\(/.test(p.text)) return;
      const type = (p.childForFieldName("type")?.text ?? "").replace(/\s+/g, " ").trim();
      if (!FREE_TEXT_TYPE.test(type)) return;
      tainted.push(n);
    });
    return { taintedParams: tainted };
  },
  source: /\brequest\.(?:args|form|json|values|files|cookies|headers|data|get_json\s*\(|GET|POST|body|query_params|path_params)\b/,
  assignment(node) {
    if (node.type !== "assignment" && node.type !== "augmented_assignment") return null;
    const value = node.childForFieldName("right");
    if (!value) return null;
    const names = boundIdentifiers(node.childForFieldName("left"));
    // `x += y` keeps x's taint and adds y's.
    return { names: node.type === "augmented_assignment" ? names : names, value };
  },
  call(node) {
    if (node.type !== "call") return null;
    const callee = node.childForFieldName("function")?.text;
    if (!callee) return null;
    const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
    return { callee: callee.replace(/\s+/g, ""), args };
  },
  sanitizer: /^\s*(?:int|float|bool|abs|len|uuid\.UUID|UUID|shlex\.quote|quote|secure_filename|os\.path\.basename|basename|html\.escape|escape|bleach\.clean|markupsafe\.escape|urllib\.parse\.quote)\s*\(|^\s*(?:pathlib\.)?(?:Pure)?Path\s*\(.*\)\.name\s*$/s,
  propagator: /^(?:os\.path\.(?:join|abspath|normpath|realpath|expanduser)|(?:pathlib\.)?(?:Pure)?Path|str|f|urljoin|urllib\.parse\.(?:urljoin|urlunparse)|.+\.(?:joinpath|format|replace|strip|lstrip|rstrip|lower|upper|encode|decode|join|get|copy|urlencode|split))$/,
  ifTypes: new Set(["if_statement", "elif_clause"]),
  sinks: [
    { callee: /(?:^|\.)(?:execute|executemany|executescript|raw)$|^(?:sqlalchemy\.)?text$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput))$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
    { callee: /^(?:open|io\.open|send_file|FileResponse|os\.(?:remove|unlink|rmdir)|shutil\.(?:rmtree|copy|move))$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
    { callee: /^(?:requests|httpx|session|client)\.(?:get|post|put|patch|delete|head)$|^(?:urllib\.request\.)?urlopen$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
    { callee: /^(?:redirect|RedirectResponse|HttpResponseRedirect)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    { callee: /^(?:eval|exec)$/, category: "eval-exec", cwe: "CWE-95", what: "the code" },
  ],
};

function paramName(p: Node): string | undefined {
  if (p.type === "identifier") return p.text;
  const named = p.childForFieldName("name") ?? p.namedChildren.find((c) => c.type === "identifier");
  return named?.text;
}

/** Request input reaching a sink inside a Python request handler (see `handlerTaint`). */
export function pythonTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath, facts);
}
