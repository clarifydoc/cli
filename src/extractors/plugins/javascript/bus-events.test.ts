import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * An app-wide event bus (a `mitt()` instance a module exports): a component emits an
 * event by a constant, another listens to the same constant on the same bus with a
 * method of its own — directly or through a project composable wrapping `emitter.on`.
 * A click on the emitting side runs the listener (real-repo FP: the clicks emitting
 * on the bus reached no route). Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0", mitt: "^3.0.0" } }),
  "src/helpers/bus.js": `import mitt from 'mitt';
const emitter = mitt();
export { emitter };
`,
  "src/helpers/otherBus.js": `import mitt from 'mitt';
export const emitter = mitt();
`,
  "src/constants/events.js": `export const LEAGUE_EVENTS = {
  CLUB_SAVED: 'clubSaved',
  SHOW_TOAST: 'newToast',
};
export const CMD_RELOAD_SQUAD = 'CMD_RELOAD_SQUAD';
`,
  "src/composables/useBusListener.js": `import { onMounted, onBeforeUnmount } from 'vue';
import { emitter } from '../helpers/bus';

export const useBusListener = (eventName, callback) => {
  onMounted(() => {
    emitter.on(eventName, callback);
  });
  onBeforeUnmount(() => {
    emitter.off(eventName, callback);
  });
};
`,
  "src/components/ClubCard.vue": `<script setup>
import { emitter } from '../helpers/bus';
import { LEAGUE_EVENTS, CMD_RELOAD_SQUAD } from '../constants/events';

function saveClub() {
  emitter.emit(LEAGUE_EVENTS.CLUB_SAVED, { id: 1 });
}
function reloadSquad() {
  emitter.emit(CMD_RELOAD_SQUAD);
}
function ping() {
  emitter.emit('pingLeague');
}
</script>

<template>
  <div>
    <button @click="saveClub">Save</button>
    <button @click="reloadSquad">Reload</button>
    <button @click="ping">Ping</button>
  </div>
</template>
`,
  "src/views/ClubList.vue": `<script>
import axios from 'axios';
import { emitter } from '../helpers/bus';
import { LEAGUE_EVENTS } from '../constants/events';

export default {
  mounted() {
    emitter.on(LEAGUE_EVENTS.CLUB_SAVED, this.refreshClubs);
  },
  methods: {
    async refreshClubs() {
      await axios.get('/api/v2/clubs');
    },
  },
};
</script>

<template>
  <div />
</template>
`,
  "src/views/SquadView.vue": `<script setup>
import axios from 'axios';
import { useBusListener } from '../composables/useBusListener';
import { CMD_RELOAD_SQUAD } from '../constants/events';

async function loadSquad() {
  await axios.get('/api/v2/squads/1');
}
useBusListener(CMD_RELOAD_SQUAD, loadSquad);
</script>

<template>
  <div />
</template>
`,
  "src/views/LeaguePing.vue": `<script setup>
import axios from 'axios';
import { emitter } from '../helpers/bus';

emitter.on('pingLeague', () => {
  axios.get('/api/v2/ping');
});
</script>

<template>
  <div />
</template>
`,
  "src/entrypoints/league.js": `import { createApp } from 'vue';
import ClubCard from '../components/ClubCard.vue';
import ClubList from '../views/ClubList.vue';
import SquadView from '../views/SquadView.vue';
import LeaguePing from '../views/LeaguePing.vue';
import TransferBoard from '../views/TransferBoard.vue';

createApp({ components: { ClubCard, ClubList, SquadView, LeaguePing, TransferBoard } }).mount('#league');
`,
  "src/entrypoints/ticker.js": `import { createApp } from 'vue';
import ScoreTicker from '../ticker/ScoreTicker.vue';

createApp(ScoreTicker).mount('#ticker');
`,
  "src/ticker/ScoreTicker.vue": `<script>
import axios from 'axios';
import { emitter } from '../helpers/bus';
import { LEAGUE_EVENTS } from '../constants/events';

export default {
  mounted() {
    emitter.on(LEAGUE_EVENTS.CLUB_SAVED, this.refreshScores);
  },
  methods: {
    async refreshScores() {
      await axios.get('/api/v2/scores');
    },
  },
};
</script>

<template>
  <div />
</template>
`,
  "src/views/TransferBoard.vue": `<script>
import axios from 'axios';
import { emitter } from '../helpers/otherBus';
import { LEAGUE_EVENTS } from '../constants/events';

export default {
  mounted() {
    emitter.on(LEAGUE_EVENTS.CLUB_SAVED, this.loadTransfers);
  },
  methods: {
    async loadTransfers() {
      await axios.get('/api/v2/transfers');
    },
  },
};
</script>

<template>
  <div />
</template>
`,
};

describe("an app-wide event bus", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-bus-events-"));
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

  const busLinks = () =>
    summary.symbolLinks
      .filter((l) => l.sourceFile === "src/components/ClubCard.vue" && l.strategy === "dispatch:event-bus")
      .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("joins an emit to the method listening to the same constant on the same bus, directly or through a wrapper", () => {
    expect(busLinks()).toEqual([
      "reloadSquad -emitter.emit-> src/views/SquadView.vue::loadSquad",
      "saveClub -emitter.emit-> src/views/ClubList.vue::refreshClubs",
    ]);
  });

  it("never joins a listener on another bus, or an inline listener that names no function", () => {
    expect(busLinks().some((l) => l.includes("TransferBoard") || l.includes("LeaguePing"))).toBe(false);
  });

  it("never joins a listener of another app built from its own entry, though both import the bus module", () => {
    expect(busLinks().some((l) => l.includes("ScoreTicker"))).toBe(false);
  });
});
