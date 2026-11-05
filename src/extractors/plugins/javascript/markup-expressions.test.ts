import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(src: string, rel: string): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "markup-expr-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "markup-expr-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

const setupCalls = (a: FileAnalysis) =>
  (a.functions.find((f) => f.name === "<setup>")?.calls ?? []).map((c) => `${c.name}@${c.line}`);

describe("calls a template's expressions make", () => {
  it("reads Svelte mustaches, #if / #each / :else if, {@html}, attribute values and an await's `then` form", () => {
    return analyze(`<script lang="ts">
  import { loadClubs, fmtScore, badge, crest, rows, isLive, tone } from './helpers';
  let n = 1;
</script>

{#await loadClubs() then clubs}
  <p>{fmtScore(n)}</p>
{/await}
{#if badge()}
  <b class={tone(n)}>x</b>
{:else if isLive(n)}
  {@html crest(n)}
{/if}
{#each rows(n) as row}
  <i>{row.name}</i>
{/each}
<button on:click={() => save(n)} onfocus={refocus}>go</button>
{#snippet cell(item)}<td>{item}</td>{/snippet}
<style>
  p { color: red; }
</style>
`, "web/src/ClubCard.svelte").then((a) => {
      const calls = setupCalls(a);
      for (const want of ["loadClubs@6", "fmtScore@7", "badge@9", "tone@10", "isLive@11", "crest@12", "rows@14"]) expect(calls).toContain(want);
      // Handlers are the interactive elements' (markupCalls); a snippet declaration and a plain value are no calls.
      expect(calls.some((c) => c.startsWith("cell@"))).toBe(false);
      expect(calls.some((c) => c.startsWith("item"))).toBe(false);
    });
  });

  it("reads Vue mustaches, bound props, v-if and v-for, and leaves handlers and slot params", () => {
    return analyze(`<template>
  <div>
    <h1>{{ label(club) }}</h1>
    <ClubBadge :msg="badgeText(club)" :count="2" v-if="canEdit(club)" />
    <li v-for="p in sorted(players)" :key="p.id">{{ p.name }}</li>
    <button @click="save(club)">Save</button>
    <Row v-slot="{ item }" />
    <p v-show="a && b">{{ x ? fmt(x) : '-' }}</p>
  </div>
</template>
<script setup lang="ts">
import { label, badgeText, canEdit, sorted, fmt } from './helpers';
const club = { name: 'x' };
</script>
`, "web/src/ClubList.vue").then((a) => {
      const calls = setupCalls(a);
      for (const want of ["label@3", "badgeText@4", "canEdit@4", "sorted@5", "fmt@8"]) expect(calls).toContain(want);
      // The handler is the interactive element's: one call, not two.
      expect(calls.filter((c) => c.startsWith("save@"))).toEqual(["save@6"]);
    });
  });

  it("links a template call to the function the script declares (Options API)", () => {
    return analyze(`<template><span>{{ label(club) }}</span></template>
<script>
export default { methods: { label(c) { return c.name; } } };
</script>
`, "web/src/ClubName.vue").then((a) => {
      expect(setupCalls(a)).toContain("label@1");
    });
  });
});
