import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string, rel = "src/pages/clubs.astro"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "astro-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
    frameworkIds: ["astro"],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "astro-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const setupCalls = (a: FileAnalysis) => (a.functions.find((f) => f.name === "<setup>")?.calls ?? []).map((c) => `${c.name}@${c.line}`).sort();

describe("Astro markup expressions and getStaticPaths", () => {
  it("reads the calls a page's markup expressions make as the page's own", async () => {
    const a = await analyze(`---
import { fmtScore, crestUrl, label } from '../lib/clubs';
const clubs = [];
---
<h1>{fmtScore(3)}</h1>
<img src={crestUrl(clubs[0])} />
<ul>{clubs.map((c) => <li>{label(c)}</li>)}</ul>
<p>{clubs.length} clubs</p>
`);
    expect(setupCalls(a)).toEqual(["crestUrl@6", "fmtScore@5", "label@7"]);
  });

  it("counts what getStaticPaths calls among the page's own calls", async () => {
    const a = await analyze(`---
import { listClubs } from '../lib/clubs';
export async function getStaticPaths() {
  const clubs = await listClubs();
  return clubs.map((c) => ({ params: { id: c.id } }));
}
const { id } = Astro.params;
---
<h1>{id}</h1>
`, "src/pages/clubs/[id].astro");
    expect(setupCalls(a)).toEqual(["getStaticPaths@3"]);
    expect(a.functions.find((f) => f.name === "getStaticPaths")?.calls.map((c) => c.name)).toContain("listClubs");
  });

  it("reads a content collection as a data read of the collection", async () => {
    const a = await analyze(`---
import { getCollection, getEntry } from 'astro:content';
const clubs = await getCollection('clubs');
const first = await getEntry('players', 'p1');
---
<ul>{clubs.length}</ul>
`);
    expect(a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.target} ${d.access}`)).toEqual(["clubs read", "players read"]);
  });
});
