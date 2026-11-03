import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/**
 * A definition is quoted with its head: the decorators, attributes and doc
 * comment above it say what it is (a guarded route, a platform variant), and a
 * snippet starting at the `def`/`fn` line drops exactly that.
 */
describe("extract quotes a definition with its head", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-head-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league","version":"1.0.0","dependencies":{"@nestjs/common":"10.0.0"}}');
    await file(
      "src/clubs.controller.ts",
      [
        'import { Controller, Get, UseGuards } from "@nestjs/common";',
        "",
        '@Controller("clubs")',
        "export class ClubsController {",
        "  // The roster lives elsewhere.",
        "",
        "  /** Lists the clubs of one league. */",
        "  @Get()",
        "  @UseGuards(CoachGuard)",
        "  list(): string[] {",
        "    return [];",
        "  }",
        "",
        "  @Get(\":id\")",
        "  @ApiResponse({",
        "    status: 200,",
        "  })",
        "  one(): string {",
        "    return \"\";",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "app/main.py",
      ["from fastapi import FastAPI", "", "app = FastAPI()", "", "# Unrelated note.", "", '@app.get("/clubs")', "def list_clubs():", '    """Every club in the league."""', "    return []", ""].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts a method at its doc comment and decorators", async () => {
    const text = await call("clarifydoc_extract", { symbol: "ClubsController.list", depth: 0 });
    expect(text).toMatch(/^## ClubsController\.list\(\) — src\/clubs\.controller\.ts:7-12/m);
    expect(text).toContain("/** Lists the clubs of one league. */\n  @Get()\n  @UseGuards(CoachGuard)\n  list()");
    expect(text).not.toContain("The roster lives elsewhere");
  });

  it("takes a decorator whose arguments are spread over rows", async () => {
    const text = await call("clarifydoc_extract", { symbol: "ClubsController.one", depth: 0 });
    expect(text).toMatch(/^## ClubsController\.one\(\) — src\/clubs\.controller\.ts:14-20/m);
    expect(text).toContain('@Get(":id")\n  @ApiResponse({\n    status: 200,\n  })\n  one()');
  });

  it("starts a Python function at its decorator, never at a comment that is not its doc", async () => {
    const text = await call("clarifydoc_extract", { symbol: "list_clubs", depth: 0 });
    expect(text).toMatch(/^## list_clubs\(\) — app\/main\.py:7-10/m);
    expect(text).toContain('@app.get("/clubs")\ndef list_clubs():');
    expect(text).not.toContain("Unrelated note");
  });

  it("explain packs the same head", async () => {
    const text = await call("clarifydoc_explain", { subject: "list_clubs" });
    expect(text).toContain('@app.get("/clubs")');
  });
});
