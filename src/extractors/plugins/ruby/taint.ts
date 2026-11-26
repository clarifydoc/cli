import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/** A class that serves requests: a Rails/Grape/Sinatra controller by its superclass. */
const CONTROLLER_BASE = /(?:Controller|ActionController::\w+|Grape::API|Sinatra::(?:Base|Application)|Hanami::Action|Roda)$/;
/** Sinatra and Grape route verbs: `get "/clubs" do … end`. */
const ROUTE_VERB = /^(?:get|post|put|patch|delete|head|options|route)$/;
/** Where Rails keeps controllers (and the concerns they include): every method there runs inside a request. */
const CONTROLLER_PATH = /(?:^|\/)app\/controllers\//;

/** Calls that turn the value into another kind, or quote it: the result is clean. */
const SANITIZER = new RegExp(
  "^(?:(?!#\\{)[\\s\\S])*\\.(?:to_i|to_f|to_r|to_c|to_d|to_sym|to_b|length|size|count|empty\\?|nil\\?|blank\\?|present\\?|zero\\?|positive\\?|negative\\?|hash|object_id|shellescape|to_json)\\s*$" +
    "|^\\s*(?:Integer|Float|Rational|Complex|BigDecimal|Shellwords\\.(?:escape|shellescape)|(?:[\\w:.]*\\.)?(?:sanitize_sql\\w*|quote|quote_string|quote_table_name|quote_column_name)|CGI\\.escape\\w*|ERB::Util\\.(?:h|html_escape|url_encode)|html_escape|(?:Rack::Utils|URI)\\.(?:escape\\w*|encode_www_form_component)|h|sanitize|escape|[\\w.]+_(?:path|url)|SecureRandom\\.\\w+)\\s*\\(" +
    "|^\\s*[\\w:.]*(?:[Cc]lean|[Ss]anitiz|[Ee]scape|[Qq]uote|[Vv]alidat|[Nn]ormali[sz]e)[\\w:.]*\\s*\\(",
);

/** A condition that checks the value: a prefix or membership test, a pattern match, a validity predicate. */
const GUARD = /\b(?:start_with|end_with|include|member|match|valid\w*|allow\w*|permitted|one_of|key|has_key)\?|=~/;

const CONTEXT_SOURCE = /(?<![\w.@$:])(?:params\b|cookies\[|request\.(?:params|query_parameters|request_parameters|GET|POST|headers|cookies|raw_post|body|query_string|path_parameters)\b)/;

/** The identifiers an assignment target names: `q`, `@q`, `a, b`. */
function targetNames(node: Node | null): string[] {
  if (!node) return [];
  if (node.type === "identifier" || node.type === "instance_variable") return [node.text];
  if (node.type === "left_assignment_list" || node.type === "destructured_left_assignment") return node.namedChildren.flatMap(targetNames);
  return [];
}

function superclassOf(cls: Node): string {
  return cls.childForFieldName("superclass")?.text.replace(/^<\s*/, "").trim() ?? "";
}

/** The class a method sits in, or null. */
function enclosingClass(node: Node): Node | null {
  for (let p = node.parent; p; p = p.parent) if (p.type === "class") return p;
  return null;
}

/** The first argument of a route's call is a path (`"/clubs/:id"`, `":id"`): Sinatra and Grape. */
function routeBlock(fn: Node): boolean {
  if (fn.type !== "do_block" && fn.type !== "block") return false;
  const call = fn.parent;
  if (!call || call.type !== "call" || call.childForFieldName("receiver")) return false;
  if (!ROUTE_VERB.test(call.childForFieldName("method")?.text ?? "")) return false;
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  return first?.type === "string" && /^["'][/:*]/.test(first.text);
}

/** Whether `fn` assigns the local `name` (`params = {…}.to_query`). */
function assignsLocal(fn: Node, name: string): boolean {
  const visit = (n: Node): boolean => {
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name) return true;
    return n.namedChildren.some((c) => c.type !== "method" && visit(c));
  };
  return visit(fn);
}

/**
 * The text of a heredoc whose opening `node` is: tree-sitter-ruby puts every `heredoc_body` of a line after the
 * statement that opens them, one per opening in order, so `find_by_sql(<<~SQL)` has no text of its own.
 */
function heredocBody(node: Node): Node | null {
  let stmt: Node = node;
  while (stmt.parent && stmt.nextNamedSibling?.type !== "heredoc_body" && stmt.parent.type !== "program") stmt = stmt.parent;
  let index = 0;
  const count = (n: Node): void => {
    if (n.type === "heredoc_beginning" && n.startIndex < node.startIndex) index++;
    for (const c of n.namedChildren) count(c);
  };
  count(stmt);
  let body = stmt.nextNamedSibling;
  for (let i = 0; body && i < index; i++) body = body.nextNamedSibling;
  return body?.type === "heredoc_body" ? body : null;
}

/** Methods that hand the heredoc's text back unchanged in kind (`<<~SQL.strip`): the chain is still the text. */
const TEXT_KEEPING = /^(?:strip|lstrip|rstrip|chomp|chop|squish|freeze|dup|to_s|strip_heredoc)$/;

/** The heredoc opening a chain of text-keeping, argument-less calls starts from (`<<~SQL.strip.freeze`), or null. */
function chainedHeredoc(node: Node): Node | null {
  let n: Node | null = node;
  while (n?.type === "call" && !n.childForFieldName("arguments") && !n.childForFieldName("block") && TEXT_KEEPING.test(n.childForFieldName("method")?.text ?? "")) n = n.childForFieldName("receiver");
  return n && n !== node && n.type === "heredoc_beginning" ? n : null;
}

/** A heredoc opening stands for its body, so interpolations in it are what the statement reads. */
function withBody(node: Node): Node {
  const opening = node.type === "heredoc_beginning" ? node : chainedHeredoc(node);
  return opening ? (heredocBody(opening) ?? node) : node;
}

function buildSpec(filePath: string): TaintSpec {
  const controllerFile = CONTROLLER_PATH.test(filePath);
  return {
    functionTypes: new Set(["method", "singleton_method", "do_block", "block"]),
    handler(fn) {
      if (fn.type === "do_block" || fn.type === "block") return routeBlock(fn) ? { taintedParams: [] } : null;
      // A `params` the method assigns itself is a local, not the request's.
      if (assignsLocal(fn, "params")) return null;
      const cls = enclosingClass(fn);
      return (cls && CONTROLLER_BASE.test(superclassOf(cls))) || controllerFile ? { taintedParams: [] } : null;
    },
    source: CONTEXT_SOURCE,
    assignment(node) {
      if (node.type === "assignment") {
        const value = node.childForFieldName("right");
        return value ? { names: targetNames(node.childForFieldName("left")), value: withBody(value) } : null;
      }
      if (node.type === "operator_assignment") {
        const value = node.childForFieldName("right");
        return value ? { names: targetNames(node.childForFieldName("left")), value, keep: true } : null;
      }
      return null;
    },
    call(node) {
      if (node.type === "subshell") return { callee: "`", args: [node] };
      if (node.type !== "call") return null;
      const method = node.childForFieldName("method")?.text;
      if (!method) return null;
      const receiver = node.childForFieldName("receiver")?.text;
      // A keyword argument (`where(name: params[:x])`, `redirect_to controller: …`) is bound or a routing option, never the SQL or the target.
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "pair" && a.type !== "comment" && a.type !== "block_argument" && a.type !== "hash_splat_argument").map(withBody);
      return { callee: (receiver ? `${receiver.replace(/\s+/g, "")}.` : "") + method, args };
    },
    sanitizer: SANITIZER,
    fileNameSanitizers: [{ call: /^\s*File\.basename\s*\(/ }],
    propagator: /^(?:File\.(?:join|expand_path|absolute_path|realpath)|Pathname(?:\.new)?|Rails\.root\.join|String|format|sprintf|Kernel\.(?:format|sprintf)|URI(?:\.parse)?|Array|.+\.(?:join|concat|prepend|gsub|sub|tr|delete|center|ljust|rjust|insert))$/,
    ifTypes: new Set(["if", "unless", "elsif", "if_modifier", "unless_modifier"]),
    guard: GUARD,
    sourceReads: /(?<![\w.@$:])params\s*(?:\[[^\]]*\]|\.(?:fetch|dig|require)\([^)]*\))/g,
    leadingOperand(value) {
      let n: Node | null = value;
      // `"#{base}/auth?#{params[:x]}"`: a string that opens with an interpolation or a literal of its own.
      if (n.type === "string") {
        const first = n.namedChildren[0];
        if (first?.type === "interpolation") return first.namedChildren[0] ?? null;
        return first?.type === "string_content" && !/^[/\\]{0,2}$/.test(first.text) ? first : null;
      }
      if (n.type !== "binary" || n.childForFieldName("operator")?.text !== "+") return null;
      while (n?.type === "binary") n = n.childForFieldName("left");
      return n;
    },
    paramNames(fn) {
      const list = fn.childForFieldName("parameters");
      return (list?.namedChildren ?? []).flatMap((p) => (p.type === "identifier" ? [p.text] : p.type === "optional_parameter" ? [p.childForFieldName("name")?.text ?? ""] : []));
    },
    stringTypes: new Set(["string", "subshell", "heredoc_body", "bare_string", "delimited_symbol"]),
    interpolationTypes: new Set(["interpolation"]),
    returnTypes: new Set(["return"]),
    sinks: [
      { callee: /(?:^|\.)(?:where|having|find_by_sql|count_by_sql|update_all|delete_all|joins|from|rewhere)$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text", when: sqlText },
      { callee: /(?:^|\.)(?:connection|conn|ActiveRecord::Base\.connection)\.(?:execute|exec_query|exec_update|exec_delete|select_all|select_one|select_value|select_values|select_rows|insert|update|delete)$|^Arel\.sql$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
      { callee: /^(?:Kernel\.)?(?:system|exec|spawn)$|^`$|^(?:IO|Open3|Process)\.(?:popen\w*|capture\w+|pipeline\w*|spawn|exec)$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
      { callee: /^(?:eval|instance_eval|class_eval|module_eval|[\w:.]+\.(?:instance_eval|class_eval|module_eval))$/, category: "eval-exec", cwe: "CWE-95", what: "the code" },
      { callee: /(?:^|\.)(?:send|public_send|__send__)$/, category: "eval-exec", cwe: "CWE-470", what: "the method name" },
      { callee: /^(?:File|IO|FileUtils)\.(?:read|binread|readlines|foreach|open|write|binwrite|delete|unlink|rm|rm_f|rm_rf|cp|mv)$|^(?:send_file|send_data)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
      { callee: /^(?:Net::HTTP\.(?:get|get_response|post|post_form|get_print)|(?:HTTParty|Faraday|RestClient|Typhoeus|Excon)\.(?:get|post|put|delete|head)|URI\.open)$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
      { callee: /^(?:redirect_to|redirect)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
    ],
  };
}

/** `where` and its kin take SQL text as a string, or a variable holding one; a symbol, hash or array is bound by Rails. */
function sqlText(args: Node[]): boolean {
  const first = args[0];
  return !!first && first.type !== "simple_symbol" && first.type !== "hash" && first.type !== "array";
}

/**
 * Request input reaching a sink inside a Ruby controller action or Sinatra route (see `handlerTaint`). The meta states
 * it as `regexTaint` (`{ gate, taint }`, no `ast.taint` hook): a file whose source matches the gate is parsed once more
 * with tree-sitter-ruby, never a test or generated file or a tree with syntax errors. Handlers are every method of a
 * controller (superclass or `app/controllers/`) and `get "/x" do` blocks; keyword arguments (`where(name: params[:x])`)
 * are dropped and a method that assigns its own `params` has none. A heredoc opening is read as the `heredoc_body` that
 * follows its statement, so interpolation in `find_by_sql(<<~SQL)` reaches the sink, and a heredoc chained into
 * text-keeping calls (`<<~SQL.strip`, `.squish`) is its body.
 */
export function rubyTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, buildSpec(filePath), filePath, facts);
}
