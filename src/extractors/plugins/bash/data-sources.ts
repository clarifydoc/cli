import type { Node } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { commandArgs, commandName, operandText } from "./commands.js";

/** Programs whose operands (or here-document) are SQL. */
const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "clickhouse-client", "duckdb", "cockroach", "bq", "snowsql"]);
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https"]);

/**
 * Shell data access:
 *
 *  - HTTP: `curl` (`-X` / `--request`, a data flag implies POST, `-I` HEAD),
 *    `wget` (`--method=`, `--post-data`), HTTPie (`http POST url`). A URL on
 *    a variable keeps its literal tail and names the variable as its base
 *    (`"$API_URL/api/deploys"` → `/api/deploys`, `baseEnv: API_URL`).
 *  - SQL: the operands and here-document of a database client — `psql -c
 *    "…"`, `mysql -e "…"`, `cat <<SQL | sqlite3 app.db`, a client run
 *    through `docker exec`. Only there: `echo "Select a file from disk"` is
 *    prose, not a query of a table `disk`.
 */
export class BashDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["bash"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "command") {
      const name = commandName(node);
      if (name && HTTP_CLIENTS.has(name)) {
        const call = httpCall(node, name);
        if (call) sources.push(call);
      }
      if (isDbCommand(node, name)) {
        for (const arg of commandArgs(node)) {
          if (arg.type === "string" || arg.type === "raw_string" || arg.type === "word") {
            sources.push(...sqlSources(operandText(arg), arg.startPosition.row + 1));
          }
        }
      }
    } else if (node.type === "redirected_statement") {
      const body = node.descendantsOfType("heredoc_body")[0];
      if (body && node.descendantsOfType("command").some((c) => isDbCommand(c, commandName(c)))) {
        sources.push(...sqlSources(body.text, body.startPosition.row + 1));
      }
    }
  }
}

function isDbCommand(node: Node, name: string | null): boolean {
  if (name && DB_CLIENTS.has(name)) return true;
  // `docker exec db psql -c "…"`, `kubectl exec … -- mysql -e "…"`
  return commandArgs(node).some((a) => a.type === "word" && DB_CLIENTS.has(a.text));
}

/** One data source per SQL statement in `text` (statements split at `;`), lines kept. */
function sqlSources(text: string, firstLine: number): DataSourceInfo[] {
  if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE|CREATE|DROP|ALTER)\b/i.test(text)) return [];
  const lines: string[] = [];
  const starts: number[] = [];
  let pending = "";
  let start = firstLine;
  text.split("\n").forEach((raw, i) => {
    if (!pending.trim()) start = firstLine + i;
    pending += " " + raw;
    if (/;\s*$/.test(raw)) {
      lines.push(literal(pending));
      starts.push(start);
      pending = "";
    }
  });
  if (pending.trim()) { lines.push(literal(pending)); starts.push(start); }
  return extractSqlStringDataSources(lines).map((s) => ({ ...s, line: starts[s.line - 1] ?? firstLine }));
}

const literal = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim()}";`;

function httpCall(node: Node, client: string): DataSourceInfo | null {
  const args = commandArgs(node).map(operandText);
  let method: string | null = null;
  let url: string | null = null;
  let sendsData = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = /^(?:-X|--request)(?:=?(\w+))?$/.exec(a);
    if (flag) { method = (flag[1] ?? args[++i] ?? "").toUpperCase() || null; continue; }
    if (/^-X\w+$/.test(a)) { method = a.slice(2).toUpperCase(); continue; }
    if (/^--method=/.test(a)) { method = a.slice("--method=".length).toUpperCase(); continue; }
    if (/^(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form|--json|--post-data|--post-file)(?:=|$)/.test(a)) { sendsData = true; if (!a.includes("=")) i++; continue; }
    if (/^(?:-I|--head)$/.test(a)) { method = "HEAD"; continue; }
    if (client.startsWith("http") && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(a)) { method = a; continue; }
    if (/^-/.test(a)) continue;
    if (!url && /^(?:https?:\/\/|\$\{?\w+|\/)/.test(a)) url = a;
  }
  if (!url) return null;
  const base = /^\$\{?(\w+)(?::-[^}]*)?\}?(?=\/)/.exec(url);
  let target = base ? url.slice(base[0].length) : url;
  target = target.replace(/\$\{?(\w+)\}?/g, "{$1}");
  if (!target.startsWith("/") && !/^https?:\/\//.test(target)) return null;
  const verb = method ?? (sendsData ? "POST" : "GET");
  const source: DataSourceInfo = { kind: "api-call", name: `${verb} ${target}`, target, calls: [], line: node.startPosition.row + 1 };
  if (base && /^[A-Z][A-Z0-9_]*$/.test(base[1]!)) source.baseEnv = base[1]!;
  return source;
}
