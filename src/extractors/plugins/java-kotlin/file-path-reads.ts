import type { Node, Tree } from "web-tree-sitter";
import type { FilePathRead } from "../../../types/analysis.js";

/**
 * Files a Java or Kotlin file opens by a path written in string literals: `new File("config/league.yml")`,
 * `new File("config", "league.yml")`, `Paths.get(…)`, `Path.of(…)`, Kotlin `File("config/league.yml")`.
 * Only the java.io / java.nio.file types count (the file must import them) and only when every argument
 * is a plain literal — a variable, a concatenation or an interpolation is no stated path.
 */
const FILE_TYPES = new Set(["File", "FileReader", "FileInputStream"]);
const PATH_FACTORIES = new Set(["Paths.get", "Path.of"]);
const LITERALS = /^\(\s*"([^"$\\]*)"((?:\s*,\s*"[^"$\\]*")*)\s*\)$/;

export function extractJavaKotlinFilePathReads(tree: Tree, sourceText: string): FilePathRead[] {
  if (!/\bimport\s+java\.(?:io|nio\.file)\./.test(sourceText)) return [];
  const out: FilePathRead[] = [];
  for (const node of tree.rootNode.descendantsOfType(["object_creation_expression", "method_invocation", "call_expression"])) {
    if (!node) continue;
    const callee = calleeOf(node);
    if (!callee || !(FILE_TYPES.has(callee) || PATH_FACTORIES.has(callee))) continue;
    const args = argumentsOf(node);
    const m = args ? LITERALS.exec(args) : null;
    if (!m) continue;
    const parts = [m[1]!, ...[...m[2]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!)];
    if (parts.length > 0 && parts[0] !== "") out.push({ parts, line: node.startPosition.row + 1 });
  }
  return out;
}

/** `File` for `new File(…)` / Kotlin `File(…)`, `Paths.get` for a static factory. */
function calleeOf(node: Node): string | null {
  if (node.type === "object_creation_expression") return node.childForFieldName("type")?.text ?? null;
  if (node.type === "method_invocation") {
    const name = node.childForFieldName("name")?.text;
    const object = node.childForFieldName("object")?.text;
    return name && object ? `${object}.${name}` : null;
  }
  return node.child(0)?.text.replace(/\s+/g, "") ?? null;
}

function argumentsOf(node: Node): string | null {
  if (node.type === "call_expression") return node.children.find((c) => c.type === "call_suffix")?.text ?? null;
  return node.childForFieldName("arguments")?.text ?? null;
}
