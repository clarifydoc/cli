import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Vue Options API watchers (`watch: { page() {…} }`, a dotted key, `{ handler, immediate }`, `deep`) joined to the
 * methods writing `this.page`, and watchers that run at setup (`immediate: true`, `watchEffect`) joined to the
 * component's setup even when nothing writes the cell. Decoys: the same names in another component, a push into a
 * list watched without `deep`, a watcher on another cell. Labels written by hand from the sources below.
 */
const PLAYER_LIST = `<template>
  <div>
    <button @click="nextPage()">Next</button>
    <button @click="pickLeague(3)">League</button>
    <button @click="setSize(10)">Size</button>
    <button @click="addClub(2)">Club</button>
    <button @click="addBench(2)">Bench</button>
  </div>
</template>
<script>
import axios from "axios";
export default {
  data() {
    return { page: 1, size: 5, filters: { league: 0 }, clubs: [], bench: [] };
  },
  watch: {
    page() {
      axios.get("/api/players");
    },
    "filters.league"(n) {
      axios.get("/api/fixtures");
    },
    size: {
      handler() {
        axios.get("/api/standings");
      },
      immediate: true,
    },
    clubs: {
      handler() {
        axios.get("/api/clubs");
      },
      deep: true,
    },
    bench() {
      axios.get("/api/bench");
    },
  },
  methods: {
    nextPage() {
      this.page = this.page + 1;
    },
    pickLeague(id) {
      this.filters.league = id;
    },
    setSize(n) {
      this.size = n;
    },
    addClub(c) {
      this.clubs.push(c);
    },
    addBench(c) {
      this.bench.push(c);
    },
  },
};
</script>
`;

const CLUB_LIST = `<template><button @click="nextPage()">Next</button></template>
<script>
import axios from "axios";
export default {
  data() {
    return { page: 1 };
  },
  watch: {
    other() {
      axios.get("/api/transfers");
    },
  },
  methods: {
    nextPage() {
      this.page = this.page + 1;
    },
  },
};
</script>
`;

const INBOX = `<template><div>inbox</div></template>
<script setup lang="ts">
import { watch, watchEffect } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";
const route = useRoute();
function markRead(club) {
  axios.put(\`/api/v2/clubs/\${club}/read\`);
}
function markAll() {
  axios.get("/api/players");
}
watch(() => route.params.club, markRead, { immediate: true });
watchEffect(markAll);
</script>
`;

const QUIET = `<template><div>quiet</div></template>
<script setup lang="ts">
import { watch, ref } from "vue";
import axios from "axios";
const club = ref(0);
function markRead(c) {
  axios.put(\`/api/v2/clubs/\${c}/read\`);
}
watch(club, markRead);
</script>
`;

const STANDINGS = `<template><button @click="reload([])">Reload</button></template>
<script>
import axios from "axios";
export default {
  data() {
    return { rows: [], size: 10 };
  },
  computed: {
    total() {
      return this.rows.length;
    },
    pages() {
      return Math.ceil(this.total / this.size) + this.countDecoy();
    },
  },
  watch: {
    total() {
      axios.get("/api/standings");
    },
    pages() {
      axios.get("/api/pages");
    },
    rows: [
      {
        handler() {
          axios.get("/api/clubs");
        },
        immediate: true,
      },
    ],
  },
  methods: {
    reload(r) {
      this.rows = r;
    },
    resize(n) {
      this.size = n;
    },
    countDecoy() {
      return 0;
    },
    build() {
      return {
        reset() {
          this.rows = [];
        },
      };
    },
  },
};
</script>
`;

const FILES: Record<string, string> = {
  "web/src/Standings.vue": STANDINGS,
  "api/server.js": `const express = require("express");
const app = express();
app.get("/api/players", (req, res) => res.json([]));
app.get("/api/fixtures", (req, res) => res.json([]));
app.get("/api/standings", (req, res) => res.json([]));
app.get("/api/clubs", (req, res) => res.json([]));
app.get("/api/bench", (req, res) => res.json([]));
app.get("/api/transfers", (req, res) => res.json([]));
app.put("/api/v2/clubs/:club/read", (req, res) => res.json({}));
`,
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0" } }),
  "web/src/PlayerList.vue": PLAYER_LIST,
  "web/src/ClubList.vue": CLUB_LIST,
  "web/src/Inbox.vue": INBOX,
  "web/src/Quiet.vue": QUIET,
};

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("Vue Options API watchers and watchers run at setup", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const triggers = () => (summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:reactive-trigger").map((l) => `${l.sourceFile}::${l.sourceSymbol} --${l.callName}--> ${l.targetSymbol}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-reactive-options-"));
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

  it("joins a method writing this.x to the watcher on x, written as a method, a dotted key or a handler", () => {
    const f = "web/src/PlayerList.vue";
    expect(triggers()).toEqual(expect.arrayContaining([
      `${f}::nextPage --page--> page`,
      `${f}::pickLeague --filters--> <watch@${lineOf(PLAYER_LIST, '"filters.league"(n)')}>`,
      `${f}::setSize --size--> <watch@${lineOf(PLAYER_LIST, "axios.get(\"/api/standings\")") - 1}>`,
      `${f}::addClub --clubs--> <watch@${lineOf(PLAYER_LIST, "axios.get(\"/api/clubs\")") - 1}>`,
    ]));
  });

  it("leaves a push into a list watched without deep, a watcher on another cell and another component alone", () => {
    const all = triggers().join("\n");
    expect(all).not.toContain("::addBench");
    expect(all).not.toContain("ClubList.vue");
  });

  it("reads an array of watcher objects, names a watcher of a computed apart from it, and keeps a nested method's this out", () => {
    const f = "web/src/Standings.vue";
    const handler = `<watch@${lineOf(STANDINGS, "handler() {")}>`;
    expect(triggers()).toContain(`${f}::reload --rows--> ${handler}`);
    expect(triggers()).toContain(`${f}::<setup> --immediate--> ${handler}`);
    // `reset` is a method of an object `build` returns: its `this` is that object's.
    expect(triggers().join("\\n")).not.toContain("::reset");
    // Nothing writes `total` (a computed), and no watcher shares its function name.
    expect(triggers().join("\\n")).not.toContain("--> total");
  });

  it("runs a watcher on a computed when a member it reads is written, through the computeds it reads in turn", () => {
    const f = "web/src/Standings.vue";
    const onTotal = `<watch@${lineOf(STANDINGS, 'axios.get("/api/standings")') - 1}>`;
    const onPages = `<watch@${lineOf(STANDINGS, 'axios.get("/api/pages")') - 1}>`;
    // `total` measures `this.rows`; `pages` reads `total` and `size`.
    expect(triggers()).toContain(`${f}::reload --rows--> ${onTotal}`);
    expect(triggers()).toContain(`${f}::reload --rows--> ${onPages}`);
    expect(triggers()).toContain(`${f}::resize --size--> ${onPages}`);
    // `resize` writes nothing `total` reads, and a method a computed calls is no read.
    expect(triggers()).not.toContain(`${f}::resize --size--> ${onTotal}`);
    expect(triggers().join("\n")).not.toContain("::countDecoy");
  });

  it("runs an immediate watcher from the component's setup, written to or not", () => {
    const f = "web/src/PlayerList.vue";
    expect(triggers()).toContain(`${f}::<setup> --immediate--> <watch@${lineOf(PLAYER_LIST, "axios.get(\"/api/standings\")") - 1}>`);
    expect(triggers()).toContain("web/src/Inbox.vue::<setup> --immediate--> markRead");
    expect(triggers()).toContain("web/src/Inbox.vue::<setup> --immediate--> markAll");
    // The same watcher without `immediate`: nothing runs it at setup.
    expect(triggers().filter((t) => t.startsWith("web/src/Quiet.vue"))).toEqual([]);
  });
});
