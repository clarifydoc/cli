import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/** The extractor types that fill a handler parameter from the request: axum, actix-web and rocket spell them alike. */
const EXTRACTOR = /^(?:Query|Json|Path|Form)$/;
/** A rocket route attribute: `#[get("/clubs/<id>")]`. */
const ROUTE_ATTRIBUTE = /^#\[\s*(?:rocket::)?(?:get|post|put|patch|delete|head|options|route)\s*\(/;
const FORMAT_MACROS = /^(?:format|format_args|write|writeln)$/;
const INERT = /^(?:[iu](?:8|16|32|64|128|size)|f(?:32|64)|bool|char|Uuid|Duration|DateTime|NaiveDate|NaiveDateTime|SystemTime|IpAddr)$/;

/** Calls that make the text into a number or a quoted value, and calls whose name says they clean it: the result is clean. */
const SANITIZER = new RegExp(
  "\\.parse\\s*(?:::\\s*<[^>]*>)?\\s*\\(\\s*\\)(?:\\s*(?:\\?|\\.unwrap\\w*\\([^()]*\\)|\\.expect\\([^()]*\\)|\\.map_err\\([\\s\\S]*\\)|\\.ok\\(\\)))*\\s*$" +
    "|\\.(?:len|count|is_empty|is_some|is_none|is_ok|is_err)\\s*\\(\\s*\\)\\s*$" +
    "|\\.(?:starts_with|ends_with|contains|contains_key|eq|ne|eq_ignore_ascii_case)\\s*\\([^()]*\\)\\s*$" +
    "|^\\s*(?:[iu](?:8|16|32|64|128|size)|f(?:32|64)|Uuid|bool)::(?:from_str|from|parse_str|try_from)\\s*\\(" +
    "|^\\s*(?:urlencoding|percent_encoding|shlex|shell_escape|html_escape|ammonia|htmlescape)::\\w+\\s*\\(" +
    "|^\\s*(?:utf8_percent_encode|encode_text|encode_safe|encode_double_quoted_string)\\s*\\(" +
    "|^\\s*(?!(?:Path|PathBuf)::)[\\w:.]*(?:[Cc]lean|[Ss]anitiz|[Ee]scape|[Qq]uote|[Vv]alidat|[Nn]ormali[sz]e)[\\w:.]*\\s*\\(",
);

/** A condition that checks the value: a prefix or membership test, a pattern match, a validity predicate. */
const GUARD = /\b(?:starts_with|ends_with|strip_prefix|contains|contains_key|is_match|is_absolute|is_ascii_alphanumeric|canonicalize|validate\w*|is_valid\w*|\w*allowed\w*)\s*\(|\bmatches!\s*\(|\.(?:all|any)\s*\(/;

/** A name on the way to a SQL call that says it is a database handle: `conn`, `client`, `db`, `pool`, `tx`, `self.db`. */
const DB_HANDLE = /(?:^|\.)(?:db|conn|connection|client|pool|tx|txn|transaction|pg|sqlite|mysql|stmt|\w*_(?:db|conn|pool|client|tx))\w*$/;

const stripSpace = (s: string): string => s.replace(/\s+/g, "");

function contentOf(literal: Node): string {
  return literal.namedChildren.filter((c) => c.type === "string_content").map((c) => c.text).join("");
}

/** A callee as written, where a chained call keeps its first literal argument (`Command::new(sh).arg(-c).arg`). */
function calleeText(fn: Node | null): string {
  if (!fn) return "";
  switch (fn.type) {
    case "generic_function":
      return calleeText(fn.childForFieldName("function"));
    case "field_expression":
      return `${calleeText(fn.childForFieldName("value"))}.${fn.childForFieldName("field")?.text ?? ""}`;
    case "call_expression": {
      const first = fn.childForFieldName("arguments")?.namedChildren[0];
      return `${calleeText(fn.childForFieldName("function"))}(${first?.type === "string_literal" ? contentOf(first) : ""})`;
    }
    case "await_expression":
    case "try_expression":
    case "parenthesized_expression":
    case "reference_expression":
      return calleeText(fn.namedChildren[0] ?? null);
    default:
      return stripSpace(fn.text);
  }
}

/** The last path segment of a type, and its type arguments: `web::Query<Search>` → `Query`, `[Search]`. */
function typeHead(type: Node | null): { head: string; args: Node[] } | null {
  if (!type) return null;
  if (type.type === "generic_type") {
    const inner = type.childForFieldName("type");
    const head = inner?.type === "scoped_type_identifier" ? inner.childForFieldName("name")?.text : inner?.text;
    return head ? { head, args: type.childForFieldName("type_arguments")?.namedChildren ?? [] } : null;
  }
  if (type.type === "scoped_type_identifier") return { head: type.childForFieldName("name")?.text ?? "", args: [] };
  if (type.type === "type_identifier" || type.type === "primitive_type") return { head: type.text, args: [] };
  return null;
}

/** The struct a file declares, by name. */
function structOf(root: Node, name: string): Node | null {
  let found: Node | null = null;
  const visit = (n: Node): void => {
    if (found) return;
    if (n.type === "struct_item" && n.childForFieldName("name")?.text === name) found = n;
    else if (n.type !== "function_item") for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return found;
}

type Shape = "text" | "inert" | string[] | null;

/**
 * What a value of `type` can hold: text (a string, a path, a JSON value), nothing that carries a payload (numbers,
 * booleans, ids, times), the dotted names of a struct's text fields (the struct is declared in this file), or null when
 * unknown (a type from another file: not judged, never accused).
 */
function shapeOf(type: Node | null, root: Node, depth = 0): Shape {
  if (!type || depth > 3) return null;
  if (type.type === "reference_type" || type.type === "array_type" || type.type === "slice_type") return shapeOf(type.childForFieldName("type") ?? type.namedChildren[0] ?? null, root, depth + 1);
  if (type.type === "tuple_type") {
    const parts = type.namedChildren.map((t) => shapeOf(t, root, depth + 1));
    return parts.some((p) => p === "text" || Array.isArray(p)) ? "text" : parts.every((p) => p === "inert") ? "inert" : null;
  }
  const t = typeHead(type);
  if (!t) return null;
  if (t.head === "HashMap" || t.head === "BTreeMap") return shapeOf(t.args[1] ?? null, root, depth + 1) === "inert" ? "inert" : "text";
  if (t.head === "Cow" || t.head === "Arc" || t.head === "Rc" || t.head === "Bytes") return t.args.length ? shapeOf(t.args[0]!, root, depth + 1) : "text";
  if (t.head === "Option" || t.head === "Vec" || t.head === "Box") return shapeOf(t.args[0] ?? null, root, depth + 1);
  if (t.head === "String" || t.head === "str" || t.head === "PathBuf" || t.head === "Value") return "text";
  if (INERT.test(t.head)) return "inert";
  const struct = structOf(root, t.head);
  const fields = struct?.childForFieldName("body");
  if (!fields || fields.type !== "field_declaration_list") return null;
  const out: string[] = [];
  for (const f of fields.namedChildren) {
    if (f.type !== "field_declaration") continue;
    const name = f.childForFieldName("name")?.text;
    const shape = shapeOf(f.childForFieldName("type"), root, depth + 1);
    if (!name || shape === "inert" || shape === null) continue;
    out.push(name);
  }
  return out;
}

/** The names a pattern binds (`q`, `Query(q)`, `(a, b)`, `mut x`), never a constructor's own name. */
function patternNames(pattern: Node | null): string[] {
  if (!pattern) return [];
  if (pattern.type === "identifier") return [pattern.text];
  const out: string[] = [];
  const constructor = pattern.childForFieldName("type");
  for (const c of pattern.namedChildren) {
    if (constructor && c.id === constructor.id) continue;
    out.push(...patternNames(c));
  }
  return out;
}

/** The route attribute above a function (`#[get("/clubs/<id>")]`), or "". */
function routeAttribute(fn: Node): string {
  for (let p = fn.previousNamedSibling; p?.type === "attribute_item" || p?.type === "line_comment"; p = p.previousNamedSibling) {
    if (p.type === "attribute_item" && ROUTE_ATTRIBUTE.test(p.text)) return p.text;
  }
  return "";
}

/** The parameters of a handler that carry request input: names, or `name.field` for each text field of a struct. */
function requestParams(fn: Node): string[] {
  const root = fn.tree.rootNode;
  const attribute = routeAttribute(fn);
  const out: string[] = [];
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type !== "parameter") continue;
    const type = p.childForFieldName("type");
    const names = patternNames(p.childForFieldName("pattern"));
    const head = typeHead(type);
    if (head && EXTRACTOR.test(head.head)) {
      const arg = head.args[0] ?? null;
      const parts = arg?.type === "tuple_type" && arg.namedChildren.length === names.length && names.length > 1 ? arg.namedChildren : null;
      names.forEach((name, i) => {
        const shape = shapeOf(parts ? parts[i]! : arg, root);
        if (shape === "text") out.push(name);
        else if (Array.isArray(shape)) out.push(...shape.map((f) => `${name}.${f}`));
      });
    } else if (attribute && names.length === 1 && new RegExp(`<${names[0]}(?:\\.\\.)?>`).test(attribute)) {
      // Rocket: a path or query segment named in the attribute, filled from the request as text.
      // (a rocket `PathBuf` segment is checked by rocket itself: no `..`, no hidden or special segment)
      if (shapeOf(type, root) === "text" && typeHead(type)?.head !== "PathBuf") out.push(names[0]!);
    }
  }
  return out;
}

/** The names of `req: HttpRequest` parameters in the file, whose methods read the request. */
function requestObjects(root: Node): string[] {
  const names = new Set<string>();
  const visit = (n: Node): void => {
    if (n.type === "parameter" && typeHead(n.childForFieldName("type"))?.head === "HttpRequest") for (const x of patternNames(n.childForFieldName("pattern"))) names.add(x);
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return [...names];
}

/** The identifiers a `let` or `if let` pattern binds. */
function letNames(node: Node): string[] {
  return patternNames(node.childForFieldName("pattern"));
}

function buildSpec(requests: readonly string[], usesReqwest: boolean): TaintSpec {
  const recv = requests.length ? `(?:${requests.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})` : "(?!)";
  const source = new RegExp(`(?<![\\w.])${recv}\\.(?:query_string|match_info|uri|path|headers|cookie|cookies|query)\\b`);
  const clientCall = usesReqwest ? "|(?:^|\\.)(?:http_?client|client|reqwest_client|http)\\.(?:get|post|put|delete|head|patch)$|^reqwest::(?:blocking::)?Client::new\\(\\)\\.(?:get|post|put|delete|head|patch)$" : "";
  const isLocationHeader = (args: Node[]): boolean => /^\(\s*(?:"location"|(?:header::)?LOCATION)\b/i.test(args[0]?.text ?? "");
  return {
    functionTypes: new Set(["function_item"]),
    handler(fn) {
      const params = requestParams(fn);
      if (params.length) return { taintedParams: params };
      const reads = requests.length > 0 && (fn.childForFieldName("parameters")?.namedChildren ?? []).some((p) => p.type === "parameter" && patternNames(p.childForFieldName("pattern")).some((n) => requests.includes(n)));
      return reads ? { taintedParams: [] } : null;
    },
    source,
    assignment(node) {
      if (node.type === "let_declaration" || node.type === "let_condition") {
        const value = node.childForFieldName("value");
        return value ? { names: letNames(node), value } : null;
      }
      if (node.type === "assignment_expression") {
        const value = node.childForFieldName("right");
        const left = node.childForFieldName("left");
        return value && left?.type === "identifier" ? { names: [left.text], value } : null;
      }
      if (node.type === "compound_assignment_expr") {
        const value = node.childForFieldName("right");
        const left = node.childForFieldName("left");
        return value && left?.type === "identifier" ? { names: [left.text], value, keep: true } : null;
      }
      // `sql.push_str(&x)`: the string being built now carries what it was given.
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        const receiver = fn?.type === "field_expression" ? fn.childForFieldName("value") : null;
        const method = fn?.childForFieldName("field")?.text ?? "";
        const first = node.childForFieldName("arguments")?.namedChildren[0];
        if (receiver?.type === "identifier" && first && /^(?:push_str|insert_str|extend|push)$/.test(method) && !/(?:qb|builder)/i.test(receiver.text)) return { names: [receiver.text], value: first, keep: true };
      }
      return null;
    },
    call(node) {
      if (node.type === "macro_invocation") {
        const name = node.childForFieldName("macro")?.text ?? "";
        if (!FORMAT_MACROS.test(name)) return null;
        return { callee: `${name}!`, args: [] };
      }
      if (node.type !== "call_expression") return null;
      const callee = calleeText(node.childForFieldName("function"));
      if (!callee) return null;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "line_comment" && a.type !== "block_comment");
      return { callee, args };
    },
    sanitizer: SANITIZER,
    fileNameSanitizers: [{ call: /^\s*(?:std::path::)?Path::new\s*\([^()]*\)\s*\.file_name\s*\(/ }],
    propagator: /^(?:format|format_args|write|writeln)!$|^(?:(?:std::path::)?Path(?:Buf)?::(?:new|from)|String::from|(?:std::)?format)$|\.(?:join|push|push_str|replace|replacen|concat|to_string|to_owned|to_lowercase|to_uppercase|trim|trim_matches|trim_start|trim_end|as_str|as_ref|clone|into|unwrap|unwrap_or|unwrap_or_default|expect|cloned|borrow|display|to_str|to_string_lossy|into_inner|as_deref)$/,
    ifTypes: new Set(["if_expression"]),
    guard: GUARD,
    stringTypes: new Set(["string_literal", "raw_string_literal"]),
    stringReads(literal) {
      const macro = literal.parent?.parent;
      if (literal.parent?.type !== "token_tree" || macro?.type !== "macro_invocation" || !FORMAT_MACROS.test(macro.childForFieldName("macro")?.text ?? "")) return null;
      const names = [...contentOf(literal).replace(/\{\{|\}\}/g, "").matchAll(/\{([A-Za-z_]\w*)(?::[^}]*)?\}/g)].map((m) => m[1]!);
      return names.length ? names.join(" ") : null;
    },
    leadingOperand(value) {
      // `format!("https://host/{}", x)`: a literal that states the host before the first hole, or `base + x`.
      const macro = value.type === "reference_expression" ? value.namedChildren[0] : value;
      if (macro?.type === "macro_invocation" && FORMAT_MACROS.test(macro.childForFieldName("macro")?.text ?? "")) {
        const lit = macro.namedChildren.find((c) => c.type === "token_tree")?.namedChildren.find((c) => c.type === "string_literal");
        if (!lit) return null;
        const text = contentOf(lit);
        if (/^[a-z][a-z0-9+.-]*:\/\/[^/{\s]+/i.test(text)) return lit;
        // `format!("{}{redirect}", admin_path())`: an opening positional hole is the first argument after the literal.
        return /^\{(?:0)?(?::[^}]*)?\}/.test(text) ? lit.nextNamedSibling : null;
      }
      let n: Node | null = macro ?? null;
      if (n?.type !== "binary_expression" || n.childForFieldName("operator")?.text !== "+") return null;
      while (n?.type === "binary_expression") n = n.childForFieldName("left");
      return n;
    },
    result(node) {
      // A boolean has no payload; an `if` or `match` is its arms' values, never what it tests.
      if (node.type === "binary_expression" && /^(?:==|!=|<|>|<=|>=|&&|\|\|)$/.test(node.childForFieldName("operator")?.text ?? "")) return [];
      if (node.type === "if_expression") return [node.childForFieldName("consequence"), node.childForFieldName("alternative")].filter((n): n is Node => !!n);
      if (node.type === "else_clause") return node.namedChildren;
      if (node.type === "match_expression") return (node.childForFieldName("body")?.namedChildren ?? []).flatMap((arm) => (arm.type === "match_arm" ? [arm.childForFieldName("value")].filter((n): n is Node => !!n) : []));
      return null;
    },
    returnTypes: new Set(["return_expression"]),
    sinks: [
      { callee: /^(?:sqlx::)?(?:query|query_as|query_scalar|raw_sql)$|^(?:diesel::)?sql_query$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: /^Statement::from_string$/, arg: 1, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: new RegExp(`${DB_HANDLE.source.replace(/\$$/, "")}\\.(?:execute|execute_unprepared|query|query_one|query_opt|query_row|query_map|prepare|batch_execute|simple_query|fetch_all|fetch_one|fetch_optional)$`), category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: /(?:^|\.)(?:qb|query_builder|\w+_qb|\w*query_builder)\.push$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: /^(?:(?:std|tokio)::process::)?Command::new$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
      { callee: /^(?:(?:std|tokio)::process::)?Command::new\((?:\/bin\/)?(?:ba|z|da|a)?sh\)(?:\.\w+\([^()]*\))*\.arg\(-c\)\.arg$/, category: "command-injection", cwe: "CWE-78", what: "the shell command" },
      { callee: /^(?:(?:std|tokio|async_std)::)?(?:fs::File|File)::(?:open|create|create_new)$|^(?:(?:std|tokio|async_std)::)?fs::(?:read|read_to_string|read_dir|write|remove_file|remove_dir|remove_dir_all|create_dir|create_dir_all|copy|rename|metadata|canonicalize|hard_link)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
      { callee: new RegExp(`^(?:reqwest|ureq|surf|isahc|attohttpc)::(?:blocking::)?(?:get|post|put|delete|head|patch)$${clientCall}`), category: "ssrf", cwe: "CWE-918", what: "the URL" },
      { callee: /^(?:Redirect|axum::response::Redirect|rocket::response::Redirect)::(?:to|temporary|permanent|found|see_other|moved)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
      { callee: /^HttpResponse::(?:Found|SeeOther|TemporaryRedirect|PermanentRedirect|MovedPermanently)\(\)\.(?:insert_header|append_header)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target", when: isLocationHeader },
    ],
  };
}

/** Request input reaching a sink inside an axum, actix-web or rocket handler (see `handlerTaint`). */
export function rustTaint(tree: Tree, sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, buildSpec(requestObjects(tree.rootNode), /\breqwest\b/.test(sourceText)), filePath, facts);
}
