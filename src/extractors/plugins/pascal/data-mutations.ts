import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";

export class PascalMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["pascal"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // Pascal assignment: identifier := expr
    if (node.type === "assignment") {
      const lhs = node.childForFieldName("lhs");
      if (lhs) {
        const lhsText = lhs.text;
        // Field assignments (Self.xxx or FXxx pattern) and property writes
        if (
          lhsText.startsWith("F") && lhsText.length > 1 && lhsText[1] === lhsText[1].toUpperCase() ||
          lhsText.includes(".")
        ) {
          // Find the right-hand side value
          let value: string | null = null;
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i)!;
            if (child.type === "kAssign") {
              const next = node.child(i + 1);
              if (next) value = this.truncate(next.text, 80);
              break;
            }
          }
          mutations.push({
            kind: "assignment",
            target: lhsText,
            value,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    // Database write patterns via method calls
    if (node.type === "exprCall") {
      const text = node.text.toLowerCase();
      if (
        text.includes(".post") ||
        text.includes(".applyupdates") ||
        text.includes(".execsql") ||
        text.includes(".delete") ||
        text.includes(".insert") ||
        text.includes(".edit") ||
        text.includes(".append")
      ) {
        mutations.push({
          kind: "db-write",
          target: node.text.length > 100 ? node.text.slice(0, 100) + "..." : node.text,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
