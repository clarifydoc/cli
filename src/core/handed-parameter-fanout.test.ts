import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** A composable runs a function handed to it; its spec calls it with a mock, which says nothing about the screens. */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "league-ui", "dependencies": { "vue": "^3.4.0", "axios": "^1.0.0" } }\n`,
  "src/api/matchApi.ts": `import axios from 'axios';
class MatchApi {
  list(params: any) { return axios.get('/api/matches', { params }); }
  docs(params: any) { return axios.get('/api/docs', { params }); }
}
export default new MatchApi();
`,
  "src/composables/useDrilldown.ts": `import { ref } from 'vue';
export function useDrilldown(fetcher: (params: any) => Promise<any>) {
  const rows = ref([]);
  const fetchPage = async (page: number) => {
    const res = await fetcher({ page });
    rows.value = res.data;
  };
  const open = async (page: number) => {
    await fetchPage(page);
  };
  return { rows, open };
}
`,
  "src/composables/useDrilldown.spec.ts": `import { vi, it } from 'vitest';
import { useDrilldown } from './useDrilldown';
it('opens', async () => {
  const fetcher = vi.fn();
  const { open } = useDrilldown(fetcher);
  await open(1);
});
`,
  "src/views/MatchList.vue": `<template><button @click="open(1)">Load</button></template>
<script setup lang="ts">
import MatchApi from '../api/matchApi';
import { useDrilldown } from '../composables/useDrilldown';
const { rows, open } = useDrilldown((params) => MatchApi.list(params));
</script>
`,
  // The decoy: a composable two screens hand different functions, and its spec a mock.
  "src/composables/useSearch.ts": `export function useSearch(fetcher: (params: any) => Promise<any>) {
  async function page(q: string) { return fetcher({ q }); }
  async function run(q: string) { return page(q); }
  return { run };
}
`,
  "src/composables/useSearch.spec.ts": `import { vi, it } from 'vitest';
import { useSearch } from './useSearch';
it('runs', () => { useSearch(vi.fn()).run('x'); });
`,
  "src/views/Docs.vue": `<template><button @click="run('a')">Go</button></template>
<script setup lang="ts">
import MatchApi from '../api/matchApi';
import { useSearch } from '../composables/useSearch';
const { run } = useSearch((params) => MatchApi.docs(params));
</script>
`,
  "src/views/Matches.vue": `<template><button @click="run('a')">Go</button></template>
<script setup lang="ts">
import MatchApi from '../api/matchApi';
import { useSearch } from '../composables/useSearch';
const { run } = useSearch((params) => MatchApi.list(params));
</script>
`,
  "src/server.js": `const express = require('express');
const app = express();
app.get('/api/matches', (req, res) => res.json([]));
app.get('/api/docs', (req, res) => res.json([]));
`,
};

describe("a function handed to a composable, with a spec calling it with a mock", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-fanout-"));
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

  const hop = (file: string, symbol: string, call: string): string[] =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.callName === call)
      .map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`).sort();

  it("follows the function a screen hands the composable, whatever its spec passes", () => {
    expect(hop("src/composables/useDrilldown.ts", "fetchPage", "fetcher")).toEqual(["matchApi.ts::MatchApi.list"]);
  });

  it("links nothing for a parameter two screens state differently, and runs each screen's own", () => {
    expect(hop("src/composables/useSearch.ts", "run", "fetcher")).toEqual([]);
    expect(hop("src/views/Docs.vue", "<setup>", "run")).toContain("matchApi.ts::MatchApi.docs");
    expect(hop("src/views/Matches.vue", "<setup>", "run")).toContain("matchApi.ts::MatchApi.list");
  });
});

/**
 * A composable taking an options object runs its callbacks by member (`config.onSubmit(data)` in a nested `handleSubmit`),
 * the parameter typed by an interface; each screen's own literal states them (real-repo FP: one form composable, 31 forms).
 * Decoys: a member a screen does not state, and a namesake composable of another module.
 */
const OPTION_FILES: Record<string, string> = {
  "package.json": `{ "name": "league-ui", "dependencies": { "vue": "^3.4.0" } }\n`,
  "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n`,
  "src/api.ts": `export const renameClub = (name: string) => fetch("/api/clubs", { method: "PUT", body: name });
export const signPlayer = (name: string) => fetch("/api/players", { method: "POST", body: name });
export const parkCar = (name: string) => fetch("/api/garages", { method: "POST", body: name });
`,
  "src/composables/useForm.ts": `interface UseFormConfig<T> {
  initialValues: T;
  onSubmit: (data: T) => Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  onFinally?: () => void;
}
export const useForm = <T extends object>(config: UseFormConfig<T>) => {
  const handleSubmit = async () => {
    const result = await config.onSubmit(config.initialValues);
    config.onSuccess?.(result);
    config.onFinally?.();
  };
  return { handleSubmit };
};
`,
  "src/components/RenameClubForm.vue": `<template><form @submit.prevent="handleSubmit"><button>Save</button></form></template>
<script setup lang="ts">
import { useForm } from "@/composables/useForm";
import { renameClub } from "@/api";
const close = () => {};
const { handleSubmit } = useForm({
  initialValues: { name: "" },
  onSubmit: async ({ name }) => renameClub(name),
  onSuccess: () => close(),
});
</script>
`,
  "src/components/SignPlayerForm.vue": `<template><form @submit.prevent="handleSubmit"><button>Sign</button></form></template>
<script setup lang="ts">
import { useForm } from "@/composables/useForm";
import { signPlayer } from "@/api";
const { handleSubmit } = useForm({
  initialValues: { name: "" },
  onSubmit: async ({ name }) => signPlayer(name),
});
</script>
`,
  "src/legacy/useForm.ts": `export const useForm = (config: { onSubmit: () => void }) => ({ handleSubmit: () => config.onSubmit() });
`,
  "src/legacy/ParkForm.vue": `<template><form @submit.prevent="handleSubmit"><button>Park</button></form></template>
<script setup lang="ts">
import { useForm } from "./useForm";
import { parkCar } from "@/api";
const { handleSubmit } = useForm({ onSubmit: () => parkCar("x") });
</script>
`,
};

describe("a composable running the callbacks of its options object", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-options-callbacks-"));
    for (const [path, text] of Object.entries(OPTION_FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const rows = () => (summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:param-arg").map((l) => `${l.sourceFile} -${l.callName}-> ${l.targetSymbol}`);

  it("runs each screen's own onSubmit and onSuccess from the handler it binds", () => {
    expect(rows()).toEqual(expect.arrayContaining([
      "src/components/RenameClubForm.vue -handleSubmit-> renameClub",
      "src/components/RenameClubForm.vue -handleSubmit-> close",
      "src/components/SignPlayerForm.vue -handleSubmit-> signPlayer",
    ]));
  });

  it("states nothing for a member a screen leaves out, and never crosses to a namesake composable", () => {
    expect(rows().filter((r) => r.startsWith("src/components/SignPlayerForm.vue") && r.endsWith("close"))).toEqual([]);
    expect(rows().filter((r) => r.includes("legacy") || r.endsWith("parkCar"))).toEqual([]);
    expect(rows().filter((r) => r.startsWith("src/components/RenameClubForm.vue") && r.endsWith("signPlayer"))).toEqual([]);
  });
});
