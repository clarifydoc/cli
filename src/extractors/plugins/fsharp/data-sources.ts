import type { Node } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { calleeName, flattenApplication, stringValue } from "./syntax.js";

const HTTP_METHODS: Record<string, string> = {
  GetAsync: "GET", GetStringAsync: "GET", GetFromJsonAsync: "GET", GetByteArrayAsync: "GET", GetStreamAsync: "GET",
  PostAsync: "POST", PostAsJsonAsync: "POST", PutAsync: "PUT", PutAsJsonAsync: "PUT", PatchAsync: "PATCH", DeleteAsync: "DELETE",
};

/**
 * F# data access:
 *  - SQL in any string literal — Dapper (`conn.QueryAsync<Order>("SELECT …")`),
 *    Npgsql.FSharp (`Sql.query "…"`), SqlCommand, a `"""…"""` block; one source
 *    per statement, a string with no SQL statement is skipped;
 *  - HttpClient calls with a literal URL (`client.GetAsync("/api/x")`).
 */
export class FSharpDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["fsharp"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (/string$/.test(node.type) && node.parent?.type === "const") {
      const value = stringValue(node);
      if (value && /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(value)) {
        const literal = `"${value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
        for (const s of extractSqlStringDataSources([literal])) sources.push({ ...s, line: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type === "application_expression") {
      const { head, args } = flattenApplication(node);
      const name = calleeName(head);
      const method = name ? HTTP_METHODS[name.split(".").pop()!] : undefined;
      if (!method) return;
      const first = args[0]?.type === "paren_expression" ? args[0].namedChildren[0] : args[0];
      const urlNode = first?.type === "tuple_expression" ? first.namedChildren[0] : first;
      const url = urlNode ? stringValue(urlNode) : null;
      if (url && (url.startsWith("/") || /^https?:\/\//.test(url))) {
        sources.push(this.ds({ kind: "api-call", name: `${method} ${url}`, target: url, line: node.startPosition.row + 1 }));
      }
    }
  }
}
