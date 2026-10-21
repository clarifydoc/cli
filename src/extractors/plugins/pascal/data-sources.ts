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
 * Raw SQL rides the shared SQL-in-strings scanner after two normalizations
 * (`sqlScannerLines`): Pascal `'…'` literals become C-style `"…"`, and
 * `Query1.SQL.Add('…');` builder lines lose their statement terminator so
 * consecutive Add calls concatenate into one statement — the idiomatic
 * multi-line query:
 *
 *     Query1.SQL.Add('SELECT id, name');
 *     Query1.SQL.Add('FROM customers WHERE active = 1');
 *     Query1.Open;
 */

/** Dataset verbs: the TDataSet ones, plus FIBPlus/IBX `ExecQuery`,
 *  `CloseOpen`, `FullRefresh` and cached-update `ApplyUpdates`. */
const DATASET_VERBS = "Open|ExecSQL|ExecProc|ExecQuery|CloseOpen|FullRefresh|ApplyUpdates|Post|Append|Edit|Delete|Insert|Locate|Lookup|FieldByName";

/** Dataset components by naming convention: Query1, tblOrders, cdsUsers,
 *  FDQuery, ADOTable, IBQuery, mySQLQuery … */
const DATASET_RECEIVER = new RegExp(
  String.raw`\b((?:\w+\.)?\w*(?:query|qry|table|tbl|dataset|storedproc|cds|clientdata)\w*)\s*\.\s*(${DATASET_VERBS})\b`,
  "i",
);

/** Any receiver with a dataset verb — accepted when the unit DECLARES it a dataset. */
const ANY_DATASET_CALL = new RegExp(String.raw`\b((?:\w+\.)?(\w+))\s*\.\s*(${DATASET_VERBS})\b`, "gi");

/**
 * A database dataset class: `TpFIBDataSet`, `TpFIBQuery`, `TFDQuery`,
 * `TADOTable`, `TIBSQL`, `TStoredProc`, `TADOCommand` … In-memory tables
 * (`TFDMemTable`, `TkbmMemTable`) are no database; `TdxMemData` and
 * `TJvMemoryData` do not end in a dataset word at all.
 */
const DATASET_TYPE_RE = /^T\w*(?:Query|Table|DataSet|StoredProc|SQL|Command)$/i;
const IN_MEMORY_TYPE_RE = /Mem/i;

/** `dsTransfers: TpFIBDataSet;` — a form's component field, a routine's local, a parameter list entry. */
const DECLARATION_RE = /(?:^|[;(]|\bvar\b|\bconst\b)\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([A-Za-z_][\w.]*)\s*(?=[;)=])/g;
/** `q := TpFIBQuery.Create(nil)` — a local typed by its constructor. */
const CREATED_RE = /\b([A-Za-z_]\w*)\s*:=\s*([A-Za-z_]\w*)\s*\.\s*Create\b/g;

/** A routine header: `procedure TForm1.Load;`, `class function X.Y: Z;`. */
const ROUTINE_HEADER_RE = /^\s*(?:class\s+)?(?:procedure|function|constructor|destructor|operator)\s+[\w.<>]+/i;

/**
 * The names a unit declares as database datasets — the form's component
 * fields (`dsTransfers: TpFIBDataSet;`, which the IDE writes for every
 * component on the companion `.dfm`), locals and parameters of a dataset
 * type, and locals created as one. A project that names its datasets `ds*`
 * or `q*` is invisible to the naming convention; its declarations are not.
 */
export function declaredDatasets(lines: string[]): Set<string> {
  const out = new Set<string>();
  const isDataset = (type: string): boolean => {
    const leaf = type.split(".").pop()!;
    return DATASET_TYPE_RE.test(leaf) && !IN_MEMORY_TYPE_RE.test(leaf);
  };
  for (const line of lines) {
    if (!line.includes(":")) continue;
    for (const m of line.matchAll(DECLARATION_RE)) {
      if (!isDataset(m[2]!)) continue;
      for (const name of m[1]!.split(",")) out.add(name.trim().toLowerCase());
    }
    if (!line.includes(".Create") && !line.includes(".create")) continue;
    for (const m of line.matchAll(CREATED_RE)) {
      if (isDataset(m[2]!)) out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

/** The dataset call on a line: by naming convention, or on a receiver the unit declares a dataset. */
function datasetCall(line: string, declared: Set<string>): { receiver: string; verb: string } | null {
  const named = line.match(DATASET_RECEIVER);
  if (named) return { receiver: named[1]!, verb: named[2]! };
  if (declared.size === 0) return null;
  for (const m of line.matchAll(ANY_DATASET_CALL)) {
    // `Self.dsX` is the unit's own field; `DM.dsX` belongs to another unit.
    const qualifier = m[1]!.includes(".") ? m[1]!.split(".")[0]!.toLowerCase() : null;
    if (qualifier && qualifier !== "self") continue;
    if (declared.has(m[2]!.toLowerCase())) return { receiver: m[1]!, verb: m[3]! };
  }
  return null;
}

/** Connection components: ADOConnection1.Open / Database1.ExecuteDirect(…). */
const CONNECTION_RECEIVER =
  /\b((?:\w+\.)?\w*(?:connection|database|conn)\w*)\s*\.\s*(Open|Execute|ExecuteDirect|StartTransaction|Commit)\b/i;

/** HTTP client verbs on http/rest-shaped receivers (TIdHTTP, THTTPClient,
 *  TRESTClient, TNetHTTPClient instances: IdHTTP1, HttpClient, RESTRequest1…).
 *  "rest" alone would swallow Restore. `GetURL`/`PostURL` are the wrappers
 *  in-house HTTPS classes put around Indy. */
const HTTP_CLIENT_RE =
  /\b(\w*http\w*|\w*rest(?:client|request|response)\w*)\s*\.\s*(Get|Post|Put|Delete|Head|Options|Patch|Execute)(?:URL)?\b\s*(\()?/i;

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

/** Split `text` at top-level occurrences of `sep` (outside quotes and parens). */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") inQuote = !inQuote;
    else if (inQuote) continue;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** The argument text of the call whose `(` is at `open`, or null when it does not close. */
function callArgs(text: string, open: number): string | null {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") inQuote = !inQuote;
    else if (inQuote) continue;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/**
 * Where an HTTP call's URL comes from, read back through the unit: the
 * client never writes the URL into the call (`HTTPS.Post(URL)`), it builds it
 * in a local first — `URL := ApiUrl('/REST/PlayerPhoto/' + hash)`,
 * `Format('/REST/%d/MatchReport', [matchId])`, or a `const PATH = '/api/…'`.
 * A local resolves to its nearest assignment above the call in the same
 * routine, then to a constant of that name (the routine's own first).
 */
class UrlResolver {
  private readonly routineStart: number[];
  constructor(private readonly lines: string[]) {
    this.routineStart = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (ROUTINE_HEADER_RE.test(lines[i]!)) start = i;
      this.routineStart.push(start);
    }
  }

  /** The URL path of the call's first argument at line index `at`, or null. */
  argumentUrl(line: string, open: number, at: number): string | null {
    const args = callArgs(line, open);
    if (args === null) return null;
    const first = splitTopLevel(args, ",")[0] ?? "";
    const url = this.evaluate(first, at, 0);
    if (!url || !/^(?:https?:\/\/|\/)/i.test(url)) return null;
    return url.replace(/\?.*$/, "") || null;
  }

  private evaluate(expr: string, at: number, depth: number): string | null {
    const text = expr.trim().replace(/;$/, "").trim();
    if (!text || depth > 4) return null;
    const operands = splitTopLevel(text, "+");
    if (operands.length > 1) {
      const parts = operands.map((o) => this.operand(o, at, depth) ?? `{${o.replace(/\W+/g, "") || "p"}}`);
      return parts.join("");
    }
    return this.operand(text, at, depth);
  }

  private operand(text: string, at: number, depth: number): string | null {
    const literal = /^'((?:[^']|'')*)'$/.exec(text);
    if (literal) return literal[1]!.replace(/''/g, "'");
    const call = /^([A-Za-z_][\w.]*)\s*\(/.exec(text);
    if (call && callArgs(text, call[0].length - 1)?.length === text.length - call[0].length - 1) {
      const args = splitTopLevel(callArgs(text, call[0].length - 1)!, ",");
      const head = this.evaluate(args[0] ?? "", at, depth + 1);
      if (head === null) return null;
      // `Format('/REST/%d/x', [n])`: each conversion is a runtime segment. Any
      // other wrapper (`ApiUrl(path)`) prefixes a base the call's own
      // origin pass resolves; the path is its argument.
      return /^Format$/i.test(call[1]!) ? head.replace(/%(?:\d+:)?-?\d*(?:\.\d+)?[a-z]/gi, "{}") : head;
    }
    if (/^[A-Za-z_]\w*$/.test(text)) return this.identifier(text, at, depth);
    return null;
  }

  private identifier(name: string, at: number, depth: number): string | null {
    const from = this.routineStart[at] ?? 0;
    const assign = new RegExp(String.raw`^\s*${name}\s*:=\s*(.*)$`, "i");
    for (let i = at - 1; i >= from; i--) {
      const m = assign.exec(this.lines[i]!);
      if (m) return this.evaluate(this.statementFrom(m[1]!, i), i, depth + 1);
    }
    const constant = new RegExp(String.raw`^\s*(?:const\s+)?${name}\s*(?::\s*\w+\s*)?=\s*('(?:[^']|'')*')\s*;`, "i");
    let unit: string | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      const m = constant.exec(this.lines[i]!);
      if (!m) continue;
      if (i >= from && i < at) return this.operand(m[1]!, i, depth + 1);
      unit ??= m[1]!;
    }
    return unit ? this.operand(unit, at, depth + 1) : null;
  }

  /** An assignment's right-hand side, joined across the lines it continues onto up to its `;`. */
  private statementFrom(head: string, i: number): string {
    let text = head;
    for (let j = i + 1; j < Math.min(this.lines.length, i + 6) && !/;\s*$/.test(text.replace(/'(?:[^']|'')*'/g, "")); j++) {
      text += " " + this.lines[j]!.trim();
    }
    return text;
  }
}

/** A line with no string literal that only steers control flow between builder calls. */
const CONTROL_ONLY_RE = /^\s*(?:if\b.*\bthen|else|begin|end;?)?\s*$/i;

/**
 * Pascal lines prepared for the shared SQL scanner: `'…'` literals become
 * C-style `"…"`, and builder calls (`SelectSQL.Add('…');`) lose their `;` so a
 * statement built across several calls stays one statement — also when a call
 * puts its literal on the next line, and across the `if … then` lines that add
 * an optional clause:
 *
 *     ds.SelectSQL.Add('FROM SP_SEARCH(:A) P');
 *     if FSquadID <> 0 then
 *       ds.SelectSQL.Add(
 *       'INNER JOIN TSQUADPLAYERRELATION SPR ON SPR.PLAYER_ID = P.ID');
 */
function sqlScannerLines(lines: string[]): string[] {
  const out = lines.map((line) => pascalStringsToDoubleQuoted(line));
  const isBuilder = (i: number): boolean => SQL_BUILDER_RE.test(out[i]!);
  let inCall = false;
  let pendingBuilder = false;
  for (let i = 0; i < out.length; i++) {
    const conv = out[i]!;
    if (inCall) {
      if (/\)\s*;\s*$/.test(conv)) {
        out[i] = conv.replace(/\)\s*;\s*$/, " ");
        inCall = false;
      }
      continue;
    }
    if (isBuilder(i) || MYSQL_API_RE.test(conv)) {
      const closed = /\)\s*;\s*$/.test(conv);
      let next = closed ? conv.replace(/\)\s*;\s*$/, " ") : conv;
      // The call's literal is on the next line: keep the statement open here.
      if (!next.includes('"')) next += ' ""';
      out[i] = next;
      inCall = !closed && !/\)\s*$/.test(conv);
      pendingBuilder = true;
      continue;
    }
    if (pendingBuilder && CONTROL_ONLY_RE.test(conv)) {
      // Bridge to the next builder call only; anything else ends the statement.
      let j = i + 1;
      while (j < out.length && CONTROL_ONLY_RE.test(out[j]!)) j++;
      if (j < out.length && isBuilder(j)) {
        out[i] = '""';
        continue;
      }
    }
    pendingBuilder = false;
  }
  return out;
}

export function extractPascalDataSources(rawLines: string[]): DataSourceInfo[] {
  const lines = stripPascalComments(rawLines);

  const sources: DataSourceInfo[] = extractSqlStringDataSources(sqlScannerLines(lines));
  const declared = declaredDatasets(lines);
  const urls = new UrlResolver(lines);
  // `FieldByName` reads a column of a dataset already open — one row per
  // dataset per routine says the routine reads it; a row per field (1,100 on
  // one settings unit) only inflates the count.
  let fieldReads = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const lineNo = i + 1;
    // A routine's own header (`procedure THTTPLapLogThread.Execute;`) names a
    // method, it does not call one.
    if (ROUTINE_HEADER_RE.test(line)) {
      fieldReads = new Set();
      continue;
    }

    const dataset = datasetCall(line, declared);
    if (dataset) {
      const target = dataset.receiver.split(".").pop()!;
      if (/^FieldByName$/i.test(dataset.verb)) {
        const key = target.toLowerCase();
        if (fieldReads.has(key)) continue;
        fieldReads.add(key);
      }
      sources.push({
        kind: "database",
        name: `${dataset.receiver}.${dataset.verb}`,
        target,
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
      const target = line.match(URL_LITERAL_RE)?.[1]
        ?? (http[3] ? urls.argumentUrl(line, http.index! + http[0].length - 1, i) : null);
      sources.push({
        kind: "api-call",
        name: verb === "EXECUTE" ? `${http[1]}.Execute` : verb,
        target,
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
