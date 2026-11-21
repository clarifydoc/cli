import type { Node, Tree } from "web-tree-sitter";
import type { ModuleNameSpan } from "../../types/analysis.js";

/** Whether the comment at `index` starts on the row the statement before it ends on. */
function trailing(tops: Node[], index: number): boolean {
  const before = tops[index - 1];
  return !!before && before.endPosition.row === tops[index]!.startPosition.row;
}

/**
 * The names a module binds at its top level, each with the lines it owns (`FileAnalysis.moduleNames`): the statement,
 * the comments written directly above it, and the blank or loose-comment lines below it up to the next statement's own
 * comments (the last statement ends at its own last line). `namesOf` says which names one top-level node binds (none for a function, a class or an import). A line
 * between two statements therefore belongs to the binding above it, so an edit that touches a constant and the blank
 * line beside it still reads as an edit of that constant.
 */
export function moduleNameSpans(tree: Tree, namesOf: (top: Node) => string[]): ModuleNameSpan[] {
  const tops = tree.rootNode.namedChildren;
  const isComment = (n: Node) => n.type === "comment";
  // 0-based row where each non-comment statement's group (its own leading comments) starts.
  const groupStart = new Map<number, number>();
  tops.forEach((n, i) => {
    if (isComment(n)) return;
    let start = n.startPosition.row;
    // A comment trailing the statement above on its own last line belongs to that statement.
    for (let j = i - 1; j >= 0 && isComment(tops[j]!) && tops[j]!.endPosition.row + 1 >= start && !trailing(tops, j); j--) start = tops[j]!.startPosition.row;
    groupStart.set(i, start);
  });
  const out: ModuleNameSpan[] = [];
  tops.forEach((n, i) => {
    if (isComment(n)) return;
    const names = namesOf(n);
    if (names.length === 0) return;
    let next = i + 1;
    while (next < tops.length && isComment(tops[next]!)) next++;
    // The last statement owns no lines after itself: what follows the tree's last statement may be another
    // region of the file the tree reads as blank lines.
    const endRow = next < tops.length ? groupStart.get(next)! : n.endPosition.row + 1;
    const line = groupStart.get(i)! + 1;
    const endLine = Math.max(n.endPosition.row + 1, endRow);
    for (const name of new Set(names)) out.push({ name, line, endLine });
  });
  return out;
}
