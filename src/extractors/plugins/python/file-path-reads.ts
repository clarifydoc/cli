import type { Node, Tree } from "web-tree-sitter";
import type { FilePathRead } from "../../../types/analysis.js";

/**
 * Files a Python file opens by a path written in string literals: `open("settings/league.json")`,
 * `Path("settings", "league.json").read_text()`, `open(os.path.join(…))`: a path builder counts only where the file is opened. `open` names its file by
 * the first argument alone (the mode follows); the path builders take every argument. An f-string, a
 * prefixed string, a variable or a method (`self.open(…)`) states no path.
 */
const STRING = String.raw`(?:"[^"\\{}]*"|'[^'\\{}]*')`;
const OPEN_ARGS = new RegExp(String.raw`^\(\s*(${STRING})\s*[,)]`);
const BUILDER_ARGS = new RegExp(String.raw`^\(\s*(${STRING}(?:\s*,\s*${STRING})*)\s*,?\s*\)$`);
const BUILDERS = new Set(["Path", "pathlib.Path", "PurePath", "os.path.join"]);

export function extractPythonFilePathReads(tree: Tree, sourceText: string): FilePathRead[] {
  if (!/\bopen\s*\(|\bPath\s*\(|\bos\.path\.join\s*\(/.test(sourceText)) return [];
  const out: FilePathRead[] = [];
  const add = (parts: string[] | null, node: Node) => {
    if (parts && parts[0] !== "") out.push({ parts, line: node.startPosition.row + 1 });
  };
  for (const call of tree.rootNode.descendantsOfType("call")) {
    if (!call) continue;
    const callee = call.childForFieldName("function")?.text;
    const args = call.childForFieldName("arguments");
    if (!callee || !args) continue;
    if (callee === "open") {
      // `open("x")`, or `open(Path("a", "b"))` / `open(os.path.join("a", "b"))`: the builder is opened here.
      const m = OPEN_ARGS.exec(args.text);
      if (m) {
        if (!/,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]/.test(args.text)) add([unquote(m[1]!)], call);
        continue;
      }
      const first = args.namedChild(0);
      if (first?.type === "call" && !/,\s*(?:mode\s*=\s*)?["'][^"']*[wax+]/.test(args.text.slice(first.endIndex - args.startIndex))) add(builderParts(first), call);
    } else if (BUILDERS.has(callee)) {
      // `Path("a", "b").read_text()`: read where it is built; a bare `Path(...)` states nothing.
      const attr = call.parent;
      if (attr?.type === "attribute" && attr.childForFieldName("object")?.id === call.id && READERS.has(attr.childForFieldName("attribute")?.text ?? "") && attr.parent?.type === "call" && attr.parent.childForFieldName("function")?.id === attr.id) {
        add(builderParts(call), call);
      }
    }
  }
  return out;
}

const READERS = new Set(["read_text", "read_bytes", "open"]);

function builderParts(call: Node): string[] | null {
  const callee = call.childForFieldName("function")?.text;
  const args = call.childForFieldName("arguments")?.text;
  if (!callee || !args || !BUILDERS.has(callee)) return null;
  const m = BUILDER_ARGS.exec(args);
  return m ? [...m[1]!.matchAll(new RegExp(STRING, "g"))].map((x) => unquote(x[0])) : null;
}

const unquote = (s: string): string => s.slice(1, -1);
