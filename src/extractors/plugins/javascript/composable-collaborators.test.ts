import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A composable is handed its collaborators: a member another composable returned
 * (`const { clubActions } = useGarageData(); useCrud(clubActions)`), or a callback
 * whose one call is the component's `emit` (`useDialog("match", (m) => emit("save", m))`).
 * Invented names; labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "src/composables/useGarageData.ts": `import axios from "axios";
export function useGarageData() {
  const clubActions = {
    async updateClub(id: string, body: object) { return axios.put(\`/api/clubs/\${id}\`, body); },
  };
  return { clubActions };
}
`,
  "src/composables/useCrud.ts": `export function useCrud(actions: any, refresh: () => void) {
  async function save(id: string, body: object) {
    await actions.updateClub(id, body);
    refresh();
  }
  return { save };
}
`,
  "src/pages/ClubPage.vue": `<template><button @click="renameClub">Rename</button></template>
<script setup lang="ts">
import { useGarageData } from "../composables/useGarageData";
import { useCrud } from "../composables/useCrud";
const { clubActions } = useGarageData();
const crud = useCrud(clubActions, () => {});
function renameClub() { crud.save("1", {}); }
</script>
`,
  "src/composables/useDialog.ts": `export function useDialog(name: string, onSave: (v: object) => void) {
  function confirm(v: object) {
    onSave(v);
  }
  return { confirm };
}
`,
  "src/components/MatchForm.vue": `<template><button @click="submit">Save</button></template>
<script setup lang="ts">
import { useDialog } from "../composables/useDialog";
const emit = defineEmits<{ (e: "save", v: object): void }>();
const dialog = useDialog("match", (v) => emit("save", v));
function submit() { dialog.confirm({}); }
</script>
`,
  "src/components/TrainingForm.vue": `<template><button @click="submit">Save</button></template>
<script setup lang="ts">
import { useDialog } from "../composables/useDialog";
const emit = defineEmits<{ (e: "save", v: object): void }>();
const dialog = useDialog("training", (v) => emit("save", v));
function submit() { dialog.confirm({}); }
</script>
`,
  "src/pages/MatchPage.vue": `<template><MatchForm @save="storeMatch" /></template>
<script setup lang="ts">
import MatchForm from "../components/MatchForm.vue";
import axios from "axios";
function storeMatch(v: object) { axios.post("/api/matches", v); }
</script>
`,
  "src/pages/TrainingPage.vue": `<template><TrainingForm @save="storeTraining" /></template>
<script setup lang="ts">
import TrainingForm from "../components/TrainingForm.vue";
import axios from "axios";
function storeTraining(v: object) { axios.post("/api/trainings", v); }
</script>
`,
};

describe("a composable's collaborators", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-collaborators-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const from = (file: string, symbol: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === symbol).map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);

  it("reads a member destructured from another composable's result as that composable's", () => {
    expect(from("src/composables/useCrud.ts", "save")).toContain("actions.updateClub -> src/composables/useGarageData.ts::clubActions.updateClub");
  });

  it("reaches the parent's handler of the event a callback emits, for each component's own instance", () => {
    expect(from("src/components/MatchForm.vue", "submit")).toContain("dialog.confirm -> src/pages/MatchPage.vue::storeMatch");
    expect(from("src/components/TrainingForm.vue", "submit")).toContain("dialog.confirm -> src/pages/TrainingPage.vue::storeTraining");
    // Never the other component's page, nor the composable's function for every user of it.
    expect(from("src/components/MatchForm.vue", "submit").some((l) => l.includes("storeTraining"))).toBe(false);
    expect(summary.symbolLinks.some((l) => l.sourceFile === "src/composables/useDialog.ts" && /emit:/.test(l.callName))).toBe(false);
  });
});
