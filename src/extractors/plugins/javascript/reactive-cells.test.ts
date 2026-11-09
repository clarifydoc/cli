import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { sameCell } from "../../../core/reactive-triggers.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A click that only writes a reactive cell, and the watcher, effect or subscription on that cell that makes the
 * request: a Vue ref (or a `defineModel` one) and its `watch`/`watchDebounced`/`watchEffect`, `router.push({ query })` and a watcher on
 * `route.query`, a React state setter and the `useEffect` listing the state, an Angular signal's `.set` and the
 * `effect` reading it, an RxJS subject's `next` and the class's own subscription. Decoys: a watcher on a cell no
 * function writes, an effect with an empty dep list, a sibling member of the same object, and a subject of the
 * same name in another class. Labels written by hand from the sources below.
 */
const VIEW = `<template>
  <div>
    <button v-for="c in clubs" :key="c" @click="addClub(c)">Add</button>
    <input @input="setQuery($event.target.value)" />
    <button @click="changeSeason()">Season</button>
    <button @click="goPage(2)">Page</button>
    <button @click="setOrderBy('points')">Order</button>
    <button @click="pickLeague(1)">League</button>
    <button @click="benchClub(4)">Bench</button>
    <button @click="openPanel()">Open</button>
    <button @click="closePanel()">Close</button>
    <button @click="hideBadge()">Hide</button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, watchEffect } from "vue";
import { watchDebounced, whenever } from "@vueuse/core";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";

const clubs = ref<number[]>([1, 2, 3]);
const pickedClubs = ref<number[]>([]);
const query = ref("");
const season = ref(2024);
const unused = ref(0);
const sorting = ref({ orderBy: "name", orderDirection: "asc" });
const league = defineModel<number>("league");
const bench = ref<number[]>([]);
const panel = ref(false);
const badge = ref<HTMLElement | null>(null);
const route = useRoute();
const router = useRouter();

function addClub(c: number) {
  pickedClubs.value.push(c);
}

function setQuery(q: string) {
  query.value = q;
}

function changeSeason() {
  season.value = season.value + 1;
}

function goPage(p: number) {
  router.push({ query: { page: String(p) } });
}

function setOrderBy(field: string) {
  sorting.value.orderBy = field;
}

function pickLeague(id: number) {
  league.value = id;
}

function benchClub(c: number) {
  bench.value.push(c);
}

function openPanel() {
  panel.value = true;
}

function closePanel() {
  panel.value = false;
}

function hideBadge() {
  badge.value.style.display = "none";
}

watchDebounced([pickedClubs], () => {
  api.fixtures.search(pickedClubs.value);
}, { debounce: 300, deep: true });

watch(query, (q) => {
  api.players.list(q);
});

watchEffect(() => {
  if (season.value > 2000) api.standings.load();
});

watch(unused, () => {
  api.standings.load();
});

watch(() => route.query.page, () => {
  api.fixtures.search([]);
});

watch(() => sorting.value.orderBy, () => {
  api.standings.sorted();
});

watch(() => sorting.value.orderDirection, () => {
  api.standings.reversed();
});

watch(league, () => {
  api.players.list(String(league.value));
});

watch(bench, () => {
  api.players.list("bench");
});

whenever(panel, () => {
  api.standings.load();
});

watch(() => [badge.value], () => {
  api.standings.load();
});
</script>
`;

const CLUB_PAGE = `import { useEffect, useState } from "react";

export function ClubPage() {
  const [clubId, setClubId] = useState(0);
  const [tab, setTab] = useState("home");

  useEffect(() => {
    fetch(\`/api/clubs/\${clubId}\`);
  }, [clubId]);

  useEffect(() => {
    fetch("/api/leagues");
  }, []);

  return (
    <div>
      <button onClick={() => setClubId(7)}>Club 7</button>
      <button onClick={() => setTab("away")}>{tab}</button>
    </div>
  );
}
`;

const TABLE = `import { Component, effect, signal } from "@angular/core";
import { Subject, switchMap } from "rxjs";
import { LeagueService } from "./league.service";

@Component({
  selector: "app-table",
  template: \`<button (click)="reload()">Reload</button><button (click)="pick(3)">Club</button>\`,
})
export class TableComponent {
  private refresh$ = new Subject<void>();
  clubId = signal(0);

  constructor(private leagueService: LeagueService) {
    this.refresh$.pipe(switchMap(() => this.leagueService.table())).subscribe();
    effect(() => {
      this.leagueService.club(this.clubId());
    });
  }

  reload() {
    this.refresh$.next();
  }

  pick(id: number) {
    this.clubId.set(id);
  }
}
`;

const SCORERS = `import { Component, signal } from "@angular/core";
import { Subject, switchMap } from "rxjs";
import { LeagueService } from "./league.service";

@Component({ selector: "app-scorers", template: \`<button (click)="poke()">Poke</button>\` })
export class ScorersComponent {
  private refresh$ = new Subject<void>();
  clubId = signal(0);

  constructor(private leagueService: LeagueService) {
    this.refresh$.pipe(switchMap(() => this.leagueService.scorers())).subscribe();
  }

  poke() {
    this.clubId.set(1);
  }
}
`;

const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", "@vueuse/core": "^10.0.0", "vue-router": "^4.0.0", axios: "^1.0.0" } }),
  "web/src/api/index.ts": `import axios from "axios";
export const api = {
  fixtures: { search: (clubs: number[]) => axios.get("/api/v2/fixtures", { params: { clubs } }) },
  players: { list: (q: string) => axios.get("/api/v2/players", { params: { q } }) },
  standings: {
    load: () => axios.get("/api/v2/standings"),
    sorted: () => axios.get("/api/v2/standings/sorted"),
    reversed: () => axios.get("/api/v2/standings/reversed"),
  },
};
`,
  "web/src/views/FixturesView.vue": VIEW,
  "react/package.json": JSON.stringify({ name: "league-react", dependencies: { react: "^18.0.0" } }),
  "react/src/ClubPage.tsx": CLUB_PAGE,
  "ng/package.json": JSON.stringify({ name: "league-ng", dependencies: { "@angular/core": "^17.0.0", "@angular/common": "^17.0.0", rxjs: "^7.0.0" } }),
  "ng/src/app/league.service.ts": `import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Injectable({ providedIn: "root" })
export class LeagueService {
  constructor(private http: HttpClient) {}
  table() { return this.http.get("/api/v2/table"); }
  scorers() { return this.http.get("/api/v2/scorers"); }
  club(id: number) { return this.http.get(\`/api/v2/clubs/\${id}\`); }
}
`,
  "ng/src/app/table.component.ts": TABLE,
  "ng/src/app/scorers.component.ts": SCORERS,
};

/** 1-based line of the first line holding `needle`. */
const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("reactive triggers: a write to a cell runs the watchers on it", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const triggers = () => (summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:reactive-trigger").map((l) => `${l.sourceFile}::${l.sourceSymbol} --${l.callName}--> ${l.targetSymbol}`);
  const callees = (file: string, symbol: string) => (summary.symbolLinks ?? []).filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.relation !== "reference").map((l) => l.targetSymbol);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-reactive-cells-"));
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

  it("joins each Vue handler to the watcher on the ref it writes, and the watcher makes the request", () => {
    const v = "web/src/views/FixturesView.vue";
    const debounced = `<watchDebounced@${lineOf(VIEW, "watchDebounced([pickedClubs]")}>`;
    const onQuery = `<watch@${lineOf(VIEW, "watch(query,")}>`;
    const effect = `<watchEffect@${lineOf(VIEW, "watchEffect(")}>`;
    const onPage = `<watch@${lineOf(VIEW, "watch(() => route.query.page")}>`;
    const onOrderBy = `<watch@${lineOf(VIEW, "sorting.value.orderBy, ()")}>`;
    expect(triggers()).toEqual(expect.arrayContaining([
      `${v}::addClub --pickedClubs--> ${debounced}`,
      `${v}::setQuery --query--> ${onQuery}`,
      `${v}::changeSeason --season--> ${effect}`,
      `${v}::goPage --route.query--> ${onPage}`,
      `${v}::setOrderBy --sorting--> ${onOrderBy}`,
      `${v}::pickLeague --league--> <watch@${lineOf(VIEW, "watch(league,")}>`,
      `${v}::openPanel --panel--> <whenever@${lineOf(VIEW, "whenever(panel,")}>`,
    ]));
    expect(callees(v, debounced)).toContain("api.fixtures.search");
    // The setup still hands the watcher on: whatever reached its calls reaches them one hop further.
    expect(callees(v, "<setup>")).toContain(debounced);
  });

  it("joins a React state setter to the effect listing the state, not to an effect with no deps", () => {
    const f = "react/src/ClubPage.tsx";
    const effect = `<useEffect@${lineOf(CLUB_PAGE, "useEffect(() => {")}>`;
    expect(triggers()).toContain(`${f}::ClubPage --setClubId--> ${effect}`);
    expect(triggers().filter((t) => t.startsWith(f))).toHaveLength(1);
    expect(summary.symbolLinks?.some((l) => l.sourceFile === f && l.targetSymbol.startsWith("<useEffect@12"))).toBe(false);
  });

  it("joins an Angular signal's set to the effect of the same class, and a subject's next to its subscription", () => {
    const t = "ng/src/app/table.component.ts";
    expect(triggers()).toContain(`${t}::TableComponent.pick --clubId--> <effect@${lineOf(TABLE, "effect(() => {")}>`);
    expect(callees(t, "TableComponent.reload")).toContain("LeagueService.table");
  });

  it("leaves the decoys alone", () => {
    const all = triggers().join("\n");
    // A watcher on a cell nothing writes, and the sibling member of the object a handler writes.
    expect(all).not.toContain(`<watch@${lineOf(VIEW, "watch(unused,")}>`);
    expect(all).not.toContain(`<watch@${lineOf(VIEW, "sorting.value.orderDirection, ()")}>`);
    // A push into a ref's array, watched without `deep`: Vue compares the ref's value, which stays the same array.
    expect(all).not.toContain(`<watch@${lineOf(VIEW, "watch(bench,")}>`);
    // `whenever` runs only when its source turns truthy; a member of a DOM node a ref holds is no reactive value.
    expect(all).not.toContain("FixturesView.vue::closePanel");
    expect(all).not.toContain(`<watch@${lineOf(VIEW, "watch(() => [badge.value]")}>`);
    // A namesake signal and subject in another class.
    expect(all).not.toContain("ScorersComponent");
    expect(callees("ng/src/app/scorers.component.ts", "ScorersComponent.poke")).toEqual([]);
  });

  it("re-runs a read when a write replaces what it reaches, or anything below a read through", () => {
    // A write replacing the object re-runs a read of its member; a member write re-runs a read through the object.
    expect(sameCell("12:sorting", "12:sorting.orderBy")).toBe(true);
    expect(sameCell("12:sorting.orderBy", "12:sorting*")).toBe(true);
    // A shallow read of the object is not re-run by a member write; a sibling member never.
    expect(sameCell("12:sorting.orderBy", "12:sorting")).toBe(false);
    expect(sameCell("12:sorting.orderBy", "12:sorting.orderDirection")).toBe(false);
    expect(sameCell("12:sorting", "12:sortingRules*")).toBe(false);
  });
});
