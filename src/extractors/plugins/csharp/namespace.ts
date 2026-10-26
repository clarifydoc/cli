import type { Node, Tree } from "web-tree-sitter";

/**
 * The namespace a C# file declares its types in: `namespace League.Clubs;`
 * or the first `namespace League { namespace Clubs { … } }` block, nested
 * blocks joined. Null for the global namespace.
 */
export function extractCsharpNamespace(tree: Tree): string | null {
  const parts: string[] = [];
  let parent: Node = tree.rootNode;
  for (;;) {
    const ns = parent.namedChildren.find((n) => n?.type === "namespace_declaration" || n?.type === "file_scoped_namespace_declaration");
    const name = ns?.childForFieldName("name")?.text;
    if (!ns || !name) break;
    parts.push(name.replace(/\s+/g, ""));
    const body = ns.childForFieldName("body");
    if (!body) break;
    parent = body;
  }
  return parts.length > 0 ? parts.join(".") : null;
}
