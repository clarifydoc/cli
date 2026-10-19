import { describe, expect, it } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractEntryPoints } from "./entry-points.js";
import { extractPythonEntryPoints } from "../python/entry-points.js";

const js = async (src: string) => extractEntryPoints(await parseSource(src, "typescript" as never, "src/x.ts"), src).map((e) => `${e.kind} ${e.name}${e.handler ? ` → ${e.handler}` : ""} (${e.framework})`);
const py = async (src: string) => extractPythonEntryPoints(await parseSource(src, "python" as never, "app.py"), src).map((e) => `${e.kind} ${e.name} → ${e.handler} (${e.framework})`);

describe("entry points that are not routes", () => {
  it("JS/TS: MCP tools, VS Code commands and LM tools, commander and yargs commands", async () => {
    expect(await js(`
server.tool("search_orders", { q: z.string() }, searchOrders);
server.registerTool("close_order", { description: "x" }, async (args) => close(args));
vscode.commands.registerCommand("shop.refresh", () => refresh());
context.subscriptions.push(commands.registerTextEditorCommand("shop.format", this.format));
vscode.lm.registerTool("shop_lookup", new LookupTool());
program.command("deploy <env>").description("ship it").action(deploy);
yargs.command("serve [port]", "start", (y) => y, serve);
router.command; // not a call
emitter.tool(name, fn); // not a literal name
`)).toEqual([
      "mcp-tool search_orders → searchOrders (mcp)",
      "mcp-tool close_order (mcp)",
      "editor-command shop.refresh (vscode)",
      "editor-command shop.format → format (vscode)",
      "lm-tool shop_lookup (vscode)",
      "cli-command deploy → deploy (commander)",
      "cli-command serve → serve (yargs)",
    ]);
  });

  it("Python: FastMCP tools and click / typer commands from their decorators", async () => {
    expect(await py(`
@mcp.tool()
def search_orders(q: str) -> list: ...

@server.tool(name="close")
async def close_order(id: int): ...

@cli.command()
def import_data(): ...

@app.command("seed-db")
def seed(): ...
`)).toEqual([
      "mcp-tool search_orders → search_orders (mcp)",
      "mcp-tool close → close_order (mcp)",
      "cli-command import-data → import_data (click)",
      "cli-command seed-db → seed (typer)",
    ]);
  });
});
