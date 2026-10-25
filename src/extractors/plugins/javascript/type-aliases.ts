import type { Node, Tree } from "web-tree-sitter";
import type { TypeAliasInfo } from "../../../types/analysis.js";

const NAMED_TYPES = new Set(["type_identifier", "nested_type_identifier", "generic_type"]);
const EMPTY_TYPES = new Set(["null", "undefined"]);

/**
 * Top-level `type Repo = ClubRepository` (exported or not) that names one
 * type — `Garage<T>`, `league.Club`, `Club | null` — never an object, function
 * or union of several types.
 */
export function extractTsTypeAliases(tree: Tree): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  for (const top of tree.rootNode.namedChildren) {
    const decl = top.type === "export_statement" ? top.childForFieldName("declaration") : top;
    if (decl?.type !== "type_alias_declaration") continue;
    const name = decl.childForFieldName("name")?.text;
    const value = decl.childForFieldName("value");
    const named = value ? namedType(value) : null;
    if (name && named) out.push({ name, type: named.text, line: decl.startPosition.row + 1 });
  }
  return out;
}

function namedType(node: Node): Node | null {
  if (NAMED_TYPES.has(node.type)) return node;
  if (node.type !== "union_type") return null;
  const parts: Node[] = [];
  const collect = (n: Node): void => {
    if (n.type === "union_type") for (const c of n.namedChildren) collect(c);
    else if (!(n.type === "literal_type" && EMPTY_TYPES.has(n.namedChild(0)?.type ?? "")) && !(n.type === "predefined_type" && EMPTY_TYPES.has(n.text))) parts.push(n);
  };
  collect(node);
  return parts.length === 1 && NAMED_TYPES.has(parts[0]!.type) ? parts[0]! : null;
}
