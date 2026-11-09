import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Option callbacks a library object runs from its methods (`library-callbacks.ts`): a league table built with
 * TanStack Table whose pager buttons — in the same component, or in a child handed the table as a prop — run the
 * `onPaginationChange` written at the factory call. Decoys: a project function named `useVueTable`, and another
 * library's object with `nextPage`.
 * Labels written by hand from the sources below.
 */
const WEB: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", react: "^18.3.0", "@tanstack/vue-table": "^8.20.0", "@tanstack/react-table": "^8.20.0", axios: "^1.7.0", "pager-kit": "^1.0.0" } }),
  "src/api/fixtures.js": `import axios from 'axios';
export function page(n) {
  return axios.get(\`/api/v2/fixtures?page=\${n}\`);
}
export function sorted(by) {
  return axios.get(\`/api/v2/fixtures?sort=\${by}\`);
}
export function standings() {
  return axios.get('/api/v2/standings');
}
`,
  "src/components/LeagueTable.vue": `<script setup>
import { ref } from 'vue';
import { useVueTable, getCoreRowModel } from '@tanstack/vue-table';
import { page, sorted } from '../api/fixtures';
import Pager from './Pager.vue';

const rows = ref([]);
const pagination = ref({ pageIndex: 0, pageSize: 20 });

function applySort(updater) {
  sorted(updater);
}

const table = useVueTable({
  get data() {
    return rows.value;
  },
  columns: [],
  manualPagination: true,
  getCoreRowModel: getCoreRowModel(),
  onPaginationChange: (updater) => {
    pagination.value = updater(pagination.value);
    page(pagination.value.pageIndex);
  },
  onSortingChange: applySort,
});
</script>

<template>
  <div>
    <button class="next" @click="table.nextPage()">Next</button>
    <button class="sort" @click="table.setSorting([])">Reset sort</button>
    <Pager :table="table" />
  </div>
</template>
`,
  "src/components/Pager.vue": `<script setup>
const props = defineProps({ table: { type: Object, required: true } });

function last() {
  props.table.setPageIndex(props.table.getPageCount() - 1);
}
</script>

<template>
  <nav>
    <button class="first" @click="table.setPageIndex(0)">First</button>
    <button class="prev" @click="table.previousPage()">Prev</button>
    <button class="last" @click="last">Last</button>
  </nav>
</template>
`,
  "src/composables/useVueTable.js": `export function useVueTable(options) {
  return { nextPage() { return options.rows.slice(1); } };
}
`,
  "src/components/SquadTable.vue": `<script setup>
import { useVueTable } from '../composables/useVueTable';
import { standings } from '../api/fixtures';

const table = useVueTable({ rows: [], onPaginationChange: () => standings() });
</script>

<template>
  <button class="decoy-next" @click="table.nextPage()">Next</button>
</template>
`,
  "src/components/Gallery.vue": `<script setup>
import { useCarousel } from 'pager-kit';
import { standings } from '../api/fixtures';

const carousel = useCarousel({ onPaginationChange: () => standings() });
</script>

<template>
  <button class="decoy-carousel" @click="carousel.nextPage()">Next</button>
</template>
`,
  "src/react/Pager.tsx": `import React from 'react';
import type { Table } from '@tanstack/react-table';

export function Pager({ table }: { table: Table<unknown> }) {
  return <button onClick={() => table.setPageIndex(0)}>First</button>;
}
`,
  "src/react/ClubTable.jsx": `import React, { useState } from 'react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import { page } from '../api/fixtures';
import { Pager } from './Pager';

export function ClubTable() {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const table = useReactTable({
    data: [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    onPaginationChange: (updater) => {
      setPagination(updater);
      page(pagination.pageIndex);
    },
  });
  return (
    <div>
      <button onClick={() => table.previousPage()}>Prev</button>
      <Pager table={table} />
    </div>
  );
}
`,
};

const linkRows = (s: ProjectAnalysis, sourceFile: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === sourceFile && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol} ${l.confidence}`)
    .sort();

describe("option callbacks a library object runs from its methods", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-library-callbacks-"));
    for (const [path, text] of Object.entries(WEB)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("joins a table's method called in its own component to the option callback the factory call writes", () => {
    const rows = linkRows(summary, "src/components/LeagueTable.vue");
    expect(rows).toEqual(expect.arrayContaining([
      "<setup> -table.nextPage-> src/components/LeagueTable.vue#<useVueTable:onPaginationChange@21> INFERRED",
      "<setup> -table.setSorting-> src/components/LeagueTable.vue#applySort INFERRED",
      "<useVueTable:onPaginationChange@21> -page-> src/api/fixtures.js#page EXTRACTED",
    ]));
    // The callback runs when a method is called, not when the page loads.
    expect(rows).not.toContain("<setup> -page-> src/api/fixtures.js#page EXTRACTED");
  });

  it("joins a child's call on a table handed down as a prop to the parent's callback", () => {
    expect(linkRows(summary, "src/components/Pager.vue")).toEqual(expect.arrayContaining([
      "<setup> -table.setPageIndex-> src/components/LeagueTable.vue#<useVueTable:onPaginationChange@21> INFERRED",
      "<setup> -table.previousPage-> src/components/LeagueTable.vue#<useVueTable:onPaginationChange@21> INFERRED",
      "last -props.table.setPageIndex-> src/components/LeagueTable.vue#<useVueTable:onPaginationChange@21> INFERRED",
    ]));
    expect(linkRows(summary, "src/react/Pager.tsx")).toContain("Pager -table.setPageIndex-> src/react/ClubTable.jsx#<useReactTable:onPaginationChange@12> INFERRED");
  });

  it("joins a React table's method to the option callback", () => {
    expect(linkRows(summary, "src/react/ClubTable.jsx")).toEqual(expect.arrayContaining([
      "ClubTable -table.previousPage-> src/react/ClubTable.jsx#<useReactTable:onPaginationChange@12> INFERRED",
      "<useReactTable:onPaginationChange@12> -page-> src/api/fixtures.js#page EXTRACTED",
    ]));
  });

  it("joins nothing for a project function named like the factory, or another library's object", () => {
    const decoys = [...linkRows(summary, "src/components/SquadTable.vue"), ...linkRows(summary, "src/components/Gallery.vue")];
    expect(decoys.filter((r) => r.includes("onPaginationChange"))).toEqual([]);
    expect((summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:library-option" && !/LeagueTable|ClubTable/.test(l.sourceFile))).toEqual([]);
  });
});
