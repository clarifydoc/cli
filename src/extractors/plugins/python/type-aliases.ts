import type { Node, Tree } from "web-tree-sitter";
import type { NameAliasInfo, TypeAliasInfo } from "../../../types/analysis.js";

/** `Club`, `league.Club`: a class as a module-level name refers to it. */
const CLASS_REF = /^(?:[A-Za-z_]\w*\.)*[A-Z]\w*$/;

/**
 * Module-level aliases of a class: `Repo = ClubRepository`,
 * `Repo: TypeAlias = league.ClubRepository` and Python 3.12's `type Repo = ClubRepository`.
 */
export function extractPythonTypeAliases(tree: Tree): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt.type === "type_alias_statement") {
      const [left, right] = stmt.namedChildren;
      const name = left?.text.replace(/\[.*$/s, "").trim();
      if (name && right) out.push({ name, type: right.text, line: stmt.startPosition.row + 1 });
      continue;
    }
    if (stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChild(0);
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    const annotation = assignment.childForFieldName("type");
    if (left?.type !== "identifier" || !right || !/^[A-Z]/.test(left.text)) continue;
    if (annotation && !/(?:^|\.)TypeAlias$/.test(annotation.text.trim())) continue;
    if (isClassRef(right)) out.push({ name: left.text, type: right.text, line: stmt.startPosition.row + 1 });
  }
  return out;
}

function isClassRef(node: Node): boolean {
  return (node.type === "identifier" || node.type === "attribute") && CLASS_REF.test(node.text);
}

/**
 * Module-level names bound to another name: `club = attrs`, and each name of
 * a chain `s = attributes = attrs`. A call of the alias is a call of what it
 * names; core decides whether that is a function.
 */
export function extractPythonNameAliases(tree: Tree): NameAliasInfo[] {
  const out: NameAliasInfo[] = [];
  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    let assignment = stmt.namedChild(0);
    const names: string[] = [];
    while (assignment?.type === "assignment") {
      const left = assignment.childForFieldName("left");
      if (left?.type !== "identifier") break;
      names.push(left.text);
      const right = assignment.childForFieldName("right");
      if (right?.type === "identifier") {
        for (const name of names) out.push({ name, target: right.text, line: stmt.startPosition.row + 1 });
        break;
      }
      assignment = right;
    }
  }
  return out;
}
