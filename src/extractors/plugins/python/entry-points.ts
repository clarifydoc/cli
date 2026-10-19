import type { Node, Tree } from "web-tree-sitter";
import type { EntryPointInfo } from "../../../types/analysis.js";

/**
 * Python entry points that are not routes, read off decorators:
 *  - MCP tools: FastMCP `@mcp.tool()` / `@server.tool(name="x")`
 *  - CLIs: click `@cli.command()` / `@click.command("x")`, typer `@app.command()`
 * The decorated function is the handler; a name argument, when given, is how
 * the tool or command is invoked (click and typer also turn `snake_case` into
 * `snake-case`).
 */
export function extractPythonEntryPoints(tree: Tree, sourceText: string): EntryPointInfo[] {
  if (!/@\w[\w.]*\.(?:tool|command)\b/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const visit = (n: Node): void => {
    if (n.type === "decorated_definition") {
      const def = n.childForFieldName("definition");
      const fn = def?.type === "function_definition" ? def.childForFieldName("name")?.text : undefined;
      if (fn) {
        for (const d of n.namedChildren.filter((c) => c.type === "decorator")) {
          const text = d.text.replace(/^@/, "");
          const m = /^([\w.]+)\.(tool|command)\s*(\((.*)\))?\s*$/s.exec(text);
          if (!m) continue;
          const [, obj, what, , argText = ""] = m;
          const named = /(?:^|,)\s*(?:name\s*=\s*)?["']([^"']+)["']/.exec(argText)?.[1];
          if (what === "tool" && /mcp|server/i.test(obj!)) {
            out.push({ kind: "mcp-tool", name: named ?? fn, handler: fn, line: n.startPosition.row + 1, framework: "mcp" });
          } else if (what === "command") {
            const framework = /^click$/.test(obj!) || /group|cli/i.test(obj!) ? "click" : "typer";
            out.push({ kind: "cli-command", name: named ?? fn.replace(/_/g, "-"), handler: fn, line: n.startPosition.row + 1, framework });
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(tree.rootNode);
  return out;
}
