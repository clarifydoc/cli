import type { Node, Tree } from "web-tree-sitter";
import type { TypeAliasInfo } from "../../../types/analysis.js";

/** `using Repo = League.ClubRepository;` — at the top of the file or inside a namespace. */
export function extractCsharpTypeAliases(tree: Tree): TypeAliasInfo[] {
  const out: TypeAliasInfo[] = [];
  const visit = (parent: Node): void => {
    for (const n of parent.namedChildren) {
      if (!n) continue;
      if (n.type === "using_directive") {
        const alias = n.childForFieldName("name");
        if (!alias) continue; // `using League.Clubs;` imports a namespace
        const target = n.namedChildren.filter((c) => c && c.id !== alias.id).pop();
        // Only a `global using` reaches past its own file.
        const global = n.children.some((c) => c?.type === "global");
        if (target) out.push({ name: alias.text, type: target.text, line: n.startPosition.row + 1, ...(global ? {} : { fileScoped: true }) });
      } else if (n.type === "namespace_declaration" || n.type === "file_scoped_namespace_declaration") {
        visit(n.childForFieldName("body") ?? n);
      }
    }
  };
  visit(tree.rootNode);
  return out;
}
