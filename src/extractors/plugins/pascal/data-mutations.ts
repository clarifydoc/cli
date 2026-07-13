import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";

/** Write verbs on dataset/connection-shaped receivers (Query1, tblOrders,
 *  cdsUsers, ADOConnection1…). Bare `.Delete`/`.Insert`/`.Edit` substrings
 *  would flag every TStringList/TListItems call as a DB write. */
const DATASET_WRITE_RE =
  /\b((?:\w+\.)?\w*(?:query|qry|table|tbl|dataset|storedproc|cds|clientdata|connection|database)\w*)\s*\.\s*(Post|ApplyUpdates|ExecSQL|ExecProc|Delete|Insert|Edit|Append|CommitUpdates)\b/i;

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
          const kids = node.children;
          for (let i = 0; i < kids.length; i++) {
            const child = kids[i]!;
            if (child.type === "kAssign") {
              const next = kids[i + 1];
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

    // Database writes: receiver-gated verbs only. The receiver's NAME must be
    // dataset-shaped — matching bare verbs turned every TStringList.Insert
    // and TListItems.Delete into a phantom db-write.
    if (node.type === "exprCall") {
      const hit = node.text.match(DATASET_WRITE_RE);
      if (hit) {
        mutations.push({
          kind: "db-write",
          target: `${hit[1]}.${hit[2]}`,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
