import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../types/analysis.js";
import { DataSourceExtractor } from "./base.js";

export class PythonDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["python"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const fnName = fn?.text;

      if (fnName) {
        // requests.get(), httpx.get(), etc.
        if (
          fnName.includes("requests.") ||
          fnName.includes("httpx.") ||
          fnName.includes("aiohttp.")
        ) {
          const args = node.childForFieldName("arguments");
          let target: string | null = null;
          if (args && args.childCount > 1) {
            const firstArg = args.child(1);
            if (firstArg) target = firstArg.text.replace(/^['"]|['"]$/g, "");
          }
          sources.push(this.ds({
            kind: "api-call",
            name: fnName,
            target,
            line: node.startPosition.row + 1,
          }));
        }

        // os.environ, os.getenv
        if (fnName.includes("os.getenv") || fnName.includes("os.environ")) {
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // Database patterns
        if (
          fnName.includes(".query") ||
          fnName.includes(".execute") ||
          fnName.includes(".find") ||
          fnName.includes(".filter")
        ) {
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }
      }
    }
  }
}
