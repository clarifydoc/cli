import type { Tree } from "web-tree-sitter";
import type { FilePathRead } from "../../../types/analysis.js";

/**
 * Files a JS/TS file opens by a path written in string literals: `fs.readFileSync("./config/league.json")`
 * (also `readFile`, `createReadStream`, `existsSync`, on `fs`, `fs.promises`, `fsp`) and
 * `path.join(__dirname, …)` / `path.resolve(…)` only as the path argument of such a call. A path
 * that starts at `__dirname` resolves beside the file only; a variable, a template with a hole or another
 * receiver (`cache.readFile("x")`) states no path.
 */
const FS_METHODS = new Set(["readFileSync", "readFile", "createReadStream", "existsSync"]);
const FS_RECEIVERS = new Set(["fs", "fs.promises", "fsp", "promises"]);
const JOINERS = new Set(["path.join", "path.resolve"]);
const STRING = String.raw`(?:"[^"\\$]*"|'[^'\\$]*'|\`[^\`\\$]*\`)`;
const ONE = new RegExp(String.raw`^\(\s*(${STRING})\s*[,)]`);
const JOINED = new RegExp(String.raw`^\(\s*(__dirname\s*,\s*)?(${STRING}(?:\s*,\s*${STRING})*)\s*,?\s*\)$`);

export function extractJavaScriptFilePathReads(tree: Tree, sourceText: string): FilePathRead[] {
  if (!/\bfs\b|\bfsp\b/.test(sourceText)) return [];
  const out: FilePathRead[] = [];
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call) continue;
    const callee = call.childForFieldName("function")?.text.replace(/\s+/g, "");
    const argNode = call.childForFieldName("arguments");
    if (!callee || !argNode) continue;
    const dot = callee.lastIndexOf(".");
    if (!(dot > 0 && FS_METHODS.has(callee.slice(dot + 1)) && FS_RECEIVERS.has(callee.slice(0, dot)))) continue;
    const line = call.startPosition.row + 1;
    const m = ONE.exec(argNode.text);
    if (m) {
      if (unquote(m[1]!) !== "") out.push({ parts: [unquote(m[1]!)], line });
      continue;
    }
    // `fs.readFileSync(path.join(__dirname, "config", "league.json"))`: the join is the path read here.
    const first = argNode.namedChild(0);
    if (first?.type !== "call_expression" || !JOINERS.has(first.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "")) continue;
    const j = JOINED.exec(first.childForFieldName("arguments")?.text ?? "");
    if (!j) continue;
    const parts = [...j[2]!.matchAll(new RegExp(STRING, "g"))].map((x) => unquote(x[0]));
    if (parts.length > 0 && parts[0] !== "") out.push({ parts, line, ...(j[1] ? { anchor: "file" as const } : {}) });
  }
  return out;
}

const unquote = (s: string): string => s.slice(1, -1);
