import type { Node } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { labeledArg, positionalArgs, stringValue, valuePath } from "./syntax.js";

/**
 * OCaml data access:
 *  - SQL in any string or quoted string — Caqti's `(T.int ->? T.string) "SELECT …"`,
 *    ppx_rapper's `[%rapper get_one {sql| SELECT … |sql}]`, Petrol — one source per statement;
 *  - HTTP clients with a literal URL: cohttp `Client.get (Uri.of_string "…")`,
 *    Piaf `Client.Oneshot.post`, Hyper `Hyper.get "…"`, ezcurl `Ezcurl_lwt.get ~url:"…" ()`.
 */
export class OCamlDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["ocaml"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "string" || node.type === "quoted_string") {
      const value = stringValue(node);
      if (value && /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(value)) {
        // ppx_rapper's typed holes (`@int{id}`, `%string{name}`) are parameters.
        const sql = value.replace(/[@%][\w?]+\{(\w+)\}/g, "$1").replace(/\s+/g, " ");
        for (const s of extractSqlStringDataSources([`"${sql.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`])) sources.push({ ...s, line: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type !== "application_expression") return;
    const fn = valuePath(node.childForFieldName("function"));
    const m = fn ? /(?:^|\.)(?:Client(?:\.Oneshot)?|Hyper|Ezcurl(?:_lwt)?)\.(get|post|put|patch|delete|head)$/.exec(fn) : null;
    if (!m) return;
    const url = uriOf(labeledArg(node, "url") ?? positionalArgs(node).find((a) => uriOf(a) !== null));
    if (url && (url.startsWith("/") || /^https?:\/\//.test(url))) {
      const method = m[1]!.toUpperCase();
      sources.push(this.ds({ kind: "api-call", name: `${method} ${url}`, target: url, line: node.startPosition.row + 1 }));
    }
  }
}

/** `"…"`, `(Uri.of_string "…")`. */
function uriOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "parenthesized_expression") return uriOf(node.namedChildren[0]);
  if (node.type === "application_expression" && /(?:^|\.)Uri\.of_string$/.test(valuePath(node.childForFieldName("function")) ?? "")) return stringValue(positionalArgs(node)[0]);
  const s = stringValue(node);
  return s !== null && /^(?:https?:\/\/|\/)/.test(s) ? s : null;
}
