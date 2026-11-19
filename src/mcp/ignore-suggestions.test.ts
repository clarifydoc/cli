/**
 * After a run, generated and vendored folders that still hold analyzed files are suggested as
 * `.clarifydocignore` entries: in `clarifydoc_status` here, in `--verbose` output by the analyzer. A project with
 * no such folder gets exactly the status it had.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";
import { ignoreSuggestionLines, ignoreSuggestions } from "../core/ignore-suggestions.js";

describe("ignoreSuggestions", () => {
  const files = [
    "src/league.ts",
    "third_party/engine/a.ts", "third_party/engine/b.ts", "third_party/c.ts",
    "api/generated/Club.ts", "api/generated/Player.ts",
    "src/generated-not-a-root.ts",
  ];

  it("names each generated and vendored root with its analyzed files, largest first", () => {
    const found = ignoreSuggestions(files, ["api/generated", "gone/generated"]);
    expect(found).toEqual([
      { root: "third_party", kind: "vendored", files: 3 },
      { root: "api/generated", kind: "generated", files: 2 },
    ]);
    expect(ignoreSuggestionLines(found).join("\n")).toBe(
      "5 analyzed files sit under generated or vendored folders — add them to .clarifydocignore to cut noise and run time:\n" +
        "  /third_party/   # 3 files, vendored\n  /api/generated/   # 2 files, generated — its routes and calls leave the map too",
    );
  });

  it("lists a root inside another listed root once", () => {
    expect(ignoreSuggestions(["gen/a.ts", "gen/third_party/b.ts", "gen/third_party/c.ts"], ["gen"])).toEqual([{ root: "gen", kind: "generated", files: 3 }]);
  });

  it("says nothing when there is no such root", () => {
    expect(ignoreSuggestions(["src/league.ts", "src/club.ts"], [])).toEqual([]);
    expect(ignoreSuggestionLines([])).toEqual([]);
  });
});

describe("clarifydoc_status", () => {
  let dir = "";
  const proj = () => join(dir, "proj");
  const out = () => join(dir, "out");
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ignore-suggest-"));
    await cp(resolve("test-fixtures/sample-backend"), proj(), { recursive: true });
    await cp(resolve("test-output/sample-backend"), out(), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const status = async () => {
    const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: out(), allowAnalyze: false, allowColdStart: false, log: () => {} });
    const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_status", arguments: {} } })) as {
      result: { content: Array<{ text: string }> };
    };
    return res.result.content[0]!.text;
  };

  it("suggests the roots, and is untouched without one", async () => {
    const plain = await status();
    expect(plain).not.toContain(".clarifydocignore");
    const path = join(out(), "project-summary.json");
    const summary = JSON.parse(await readFile(path, "utf-8"));
    summary.files = [...summary.files, "third_party/engine/a.ts", "third_party/engine/b.ts"];
    await writeFile(path, JSON.stringify(summary));
    const withRoot = await status();
    expect(withRoot).toContain("2 analyzed files sit under generated or vendored folders");
    expect(withRoot).toContain("/third_party/   # 2 files, vendored");
    expect(withRoot.replace(/\n\n2 analyzed files[\s\S]*?vendored\n/, "\n")).not.toContain("third_party");
  });
});
