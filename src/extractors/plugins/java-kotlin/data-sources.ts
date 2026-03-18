import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

export class JavaKotlinDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "method_invocation" || node.type === "call_expression") {
      const fnNode =
        node.childForFieldName("name") ?? node.childForFieldName("function");
      const fnName = fnNode?.text;

      if (fnName) {
        // Detect HTTP client calls
        const fullText = node.text;
        if (
          fullText.includes("RestTemplate") ||
          fullText.includes("WebClient") ||
          fullText.includes("HttpClient") ||
          fullText.includes("OkHttp") ||
          fullText.includes("Retrofit") ||
          fnName.includes("exchange") ||
          fnName.includes("getForObject") ||
          fnName.includes("postForObject")
        ) {
          sources.push(this.ds({
            kind: "api-call",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // Database / repository patterns
        if (
          fnName.includes("findBy") ||
          fnName.includes("findAll") ||
          fnName.includes("save") ||
          fnName.includes("delete") ||
          fnName.includes("query") ||
          fnName.includes("execute")
        ) {
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // Environment / config reads
        if (
          fnName.includes("getProperty") ||
          fnName.includes("getenv") ||
          fnName.includes("getValue")
        ) {
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }
      }
    }

    // @Autowired or @Inject annotations indicate dependency injection
    if (
      node.type === "annotation" ||
      node.type === "marker_annotation"
    ) {
      const text = node.text;
      if (text.includes("Autowired") || text.includes("Inject") || text.includes("Value")) {
        sources.push(this.ds({
          kind: "import",
          name: text.replace(/^@/, ""),
          target: null,
          line: node.startPosition.row + 1,
        }));
      }
    }
  }
}
