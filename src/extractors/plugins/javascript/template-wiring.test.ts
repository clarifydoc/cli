import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Template and component wiring a click used to lose: callbacks the SCRIPT hands a component it opens
 * (`modal.open(ConfirmBox, { onConfirm: saveClub })`), a `v-bind` object of `onX` handlers, a `v-for`
 * variable whose collection's type the script states, a scoped slot's parameter, and an Angular getter
 * returning a child. Each has a namesake decoy that must not link.
 */
const VUE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "src/components/ConfirmBox.vue": `<script setup>
const props = defineProps({ onConfirm: { type: Function, default: null } });
function accept() { props.onConfirm(); }
</script>
<template><button @click="accept">OK</button></template>
`,
  "src/components/OtherBox.vue": `<script setup>
const props = defineProps({ onConfirm: { type: Function, default: null } });
function accept() { props.onConfirm(); }
</script>
<template><button @click="accept">OK</button></template>
`,
  "src/components/SquadBar.vue": `<script setup>
const props = defineProps({ onPick: { type: Function, default: null } });
function pick() { props.onPick(); }
</script>
<template><button @click="pick">Pick</button></template>
`,
  "src/components/ClubShell.vue": `<script setup>
import axios from 'axios';
async function saveAll(club) { await axios.put('/api/v2/clubs/all', club); }
</script>
<template><div><slot :save="saveAll" /></div></template>
`,
  "src/components/CarShell.vue": `<script setup>
import axios from 'axios';
async function saveAll(car) { await axios.put('/api/v2/cars/all', car); }
</script>
<template><div><slot :save="saveAll" /></div></template>
`,
  "src/models/club.ts": `import axios from 'axios';
export class Club {
  id = 0;
  async archive() { await axios.post('/api/v2/clubs/archive', { id: this.id }); }
}
export class Car {
  async archive() { await axios.post('/api/v2/cars/archive', {}); }
}
`,
  "src/views/ClubPage.vue": `<script setup lang="ts">
import { ref } from 'vue';
import axios from 'axios';
import ConfirmBox from '../components/ConfirmBox.vue';
import SquadBar from '../components/SquadBar.vue';
import ClubShell from '../components/ClubShell.vue';
import { Club } from '../models/club';
import { useModal } from '../modal';
const modal = useModal();
const clubs = ref<Club[]>([]);
async function saveClub() { await axios.post('/api/v2/clubs', {}); }
async function pickPlayer() { await axios.post('/api/v2/players/pick', {}); }
function ask() {
  modal.open(ConfirmBox, { onConfirm: saveClub });
}
function askInline() {
  modal.open(ConfirmBox, { props: { onConfirm: () => axios.delete('/api/v2/clubs/1') } });
}
</script>
<template>
  <button @click="ask">Ask</button>
  <SquadBar v-bind="{ onPick: pickPlayer, label: 'x' }" />
  <ClubShell>
    <template #default="{ save }">
      <button @click="save(clubs[0])">Save</button>
    </template>
  </ClubShell>
  <ul><li v-for="club in clubs" :key="club.id"><button @click="club.archive()">Archive</button></li></ul>
</template>
`,
  "src/views/DecoyPage.vue": `<script setup lang="ts">
import { ref } from 'vue';
import OtherBox from '../components/OtherBox.vue';
import CarShell from '../components/CarShell.vue';
import { Car } from '../models/club';
const cars = ref<Car[]>([]);
async function removeAll() {}
</script>
<template>
  <OtherBox />
  <CarShell>
    <template #default="{ save }"><button @click="save(1)">Save</button></template>
  </CarShell>
  <div v-for="car in cars"><button @click="car.archive()">Archive</button></div>
</template>
`,
};

const ANGULAR: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-ng", dependencies: { "@angular/core": "^17.0.0", "@angular/common": "^17.0.0" } }),
  "src/app/club-form.component.ts": `import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
@Component({ selector: 'app-club-form', template: '<form></form>' })
export class ClubFormComponent {
  constructor(private http: HttpClient) {}
  save() { return this.http.post('/api/v2/clubs', {}); }
}
`,
  "src/app/car-form.component.ts": `import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
@Component({ selector: 'app-car-form', template: '<form></form>' })
export class CarFormComponent {
  constructor(private http: HttpClient) {}
  save() { return this.http.post('/api/v2/cars', {}); }
}
`,
  "src/app/club-page.component.ts": `import { Component, ViewChild } from '@angular/core';
import { ClubFormComponent } from './club-form.component';
@Component({ selector: 'app-club-page', template: '<app-club-form #formRef></app-club-form>' })
export class ClubPageComponent {
  @ViewChild(ClubFormComponent) formRef!: ClubFormComponent;
  @ViewChild('formRef') untyped: any;
  get form() { return this.formRef; }
  get typedForm(): ClubFormComponent { return this.untyped; }
  get untypedForm() { return this.untyped; }
  submit() { this.form.save(); }
  submitTyped() { this.typedForm.save(); }
  submitUntyped() { this.untypedForm.save(); }
}
`,
};

async function run(dir: string, files: Record<string, string>): Promise<ProjectAnalysis> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", path)), { recursive: true });
    await writeFile(join(dir, "app", path), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return loadReportSummary(join(dir, "out"));
}

const linkRows = (s: ProjectAnalysis, sourceFile: string) =>
  s.symbolLinks
    .filter((l) => l.sourceFile === sourceFile && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`)
    .sort();

describe("Vue template and component wiring", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-template-wiring-"));
    summary = await run(dir, VUE);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("joins a prop read in a component the script opens to the callbacks its options hand over, not to a namesake", () => {
    expect(linkRows(summary, "src/components/ConfirmBox.vue").filter((r) => r.includes("props.onConfirm"))).toEqual([
      "accept -props.onConfirm-> src/views/ClubPage.vue#askInline",
      "accept -props.onConfirm-> src/views/ClubPage.vue#saveClub",
    ]);
    expect(linkRows(summary, "src/components/OtherBox.vue").filter((r) => r.includes("props.onConfirm"))).toEqual([]);
  });

  it("joins a v-bind object's on-handler to the child's prop call", () => {
    expect(linkRows(summary, "src/components/SquadBar.vue")).toContain("pick -props.onPick-> src/views/ClubPage.vue#pickPlayer");
  });

  it("types a v-for variable from the collection's stated element type", () => {
    expect(linkRows(summary, "src/views/ClubPage.vue")).toContain("<setup> -club.archive-> src/models/club.ts#Club.archive");
    expect(linkRows(summary, "src/views/DecoyPage.vue")).toContain("<setup> -car.archive-> src/models/club.ts#Car.archive");
    expect(linkRows(summary, "src/views/DecoyPage.vue")).not.toContain("<setup> -car.archive-> src/models/club.ts#Club.archive");
  });

  it("joins a scoped slot's parameter to the function its component offers, never the other component's", () => {
    expect(linkRows(summary, "src/views/ClubPage.vue")).toContain("<setup> -save-> src/components/ClubShell.vue#saveAll");
    const decoy = linkRows(summary, "src/views/DecoyPage.vue").filter((r) => r.includes("-save->"));
    expect(decoy).toEqual(["<setup> -save-> src/components/CarShell.vue#saveAll"]);
  });
});

describe("Angular getters returning a child", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-getter-child-"));
    summary = await run(dir, ANGULAR);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a getter by its stated return type or the typed field it returns, and leaves an untyped one alone", () => {
    const rows = linkRows(summary, "src/app/club-page.component.ts");
    expect(rows).toContain("ClubPageComponent.submit -this.form.save-> src/app/club-form.component.ts#ClubFormComponent.save");
    expect(rows).toContain("ClubPageComponent.submitTyped -this.typedForm.save-> src/app/club-form.component.ts#ClubFormComponent.save");
    expect(rows.filter((r) => r.startsWith("ClubPageComponent.submitUntyped"))).toEqual([]);
    expect(rows.some((r) => r.includes("car-form"))).toBe(false);
  });
});
