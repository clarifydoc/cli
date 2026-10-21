import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";
import { CI_DB_RECEIVER } from "./data-sources.js";

/** CodeIgniter Query Builder writes; the first string argument is the table. */
const CI_WRITE_VERBS: ReadonlySet<string> = new Set([
  "insert", "insert_batch", "update", "update_batch", "replace", "delete", "truncate", "empty_table",
]);

/** `'clubs'` from `->insert('clubs', $row)`, alias and schema dropped; null for a variable or none. */
function ciTable(call: Node): string | null {
  const arg = call.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "argument");
  const lit = arg?.namedChildren[0];
  if (!lit || (lit.type !== "string" && lit.type !== "encapsed_string")) return null;
  const table = lit.text.replace(/^['"]|['"]$/g, "").trim().split(/\s+/)[0]!.split(".").pop()!.replace(/`/g, "");
  return /^[A-Za-z_]\w*$/.test(table) ? table : null;
}

export class PhpMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["php"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // `$this->prop = value` — surface as a state mutation.
    if (node.type === "assignment_expression") {
      const left = node.child(0);
      const right = node.child(2);
      const leftText = left?.text ?? "";
      if (leftText.startsWith("$this->")) {
        mutations.push({
          kind: "assignment",
          target: leftText,
          value: this.truncate(right?.text ?? null, 80),
          line: node.startPosition.row + 1,
        });
      }
    }

    // ORM writes: `$model->save()`, `$model->update(...)`, `$model->delete()`
    if (node.type === "member_call_expression") {
      const method = node.childForFieldName("name")?.text ?? "";
      const recv = node.childForFieldName("object")?.text ?? "";
      // CodeIgniter's writes name their table: `$this->db->insert('clubs', $row)`.
      if (CI_DB_RECEIVER.test(recv) && CI_WRITE_VERBS.has(method)) {
        mutations.push({
          kind: "db-write",
          target: ciTable(node) ?? `${recv}->${method}`,
          value: null,
          line: node.startPosition.row + 1,
        });
        return;
      }
      if (/^(save|update|delete|destroy|insert|push|create)$/.test(method)) {
        mutations.push({
          kind: "db-write",
          target: `${recv}->${method}`,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Static ORM writes: `Model::create(...)`, `DB::insert(...)`
    if (node.type === "scoped_call_expression") {
      const scope = node.childForFieldName("scope")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      if (/^(create|insert|update|delete|destroy|truncate)$/.test(name)) {
        mutations.push({
          kind: "db-write",
          target: `${scope}::${name}`,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
