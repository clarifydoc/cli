import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { updateLsp } from "../core/lsp-updater.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";
import type { DefinitionAnswerFile } from "./answers-source.js";

const fixture = resolve("test-fixtures/sample-backend");
const analysis = resolve("test-output/sample-backend");

/**
 * Layer 2 from another source: the questions go out as a file, the answers
 * come back as one, and only an unambiguous answer inside the project
 * becomes a link. Nothing starts Docker.
 */
describe.skipIf(!existsSync(join(analysis, "project-summary.json")))("lsp-update with an answers file", () => {
  let dir: string;
  let queries: DefinitionQuery[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-l2-"));
    await cp(analysis, join(dir, "an"), { recursive: true });
    await rm(join(dir, "an", "lsp-enhancement.json"), { force: true });
    await rm(join(dir, "an", "lsp-ground-truth.json"), { force: true });
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, emitQueries: join(dir, "q.json") });
    expect(r.source).toBe("queries");
    queries = JSON.parse(await readFile(join(dir, "q.json"), "utf-8")).queries;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists each unresolved call once, aimed at its leaf token", () => {
    expect(queries.length).toBeGreaterThan(10);
    const keys = queries.map((q) => `${q.file}:${q.line}:${q.column}`);
    expect(new Set(keys).size).toBe(keys.length);
    const next = queries.find((q) => q.callName === "next" && q.file === "middleware/auth.ts");
    expect(next).toMatchObject({ line: 18, column: 4, language: "typescript" });
    // No server ran, so nothing was written beside the analysis.
    expect(existsSync(join(dir, "an", "lsp-enhancement.json"))).toBe(false);
  });

  it("links an unambiguous answer, abstains on a disagreement, drops paths outside the project", async () => {
    const [one, two, three] = queries;
    const answers: DefinitionAnswerFile = {
      source: "editor",
      servers: ["typescript"],
      answers: [
        { ...one!, targets: [{ file: "routes/users.ts", line: 14 }, { file: "routes/users.ts", line: 14 }] },
        { ...two!, targets: [{ file: "routes/users.ts", line: 14 }, { file: "routes/auth.ts", line: 9 }] },
        { ...three!, targets: [{ file: "../outside.ts", line: 1 }] },
      ],
    };
    await writeFile(join(dir, "a.json"), JSON.stringify(answers));
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, answers: join(dir, "a.json") });
    expect(r).toMatchObject({ source: "editor", serversUsed: ["typescript"], lspResolvedCount: 1, referenceLinksCount: 0, abstained: 1 });
    const enh = JSON.parse(await readFile(join(dir, "an", "lsp-enhancement.json"), "utf-8"));
    expect(enh.lspStats.source).toBe("editor");
    const added = enh.symbolLinks.filter((l: { resolvedBy?: string }) => l.resolvedBy === "lsp");
    expect(added).toEqual([expect.objectContaining({ sourceFile: one!.file, sourceLine: one!.line, targetFile: "routes/users.ts", targetLine: 14, strategy: "lsp-definition" })]);
    // A budgeted editor run never overwrites a full Docker capture.
    expect(existsSync(join(dir, "an", "lsp-ground-truth.json"))).toBe(false);
  });
});
