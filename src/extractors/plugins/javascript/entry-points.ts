import type { Node, Tree } from "web-tree-sitter";
import type { EntryPointInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * Entry points that are not HTTP routes: what an agent, an editor or a shell
 * invokes by name.
 *  - MCP tools: `server.tool("name", …, handler)`, `server.registerTool("name", {…}, handler)`
 *  - VS Code: `commands.registerCommand("id", handler)` (and the text-editor
 *    form), language-model tools `lm.registerTool("name", impl)`
 *  - CLIs: commander `.command("deploy <env>")….action(handler)`, yargs
 *    `.command("serve [port]", desc, builder, handler)`
 * The handler is named when it is an identifier (or `this.x` / `obj.x`); an
 * inline function has none — its calls belong to the function around it.
 */

function calleeProperty(call: Node): { object: string; property: string } | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const prop = fn.childForFieldName("property")?.text;
  const obj = fn.childForFieldName("object");
  return prop && obj ? { object: obj.text, property: prop } : null;
}

const args = (call: Node): Node[] => call.childForFieldName("arguments")?.namedChildren ?? [];
const isString = (n: Node | undefined): n is Node => !!n && (n.type === "string" || (n.type === "template_string" && !n.text.includes("${")));

/** A handler argument's name: `run`, `this.run` → `run`, `handlers.run` → `run`. */
function handlerName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "identifier") return n.text;
  if (n.type === "member_expression") return n.childForFieldName("property")?.text;
  return undefined;
}

/** The command name of a commander/yargs spec: `deploy <env> [opts]` → `deploy`. */
const commandName = (spec: string) => spec.trim().split(/\s+/)[0]!.replace(/[<[].*$/, "");

/** commander: the `.action(handler)` chained after `.command("…")`, if any. */
function chainedAction(commandCall: Node): Node | undefined {
  let at: Node | null = commandCall;
  for (let i = 0; i < 12 && at; i++) {
    const member: Node | null = at.parent;
    if (member?.type !== "member_expression") return undefined;
    const call: Node | null = member.parent;
    if (call?.type !== "call_expression") return undefined;
    if (member.childForFieldName("property")?.text === "action") return args(call)[0];
    at = call;
  }
  return undefined;
}

export function extractEntryPoints(tree: Tree, sourceText: string): EntryPointInfo[] {
  if (!/\b(?:tool|registerTool|registerCommand|registerTextEditorCommand|command)\s*\(/.test(sourceText)) return [];
  const out: EntryPointInfo[] = [];
  const visit = (n: Node): void => {
    if (n.type === "call_expression") {
      const c = calleeProperty(n);
      const a = args(n);
      if (c && isString(a[0])) {
        const name = stripQuotes(a[0].text);
        const line = n.startPosition.row + 1;
        const push = (kind: EntryPointInfo["kind"], handler: Node | undefined, framework: string) =>
          out.push({ kind, name, line, framework, ...(handlerName(handler) ? { handler: handlerName(handler) } : {}) });
        if ((c.property === "tool" || c.property === "registerTool") && /server|mcp/i.test(c.object) && a.length >= 2) {
          push("mcp-tool", a[a.length - 1], "mcp");
        } else if ((c.property === "registerCommand" || c.property === "registerTextEditorCommand") && /commands$/.test(c.object)) {
          push("editor-command", a[1], "vscode");
        } else if (c.property === "registerTool" && /\blm$/.test(c.object)) {
          push("lm-tool", a[1], "vscode");
        } else if (c.property === "command" && name.trim() && !name.startsWith("$")) {
          // yargs: `.command(spec, desc, builder, handler)`; commander: `.command(spec)…action(handler)`.
          const yargsHandler = a.length >= 4 ? a[3] : undefined;
          const action = yargsHandler ?? chainedAction(n);
          if (action || a.length >= 2) out.push({ kind: "cli-command", name: commandName(name), line, framework: yargsHandler ? "yargs" : "commander", ...(handlerName(action) ? { handler: handlerName(action) } : {}) });
        }
      }
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return out;
}
