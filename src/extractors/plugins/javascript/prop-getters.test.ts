import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A function a parent binds to a child's prop is run by a person's click only when the child runs it from an event
 * handler; a run inside a computed getter or a watch callback (Options API) is the framework's (`SymbolLink.inGetter`).
 * A prop run from a plain method, and a same-shaped prop in a decoy child that only a method runs, stay unmarked.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0" } }),
  "src/ClubOptions.vue": `<template><button @click="save">Save</button><span>{{ label }}</span></template>
<script>
export default {
  props: { onSave: Function, formatLabel: Function, onWatch: Function },
  computed: {
    label() { return this.formatLabel('x'); },
  },
  watch: { label() { this.onWatch(); } },
  methods: { save() { this.onSave({}); }, relabel() { this.formatLabel('y'); } },
};
</script>
`,
  "src/CarOptions.vue": `<template><button @click="save">Save</button></template>
<script>
export default {
  props: { onSave: Function, formatLabel: Function },
  methods: { save() { this.onSave({}); this.formatLabel('z'); } },
};
</script>
`,
  "src/ClubSetup.vue": `<template><button @click="save">Save</button><span>{{ label }}</span></template>
<script setup>
import { computed } from 'vue';
const props = defineProps({ onSave: Function, formatLabel: Function });
const label = computed(() => props.formatLabel('x'));
function save() { props.onSave({}); }
</script>
`,
  "src/Page.vue": `<template>
  <ClubOptions :on-save="(c) => store(c)" :format-label="(n) => String(n)" :on-watch="() => store(1)" />
  <CarOptions :on-save="(c) => store(c)" :format-label="(n) => String(n)" />
  <ClubSetup :on-save="(c) => store(c)" :format-label="(n) => String(n)" />
</template>
<script setup>
import ClubOptions from './ClubOptions.vue';
import CarOptions from './CarOptions.vue';
import ClubSetup from './ClubSetup.vue';
function store(x) { return x; }
</script>
`,
};

async function run(dir: string): Promise<ProjectAnalysis> {
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, "app", path)), { recursive: true });
    await writeFile(join(dir, "app", path), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return loadReportSummary(join(dir, "out"));
}

describe("a prop run inside a computed getter or watch callback", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-prop-getters-"));
    summary = await run(dir);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const into = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && /^<[^<>]+:[^<>]+@\d+>$/.test(l.targetSymbol))
      .map((l) => `${l.sourceSymbol}:${l.targetSymbol.replace(/@\d+>$/, ">")}${l.inGetter ? ` [${l.inGetter}]` : ""}`)
      .sort();

  it("marks the run site of an Options computed getter and a watch callback, not a method's", () => {
    expect(into("src/ClubOptions.vue")).toEqual([
      "<watch@8>:<ClubOptions:on-watch> [watch]",
      "label:<ClubOptions:format-label> [computed]",
      "relabel:<ClubOptions:format-label>",
      "save:<ClubOptions:on-save>",
    ]);
  });

  it("leaves a child that runs the same props from a method unmarked", () => {
    expect(into("src/CarOptions.vue")).toEqual(["save:<CarOptions:format-label>", "save:<CarOptions:on-save>"]);
  });

  it("leaves a Composition computed to the file's <setup>, which the funnel never counts", () => {
    expect(into("src/ClubSetup.vue")).toEqual(["<setup>:<ClubSetup:format-label>", "save:<ClubSetup:on-save>"]);
  });
});
