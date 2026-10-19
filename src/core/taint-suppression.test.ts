import { describe, it, expect } from "vitest";
import { analyzeFile } from "./file-analyzer.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function findings(src: string, rel: string): Promise<Array<[string, number]>> {
  const root = await mkdtemp(join(tmpdir(), "supp-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const out = await mkdtemp(join(tmpdir(), "supp-out-"));
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "javascript" },
    frameworkIds: ["express"],
    projectId: "root",
    outputOpts: { outputDir: out, pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return (result!.analysis.securityIssues ?? []).map((i) => [i.category, i.line]);
}

/** A suppression holds for a finding the taint pass makes, not only for the line scanner's. */
describe("suppressions on taint findings", () => {
  it("silences the rule named, every rule when bare, and never brings the regex finding back", async () => {
    const got = await findings(
      `app.get("/run", (req, res) => {
  const a = eval(req.query.a); // clarifydoc-ignore eval-exec
  const b = eval(req.query.b); // clarifydoc-ignore sql-injection
  // clarifydoc-ignore-next-line
  const c = eval(req.query.c);
  const d = eval(req.query.d);
  res.send(a + b + c + d);
});
`,
      "src/app.js",
    );
    expect(got.filter(([c]) => c === "eval-exec").map(([, l]) => l)).toEqual([3, 6]);
  });
});
