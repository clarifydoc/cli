import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/**
 * The parameter types that make a function a request handler: Gin, Echo, Fiber and Buffalo
 * contexts, and `net/http`'s `*http.Request` (chi, gorilla/mux, the standard mux and every router built on them).
 * `context.Context` alone is no request.
 */
const REQUEST_TYPE = /^\*?(?:gin\.Context|echo\.Context|fiber\.Ctx|buffalo\.Context|http\.Request)$/;

/** Calls that make a request's text into a value of another kind, and calls whose name says they clean it: the result is clean. */
const SANITIZER = /^\s*(?:len|cap|u?int(?:8|16|32|64)?|float(?:32|64)|bool|strconv\.(?:Atoi|Itoa|Parse\w+|Quote\w*|FormatInt|FormatUint)|url\.(?:QueryEscape|PathEscape)|html\.EscapeString|template\.(?:HTMLEscapeString|JSEscapeString|URLQueryEscaper)|filepath\.Base|path\.Base|uuid\.(?:Parse|MustParse)|shellescape\.Quote|pq\.Quote(?:Identifier|Literal)|bluemonday\.\w+|\w+\.(?:Sanitize|Escape|Len))\s*\(|^\s*(?!(?:filepath|path)\.Clean\b)[\w.]*(?:[Cc]lean|[Ss]anitiz|[Ee]scape|[Qq]uote|[Vv]alidat|[Nn]ormali[sz]e)[\w.]*\s*\(/;

/**
 * A name on the way to a SQL call that says it is a database handle: `db`, `h.db`, `s.DB`, `tx`, `conn`, `pool`, `stmt`,
 * `gorm.DB`, `db.WithContext(ctx)`. A method named `Query` on `repo` or `store` is as likely a lookup of its own: not judged.
 */
const DB_HANDLE = "(?=.*\\b(?:[dD][bB]\\w*|\\w*(?:DB|Db)\\w*|[tT]x|\\w*Tx|[cC]onn\\w*|\\w*Conn|[pP]ool\\w*|\\w*Pool|[sS]tmt\\w*|\\w*Stmt|[dD]atabase|[gG]orm\\w*|[sS]qlx?\\w*|\\w*Sql\\w*|\\w*SQL\\w*|[sS]ession|[rR]ows)\\b)";

/** A condition that checks the value: a prefix test, a membership test, a parse, a comma-ok lookup in a table. */
const GUARD = /\b(?:HasPrefix|HasSuffix|Contains|MatchString|IsAbs|Rel|Parse\w*|Atoi|Valid\w*|Is[A-Z]\w*)\s*\(|:=\s*[\w.]+\[/;

/** The names a handler's context or request parameters carry, over the whole file: source reads are looked for on these only. */
function contextNames(root: Node): string[] {
  const names = new Set<string>();
  const visit = (n: Node): void => {
    if (n.type === "parameter_declaration") {
      const type = (n.childForFieldName("type")?.text ?? "").replace(/\s+/g, "");
      if (REQUEST_TYPE.test(type)) for (const id of n.childrenForFieldName("name")) names.add(id.text);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return [...names];
}

function paramNamesOf(fn: Node): string[] {
  const list = fn.childForFieldName("parameters");
  const out: string[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue;
    for (const id of p.childrenForFieldName("name")) out.push(id.text);
  }
  return out;
}

function identifiersOf(list: Node | null): string[] {
  if (!list) return [];
  if (list.type === "identifier") return [list.text];
  return list.namedChildren.filter((c) => c.type === "identifier" && c.text !== "_").map((c) => c.text);
}

function buildSpec(names: readonly string[]): TaintSpec {
  const recv = names.length ? `(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})` : "(?!)";
  // Request input read from a context or request parameter, or through the router libraries' own accessors.
  const source = new RegExp(
    `(?<![\\w.])${recv}\\.(?:Query|DefaultQuery|QueryParam|QueryParams|QueryArray|QueryMap|GetQuery|GetQueryArray|Param|Params|ParamsInt|ParamValues|PostForm|PostFormArray|DefaultPostForm|GetPostForm|FormValue|PostFormValue|PathValue|GetHeader|Cookie|Request(?:\\(\\))?\\.(?:URL|Form|PostForm|FormValue|PostFormValue|Header|PathValue|Cookie))\\b` +
    `|(?<![\\w.])${recv}\\.(?:URL\\.(?:Query\\(\\)|Path|RawQuery)|Form\\b|PostForm\\b|Header\\.Get\\s*\\(|Referer\\s*\\()` +
    `|\\bchi\\.URLParam(?:FromCtx)?\\s*\\(|\\bmux\\.Vars\\s*\\(`,
  );
  // A database call is made on a database handle, never on the request's own context (`c.Query("name")` reads input).
  const notContext = names.length ? `(?!${recv}\\.)` : "";
  return {
    functionTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
    handler(fn) {
      const handles = (fn.childForFieldName("parameters")?.namedChildren ?? []).some((p) => p.type === "parameter_declaration" && REQUEST_TYPE.test((p.childForFieldName("type")?.text ?? "").replace(/\s+/g, "")));
      return handles ? { taintedParams: [] } : null;
    },
    source,
    assignment(node) {
      if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
        const value = node.childForFieldName("right");
        if (!value) return null;
        const op = node.childForFieldName("operator")?.text ?? "=";
        return { names: identifiersOf(node.childForFieldName("left")), value, ...(op !== "=" ? { keep: true } : {}) };
      }
      if (node.type === "var_spec") {
        const value = node.childForFieldName("value");
        return value ? { names: node.childrenForFieldName("name").map((n) => n.text), value } : null;
      }
      if (node.type === "range_clause") {
        const value = node.childForFieldName("right");
        return value ? { names: identifiersOf(node.childForFieldName("left")), value } : null;
      }
      return null;
    },
    call(node) {
      if (node.type !== "call_expression") return null;
      const callee = node.childForFieldName("function")?.text;
      if (!callee) return null;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
      return { callee: callee.replace(/\s+/g, ""), args };
    },
    sanitizer: SANITIZER,
    fileNameSanitizers: [{ call: /^\s*(?:filepath|path)\.Base\s*\(/ }],
    propagator: /^(?:fmt\.(?:Sprintf|Sprint|Sprintln)|strings\.(?:Join|Replace|ReplaceAll|TrimSpace|Trim|TrimLeft|TrimRight|TrimPrefix|TrimSuffix|ToLower|ToUpper|Split|SplitN|Fields|Title|Repeat)|filepath\.(?:Join|Clean|Abs)|path\.(?:Join|Clean)|string|\[\]byte|\[\]string|url\.(?:Parse|JoinPath))$/,
    ifTypes: new Set(["if_statement"]),
    conditionText(ifNode) {
      const init = ifNode.childForFieldName("initializer")?.text;
      const cond = ifNode.childForFieldName("condition")?.text ?? "";
      return init ? `${init}; ${cond}` : cond;
    },
    guard: GUARD,
    sourceReads: new RegExp(`(?<![\\w.])${recv}\\.[\\w.()]*?(?:Query|Param|PostForm|FormValue|PostFormValue|PathValue|GetHeader|QueryParam|DefaultQuery|Cookie|Get)\\([^()]*\\)`, "g"),
    leadingOperand(value) {
      let n: Node | null = value.type === "expression_list" ? (value.namedChildren[0] ?? null) : value;
      if (n?.type !== "binary_expression" || n.childForFieldName("operator")?.text !== "+") return null;
      while (n?.type === "binary_expression") n = n.childForFieldName("left");
      return n;
    },
    paramNames: paramNamesOf,
    stringTypes: new Set(["interpreted_string_literal", "raw_string_literal"]),
    sinks: [
      { callee: new RegExp(`^${DB_HANDLE}${notContext}.*\\.(?:Query|QueryRow|Queryx|QueryRowx|Exec|MustExec|Prepare|Preparex|Raw|Where|Order|Having|Joins)$`), category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: new RegExp(`^${DB_HANDLE}${notContext}.*\\.(?:QueryContext|QueryRowContext|ExecContext|PrepareContext|QueryxContext|NamedQueryContext)$`), arg: 1, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: /^exec\.Command$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
      { callee: /^exec\.Command$/, arg: 2, when: shellForm(1), category: "command-injection", cwe: "CWE-78", what: "the shell command" },
      { callee: /^exec\.CommandContext$/, arg: 1, category: "command-injection", cwe: "CWE-78", what: "the command" },
      { callee: /^exec\.CommandContext$/, arg: 3, when: shellForm(2), category: "command-injection", cwe: "CWE-78", what: "the shell command" },
      { callee: /^(?:os\.(?:Open|OpenFile|ReadFile|Remove|RemoveAll|Create|WriteFile|Stat|ReadDir|Mkdir|MkdirAll)|ioutil\.(?:ReadFile|WriteFile|ReadDir)|filepath\.(?:Walk|WalkDir)|afero\.\w+)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
      { callee: /^http\.ServeFile$/, arg: 2, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
      { callee: /^\w+\.(?:File|FileAttachment|SendFile|Attachment|Download)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
      { callee: /^(?:http\.(?:Get|Head|Post|PostForm)|(?:client|httpClient|http\.DefaultClient)\.(?:Get|Head|Post|PostForm))$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
      { callee: /^http\.NewRequest$/, arg: 1, category: "ssrf", cwe: "CWE-918", what: "the URL" },
      { callee: /^http\.NewRequestWithContext$/, arg: 2, category: "ssrf", cwe: "CWE-918", what: "the URL" },
      { callee: /^http\.Redirect$/, arg: 2, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
      { callee: /^(?!http\.)\w+\.Redirect$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
      { callee: /^(?!http\.)\w+\.Redirect$/, arg: 1, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    ],
  };
}

/** `exec.Command("sh", "-c", script)`: the program is a shell and the flag at `flagIndex` hands it a script. */
function shellForm(flagIndex: number): (args: Node[]) => boolean {
  return (args) => {
    const program = args[flagIndex - 1]?.text.replace(/^["'`]|["'`]$/g, "") ?? "";
    const flag = args[flagIndex]?.text.replace(/^["'`]|["'`]$/g, "") ?? "";
    return /^(?:\/bin\/)?(?:ba|z|da|a)?sh$|^cmd(?:\.exe)?$|^powershell(?:\.exe)?$/.test(program) && /^(?:-c|\/c|-Command)$/i.test(flag);
  };
}

/** Request input reaching a sink inside a Go request handler (see `handlerTaint`). */
export function goTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  const names = contextNames(tree.rootNode);
  if (names.length === 0) return [];
  return handlerTaint(tree, buildSpec(names), filePath, facts);
}
