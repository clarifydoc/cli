import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A Vue parent hands its children functions by name as props — `:on-confirm="confirmDeletion"`,
 * `:update-selected="setSelected"`, a listener `@refresh="reload"` the child declares as its
 * `onRefresh` prop — and the child calls the prop (`props.onConfirm()`, `this.onSubmit(…)`).
 * A click in the child runs the parent's function (real-repo FP: the confirm button of a shared
 * delete dialog reached no route). Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "src/components/ClubDeleteModal.vue": `<script setup>
defineProps({
  onClose: { type: Function, default: () => {} },
  onConfirm: { type: Function, default: () => {} },
  title: { type: String, default: '' },
});
</script>

<template>
  <div class="modal">
    <button @click="onClose">Cancel</button>
    <button @click="onConfirm">Delete</button>
  </div>
</template>
`,
  "src/components/PlayerForm.vue": `<script>
export default {
  props: {
    onSubmit: { type: Function, required: true },
    formatName: { type: Function, default: null },
  },
  data() {
    return { name: '' };
  },
  methods: {
    handleSubmit() {
      this.onSubmit({ name: this.name });
    },
  },
};
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <input v-model="name" />
  </form>
</template>
`,
  "src/components/SquadPicker.vue": `<script setup>
const props = defineProps({
  updateSelected: { type: Function, default: () => {} },
});
function toggleAll() {
  props.updateSelected([]);
}
</script>

<template>
  <input type="checkbox" @change="toggleAll" />
</template>
`,
  "src/components/ScoreBoard.vue": `<script setup>
const props = defineProps({ onRefresh: { type: Function, default: null } });
async function refreshScores() {
  await props.onRefresh?.();
}
</script>

<template>
  <button @click="refreshScores">Refresh</button>
</template>
`,
  "src/views/ClubPage.vue": `<script>
import axios from 'axios';
import ClubDeleteModal from '../components/ClubDeleteModal.vue';
import PlayerForm from '../components/PlayerForm.vue';
import SquadPicker from '../components/SquadPicker.vue';
import ScoreBoard from '../components/ScoreBoard.vue';

export default {
  components: { ClubDeleteModal, PlayerForm, SquadPicker, ScoreBoard },
  data() {
    return { showDelete: false, selectedPlayers: [] };
  },
  methods: {
    async confirmDeletion() {
      await axios.delete('/api/v2/clubs/7');
    },
    closePopup() {
      this.showDelete = false;
    },
    async createPlayer(player) {
      await axios.post('/api/v2/players', player);
    },
    async setSelected(list) {
      await axios.put('/api/v2/squads/7', { players: list });
    },
    async reload() {
      await axios.get('/api/v2/scores');
    },
    formatName(name) {
      return name.trim();
    },
  },
};
</script>

<template>
  <div>
    <ClubDeleteModal :on-confirm="confirmDeletion" :on-close="closePopup" :title="'Delete club'" />
    <PlayerForm :on-submit="createPlayer" :format-name="formatName" />
    <SquadPicker :update-selected="setSelected" />
    <SquadPicker :update-selected="selectedPlayers" />
    <ScoreBoard @refresh="reload" />
  </div>
</template>
`,
};

describe("Vue functions handed to a child as props", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-callback-props-"));
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

  const linksFrom = (file: string) =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === file && l.targetFile === "src/views/ClubPage.vue")
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetSymbol}`)
      .sort();

  it("joins the child's markup call of a function prop (read into its setup) to the parent's function bound by name", () => {
    expect(linksFrom("src/components/ClubDeleteModal.vue")).toEqual([
      "<setup> -onClose-> closePopup",
      "<setup> -onConfirm-> confirmDeletion",
    ]);
  });

  it("joins an options-API child's this.prop() call, and only for the prop it calls", () => {
    expect(linksFrom("src/components/PlayerForm.vue")).toEqual(["handleSubmit -this.onSubmit-> createPlayer"]);
  });

  it("joins a props.x() call to a non-callback-named prop bound to a function, never to a data binding", () => {
    expect(linksFrom("src/components/SquadPicker.vue")).toEqual(["toggleAll -props.updateSelected-> setSelected"]);
  });

  it("joins a listener the child declares as its on-prop to the parent's handler", () => {
    expect(linksFrom("src/components/ScoreBoard.vue")).toEqual(["refreshScores -props.onRefresh-> reload"]);
  });
});

/**
 * A function handed down under a prop no event name marks, or taken from somewhere other than the parent's own
 * script: a React parent's `order={orderKit}` the child destructures and calls, a prop the middle component
 * destructures and binds on again (`onConfirm={handleRelease}`), a Vue Options API page binding its mixin's method
 * (`mixins: [stadiumActions]` + `:on-save="saveStadium"`), and an Angular dialog output subscribed with a bound method.
 * Each decoy calls a function of the same name that is no prop. Labels written by hand from the sources below.
 */
const MORE_FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "^18.2.0", axios: "^1.6.0" } }),
  "web/src/KitRow.tsx": `import React from 'react';

export function KitRow({ size, order }: { size: string; order: (s: string) => void }) {
  return <button onClick={() => order(size)}>Order kit</button>;
}
`,
  "web/src/ScarfRow.tsx": `import React from 'react';
import { order } from './shop';

export function ScarfRow({ size }: { size: string }) {
  return <button onClick={() => order(size)}>Order scarf</button>;
}
`,
  "web/src/shop.ts": `import axios from 'axios';

export async function order(size: string) {
  await axios.post('/api/v2/scarves', { size });
}
`,
  "web/src/ConfirmBox.tsx": `import React from 'react';

export function ConfirmBox({ onConfirm }: { onConfirm: () => void }) {
  return <button onClick={onConfirm}>Confirm</button>;
}
`,
  "web/src/ReleaseDialog.tsx": `import React from 'react';
import { ConfirmBox } from './ConfirmBox';

export const ReleaseDialog = ({ handleRelease }: { handleRelease: () => void }) => {
  return <ConfirmBox onConfirm={handleRelease} />;
};
`,
  "web/src/SquadPage.tsx": `import React from 'react';
import axios from 'axios';
import { KitRow } from './KitRow';
import { ScarfRow } from './ScarfRow';
import { ReleaseDialog } from './ReleaseDialog';

export function SquadPage() {
  const orderKit = async (size: string) => {
    await axios.post('/api/v2/kits', { size });
  };
  async function releasePlayer() {
    await axios.post('/api/v2/squads/release');
  }
  const kitLabel = 'Home kit';
  return (
    <div>
      <KitRow size="L" order={orderKit} />
      <KitRow size="XL" order={(s) => orderKit(s)} />
      <ScarfRow size="M" label={kitLabel} />
      <ReleaseDialog handleRelease={releasePlayer} />
    </div>
  );
}
`,
  "vue/package.json": JSON.stringify({ name: "league-vue", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "vue/src/mixins/stadiumActions.js": `import axios from 'axios';

export default {
  methods: {
    async saveStadium() {
      await axios.put('/api/v2/stadiums/1');
    },
    formatDate(d) {
      return String(d);
    },
  },
};
`,
  "vue/src/dates.js": `export function formatDate(d) {
  return new Date(d).toISOString();
}
`,
  "vue/src/components/StadiumForm.vue": `<script>
export default {
  props: { onSave: { type: Function, required: true }, title: String },
  methods: {
    submit() {
      this.onSave();
    },
  },
};
</script>

<template>
  <button @click="submit">Save stadium</button>
</template>
`,
  "vue/src/StadiumPage.vue": `<script>
import StadiumForm from './components/StadiumForm.vue';
import stadiumActions from './mixins/stadiumActions';
import { formatDate } from './dates';

export default {
  components: { StadiumForm },
  mixins: [stadiumActions],
  data() {
    return { pageTitle: 'Stadium' };
  },
  methods: {
    refresh() {
      this.saveStadium();
      return formatDate(Date.now());
    },
  },
};
</script>

<template>
  <StadiumForm :on-save="saveStadium" :title="pageTitle" />
  <button @click="saveStadium">Save now</button>
</template>
`,
  "ng/package.json": JSON.stringify({ name: "league-ng", dependencies: { "@angular/core": "^19.0.0", "@ng-bootstrap/ng-bootstrap": "^17.0.0", rxjs: "^7.8.0" } }),
  "ng/src/app/club-edit-dialog.component.ts": `import { Component, output } from '@angular/core';

@Component({ selector: 'app-club-edit-dialog', template: '<button (click)="save()">Save</button>' })
export class ClubEditDialogComponent {
  readonly saved = output<{
    clubId: number;
    name: string;
  }>();
  save() {
    this.saved.emit({ clubId: 1, name: 'Rovers' });
  }
}
`,
  "ng/src/app/club-page.component.ts": `import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { first } from 'rxjs';
import { ClubEditDialogComponent } from './club-edit-dialog.component';

@Component({ selector: 'app-club-page', template: '<app-club-edit-dialog (saved)="reloadClubs()"></app-club-edit-dialog><button (click)="edit()">Edit</button>' })
export class ClubPageComponent {
  constructor(private modalService: NgbModal, private http: HttpClient) {}

  edit() {
    const modal = this.modalService.open(ClubEditDialogComponent);
    modal.componentInstance.saved.pipe(first()).subscribe(this.refreshSquad.bind(this));
  }

  reloadClubs() {
    this.http.get('/api/v2/clubs').subscribe();
  }

  refreshSquad() {
    this.http.get('/api/v2/squads').subscribe();
  }
}
`,
};

describe("functions handed down under any prop name, from a mixin, or bound", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-function-props-"));
    for (const [path, text] of Object.entries(MORE_FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
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

  it("joins a React child's call of a destructured prop no `on` marks to the function the parent binds or an arrow passes on, at each binding", () => {
    expect(linksFrom("web/src/KitRow.tsx")).toEqual(["KitRow -order-> web/src/SquadPage.tsx:orderKit via web/src/SquadPage.tsx:17,web/src/SquadPage.tsx:18"]);
    // A function of the same name the child imports is that import, never a prop.
    expect(linksFrom("web/src/ScarfRow.tsx")).toEqual(["ScarfRow -order-> web/src/shop.ts:order"]);
  });

  it("follows a prop the middle component destructures and binds on again up to the page's function", () => {
    expect(linksFrom("web/src/ConfirmBox.tsx")).toEqual(["<template> -onConfirm-> web/src/SquadPage.tsx:releasePlayer via web/src/ReleaseDialog.tsx:5"]);
  });

  it("joins a Vue child's prop call to the parent's mixin method, and the parent's own calls of it — never an import's namesake", () => {
    expect(linksFrom("vue/src/components/StadiumForm.vue")).toEqual(["submit -this.onSave-> vue/src/mixins/stadiumActions.js:saveStadium via vue/src/StadiumPage.vue:22"]);
    expect(linksFrom("vue/src/StadiumPage.vue")).toEqual([
      "<setup> -saveStadium-> vue/src/mixins/stadiumActions.js:saveStadium",
      "refresh -formatDate-> vue/src/dates.js:formatDate",
      "refresh -this.saveStadium-> vue/src/mixins/stadiumActions.js:saveStadium",
    ]);
  });

  it("reads an Angular output whose type spans lines, and a dialog output subscribed with a bound method", () => {
    expect(linksFrom("ng/src/app/club-edit-dialog.component.ts")).toEqual([
      "ClubEditDialogComponent.save -emit:saved-> ng/src/app/club-page.component.ts:ClubPageComponent.edit via ng/src/app/club-page.component.ts:13",
      "ClubEditDialogComponent.save -emit:saved-> ng/src/app/club-page.component.ts:ClubPageComponent.reloadClubs via ng/src/app/club-page.component.ts:7",
    ]);
    const edit = summary.symbolLinks.filter((l) => l.sourceSymbol === "ClubPageComponent.edit" && l.targetSymbol === "ClubPageComponent.refreshSquad");
    expect(edit.map((l) => l.callName)).toEqual(["this.refreshSquad"]);
  });
});
