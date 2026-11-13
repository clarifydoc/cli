import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A statement the template runs writes a cell like a function body does: `@click="page = 2"`,
 * `@click="filters.league = 3"`, `@click="showAll = !showAll"`, `v-model="query"` in a `<script setup>` component
 * (a ref is read without `.value` there) and `@click="page = 3"`, `v-model="term"` in an Options API one (`this.page`),
 * and the watcher on that cell runs. An Options API component with an `immediate` watcher and no setup of its own
 * gets the run from its component pseudo-function. Decoys: a write to a cell nothing watches, a `v-for` variable
 * of the same name, an arrow parameter of the same name, a comparison, and the same names in another component.
 * Labels written by hand from the sources below.
 */
const CLUB_LIST = `<template>
  <div>
    <button @click="page = 2">Page</button>
    <button @click="filters.league = 3">League</button>
    <button @click="showAll = !showAll">All</button>
    <input v-model="query" />
    <button @click="bench = 5">Bench</button>
    <button v-for="page in pages" :key="page" @click="page = 9">Shadowed</button>
    <button @click="rows.forEach((page) => page = 1)">Arrow</button>
    <button @click="check = page === 2">Compare</button>
    <button @click="season = 2025; rows.map((season) => season.id)">Before the arrow</button>
    <button @click="bench = 7; track('/api/ghost')">Call beside</button>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from "vue";
import axios from "axios";

const page = ref(1);
const pages = ref([1, 2]);
const rows = ref([]);
const filters = reactive({ league: 0 });
const showAll = ref(false);
const query = ref("");
const bench = ref(0);
const check = ref(false);
const season = ref(2024);

watch(page, async () => {
  await axios.get("/api/clubs", { params: { page: page.value } });
});
watch(() => filters.league, async () => {
  await axios.get("/api/leagues");
});
watch(showAll, async () => {
  await axios.get("/api/matches");
});
watch(query, async () => {
  await axios.get("/api/players");
});
watch(season, async () => {
  await axios.get("/api/matches");
});
</script>
`;

/** The same names in a component whose template writes nothing. */
const PLAYER_LIST = `<template>
  <div>
    <button @click="load()">Load</button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import axios from "axios";

const page = ref(1);
const query = ref("");

function load() {
  axios.get("/api/stadiums");
}

watch(page, async () => {
  await axios.get("/api/stadiums");
});
watch(query, async () => {
  await axios.get("/api/stadiums");
});
</script>
`;

const GARAGE = `<template>
  <div>
    <button @click="page = 3">Page</button>
    <input v-model="term" />
    <button @click="other = 1">Other</button>
  </div>
</template>

<script>
import axios from "axios";

export default {
  data() {
    return { page: 1, term: "", seen: 0, other: 0 };
  },
  watch: {
    page() {
      axios.get("/api/cars");
    },
    term: {
      handler() {
        axios.get("/api/drivers");
      },
    },
    seen: {
      handler() {
        axios.get("/api/garages");
      },
      immediate: true,
    },
  },
};
</script>
`;

/** The same names, no template write. */
const WORKSHOP = `<template>
  <div>
    <button @click="refresh()">Refresh</button>
  </div>
</template>

<script>
import axios from "axios";

export default {
  data() {
    return { page: 1, term: "" };
  },
  methods: {
    refresh() {
      axios.get("/api/cars");
    },
  },
  watch: {
    page() {
      axios.get("/api/cars");
    },
    term() {
      axios.get("/api/drivers");
    },
  },
};
</script>
`;

const API = `const express = require("express");
const app = express();
for (const name of ["clubs", "leagues", "matches", "players", "stadiums", "cars", "drivers", "garages"]) {
  app.get("/api/" + name, (_req, res) => res.json([]));
}
module.exports = app;
`;

const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "web", dependencies: { vue: "3.4.0" } }),
  "web/src/ClubList.vue": CLUB_LIST,
  "web/src/PlayerList.vue": PLAYER_LIST,
  "web/src/Garage.vue": GARAGE,
  "web/src/Workshop.vue": WORKSHOP,
  "api/server.js": API,
};

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("template writes join the watchers on the cell they change", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const triggers = () => (summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:reactive-trigger").map((l) => `${l.sourceFile}::${l.sourceSymbol}@${l.sourceLine} --${l.callName}--> ${l.targetSymbol}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-template-writes-"));
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

  it("joins an inline assignment, a member write, a toggle and a v-model of a <script setup> component", () => {
    const f = "web/src/ClubList.vue";
    const at = (needle: string) => lineOf(CLUB_LIST, needle);
    expect(triggers()).toEqual(expect.arrayContaining([
      `${f}::<setup>@${at('@click="page = 2"')} --page--> <watch@${at("watch(page,")}>`,
      `${f}::<setup>@${at('@click="filters.league = 3"')} --filters--> <watch@${at("watch(() => filters.league")}>`,
      `${f}::<setup>@${at('@click="showAll = !showAll"')} --showAll--> <watch@${at("watch(showAll,")}>`,
      `${f}::<setup>@${at('v-model="query"')} --query--> <watch@${at("watch(query,")}>`,
    ]));
  });

  it("leaves a cell nothing watches, a loop variable, an arrow parameter and a comparison alone", () => {
    const f = "web/src/ClubList.vue";
    const from = triggers().filter((t) => t.startsWith(`${f}::`));
    // page (assignment) only: the shadowed `page = 9` and the arrow's `page = 1` are another name; `check = page === 2` writes `check`.
    expect(from.filter((t) => t.includes("--page-->"))).toHaveLength(1);
    // an arrow's own parameter shadows only from its `=>` on: the write before it still counts
    expect(from.filter((t) => t.includes("--season-->"))).toHaveLength(1);
    expect(from).toHaveLength(5);
  });

  it("keeps the handler's own calls and strings out of the parsed text", () => {
    expect((summary.apiCalls ?? []).some((c) => JSON.stringify(c).includes("ghost"))).toBe(false);
  });

  it("does not join a same-named cell of a component whose template writes nothing", () => {
    expect(triggers().filter((t) => t.startsWith("web/src/PlayerList.vue::"))).toEqual([]);
  });

  it("joins an Options API template write and v-model to the watcher on that data member", () => {
    const f = "web/src/Garage.vue";
    const at = (needle: string) => lineOf(GARAGE, needle);
    const got = triggers().filter((t) => t.startsWith(`${f}::<setup>`));
    expect(got).toEqual(expect.arrayContaining([
      `${f}::<setup>@${at('@click="page = 3"')} --page--> page`,
      `${f}::<setup>@${at('v-model="term"')} --term--> <watch@${at("handler() {")}>`,
    ]));
    // `other` is written but nothing watches it
    expect(got.some((t) => t.includes("--other-->"))).toBe(false);
  });

  it("runs an immediate Options API watcher from the component pseudo-function when there is no setup", () => {
    const f = "web/src/Garage.vue";
    const handlers = GARAGE.split("\n").flatMap((l, i) => (l.includes("handler() {") ? [i + 1] : []));
    expect(triggers()).toContain(`${f}::<setup>@${lineOf(GARAGE, "seen: {")} --immediate--> <watch@${handlers[1]}>`);
    // the other two watchers are not run at setup
    expect(triggers().filter((t) => t.startsWith(`${f}::<setup>`) && t.includes("--immediate-->"))).toHaveLength(1);
  });

  it("does not join an Options API component whose template writes nothing", () => {
    expect(triggers().filter((t) => t.startsWith("web/src/Workshop.vue::"))).toEqual([]);
  });
});
