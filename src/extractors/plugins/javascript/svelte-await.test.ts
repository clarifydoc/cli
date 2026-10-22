import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string, rel = "web/src/lib/components/ClubCard.svelte"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "svelte-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "svelte-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("Svelte {#await} blocks", () => {
  it("records the awaited expression's calls as the component's own, at their lines", async () => {
    const a = await analyze(`<script lang="ts">
  import { getClubInfo, getSquadStats } from '@league/sdk';
  let { clubId }: { clubId: string } = $props();
</script>

{#await getClubInfo({ ...auth.params, id: clubId })}
  <p>Loading</p>
{:then club}
  <h2>{club.name}</h2>
{/await}

{#await getSquadStats({ clubId }) then stats}
  <p>{stats.players}</p>
{/await}
`);
    const setup = a.functions.find((f) => f.name === "<setup>");
    expect(setup?.calls.filter((c) => /^get/.test(c.name)).map((c) => `${c.name} ${c.kind} @${c.line}`)).toEqual([
      "getClubInfo cross-file @6",
      "getSquadStats cross-file @12",
    ]);
  });
});
