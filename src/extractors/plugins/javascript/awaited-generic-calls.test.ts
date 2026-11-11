import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string, rel = "use.ts"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "awaited-generic-"));
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "awaited-generic-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("an awaited call with type arguments", () => {
  // tree-sitter nests `await pick<Club>(id)` as call(function: await_expression(pick), type_arguments, arguments).
  it("is a call of the function, bare or on a receiver", async () => {
    const a = await analyze([
      'import { pick, Garage } from "./repo";',
      "interface Club { id: string }",
      "export async function load(id: string) {",
      "  const g = new Garage();",
      "  const c = await pick<Club>(id);",
      "  await g.park<Club>(c);",
      "  return pick<Club>(id);",
      "}",
    ].join("\n"));
    const calls = a.functions.find((f) => f.name === "load")!.calls.map((c) => `${c.name}@${c.line}`);
    expect(calls).toEqual(expect.arrayContaining(["Garage@4", "pick@5", "g.park@6", "pick@7"]));
  });
});
