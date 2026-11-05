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
