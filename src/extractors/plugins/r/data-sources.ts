import type { Node } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { callArgs, callName, leafOf, stringValue } from "./syntax.js";

/** DBI / dplyr calls whose second argument NAMES a table. */
const TABLE_READ = new Set(["dbReadTable", "tbl", "dbListFields", "dbExistsTable"]);
const TABLE_WRITE = new Set(["dbWriteTable", "dbAppendTable", "dbRemoveTable", "dbCreateTable"]);
/** HTTP clients whose first argument is the URL; httr's verb functions carry the method. */
const HTTR_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const URL_GETTERS = new Set(["request", "curl_fetch_memory", "curl_fetch_disk", "getURL", "fromJSON", "read_json", "url"]);

/**
 * R data access:
 *  - SQL in any string (`dbGetQuery(con, "SELECT …")`, `dbExecute`, a
 *    `glue_sql()` template) — one source per statement;
 *  - a table named to DBI / dplyr (`dbReadTable(con, "orders")`,
 *    `tbl(con, "orders")` read; `dbWriteTable` / `dbAppendTable` write);
 *  - HTTP: httr (`GET(url)`, `POST(url, body = …)`), httr2 `request(url)`,
 *    curl, `jsonlite::fromJSON("https://…")`. A URL built with `paste0` keeps
 *    its literal parts (`paste0(base, "/users/", id)` → `/users/{id}`).
 */
export class RDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["r"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "string") {
      const value = stringValue(node);
      if (value && /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(value)) {
        const literal = `"${value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
        for (const s of extractSqlStringDataSources([literal])) sources.push({ ...s, line: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type !== "call") return;
    const name = callName(node);
    if (!name) return;
    const leaf = leafOf(name);
    const args = callArgs(node);
    const line = node.startPosition.row + 1;
    if (TABLE_READ.has(leaf) || TABLE_WRITE.has(leaf)) {
      const table = stringValue(args[1]?.value) ?? stringValue(args.find((a) => a.name === "name")?.value);
      if (table) {
        const access = TABLE_WRITE.has(leaf) ? "write" : "read";
        sources.push(this.ds({ kind: "database", name: leaf, target: table, entity: table, access, line }));
      }
      return;
    }
    const verb = HTTR_VERBS.has(leaf) && (name === leaf || /^httr\./.test(name)) ? leaf : URL_GETTERS.has(leaf) ? "GET" : null;
    if (!verb) return;
    const urlNode = args[0]?.value ?? args.find((a) => a.name === "url")?.value ?? null;
    const url = urlOf(urlNode);
    if (url && (url.startsWith("/") || /^https?:\/\//.test(url))) {
      const source = this.ds({ kind: "api-call", name: `${verb} ${url}`, target: url, line });
      // `paste0(Sys.getenv("CRM_URL"), "/users")`: the base is configuration.
      const env = urlNode?.type === "call" ? /^Sys\.getenv\(\s*["']([^"']+)["']/.exec(callArgs(urlNode)[0]?.value?.text ?? "")?.[1] : undefined;
      if (env) source.baseEnv = env;
      sources.push(source);
    }
  }
}

/** A URL argument: a literal, or `paste0("https://x/users/", id)` / `glue("…/{id}")` with its holes as `{name}`. */
function urlOf(node: Node | null): string | null {
  if (!node) return null;
  const literal = stringValue(node);
  if (literal !== null) return literal;
  if (node.type === "call" && /^(?:paste0|paste|glue|sprintf|str_glue)$/.test(leafOf(callName(node) ?? ""))) {
    const parts = callArgs(node).filter((a) => a.name === null || a.name === "sep");
    let url = "";
    for (const p of parts) {
      if (p.name === "sep") continue;
      const s = stringValue(p.value);
      url += s !== null ? s.replace(/%[sd]/g, "{}") : `{${p.value?.text.replace(/.*\$/, "") ?? ""}}`;
    }
    // A leading base variable is configuration: keep the path after it.
    return url.replace(/^\{[^}]*\}(?=\/)/, "");
  }
  return null;
}
