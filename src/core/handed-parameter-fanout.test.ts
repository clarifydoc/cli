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
  // A callback default (real-repo FP): a screen calling the composable with no argument runs the default; a
  // default doing more than one call states nothing.
  "src/composables/useReport.ts": `import MatchApi from '../api/matchApi';
export function useReport(fetcher = (params: any) => MatchApi.docs(params)) {
  const fetchPage = async (page: number) => fetcher({ page });
  return { open: (page: number) => fetchPage(page) };
}
export function useLog(fetcher = (params: any) => { console.log(params); return MatchApi.list(params); }) {
  const fetchPage = async (page: number) => fetcher({ page });
  return { open: (page: number) => fetchPage(page) };
}
`,
  "src/views/Report.vue": `<template><button @click="open(1)">Report</button><button @click="openLog(1)">Log</button></template>
<script setup lang="ts">
import { useReport, useLog } from '../composables/useReport';
const { open } = useReport();
const { open: openLog } = useLog();
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

  it("runs a callback default when a screen leaves the parameter out, and nothing for a default doing more", () => {
    expect(hop("src/composables/useReport.ts", "fetchPage", "fetcher")).toEqual(["matchApi.ts::MatchApi.docs"]);
    expect(hop("src/composables/useReport.ts", "fetchPage", "fetcher").length).toBe(1);
    expect(summary.symbolLinks.filter((l) => l.sourceFile === "src/composables/useReport.ts" && l.callName === "fetcher" && l.targetSymbol === "MatchApi.list")).toEqual([]);
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

/**
 * A composable with a callback default, called by screens that disagree (real-repo FP): one leaves the argument out
 * and runs the default, one hands an arrow calling its own prop (bound by the screen that renders it), one hands
 * its own request. Each screen's call runs its own.
 */
const USAGE_FILES: Record<string, string> = {
  "package.json": `{ "name": "league-ui", "dependencies": { "vue": "^3.4.0", "axios": "^1.0.0" } }\n`,
  "src/api/matchApi.ts": `import axios from 'axios';
class MatchApi {
  list(params: any) { return axios.get('/api/matches', { params }); }
  docs(params: any) { return axios.get('/api/docs', { params }); }
}
export default new MatchApi();
`,
  "src/composables/useUsage.ts": `import MatchApi from '../api/matchApi';
export function useUsage(fetcher = (params: any) => MatchApi.docs(params)) {
  const fetchPage = async (page: number) => fetcher({ page });
  const open = (page: number) => fetchPage(page);
  return { open };
}
`,
  "src/views/UsageDrawer.vue": `<template><button @click="load">Load</button></template>
<script setup lang="ts">
import { useUsage } from '../composables/useUsage';
const props = defineProps({ fetcher: { type: Function, required: true } });
const { open } = useUsage((params) => props.fetcher(params));
function load() { open(1); }
</script>
`,
  "src/views/PlayerUsage.vue": `<template><UsageDrawer :fetcher="fetchPlayers" /></template>
<script setup lang="ts">
import MatchApi from '../api/matchApi';
import UsageDrawer from './UsageDrawer.vue';
const fetchPlayers = (params: any) => MatchApi.list(params);
</script>
`,
  "src/views/DefaultUsage.vue": `<template><button @click="load">Load</button></template>
<script setup lang="ts">
import { useUsage } from '../composables/useUsage';
const { open } = useUsage();
function load() { open(1); }
</script>
`,
  "src/views/PlainDefault.vue": `<template><button @click="load">Load</button></template>
<script setup>
import { useUsage } from '../composables/useUsage';
const {
  open: openUsage,
} = useUsage();
function load() { openUsage(1); }
</script>
`,
  "src/views/OddUsage.vue": `<template><button @click="load">Load</button></template>
<script setup lang="ts">
import MatchApi from '../api/matchApi';
import { useUsage } from '../composables/useUsage';
const { open } = useUsage((params) => MatchApi.list(params));
function load() { open(1); }
</script>
`,
  "src/server.js": `const express = require('express');
const app = express();
app.get('/api/matches', (req, res) => res.json([]));
app.get('/api/docs', (req, res) => res.json([]));
`,
};

describe("a composable's callback default and a prop-calling arrow, per screen", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-usage-"));
    for (const [rel, text] of Object.entries(USAGE_FILES)) {
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

  it("runs the default for a screen leaving the argument out, never every screen's at once", () => {
    expect(hop("src/views/DefaultUsage.vue", "load", "open")).toContain("matchApi.ts::MatchApi.docs");
    expect(hop("src/views/PlainDefault.vue", "load", "openUsage")).toContain("matchApi.ts::MatchApi.docs");
    expect(hop("src/views/DefaultUsage.vue", "load", "open").filter((t) => t.includes("useUsage:arg0"))).toEqual([]);
    expect(hop("src/composables/useUsage.ts", "fetchPage", "fetcher")).toEqual([]);
  });

  it("holds an arrow calling a prop and reaches what the rendering screen binds", () => {
    expect(hop("src/views/UsageDrawer.vue", "load", "open")).toContain("UsageDrawer.vue::<useUsage:arg0@5>");
    expect(hop("src/views/UsageDrawer.vue", "<useUsage:arg0@5>", "props.fetcher")).toEqual(["PlayerUsage.vue::fetchPlayers"]);
    expect(hop("src/views/OddUsage.vue", "load", "open").filter((t) => t.startsWith("matchApi"))).toEqual(["matchApi.ts::MatchApi.list"]);
  });
});
