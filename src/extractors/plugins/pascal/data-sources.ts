import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Delphi / Free Pascal data sources.
 *
 * Everything here is line-scanned from the unit text (captured in
 * `beginFile`, flushed once at the root node) — the patterns are receiver-
 * gated so they need no AST context, and Pascal's statement-per-line style
 * makes lines the natural unit. The previous extractor substring-matched the
 * whole call text (`.open` → `Windows.OpenProcessToken`, `http` →
 * `HttpOpenRequest` name noise) which flooded desktop corpora with phantom
 * "database" accesses.
 *
 * Raw SQL rides the shared SQL-in-strings scanner after two normalizations:
 * Pascal `'…'` literals become C-style `"…"`, and `Query1.SQL.Add('…');`
 * builder lines lose their statement terminator so consecutive Add calls
 * concatenate into one statement — the idiomatic multi-line query:
 *
 *     Query1.SQL.Add('SELECT id, name');
 *     Query1.SQL.Add('FROM customers WHERE active = 1');
 *     Query1.Open;
 */

/** Dataset components by naming convention: Query1, tblOrders, cdsUsers,
 *  FDQuery, ADOTable, IBQuery, mySQLQuery … */
const DATASET_RECEIVER =
  /\b((?:\w+\.)?\w*(?:query|qry|table|tbl|dataset|storedproc|cds|clientdata)\w*)\s*\.\s*(Open|ExecSQL|ExecProc|Post|Append|Edit|Delete|Insert|Locate|Lookup|FieldByName)\b/i;

/** Connection components: ADOConnection1.Open / Database1.ExecuteDirect(…). */
const CONNECTION_RECEIVER =
  /\b((?:\w+\.)?\w*(?:connection|database|conn)\w*)\s*\.\s*(Open|Execute|ExecuteDirect|StartTransaction|Commit)\b/i;

/** HTTP client verbs on http/rest-shaped receivers (TIdHTTP, THTTPClient,
 *  TRESTClient, TNetHTTPClient instances: IdHTTP1, HttpClient, RESTRequest1…).
 *  "rest" alone would swallow Restore*/
const HTTP_CLIENT_RE =
  /\b(\w*http\w*|\w*rest(?:client|request|response)\w*)\s*\.\s*(Get|Post|Put|Delete|Head|Options|Patch|Execute)\b/i;

/** WinINet / URLMon API calls — the classic pre-Indy HTTP stack. */
const WININET_RE =
  /\b(InternetOpenUrl|InternetConnect|HttpOpenRequest|HttpSendRequest|URLDownloadToFile|WinHttpOpenRequest|WinHttpConnect)[AW]?\s*\(/i;

/** ShellExecute opening a literal web URL (an outbound link, not UI noise). */
const SHELL_EXECUTE_RE = /\bShellExecute(?:Ex)?[AW]?\s*\(/i;

const URL_LITERAL_RE = /'(https?:\/\/[^']+)'/i;
const STRING_LITERAL_RE = /'((?:[^']|'')+)'/;
/** A literal that can plausibly be a host name — `InternetConnect(h, '', …)`
 *  empty-string args otherwise let the generic literal regex match `', '`
 *  ACROSS two empties. */
const HOST_LITERAL_RE = /'([A-Za-z0-9][A-Za-z0-9._-]{2,})'/;

const ENV_RE = /\bGetEnvironmentVariable\s*\(\s*'([^']+)'/i;

/** Config reads/writes on ini/registry-shaped receivers. */
const CONFIG_RE =
  /\b(\w*(?:ini|reg)\w*)\s*\.\s*(ReadString|ReadInteger|ReadBool|ReadFloat|ReadSection|WriteString|WriteInteger|WriteBool|GetValue|SetValue|OpenKey|ReadSectionValues)\b/i;

/** SQL-builder calls whose per-call `;` must not end the SQL statement. */
const SQL_BUILDER_RE =
  /\.\s*(SQL|SelectSQL|InsertSQL|ModifySQL|DeleteSQL|RefreshSQL|CommandText)\s*\.\s*(Add|Append)\s*\(/i;

/** Direct libmysql / API query calls: mysql_query(handle, 'SELECT …'). */
const MYSQL_API_RE = /\bmysql_(?:real_)?query\s*\(/i;

/**
 * Blank `{ … }` / `(* … *)` comments (which routinely contain prose that the
 * SQL scanner would misread) while leaving string literals intact. `//` line
 * comments are cut at the marker. Tracks block-comment state across lines.
 */
export function stripPascalComments(lines: string[]): string[] {
  let inBrace = false;
  let inParen = false;
  return lines.map((line) => {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBrace) {
        const j = line.indexOf("}", i);
        if (j < 0) return out;
        inBrace = false;
        i = j + 1;
        continue;
      }
      if (inParen) {
        const j = line.indexOf("*)", i);
        if (j < 0) return out;
        inParen = false;
        i = j + 2;
        continue;
      }
      const ch = line[i]!;
      if (ch === "'") {
        out += ch;
        i++;
        while (i < line.length) {
          out += line[i];
          if (line[i] === "'") {
            if (line[i + 1] === "'") { out += "'"; i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "/" && line[i + 1] === "/") return out;
      if (ch === "{") { inBrace = true; i++; continue; }
      if (ch === "(" && line[i + 1] === "*") { inParen = true; i += 2; continue; }
      out += ch;
      i++;
    }
    return out;
  });
}

/** Rewrite Pascal `'…'` literals ('' escapes a quote) into C-style `"…"`. */
export function pascalStringsToDoubleQuoted(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "'") {
      let buf = "";
      i++;
      while (i < line.length) {
        if (line[i] === "'") {
          if (line[i + 1] === "'") { buf += "'"; i += 2; continue; }
          i++;
          break;
        }
        buf += line[i];
        i++;
      }
      out += '"' + buf.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    } else {
      out += line[i];
      i++;
    }
  }
  return out;
}

export function extractPascalDataSources(rawLines: string[]): DataSourceInfo[] {
  const lines = stripPascalComments(rawLines);

  // Raw SQL: quote-normalize, un-terminate SQL.Add(...) builder lines so a
  // statement built across several Add calls stays one statement.
  const normLines = lines.map((line) => {
    let conv = pascalStringsToDoubleQuoted(line);
    if (SQL_BUILDER_RE.test(conv) || MYSQL_API_RE.test(conv)) {
      conv = conv.replace(/\)\s*;\s*$/, " ");
    }
    return conv;
  });
  const sources: DataSourceInfo[] = extractSqlStringDataSources(normLines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const lineNo = i + 1;

    const dataset = line.match(DATASET_RECEIVER);
    if (dataset) {
      sources.push({
        kind: "database",
        name: `${dataset[1]}.${dataset[2]}`,
        target: dataset[1]!.split(".").pop()!,
        calls: [],
        line: lineNo,
      });
      continue;
    }
    const conn = line.match(CONNECTION_RECEIVER);
    if (conn) {
      sources.push({
        kind: "database",
        name: `${conn[1]}.${conn[2]}`,
        target: conn[1]!.split(".").pop()!,
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const http = line.match(HTTP_CLIENT_RE);
    if (http) {
      const verb = http[2]!.toUpperCase();
      sources.push({
        kind: "api-call",
        name: verb === "EXECUTE" ? `${http[1]}.Execute` : verb,
        target: line.match(URL_LITERAL_RE)?.[1] ?? null,
        calls: [],
        line: lineNo,
      });
      continue;
    }
    const wininet = line.match(WININET_RE);
    if (wininet) {
      sources.push({
        kind: "api-call",
        name: wininet[1]!,
        target: line.match(URL_LITERAL_RE)?.[1]
          ?? (/(InternetConnect|WinHttpConnect)/i.test(wininet[1]!)
            ? line.match(HOST_LITERAL_RE)?.[1] ?? null
            : null),
        calls: [],
        line: lineNo,
      });
      continue;
    }
    if (SHELL_EXECUTE_RE.test(line)) {
      const url = line.match(URL_LITERAL_RE)?.[1];
      // Only a literal web URL is an outbound edge; opening files/apps is not.
      if (url) {
        sources.push({ kind: "api-call", name: "ShellExecute", target: url, calls: [], line: lineNo });
      }
      continue;
    }

    const env = line.match(ENV_RE);
    if (env) {
      sources.push({ kind: "env", name: "GetEnvironmentVariable", target: env[1]!, calls: [], line: lineNo });
      continue;
    }
    const config = line.match(CONFIG_RE);
    if (config) {
      sources.push({
        kind: "env",
        name: `${config[1]}.${config[2]}`,
        target: line.match(STRING_LITERAL_RE)?.[1] ?? null,
        calls: [],
        line: lineNo,
      });
    }
  }

  return sources;
}

export class PascalDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["pascal"];

  private fileSources: DataSourceInfo[] = [];

  override beginFile(_tree: Tree, sourceText: string): void {
    this.fileSources = extractPascalDataSources(sourceText.split(/\r?\n/));
  }

  override endFile(): void {
    this.fileSources = [];
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // Line-scanned per file; flush once when the walk visits the root.
    if (node.parent === null && this.fileSources.length > 0) {
      sources.push(...this.fileSources);
      this.fileSources = [];
    }
  }
}
