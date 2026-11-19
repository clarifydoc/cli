import type { Tree } from "web-tree-sitter";
import type { FilePathRead } from "../../../types/analysis.js";

/**
 * Files a Python file opens by a path written in string literals: `open("settings/league.json")`,
 * `Path("settings", "league.json")`, `os.path.join("settings", "league.json")`. `open` names its file by
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
  for (const call of tree.rootNode.descendantsOfType("call")) {
    if (!call) continue;
    const callee = call.childForFieldName("function")?.text;
    const args = call.childForFieldName("arguments")?.text;
    if (!callee || !args) continue;
    let parts: string[] | null = null;
    if (callee === "open") {
      const m = OPEN_ARGS.exec(args);
      parts = m ? [unquote(m[1]!)] : null;
    } else if (BUILDERS.has(callee)) {
      const m = BUILDER_ARGS.exec(args);
      parts = m ? [...m[1]!.matchAll(new RegExp(STRING, "g"))].map((x) => unquote(x[0])) : null;
    }
    if (parts && parts[0] !== "") out.push({ parts, line: call.startPosition.row + 1 });
  }
  return out;
}

const unquote = (s: string): string => s.slice(1, -1);
