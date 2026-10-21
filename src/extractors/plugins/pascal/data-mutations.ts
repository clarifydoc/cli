import type { Node, Tree } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";
import { declaredDatasets } from "./data-sources.js";

/** Write verbs on dataset/connection-shaped receivers (Query1, tblOrders,
 *  cdsUsers, ADOConnection1…). Bare `.Delete`/`.Insert`/`.Edit` substrings
 *  would flag every TStringList/TListItems call as a DB write. */
const DATASET_WRITE_RE =
  /\b((?:\w+\.)?\w*(?:query|qry|table|tbl|dataset|storedproc|cds|clientdata|connection|database)\w*)\s*\.\s*(Post|ApplyUpdates|ExecSQL|ExecProc|Delete|Insert|Edit|Append|CommitUpdates)\b/i;

/** Write verbs on any receiver — kept when the unit declares the receiver a dataset. */
const ANY_WRITE_RE = /\b((?:Self\.)?(\w+))\s*\.\s*(Post|ApplyUpdates|ExecSQL|ExecProc|ExecQuery|Delete|Insert|Edit|Append|CommitUpdates)\b/i;

/**
 * VCL presentation properties: `btnSave.Visible := False` sets how a control
 * looks, not application state. 4,000 such writes on one Delphi app buried the
 * assignments that do change state.
 */
const UI_PROPERTY_RE =
  /\.(?:Visible|Enabled|Caption|Hint|ShowHint|Color|Font|Left|Top|Width|Height|Align|Anchors|Cursor|TabOrder|TabStop|ReadOnly|ImageIndex|Glyph|ParentFont|ParentColor|BorderStyle|Style|Images|PopupMenu|Constraints|Margins|AlignWithMargins|Transparent|WordWrap|Layout|Alignment|DisplayFormat|EditMask|MaxLength|Kind|Down|Flat|Default|Cancel|ModalResult|ActivePage|ActivePageIndex|TabVisible|PageIndex|ScrollBars|ColCount|RowCount|DefaultRowHeight|ColWidths|RowHeights|Properties)(?:\.\w+)*$/i;

export class PascalMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["pascal"];

  private declared = new Set<string>();

  override beginFile(_tree: Tree, sourceText: string): void {
    this.declared = declaredDatasets(sourceText.split(/\r?\n/));
  }

  override endFile(): void {
    this.declared = new Set();
  }

  /** A write on a dataset — by naming convention, or on a receiver the unit declares a dataset. */
  private datasetWrite(text: string): string | null {
    const named = text.match(DATASET_WRITE_RE);
    if (named) return `${named[1]}.${named[2]}`;
    const any = text.match(ANY_WRITE_RE);
    return any && this.declared.has(any[2]!.toLowerCase()) ? `${any[1]}.${any[3]}` : null;
  }

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // Pascal assignment: identifier := expr
    if (node.type === "assignment") {
      const lhs = node.childForFieldName("lhs");
      if (lhs) {
        const lhsText = lhs.text;
        // Field assignments (Self.xxx or FXxx pattern) and property writes
        if (
          (lhsText.startsWith("F") && lhsText.length > 1 && lhsText[1] === lhsText[1].toUpperCase() ||
            lhsText.includes(".")) &&
          !UI_PROPERTY_RE.test(lhsText)
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
      const hit = this.datasetWrite(node.text);
      if (hit) {
        mutations.push({
          kind: "db-write",
          target: hit,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
