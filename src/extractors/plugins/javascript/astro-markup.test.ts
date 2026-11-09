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

describe("Astro markup: a callback head around nested markup", () => {
  it("keeps the call the callback hangs on (`getClubs().map(…)`) beside the calls inside it", async () => {
    const a = await analyze(`---
import { getClubs, getPlayers, label, tag } from '../lib/clubs';
---
<ul>{getClubs().map((c) => <li>{label(c)}</li>)}</ul>
<ul>{(await getPlayers()).filter((p) => p.ok).map((p) => <li>{tag(p)}</li>)}</ul>
`);
    expect(setupCalls(a)).toEqual(["getClubs@4", "getPlayers@5", "label@4", "tag@5"]);
  });
});

describe("Astro <script src> and <link href> as imports", () => {
  const sources = (a: FileAnalysis) => a.imports.map((i) => i.source).sort();

  it("records local scripts, stylesheets and module preloads, not URLs or comments", async () => {
    const a = await analyze(`---
import Layout from '../layouts/Layout.astro';
---
<html><head>
<link rel="stylesheet" href="../styles/club.css">
<link href="../scripts/preload.ts" rel="modulepreload" />
<link rel="icon" href="../img/crest.svg">
<link rel="stylesheet" href="https://cdn.example.com/league.css">
<!-- <script src="../scripts/old.ts"></script> -->
</head><body>
<script src="../scripts/club.ts"></script>
<script type="module" src='./local.js'></script>
<script src="//cdn.example.com/x.js"></script>
<script src="/vendor/table.js"></script>
</body></html>
`);
    expect(sources(a)).toEqual(["../layouts/Layout.astro", "../scripts/club.ts", "../scripts/preload.ts", "../styles/club.css", "./local.js", "public/vendor/table.js"]);
    expect(a.imports.find((i) => i.source === "../scripts/club.ts")?.line).toBe(11);
  });
});
