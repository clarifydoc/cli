import type { Node, Tree } from "web-tree-sitter";
import type { SecurityIssue } from "../../../types/analysis.js";
import { handlerTaint, type TaintFacts, type TaintSpec } from "../shared/handler-taint.js";

/**
 * Request input followed through an ASP.NET action (see `handlerTaint`). An
 * action is a method carrying an HTTP verb or `[Route]` attribute; its
 * parameters are bound from the request — `[FromQuery]`/`[FromRoute]`/
 * `[FromBody]`/`[FromForm]`/`[FromHeader]`, or unannotated — except what the
 * container injects (`[FromServices]`, services, contexts, loggers,
 * cancellation tokens). `Request.Query[…]`, `Request.Form[…]` and friends
 * are request input too. `$"…{name}…"` carries `name`; a literal's text does
 * not.
 */

const ACTION = /^(?:HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions|Route|AcceptVerbs)$/;
const INJECTED_TYPE = /(?:Service|Context|Repository|Logger|Token|Options|Mediator|Factory|Provider|Manager|Mapper|Environment|Configuration|ISender|IPublisher)\b|^(?:CancellationToken|IFormFile|HttpContext|HttpRequest|HttpResponse)$/;

const NON_TEXT_TYPE = /^(?:int|long|short|byte|uint|ulong|ushort|sbyte|decimal|double|float|bool|Guid|DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|Int\d+|UInt\d+)\??$/;

const attributeNames = (n: Node): string[] =>
  n.namedChildren.filter((c) => c.type === "attribute_list").flatMap((l) => l.namedChildren.filter((a) => a.type === "attribute").map((a) => a.childForFieldName("name")?.text.split(".").pop() ?? ""));

const spec: TaintSpec = {
  functionTypes: new Set(["method_declaration"]),
  handler(fn) {
    if (!attributeNames(fn).some((a) => ACTION.test(a))) return null;
    const tainted: string[] = [];
    for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type !== "parameter") continue;
      const name = p.childForFieldName("name")?.text;
      const type = p.childForFieldName("type")?.text ?? "";
      if (!name) continue;
      const attrs = attributeNames(p);
      if (attrs.includes("FromServices") || attrs.includes("FromKeyedServices")) continue;
      // A number, GUID, date or flag carries no path, query or URL text.
      if (NON_TEXT_TYPE.test(type)) continue;
      if (attrs.some((a) => /^From/.test(a)) || !INJECTED_TYPE.test(type)) tainted.push(name);
    }
    return { taintedParams: tainted };
  },
  source: /\b(?:HttpContext\.)?Request\.(?:Query|Form|Headers|Cookies|Body|RouteValues|QueryString|Path)\b/,
  assignment(node) {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name")?.text;
      const value = node.namedChildren.filter((c) => c.type !== "identifier" || c.text !== name).pop();
      return name && value && value.id !== node.childForFieldName("name")?.id ? { names: [name], value } : null;
    }
    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const value = node.childForFieldName("right");
      return value && left?.type === "identifier" ? { names: [left.text], value } : null;
    }
    return null;
  },
  call(node) {
    if (node.type === "invocation_expression") {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument").map((a) => a.namedChildren[a.namedChildren.length - 1] ?? a);
      return { callee: fn.text.replace(/\s+/g, "").replace(/<[^>]*>$/, ""), args };
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type")?.text;
      if (!type) return null;
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument").map((a) => a.namedChildren[a.namedChildren.length - 1] ?? a);
      return { callee: `new ${type.replace(/<.*$/, "")}`, args };
    }
    return null;
  },
  sanitizer: /^\s*(?:int|long|Guid|decimal|double|bool|DateTime)\.(?:Parse|TryParse)|^\s*(?:Path\.GetFileName|HtmlEncoder\.\w+\.Encode|WebUtility\.(?:HtmlEncode|UrlEncode)|HttpUtility\.(?:HtmlEncode|UrlEncode)|Uri\.EscapeDataString|Convert\.ToInt\d+)\s*\(/,
  propagator: /^(?:string\.(?:Format|Concat|Join)|String\.(?:Format|Concat|Join)|Path\.(?:Combine|Join|GetFullPath)|new Uri|.+\.(?:Trim|ToLower|ToUpper|ToLowerInvariant|ToUpperInvariant|Replace|Substring|ToString|Append|AppendFormat))$/,
  ifTypes: new Set(["if_statement"]),
  stringTypes: new Set(["string_literal", "verbatim_string_literal", "raw_string_literal", "interpolated_string_expression"]),
  interpolationTypes: new Set(["interpolation"]),
  sinks: [
    { callee: /^new (?:SqlCommand|SqliteCommand|NpgsqlCommand|MySqlCommand|OracleCommand|OleDbCommand|OdbcCommand)$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    // EF Core's raw verbs and Dapper's (the interpolated `FromSqlInterpolated` is parameterized, not here).
    { callee: /\.(?:FromSqlRaw|ExecuteSqlRaw|ExecuteSqlRawAsync|SqlQueryRaw|ExecuteSqlCommand|ExecuteSqlCommandAsync)$|^(?:\w*(?:conn|Connection|db|Db)\w*)\.(?:Query|QueryAsync|QueryFirst\w*|QuerySingle\w*|Execute|ExecuteAsync|ExecuteScalar\w*|ExecuteReader\w*)$/, category: "sql-injection", cwe: "CWE-89", what: "the SQL text" },
    { callee: /^(?:Process\.Start|new ProcessStartInfo)$/, category: "command-injection", cwe: "CWE-78", what: "the command" },
    { callee: /^(?:(?:System\.IO\.)?File\.(?:ReadAllText|ReadAllTextAsync|ReadAllBytes|ReadAllBytesAsync|ReadAllLines|OpenRead|OpenWrite|Open|WriteAllText|WriteAllTextAsync|WriteAllBytes|Delete|Copy|Move)|new (?:FileStream|StreamReader|StreamWriter|FileInfo)|PhysicalFile)$/, category: "path-traversal", cwe: "CWE-22", what: "the file path" },
    // An HTTP client's verbs (a cache provider's `GetAsync(key)` is no request).
    { callee: /^(?:this\.)?_?\w*(?:[Hh]ttp|[Cc]lient|[Ww]eb)\w*\.(?:GetAsync|GetStringAsync|GetStreamAsync|GetByteArrayAsync|PostAsync|PutAsync|DeleteAsync|SendAsync|GetFromJsonAsync|PostAsJsonAsync|DownloadString|DownloadStringTaskAsync|DownloadFileTaskAsync)$|^WebRequest\.Create$/, category: "ssrf", cwe: "CWE-918", what: "the URL" },
    { callee: /^(?:Redirect|RedirectPermanent|Response\.Redirect)$/, category: "open-redirect", cwe: "CWE-601", what: "the redirect target" },
  ],
};

/** Request input reaching a sink inside an ASP.NET action. */
export function csharpTaint(tree: Tree, _sourceText: string, filePath: string, facts?: TaintFacts): SecurityIssue[] {
  return handlerTaint(tree, spec, filePath, facts);
}
