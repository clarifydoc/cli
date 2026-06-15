import type { Node, Tree } from "web-tree-sitter";
import type {
  ImportInfo,
  Language,
  TemplateComponentNode,
} from "../../../types/analysis.js";
import { extractJsxProps } from "./sub-components.js";
import { INTERACTIVE_TAGS, isEventProp } from "./interactive-elements.js";

/**
 * Build a framework-neutral nested component tree from a React JSX/TSX AST —
 * the equivalent of the Vue SFC `templateTree`, but sourced from the
 * tree-sitter JSX hierarchy instead of regex tokenizing.
 *
 * Mirrors the Vue tokenizer's shape: plain HTML wrappers (`<div>`/`<span>`)
 * form the nesting skeleton but are NOT nodes — only components (`<UserCard>`)
 * and *bound* interactive HTML (`<button onClick>`) become nodes, each attached
 * under its nearest ancestor node. A node is `repeated` when it sits inside a
 * `.map(...)` (or other iteration-method) callback.
 */
export function extractJsxComponentTree(
  tree: Tree,
  language: Language,
  _imports: ImportInfo[],
): TemplateComponentNode[] {
  if (language !== "typescript" && language !== "javascript") return [];
  const roots: TemplateComponentNode[] = [];
  walk(tree.rootNode, roots, false);
  return roots;
}

/** Iteration methods whose callback renders a list — JSX inside is `repeated`. */
const LOOP_METHODS = new Set(["map", "flatMap"]);

function walk(
  node: Node,
  siblings: TemplateComponentNode[],
  repeated: boolean,
): void {
  if (node.type === "jsx_element" || node.type === "jsx_self_closing_element") {
    const el = elementInfo(node);
    if (el) {
      const treeNode = makeNode(el, repeated);
      if (treeNode) {
        siblings.push(treeNode);
        // Nest content under this node.
        for (const child of contentChildren(node)) {
          walk(child, treeNode.children, repeated);
        }
        return;
      }
    }
    // Structural HTML (div/span/…): not a node — recurse keeping the same parent.
    for (const child of contentChildren(node)) {
      walk(child, siblings, repeated);
    }
    return;
  }

  // A `.map(...)` call marks every JSX element in its callback as looped.
  const childRepeated = repeated || isLoopCall(node);
  for (const child of node.children) {
    walk(child, siblings, childRepeated);
  }
}

interface ElInfo {
  tag: string;
  /** The opening element (jsx_element) or the self-closing element — its
   *  children hold the `jsx_attribute`s, and its start row is the match line. */
  attrsHost: Node;
  line: number;
}

function elementInfo(node: Node): ElInfo | null {
  if (node.type === "jsx_self_closing_element") {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (!nameNode) return null;
    return { tag: nameNode.text, attrsHost: node, line: node.startPosition.row + 1 };
  }
  // jsx_element → its <Open> tag holds name + attributes.
  const opening = node.children.find((c) => c.type === "jsx_opening_element");
  if (!opening) return null;
  const nameNode = opening.childForFieldName("name") ?? opening.child(1);
  if (!nameNode) return null;
  return { tag: nameNode.text, attrsHost: opening, line: opening.startPosition.row + 1 };
}

function makeNode(el: ElInfo, repeated: boolean): TemplateComponentNode | null {
  const isComponent = /^[A-Z]/.test(el.tag);
  const htmlControl = INTERACTIVE_TAGS[el.tag.toLowerCase()];
  const isInteractive = !!htmlControl && hasEventHandler(el.attrsHost);
  if (!isComponent && !isInteractive) return null;

  return {
    name: isComponent ? el.tag : el.tag.toLowerCase(),
    props: extractJsxProps(el.attrsHost),
    line: el.line,
    repeated,
    children: [],
    ...(isComponent
      ? {}
      : { element: htmlControl as NonNullable<TemplateComponentNode["element"]> }),
  };
}

/** Whether the element carries an `on*` event-handler prop. */
function hasEventHandler(attrsHost: Node): boolean {
  for (const child of attrsHost.children) {
    if (child.type !== "jsx_attribute") continue;
    const name = child.childForFieldName("name")?.text ?? child.child(0)?.text;
    if (name && isEventProp(name)) return true;
  }
  return false;
}

function isLoopCall(node: Node): boolean {
  if (node.type !== "call_expression") return false;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return false;
  const prop = fn.childForFieldName("property")?.text;
  return !!prop && LOOP_METHODS.has(prop);
}

/** A JSX element's nested content — its children minus the open/close tags. */
function contentChildren(node: Node): Node[] {
  if (node.type === "jsx_self_closing_element") return [];
  return node.children.filter(
    (c) => c.type !== "jsx_opening_element" && c.type !== "jsx_closing_element",
  );
}
