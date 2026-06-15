import type { Node, Tree } from "web-tree-sitter";
import type {
  SubComponentInfo,
  ImportInfo,
  Language,
} from "../../../types/analysis.js";

/**
 * Extract sub-component usage from JSX/TSX files.
 * Looks for <ComponentName> usage in JSX elements.
 */
export function extractSubComponents(
  tree: Tree,
  sourceText: string,
  language: Language,
  imports: ImportInfo[],
): SubComponentInfo[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const components: SubComponentInfo[] = [];
  const seen = new Set<string>();
  const importMap = buildImportMap(imports);

  walkForJsx(tree.rootNode, components, seen, importMap);
  return components;
}

function walkForJsx(
  node: Node,
  components: SubComponentInfo[],
  seen: Set<string>,
  importMap: Map<string, string>,
) {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode) {
      const name = nameNode.text;
      // Components start with uppercase (not HTML elements)
      if (name && /^[A-Z]/.test(name) && !seen.has(name)) {
        seen.add(name);
        const props = extractJsxProps(node);
        components.push({
          name,
          importSource: importMap.get(name) ?? null,
          props,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (const child of node.children) {
    walkForJsx(child, components, seen, importMap);
  }
}

export function extractJsxProps(node: Node): string[] {
  const props: string[] = [];
  for (const child of node.children) {
    if (child.type === "jsx_attribute") {
      const name = child.childForFieldName("name")?.text ?? child.child(0)?.text;
      if (name) props.push(name);
    } else if (child.type === "jsx_expression" && child.text.includes("...")) {
      props.push("...spread");
    }
  }
  return props;
}

function buildImportMap(imports: ImportInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    for (const spec of imp.specifiers) {
      map.set(spec, imp.source);
    }
  }
  return map;
}
