import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n",
  "types.go": `package league

type Match struct{ n int }

func (m Match) Play() {}
`,
  "use.go": `package league

func Shadow() { type Match struct{ n int }; m := Match{}; m.Play() }

func ShadowBlock() {
	type Match struct {
		n int
	}
	m := Match{}
	m.Play()
}

func Before() {
	p := Match{}
	p.Play()
	type Match struct{ n int }
}

func Plain() { m := Match{}; m.Play() }
`,
};

describe.each([["antlr", undefined], ["regex", "no-antlr"]])("Go block-local type declarations hide the package type (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-go-blocktype-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (from: string) => summary.symbolLinks.filter((l) => l.sourceSymbol === from).map((l) => `${l.callName}->${l.targetSymbol}`).sort();

  it("links neither the construction nor the method of a type the function declares itself", () => {
    expect(rows("Shadow")).toEqual([]);
    expect(rows("ShadowBlock")).toEqual([]);
  });

  it("keeps the link of a use that comes before the declaration", () => {
    expect(rows("Before")).toEqual(["Match->Match", "p.Play->Match.Play"]);
  });

  it("keeps the package type where no local type shadows it", () => {
    expect(rows("Plain")).toEqual(["Match->Match", "m.Play->Match.Play"]);
  });
});
