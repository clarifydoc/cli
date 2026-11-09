import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Function values that flow through members, options and arrays, with a callback written in place as a
 * function of its own (`heldFunction`): a handler a factory builds (`this.changeName = fieldUpdater('name')`),
 * a member assigned at run time (`dialog.callback = callbacks[mode]`, `toast.action = () => …`), a dialog a field
 * holds (`open(this.editClubDialog)`), an options prop's member (`:options="{ onClick: () => … }"`), and the
 * objects of an array a loop runs (written in the template, declared in the script, imported). Each has a
 * namesake decoy that must not link. Labels written by hand from the sources below.
 */
const WEB: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0", react: "^18.0.0", "@angular/core": "^17.0.0", "@ng-bootstrap/ng-bootstrap": "^16.0.0" } }),
  "src/api.ts": `import axios from 'axios';
export const agent = {
  Clubs: {
    update: (field: string, value: string) => axios.patch(\`/api/v2/clubs/\${field}\`, { value }),
    save: (club: unknown) => axios.post('/api/v2/clubs', club),
  },
};
export function trackField(field: string) {
  return (ev: any) => axios.patch(\`/api/v2/players/\${field}\`, { v: ev.target.value });
}
export async function relegateClub() { await axios.post('/api/v2/clubs/relegate'); }
export async function promoteClub() { await axios.post('/api/v2/clubs/promote'); }
export const clubActions = [
  { label: 'Relegate', action: () => relegateClub() },
  { label: 'Promote', action: promoteClub },
];
export function createStore(name: string) { return { dispatch: (a: string) => axios.post(\`/api/v2/\${name}/\${a}\`) }; }
`,
  "src/react/ClubEditor.jsx": `import React from 'react';
import { agent, trackField, createStore } from '../api';

class ClubEditor extends React.Component {
  constructor() {
    super();
    const fieldUpdater = key => ev => agent.Clubs.update(key, ev.target.value);
    this.changeName = fieldUpdater('name');
    this.changeCity = trackField('city');
    this.saveClub = ev => { agent.Clubs.save(this.props.club); };
    this.store = createStore('club');
  }
  componentDidMount() { this.store.dispatch('load'); }
  changeCountry = trackField('country');
  league = createStore('league');
  render() {
    return (
      <form>
        <input onChange={this.changeName} />
        <input onChange={this.changeCity} />
        <input onChange={this.changeCountry} />
        <button onClick={this.saveClub}>Save</button>
        <Roster store={this.store} />
        <Table league={this.league} />
      </form>
    );
  }
}
export default ClubEditor;
`,
  "src/components/BaseDialog.vue": `<script setup>
const emit = defineEmits(['submit']);
function confirm() { emit('submit'); }
</script>
<template><button @click="confirm">OK</button></template>
`,
  "src/views/ClubBulk.vue": `<script setup>
import { reactive } from 'vue';
import axios from 'axios';
import BaseDialog from '../components/BaseDialog.vue';
const dialog = reactive({ state: false, callback: () => {} });
const toast = reactive({ action: null });
async function deleteClubs() { await axios.delete('/api/v2/clubs'); }
async function exportClubs() { await axios.post('/api/v2/clubs/export'); }
async function reloadLeague() { await axios.get('/api/v2/league'); }
async function unrelated() { await axios.get('/api/v2/unrelated'); }
function openDialog(mode) {
  const callbacks = { delete: deleteClubs, export: exportClubs };
  dialog.callback = callbacks[mode];
  dialog.state = true;
}
function other(dialog) {
  dialog.callback = unrelated;
}
function warn() {
  toast.action = () => reloadLeague();
  unrelated();
}
</script>
<template>
  <BaseDialog @submit="dialog.callback" />
  <button @click="openDialog('delete')">Delete</button>
  <button @click="toast.action()">Reload</button>
</template>
`,
  "src/components/ClubCard.vue": `<script setup>
const props = defineProps({ options: { type: Object, default: () => ({}) } });
function press() { props.options.onClick(); }
</script>
<template><button @click="press">Go</button></template>
`,
  "src/views/ClubOptions.vue": `<script setup>
import axios from 'axios';
import ClubCard from '../components/ClubCard.vue';
async function saveClub() { await axios.put('/api/v2/clubs/1'); }
async function decoySave() { await axios.put('/api/v2/cars/1'); }
</script>
<template>
  <ClubCard :options="{ onClick: () => saveClub(), label: 'x' }" />
</template>
`,
  "src/views/ClubMenu.vue": `<script setup>
import axios from 'axios';
import { clubActions } from '../api';
const props = defineProps({ extra: { type: Array, default: () => [] } });
async function transferPlayer() { await axios.post('/api/v2/players/transfer'); }
async function sellPlayer() { await axios.post('/api/v2/players/sell'); }
</script>
<template>
  <button v-for="item in [{ label: 'Transfer', run: () => transferPlayer() }, { label: 'Sell', run: () => sellPlayer() }]" @click="item.run()">{{ item.label }}</button>
  <button v-for="a in clubActions" @click="a.action()">{{ a.label }}</button>
  <button v-for="x in props.extra" @click="x.run()">{{ x.label }}</button>
</template>
`,
  "src/views/ClubMenuHost.vue": `<script setup>
import axios from 'axios';
import ClubMenu from './ClubMenu.vue';
async function benchPlayer() { await axios.post('/api/v2/players/bench'); }
</script>
<template><ClubMenu :extra="[{ label: 'Bench', run: () => benchPlayer() }]" /></template>
`,
  "src/views/SquadMenu.vue": `<script setup>
import { computed } from 'vue';
import axios from 'axios';
async function loanPlayer() { await axios.post('/api/v2/players/loan'); }
async function retirePlayer() { await axios.post('/api/v2/players/retire'); }
async function scoutPlayer() { await axios.get('/api/v2/players/scout'); }
const items = computed(() => [
  { label: 'Loan', run: () => loanPlayer() },
  { label: 'Retire', run: retirePlayer },
]);
</script>
<template>
  <button v-for="item in items" @click="item.run()">{{ item.label }}</button>
</template>
`,
  "src/app/club-edit-dialog.component.ts": `import { Component, EventEmitter, Output } from '@angular/core';
@Component({ selector: 'app-club-edit-dialog', template: '<button (click)="save()">Save</button>' })
export class ClubEditDialogComponent {
  @Output() saved = new EventEmitter();
  save() { this.saved.emit(); }
}
`,
  "src/app/car-edit-dialog.component.ts": `import { Component, EventEmitter, Output } from '@angular/core';
@Component({ selector: 'app-car-edit-dialog', template: '<button (click)="save()">Save</button>' })
export class CarEditDialogComponent {
  @Output() saved = new EventEmitter();
  save() { this.saved.emit(); }
}
`,
  "src/app/squad-list.component.ts": `import { Component } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient } from '@angular/common/http';
@Component({ selector: 'app-squad-list', template: '<button (click)="openCreateDialog()">New</button>' })
export abstract class SquadListComponent {
  protected editClubDialog: any;
  constructor(private modalService: NgbModal, private http: HttpClient) {}
  reloadSquad() { return this.http.get('/api/v2/squads'); }
  trackVisit() { return this.http.post('/api/v2/visits', {}); }
  openCreateDialog() {
    const activeModal = this.modalService.open(this.editClubDialog, { backdrop: 'static' });
    activeModal.componentInstance.saved.subscribe(() => {
      this.reloadSquad();
    });
    this.trackVisit();
  }
}
`,
  "src/app/club-list.component.ts": `import { Component } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient } from '@angular/common/http';
import { SquadListComponent } from './squad-list.component';
import { ClubEditDialogComponent } from './club-edit-dialog.component';
@Component({ selector: 'app-club-list', template: '<div></div>' })
export class ClubListComponent extends SquadListComponent {
  constructor(modalService: NgbModal, http: HttpClient) {
    super(modalService, http);
    this.editClubDialog = ClubEditDialogComponent;
  }
}
`,
  "src/app/squad.component.ts": `import { Component } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { HttpClient } from '@angular/common/http';
import { ClubEditDialogComponent } from './club-edit-dialog.component';
@Component({ selector: 'app-squad', template: '<button (click)="edit()">Edit</button>' })
export class SquadComponent {
  constructor(private modalService: NgbModal, private http: HttpClient) {}
  edit() {
    const ref = this.modalService.open(ClubEditDialogComponent);
    ref.componentInstance.saved.subscribe(() => this.http.get('/api/v2/squad'));
    this.http.post('/api/v2/squad/opened', {});
  }
}
`,
};

const linkRows = (s: ProjectAnalysis, sourceFile: string) =>
  s.symbolLinks
    .filter((l) => l.sourceFile === sourceFile && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`)
    .sort();

describe("function values flowing through members, options and arrays", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-function-values-"));
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

  it("reads a handler a factory builds as a method whose calls are the factory's, never a field holding a store", () => {
    const rows = linkRows(summary, "src/react/ClubEditor.jsx");
    expect(rows).toEqual(expect.arrayContaining([
      "ClubEditor.changeName -agent.Clubs.update-> src/api.ts#agent.Clubs.update",
      "ClubEditor.changeCity -trackField-> src/api.ts#trackField",
      "ClubEditor.changeCountry -trackField-> src/api.ts#trackField",
      "ClubEditor.render -this.changeName-> src/react/ClubEditor.jsx#ClubEditor.changeName",
    ]));
    expect(rows.some((r) => r.startsWith("ClubEditor.store ") || r.startsWith("ClubEditor.league "))).toBe(false);
  });

  it("joins a call of a module object's member to what the file assigns it at run time, a held callback included", () => {
    const rows = linkRows(summary, "src/views/ClubBulk.vue");
    expect(rows).toEqual(expect.arrayContaining([
      "<BaseDialog@submit@25> -dialog.callback-> src/views/ClubBulk.vue#deleteClubs",
      "<BaseDialog@submit@25> -dialog.callback-> src/views/ClubBulk.vue#exportClubs",
      "<setup> -toast.action-> src/views/ClubBulk.vue#<toast.action@20>",
      "<toast.action@20> -reloadLeague-> src/views/ClubBulk.vue#reloadLeague",
      "warn -<toast.action@20>-> src/views/ClubBulk.vue#<toast.action@20>",
    ]));
    // The callback is not its writer's call, and a parameter named like the module object is another object.
    expect(rows).not.toContain("warn -reloadLeague-> src/views/ClubBulk.vue#reloadLeague");
    expect(rows.filter((r) => r.includes("-dialog.callback->") && r.endsWith("#unrelated"))).toEqual([]);
  });

  it("lands a dialog output on the callback subscribed to it, and a dialog a field holds on the class a subclass assigns it", () => {
    expect(linkRows(summary, "src/app/club-edit-dialog.component.ts")).toEqual([
      "ClubEditDialogComponent.save -emit:saved-> src/app/squad-list.component.ts#<editClubDialog@saved@12>",
      "ClubEditDialogComponent.save -emit:saved-> src/app/squad.component.ts#<ClubEditDialogComponent@saved@10>",
    ]);
    expect(linkRows(summary, "src/app/car-edit-dialog.component.ts")).toEqual([]);
    expect(linkRows(summary, "src/app/squad-list.component.ts")).toContain(
      "<editClubDialog@saved@12> -this.reloadSquad-> src/app/squad-list.component.ts#SquadListComponent.reloadSquad",
    );
  });

  it("joins an options prop's member call to the arrow the parent's markup writes for it", () => {
    expect(linkRows(summary, "src/components/ClubCard.vue")).toContain("press -props.options.onClick-> src/views/ClubOptions.vue#<ClubCard:options.onClick@8>");
  });

  it("joins a loop item's callback to the functions of the array it loops over: in the template, declared, imported", () => {
    expect(linkRows(summary, "src/views/ClubMenu.vue")).toEqual(expect.arrayContaining([
      "<setup> -item.run-> src/views/ClubMenu.vue#transferPlayer",
      "<setup> -item.run-> src/views/ClubMenu.vue#sellPlayer",
      "<setup> -clubActions[].action-> src/api.ts#<clubActions[].action@14>",
      "<setup> -clubActions[].action-> src/api.ts#promoteClub",
    ]));
    expect(linkRows(summary, "src/views/SquadMenu.vue")).toEqual(expect.arrayContaining([
      "<setup> -item.run-> src/views/SquadMenu.vue#<items[].run@8>",
      "<setup> -item.run-> src/views/SquadMenu.vue#retirePlayer",
      "<items[].run@8> -loanPlayer-> src/views/SquadMenu.vue#loanPlayer",
    ]));
    expect(linkRows(summary, "src/views/SquadMenu.vue").some((r) => r.endsWith("#scoutPlayer"))).toBe(false);
    expect(linkRows(summary, "src/api.ts")).toContain("<clubActions[].action@14> -relegateClub-> src/api.ts#relegateClub");
  });
});
