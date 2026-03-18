import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

export class PascalDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["pascal"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // Detect common Delphi data access patterns via method calls
    if (node.type === "exprCall") {
      const fnText = node.text;
      const fnLower = fnText.toLowerCase();

      // Database patterns: TQuery.Open, TDataSet.Open, TFDQuery.ExecSQL, etc.
      if (
        fnLower.includes(".open") ||
        fnLower.includes(".execsql") ||
        fnLower.includes(".execute") ||
        fnLower.includes(".locate") ||
        fnLower.includes(".lookup") ||
        fnLower.includes(".fieldbyname")
      ) {
        sources.push(this.ds({
          kind: "database",
          name: fnText.length > 60 ? fnText.slice(0, 60) + "..." : fnText,
          target: null,
          line: node.startPosition.row + 1,
        }));
      }

      // HTTP client patterns: THTTPClient, TIdHTTP, TRESTClient, TNetHTTPClient
      if (
        fnLower.includes("http") ||
        fnLower.includes("restclient") ||
        fnLower.includes("restresponse") ||
        fnLower.includes("restrequest")
      ) {
        sources.push(this.ds({
          kind: "api-call",
          name: fnText.length > 60 ? fnText.slice(0, 60) + "..." : fnText,
          target: null,
          line: node.startPosition.row + 1,
        }));
      }

      // Environment / config: TIniFile.ReadString, TRegistry, GetEnvironmentVariable
      if (
        fnLower.includes("readstring") ||
        fnLower.includes("readinteger") ||
        fnLower.includes("readbool") ||
        fnLower.includes("getenvironmentvariable") ||
        fnLower.includes("tregistry")
      ) {
        sources.push(this.ds({
          kind: "env",
          name: fnText.length > 60 ? fnText.slice(0, 60) + "..." : fnText,
          target: null,
          line: node.startPosition.row + 1,
        }));
      }
    }
  }
}
