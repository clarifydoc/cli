import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Prop bindings the first passes left: an arrow written in place under a prop no `on` marks and calling nothing the
 * file declares, a mixin that takes on another mixin, a kit registered from an array by each component's own `name`,
 * an array of objects a parent hands a child whose loop calls `x.run()`, and a record of stores a prop picks while
 * one user binds a value no name is read for. Each has a decoy (a namesake or a component nobody binds). Labels are
 * written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.2.0", vue: "^2.7.0", axios: "^1.6.0" } }),
  "src/api/clubs.ts": `import axios from 'axios';
export function closeClub(id: number) {
  return axios.post('/api/v2/clubs/' + id + '/close');
}
export function sellPlayer(id: number) {
  return axios.delete('/api/v2/players/' + id);
}
export function sellCar(id: number) {
  return axios.delete('/api/v2/cars/' + id);
}
export function pickPlayer() {
  return axios.post('/api/v2/players/pick');
}
`,
  // An arrow under a non-`on` prop that calls nothing the page declares.
  "src/react/ClubDialog.tsx": `import React from 'react';
import { closeCar } from './cars';

export function ClubDialog(props: { handleClose: () => void; id: number }) {
  return <button onClick={() => props.handleClose()}>Close</button>;
}
export function CarNote() {
  closeCar();
  return <span>car</span>;
}
`,
  "src/react/cars.ts": `import axios from 'axios';
export function closeCar() {
  return axios.post('/api/v2/cars/close');
}
`,
  "src/react/ClubPage.tsx": `import React, { useState } from 'react';
import { ClubDialog } from './ClubDialog';
import { closeClub } from '../api/clubs';

export function ClubPage() {
  const [open, setOpen] = useState(true);
  return <ClubDialog id={1} handleClose={() => { setOpen(false); closeClub(1); }} />;
}
`,
  // A mixin of a mixin.
  "src/vue/mixins/baseActions.js": `import axios from 'axios';
export default {
  methods: {
    saveStadium() {
      return axios.post('/api/v2/stadiums');
    },
  },
};
`,
  "src/vue/mixins/stadiumActions.js": `import baseActions from './baseActions';
export default { mixins: [baseActions], methods: { openStadium() { return 1; } } };
`,
  "src/vue/mixins/loopA.js": `import loopB from './loopB';
export default { mixins: [loopB], methods: { spin() { return 1; } } };
`,
  "src/vue/mixins/loopB.js": `import loopA from './loopA';
export default { mixins: [loopA], methods: { turn() { return 2; } } };
`,
  "src/vue/StadiumForm.vue": `<template><button @click="submit">Save</button></template>
<script>
export default { props: ['onSave'], methods: { submit() { this.onSave(); } } };
</script>
`,
  "src/vue/StadiumPage.vue": `<template><StadiumForm :on-save="saveStadium" /></template>
<script>
import StadiumForm from './StadiumForm.vue';
import stadiumActions from './mixins/stadiumActions';
export default { components: { StadiumForm }, mixins: [stadiumActions] };
</script>
`,
  "src/vue/StadiumDesk.vue": `<template><button @click="go">x</button></template>
<script>
import stadiumActions from './mixins/stadiumActions';
export default { mixins: [stadiumActions], methods: { go() { this.saveStadium(); } } };
</script>
`,
  "src/vue/LoopDesk.vue": `<template><button @click="go">x</button></template>
<script>
import loopA from './mixins/loopA';
export default { mixins: [loopA], methods: { go() { this.turn(); this.spin(); this.missing(); } } };
</script>
`,
  // A kit registered from an array by each component's own `name` option.
  "src/kit/PlayerCard.vue": `<template><button @click="onPick">pick</button></template>
<script>
export default { name: 'PlayerCard', props: { onPick: Function } };
</script>
`,
  "src/kit/TrophyCard.vue": `<template><button @click="onPick">pick</button></template>
<script>
export default { name: 'TrophyCard', props: { onPick: Function } };
</script>
`,
  "src/kit/UnlistedCard.vue": `<template><button @click="onPick">pick</button></template>
<script>
export default { name: 'UnlistedCard', props: { onPick: Function } };
</script>
`,
  "src/kit/index.js": `import PlayerCard from './PlayerCard.vue';
import TrophyCard from './TrophyCard.vue';
const components = [PlayerCard, TrophyCard];
export default { install(Vue) { components.forEach((c) => Vue.component(c.name, c)); } };
`,
  "src/kit/SquadPage.vue": `<template><div><player-card :on-pick="pickPlayerNow" /><unlisted-card :on-pick="pickOther" /></div></template>
<script>
import { pickPlayer, sellCar } from '../api/clubs';
export default { methods: { pickPlayerNow() { pickPlayer(); }, pickOther() { sellCar(1); } } };
</script>
`,
  // An array of objects handed to a child that loops over it.
  "src/list/ActionList.vue": `<script setup>
import { sellCar } from '../api/clubs';
const props = defineProps({ extra: Array });
function decoy() { sellCar(1); }
</script>
<template>
  <ul>
    <li v-for="x in props.extra" :key="x.id"><button @click="x.run()">go</button></li>
  </ul>
</template>
`,
  "src/list/ActionListB.vue": `<script setup>
defineProps({ extra: Array });
</script>
<template>
  <ul>
    <li v-for="x in extra" :key="x.id"><button @click="x.run()">go</button></li>
  </ul>
</template>
`,
  "src/list/PlayerPage.vue": `<script setup>
import ActionList from './ActionList.vue';
import ActionListB from './ActionListB.vue';
import { sellPlayer } from '../api/clubs';
const rows = [{ id: 2, run: () => sellPlayer(2) }];
</script>
<template>
  <ActionList :extra="[{ id: 1, run: () => sellPlayer(1) }]" />
  <ActionListB :extra="rows" />
</template>
`,
  // A record of stores a prop picks, and one user whose binding is read from a row.
  "src/stores/kinds.ts": `export enum Kind {
  Club = 'club',
  Player = 'player',
}
`,
  "src/stores/useClubStore.ts": `import axios from 'axios';
export const useClubStore = function () {
  const actions = { async createOne(body: { name: string }) { return axios.post('/api/v2/clubs', body); } };
  return { actions };
};
`,
  "src/stores/usePlayerStore.ts": `import axios from 'axios';
export const usePlayerStore = function () {
  const actions = { async createOne(body: { name: string }) { return axios.post('/api/v2/players', body); } };
  return { actions };
};
`,
  "src/stores/Picker.vue": `<template><button @click="create">Add</button></template>
<script setup lang="ts">
import { useClubStore } from './useClubStore';
import { usePlayerStore } from './usePlayerStore';
import { Kind } from './kinds';
const props = defineProps<{ kind: Kind }>();
const squadStores = { [Kind.Club]: useClubStore(), [Kind.Player]: usePlayerStore() };
async function create() {
  await squadStores[props.kind].actions.createOne({ name: 'Rovers' });
}
</script>
`,
  "src/stores/NamedPage.vue": `<template><Picker kind="player" /></template>
<script setup>
import Picker from './Picker.vue';
</script>
`,
  "src/stores/RowPage.vue": `<template><div v-for="row in rows" :key="row.id"><Picker :kind="row.kind" /></div></template>
<script setup>
import Picker from './Picker.vue';
const rows = [];
</script>
`,
};

describe("prop bindings the first passes left", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-prop-leftovers-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.relation !== "reference" && l.targetFile !== file)
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}${l.viaUsage ? ` via ${l.viaUsage.map((u) => `${u.file}:${u.line}`).join(",")}` : ""}`)
      .sort();

  it("gives an arrow under a non-`on` prop its own function, which the child's call of the prop reaches", () => {
    expect(linksFrom("src/react/ClubDialog.tsx")).toEqual([
      "CarNote -closeCar-> src/react/cars.ts:closeCar",
      "ClubDialog -props.handleClose-> src/react/ClubPage.tsx:<ClubDialog:handleClose@7> via src/react/ClubPage.tsx:7",
    ]);
    expect(linksFrom("src/react/ClubPage.tsx")).toContain("<ClubDialog:handleClose@7> -closeClub-> src/api/clubs.ts:closeClub");
  });

  it("follows a mixin's own mixins, cycle-safe, for the page's handler and its calls", () => {
    expect(linksFrom("src/vue/StadiumForm.vue")).toEqual(["submit -this.onSave-> src/vue/mixins/baseActions.js:saveStadium via src/vue/StadiumPage.vue:1"]);
    expect(linksFrom("src/vue/StadiumDesk.vue")).toContain("go -this.saveStadium-> src/vue/mixins/baseActions.js:saveStadium");
    // A cycle of mixins terminates, and a name nobody defines stays unlinked.
    const loop = linksFrom("src/vue/LoopDesk.vue");
    expect(loop).toContain("go -this.turn-> src/vue/mixins/loopB.js:turn");
    expect(loop).toContain("go -this.spin-> src/vue/mixins/loopA.js:spin");
    expect(loop.some((l) => l.includes("missing"))).toBe(false);
  });

  it("registers a kit listed in an array under each component's own `name`, and no component the list leaves out", () => {
    expect(linksFrom("src/kit/PlayerCard.vue")).toEqual(["<setup> -onPick-> src/kit/SquadPage.vue:pickPlayerNow via src/kit/SquadPage.vue:1"]);
    expect(linksFrom("src/kit/UnlistedCard.vue")).toEqual([]);
  });

  it("carries an array's member functions, written in place or declared, to the child's loop", () => {
    expect(linksFrom("src/list/ActionList.vue")).toEqual([
      "<template> -run-> src/list/PlayerPage.vue:<ActionList:extra.run@8> via src/list/PlayerPage.vue:8",
      "decoy -sellCar-> src/api/clubs.ts:sellCar",
    ]);
    expect(linksFrom("src/list/ActionListB.vue")).toEqual(["<template> -run-> src/list/PlayerPage.vue:<rows[].run@5> via src/list/PlayerPage.vue:9"]);
  });

  it("reaches every store a prop could pick when one user binds a value no name is read for", () => {
    const reached = summary.symbolLinks
      .filter((l) => l.sourceFile === "src/stores/Picker.vue" && l.sourceSymbol === "create" && l.relation !== "reference" && /dispatch/.test(l.strategy ?? ""))
      .map((l) => `${l.targetFile}#${l.targetSymbol}${l.viaUsage ? " via " + l.viaUsage.map((u) => `${u.file}:${u.line}`).join(",") : ""}`)
      .sort();
    expect(reached).toEqual(["src/stores/useClubStore.ts#actions.createOne", "src/stores/usePlayerStore.ts#actions.createOne"]);
  });
});
