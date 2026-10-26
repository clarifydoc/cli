import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: a Nuxt page calls composables it never imports, and every call through them dead-ended. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "garage", dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" } }),
  "nuxt.config.ts": "export default defineNuxtConfig({ srcDir: 'app' });\n",
  "app/composables/use-garage.ts": `export const useGarage = function () {
  async function park(id: string) {
    return await $fetch(\`/api/cars/\${id}/park\`, { method: "POST" });
  }
  return { park };
};
`,
  "app/utils/format.ts": "export function plate(car: { plate: string }) {\n  return car.plate.toUpperCase();\n}\n",
  "app/components/deep/helpers.ts": "export function useHidden() {\n  return 1;\n}\n",
  "app/pages/index.vue": `<template>
  <button @click="park('a')">Park</button>
</template>
<script setup lang="ts">
const { park } = useGarage();
const label = plate({ plate: "ab" });
const hidden = useHidden();
</script>
`,
};

describe("Nuxt auto-imported composables and utils", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-nuxt-auto-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolve as the imports Nuxt writes for them, and what a composable returns with them", () => {
    const calls = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "app/pages/index.vue" && l.relation !== "reference")
      .map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
      .sort();
    expect(calls).toEqual([
      "park -> app/composables/use-garage.ts:park",
      "plate -> app/utils/format.ts:plate",
      "useGarage -> app/composables/use-garage.ts:useGarage",
    ]);
  });
});
