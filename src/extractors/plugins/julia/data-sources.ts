import type { Node } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { calleeName, stringValue } from "./syntax.js";

const HTTP_VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD" };

/**
 * Julia data access: SQL in any string (`LibPQ.execute(conn, "SELECT …")`,
 * `DBInterface.execute(db, "…")`, a `"""` block) — one source per statement —
 * and HTTP.jl calls with a literal URL (`HTTP.get(url)`,
 * `HTTP.request("POST", url)`).
 */
export class JuliaDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["julia"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (/string_literal$/.test(node.type)) {
      const value = stringValue(node);
      if (value && /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(value)) {
        const literal = `"${value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
        for (const s of extractSqlStringDataSources([literal])) sources.push({ ...s, line: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const name = calleeName(node.namedChildren[0]);
    const m = name ? /^HTTP\.(get|post|put|patch|delete|head|request)$/.exec(name) : null;
    if (!m) return;
    const args = node.namedChildren.find((c) => c.type === "argument_list")?.namedChildren ?? [];
    const method = m[1] === "request" ? stringValue(args[0])?.toUpperCase() : HTTP_VERBS[m[1]!];
    const url = stringValue(m[1] === "request" ? args[1] : args[0]);
    if (method && url && (url.startsWith("/") || /^https?:\/\//.test(url))) {
      sources.push(this.ds({ kind: "api-call", name: `${method} ${url}`, target: url, line: node.startPosition.row + 1 }));
    }
  }
}
