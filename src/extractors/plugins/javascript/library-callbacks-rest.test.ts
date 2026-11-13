import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * The rest of the option callbacks a library runs (`library-callbacks.ts`), written by hand from the sources below:
 *   - a table's column methods read off the table — `header.column.toggleSorting()` in a `v-for` / `.map`, or in a
 *     child handed the header — run the table's `onSortingChange` / `onColumnVisibilityChange`;
 *   - a mutation's `mutate()` / `mutateAsync()` run the `mutationFn` written at the hook call, and the callback's
 *     parameter still traces to the value `mutate` is handed (`invoked via mutate`);
 *   - a project dispatch map handed down as a prop (`:actions="ACTIONS"`) is the child's `actions.save()`.
 * Decoys: a project `useVueTable`, a table in another file with its own callback, a map no parent hands the child,
 * a map key of the same name in a second parent, another library's `useMutation`.
 */
const WEB: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", react: "^18.3.0", "vue-router": "^4.3.0", "@tanstack/vue-table": "^8.20.0", "@tanstack/react-table": "^8.20.0", "@tanstack/vue-query": "^5.0.0", axios: "^1.7.0" } }),
  "src/api/clubs.js": `import axios from 'axios';
export function saveClub(club) {
  return axios.post('/api/v2/clubs', club);
}
export function removeClub(id) {
  return axios.delete(\`/api/v2/clubs/\${id}\`);
}
export function sortFixtures(by) {
  return axios.get(\`/api/v2/fixtures?sort=\${by}\`);
}
export function hideColumn(column) {
  return axios.post('/api/v2/columns', column);
}
export function sortStandings(by) {
  return axios.get(\`/api/v2/standings?sort=\${by}\`);
}
export function sortPlayers(by) {
  return axios.get(\`/api/v2/players?sort=\${by}\`);
}
export function standings() {
  return axios.get('/api/v2/standings');
}
export function addNote(clubId, note) {
  return axios.post(\`/api/v2/clubs/\${clubId}/notes\`, note);
}
`,
  "src/local/useVueTable.js": `export function useVueTable(options) {
  return { getHeaderGroups() { return [{ headers: [] }]; }, options };
}
`,
  "src/local/query.js": `export function useMutation(options) {
  return { mutate(x) { return options.run(x); } };
}
`,
  // The table: its headers' column methods, in the template and in a child handed the header.
  "src/components/FixtureTable.vue": `<script setup>
import { useVueTable, getCoreRowModel } from '@tanstack/vue-table';
import { sortFixtures, hideColumn } from '../api/clubs';
import HeaderCell from './HeaderCell.vue';

const table = useVueTable({
  data: [],
  columns: [],
  getCoreRowModel: getCoreRowModel(),
  onSortingChange: (updater) => {
    sortFixtures(updater);
  },
  onColumnVisibilityChange: (updater) => {
    hideColumn(updater);
  },
});
</script>

<template>
  <table>
    <thead>
      <tr v-for="headerGroup in table.getHeaderGroups()" :key="headerGroup.id">
        <th v-for="header in headerGroup.headers" :key="header.id">
          <button class="sort" @click="header.column.toggleSorting()">Sort</button>
          <button class="handler" @click="header.column.getToggleSortingHandler()">Handler</button>
          <button class="hide" @click="header.column.toggleVisibility()">Hide</button>
          <HeaderCell :header="header" />
        </th>
      </tr>
    </thead>
  </table>
</template>
`,
  "src/components/HeaderCell.vue": `<script setup>
const props = defineProps({ header: { type: Object, required: true } });

function flip() {
  props.header.column.toggleSorting();
}
</script>

<template>
  <button class="flip" @click="flip">Flip</button>
  <button class="inline" @click="header.column.toggleSorting()">Sort</button>
</template>
`,
  // Another table in another file, with its own callback: its header must not reach FixtureTable's.
  "src/components/PlayerTable.vue": `<script setup>
import { useVueTable } from '@tanstack/vue-table';
import { sortPlayers } from '../api/clubs';

const table = useVueTable({ data: [], columns: [], onSortingChange: (u) => sortPlayers(u) });
</script>

<template>
  <th v-for="header in table.getHeaderGroups()[0].headers" :key="header.id">
    <button class="player-sort" @click="header.column.toggleSorting()">Sort</button>
  </th>
</template>
`,
  // The decoy: a project function named like the factory.
  "src/components/SquadTable.vue": `<script setup>
import { useVueTable } from '../local/useVueTable';
import { standings } from '../api/clubs';

const table = useVueTable({ onSortingChange: () => standings() });
</script>

<template>
  <th v-for="header in table.getHeaderGroups()[0].headers" :key="header.id">
    <button class="squad-sort" @click="header.column.toggleSorting()">Sort</button>
  </th>
</template>
`,
  "src/react/StandingsTable.jsx": `import React from 'react';
import { useReactTable, getCoreRowModel } from '@tanstack/react-table';
import { sortStandings } from '../api/clubs';
import { SortHeader } from './SortHeader';

export function StandingsTable() {
  const table = useReactTable({
    data: [],
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: (updater) => {
      sortStandings(updater);
    },
  });
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id} onClick={header.column.getToggleSortingHandler()}>
                <SortHeader header={header} />
              </th>
            ))}
          </tr>
        ))}
      </thead>
    </table>
  );
}
`,
  "src/react/SortHeader.jsx": `import React from 'react';

export function SortHeader({ header }) {
  return <button onClick={() => header.column.toggleSorting()}>Sort</button>;
}
`,
  // Not the table's headers: a plain list of headers, whatever it is called.
  "src/react/Legend.jsx": `import React from 'react';
import { useReactTable } from '@tanstack/react-table';
import { standings } from '../api/clubs';
import { SortHeader } from './SortHeader';

export function Legend({ headers }) {
  const table = useReactTable({ data: [], columns: [], onSortingChange: () => standings() });
  return <div>{headers.map((header) => <SortHeader header={header} key={header.id} />)}{table.getRowModel().rows.length}</div>;
}
`,
  // Mutations written in the component.
  "src/components/ClubForm.vue": `<script setup>
import { useRoute } from 'vue-router';
import { useMutation } from '@tanstack/vue-query';
import { saveClub, removeClub } from '../api/clubs';

const route = useRoute();
const save = useMutation({ mutationFn: (club) => saveClub(club) });
const remove = useMutation({ mutationFn: (id) => removeClub(id) });

function onSave(club) {
  save.mutate(club);
}
function onRemove() {
  remove.mutate(route.params.clubId);
}
</script>

<template>
  <button class="save" @click="onSave({})">Save</button>
  <button class="remove" @click="onRemove">Remove</button>
  <button class="again" @click="save.mutateAsync({})">Again</button>
</template>
`,
  // A hook whose callback closes over the hook's own parameter: the callback is a held function, the parameter its writer's.
  "src/composables/useAddNote.js": `import { useMutation } from '@tanstack/vue-query';
import { addNote } from '../api/clubs';

export function useAddNote(clubId) {
  return useMutation({ mutationFn: (note) => addNote(clubId, note) });
}
`,
  "src/components/NoteForm.vue": `<script setup>
import { useRoute } from 'vue-router';
import { useAddNote } from '../composables/useAddNote';

const route = useRoute();
const add = useAddNote(route.params.clubId);
</script>

<template>
  <button class="note" @click="add.mutate('hello')">Add</button>
</template>
`,
  "src/components/DecoyForm.vue": `<script setup>
import { useMutation } from '../local/query';
import { removeClub } from '../api/clubs';

const remove = useMutation({ mutationFn: (id) => removeClub(id) });
</script>

<template>
  <button class="decoy" @click="remove.mutate(1)">Remove</button>
</template>
`,
  // The dispatch map handed down: the imported functions, and a second parent whose map has the same key.
  "src/components/ClubPage.vue": `<script setup>
import { saveClub, removeClub } from '../api/clubs';
import ClubTable from './ClubTable.vue';

const ACTIONS = { save: saveClub, remove: removeClub };
</script>

<template>
  <ClubTable :actions="ACTIONS" />
</template>
`,
  "src/components/PlayerPage.vue": `<script setup>
import { standings } from '../api/clubs';
import ClubTable from './ClubTable.vue';

const ACTIONS = { save: standings };
</script>

<template>
  <ClubTable :actions="ACTIONS" />
</template>
`,
  "src/components/StaffPage.vue": `<script setup>
import { sortPlayers } from '../api/clubs';

const ACTIONS = { save: sortPlayers, remove: sortPlayers };
</script>

<template>
  <p>{{ Object.keys(ACTIONS).length }}</p>
</template>
`,
  "src/components/ClubTable.vue": `<script setup>
const props = defineProps({ actions: { type: Object, required: true } });

function onRow(row) {
  props.actions.save(row);
}
</script>

<template>
  <button class="row-save" @click="onRow({})">Save</button>
  <button class="row-remove" @click="actions.remove(1)">Remove</button>
</template>
`,
  "src/react/MatchPage.jsx": `import React from 'react';
import { saveClub } from '../api/clubs';
import { MatchRow } from './MatchRow';

export function MatchPage() {
  const ACTIONS = { save: saveClub };
  return <MatchRow actions={ACTIONS} />;
}
`,
  "src/react/MatchRow.jsx": `import React from 'react';

export function MatchRow({ actions }) {
  return <button onClick={() => actions.save({})}>Save</button>;
}
`,
};

const linkRows = (s: ProjectAnalysis, sourceFile: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === sourceFile && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol} ${l.confidence}`)
    .sort();

describe("library option callbacks: column methods, mutations and handed-down dispatch maps", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-library-callbacks-rest-"));
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

  it("joins a header's column methods in a v-for to the table's option callbacks", () => {
    const rows = linkRows(summary, "src/components/FixtureTable.vue");
    expect(rows).toEqual(expect.arrayContaining([
      "<setup> -header.column.toggleSorting-> src/components/FixtureTable.vue#<useVueTable:onSortingChange@10> INFERRED",
      "<setup> -header.column.getToggleSortingHandler-> src/components/FixtureTable.vue#<useVueTable:onSortingChange@10> INFERRED",
      "<setup> -header.column.toggleVisibility-> src/components/FixtureTable.vue#<useVueTable:onColumnVisibilityChange@13> INFERRED",
      "<useVueTable:onSortingChange@10> -sortFixtures-> src/api/clubs.js#sortFixtures EXTRACTED",
    ]));
    // Each column method runs its own feature's callback.
    expect(rows).not.toContain("<setup> -header.column.toggleVisibility-> src/components/FixtureTable.vue#<useVueTable:onSortingChange@10> INFERRED");
  });

  it("joins a child's column method on a header handed down as a prop to the parent's callback", () => {
    expect(linkRows(summary, "src/components/HeaderCell.vue")).toEqual(expect.arrayContaining([
      "<setup> -header.column.toggleSorting-> src/components/FixtureTable.vue#<useVueTable:onSortingChange@10> INFERRED",
      "flip -props.header.column.toggleSorting-> src/components/FixtureTable.vue#<useVueTable:onSortingChange@10> INFERRED",
    ]));
  });

  it("joins a React table's header methods in a .map, and in a child handed the header", () => {
    expect(linkRows(summary, "src/react/StandingsTable.jsx")).toEqual(expect.arrayContaining([
      "StandingsTable -header.column.getToggleSortingHandler-> src/react/StandingsTable.jsx#<useReactTable:onSortingChange@11> INFERRED",
    ]));
    expect(linkRows(summary, "src/react/SortHeader.jsx")).toContain("SortHeader -header.column.toggleSorting-> src/react/StandingsTable.jsx#<useReactTable:onSortingChange@11> INFERRED");
  });

  it("keeps a header to its own table: another table's callback, a project factory and a plain list join nothing", () => {
    const toFixtures = (s: string) => s.includes("FixtureTable.vue#") || s.includes("StandingsTable.jsx#");
    expect(linkRows(summary, "src/components/PlayerTable.vue")).toContain("<setup> -header.column.toggleSorting-> src/components/PlayerTable.vue#<useVueTable:onSortingChange@5> INFERRED");
    expect(linkRows(summary, "src/components/PlayerTable.vue").filter(toFixtures)).toEqual([]);
    expect(linkRows(summary, "src/components/SquadTable.vue").filter((r) => r.includes("column."))).toEqual([]);
    // `Legend` iterates the headers a parent hands it, not the table's: its child's column methods are the other callers'.
    expect(linkRows(summary, "src/react/SortHeader.jsx").filter((r) => r.includes("Legend"))).toEqual([]);
    expect((summary.symbolLinks ?? []).filter((l) => l.targetFile === "src/react/Legend.jsx" && l.strategy?.startsWith("dispatch:"))).toEqual([]);
  });

  it("joins a mutation's mutate and mutateAsync to the mutationFn written at the hook call", () => {
    const rows = linkRows(summary, "src/components/ClubForm.vue");
    expect(rows).toEqual(expect.arrayContaining([
      "onSave -save.mutate-> src/components/ClubForm.vue#<useMutation:mutationFn@7> INFERRED",
      "<setup> -save.mutateAsync-> src/components/ClubForm.vue#<useMutation:mutationFn@7> INFERRED",
      "onRemove -remove.mutate-> src/components/ClubForm.vue#<useMutation:mutationFn@8> INFERRED",
      "<useMutation:mutationFn@8> -removeClub-> src/api/clubs.js#removeClub EXTRACTED",
    ]));
    // `save` runs its own callback, not `remove`'s.
    expect(rows).not.toContain("onSave -save.mutate-> src/components/ClubForm.vue#<useMutation:mutationFn@8> INFERRED");
    expect(linkRows(summary, "src/components/DecoyForm.vue").filter((r) => r.includes("mutationFn"))).toEqual([]);
  });

  it("keeps the mutate call as the origin of the callback's parameter", () => {
    const origins = (summary.paramOrigins ?? []).filter((o) => o.sink.file === "src/api/clubs.js" && o.sink.url.includes("/clubs/"));
    const fromForm = origins.filter((o) => o.hops.some((h) => h.file === "src/components/ClubForm.vue"));
    expect(fromForm.map((o) => o.origin.kind)).toContain("route-param");
    const known = fromForm.find((o) => o.origin.kind === "route-param");
    expect(known?.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(known?.hops.map((h) => h.symbol)).toEqual(expect.arrayContaining(["onRemove", "<useMutation:mutationFn@8>"]));
    // The decoy's `mutate(1)` is another library's call: no origin of the form's.
    expect(origins.filter((o) => o.hops.some((h) => h.file === "src/components/DecoyForm.vue") && o.origin.kind === "route-param")).toEqual([]);
  });

  it("follows a held callback's closed-over parameter back to its writer's callers", () => {
    const origin = (summary.paramOrigins ?? []).find((o) => o.sink.file === "src/api/clubs.js" && o.sink.url.includes("/notes") && o.origin.kind === "route-param");
    expect(origin?.origin).toMatchObject({ kind: "route-param", name: "clubId" });
  });

  it("joins a child's call on a dispatch map handed down as a prop to the functions the parent holds", () => {
    const rows = linkRows(summary, "src/components/ClubTable.vue");
    expect(rows).toEqual(expect.arrayContaining([
      "onRow -props.actions.save-> src/api/clubs.js#saveClub INFERRED",
      "<setup> -actions.remove-> src/api/clubs.js#removeClub INFERRED",
    ]));
    // A second parent handing a map with the same key is a second binding of the child, not a replacement.
    expect(rows).toContain("onRow -props.actions.save-> src/api/clubs.js#standings INFERRED");
    // The page that holds a map but hands it to no child binds nothing.
    expect(rows.filter((r) => r.includes("sortPlayers"))).toEqual([]);
  });

  it("joins a React child's call on a dispatch map handed down as a prop", () => {
    expect(linkRows(summary, "src/react/MatchRow.jsx")).toContain("MatchRow -actions.save-> src/api/clubs.js#saveClub INFERRED");
  });
});
