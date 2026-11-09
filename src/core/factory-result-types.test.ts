import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A call on what a factory hands back where no return type is written: the factory returns a construction
 * (`return new ClubApi()`), another factory's result (`return useClubApi()`), or an object literal whose member
 * holds one (`return { clubs: useClubApi() }`). The call lands on that class's method — never on the factory,
 * never on a namesake class — and through it on the route. A library's object (`return useI18n()`) types
 * nothing, and a local whose arms build two classes stays untyped.
 */
describe("typing what a factory returns", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-result-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("web/package.json", '{"name":"league-web","dependencies":{"vue":"3.4.0","axios":"1.6.0","vue-i18n":"9.0.0"}}');
    await file("server/package.json", '{"name":"league-server","dependencies":{"express":"4.18.0"}}');
    await file("web/src/api/http.ts", 'import axios from "axios";\nexport const http = axios.create({ baseURL: "/api" });\n');
    for (const [cls, path] of [["ClubApi", "clubs"], ["PlayerApi", "players"], ["GarageApi", "garages"]] as const) {
      await file(
        `web/src/api/${cls}.ts`,
        [
          'import { http } from "./http";',
          `export class ${cls} {`,
          `  getAll() { return http.get("/${path}"); }`,
          "}",
          `export function use${cls}() { return new ${cls}(); }`,
          "",
        ].join("\n"),
      );
    }
    await file(
      "web/src/api/league.ts",
      [
        'import { useClubApi } from "./ClubApi";',
        'import { usePlayerApi } from "./PlayerApi";',
        "export function useLeagueApi() {",
        "  return { clubs: useClubApi(), players: usePlayerApi() };",
        "}",
        "export function useClubApiAgain() {",
        "  return useClubApi();",
        "}",
        "export function usePublicClubApi(slug: string) {",
        "  const api = useClubApi();",
        "  return { clubs: api, slug };",
        "}",
        "",
      ].join("\n"),
    );
    await file("web/src/util/labels.ts", 'import { useI18n } from "vue-i18n";\nexport function useLabels() {\n  return useI18n();\n}\n');
    await file("web/src/util/strings.ts", "export function t(key: string) {\n  return key.toUpperCase();\n}\n");
    await file(
      "web/src/views/ClubsView.vue",
      [
        "<template>",
        '  <button @click="loadClubs">clubs</button>',
        '  <button @click="loadPlayers">players</button>',
        '  <button @click="loadAgain">again</button>',
        '  <button @click="loadMixed">mixed</button>',
        "  <span>{{ title() }}</span>",
        "</template>",
        '<script setup lang="ts">',
        'import { useLeagueApi, useClubApiAgain, usePublicClubApi } from "../api/league";',
        'import { usePlayerApi } from "../api/PlayerApi";',
        'import { useLabels } from "../util/labels";',
        "const props = defineProps<{ slug?: string }>();",
        "const { clubs } = useLeagueApi();",
        "const league = useLeagueApi();",
        "const again = useClubApiAgain();",
        "const labels = useLabels();",
        "const mixed = props.slug ? usePublicClubApi(props.slug).clubs : usePlayerApi();",
        "function loadClubs() { clubs.getAll(); }",
        "function loadPlayers() { league.players.getAll(); }",
        "function loadAgain() { again.getAll(); }",
        "function loadMixed() { mixed.getAll(); }",
        'function title() { return labels.t("clubs.title"); }',
        "</script>",
        "",
      ].join("\n"),
    );
    await file(
      "server/src/app.ts",
      [
        'import express from "express";',
        "const app = express();",
        'app.get("/api/clubs", (req, res) => res.json([]));',
        'app.get("/api/players", (req, res) => res.json([]));',
        'app.get("/api/garages", (req, res) => res.json([]));',
        "app.listen(3000);",
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const viewLinks = async () => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    return (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "web/src/views/ClubsView.vue" && l.relation !== "reference");
  };
  const targetOf = (links: Awaited<ReturnType<typeof viewLinks>>, callName: string) =>
    links.filter((l) => l.callName === callName).map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`);

  it("follows a returned construction, a returned factory call and an object literal's member to the class", async () => {
    const links = await viewLinks();
    expect(targetOf(links, "clubs.getAll")).toEqual(["ClubApi.ts::ClubApi.getAll"]);
    expect(targetOf(links, "league.players.getAll")).toEqual(["PlayerApi.ts::PlayerApi.getAll"]);
    expect(targetOf(links, "again.getAll")).toEqual(["ClubApi.ts::ClubApi.getAll"]);
  });

  it("leaves a library's object off every namesake, and a local built as two classes untyped", async () => {
    const links = await viewLinks();
    expect(targetOf(links, "labels.t").some((t) => t.startsWith("strings.ts"))).toBe(false);
    expect(targetOf(links, "mixed.getAll")).toEqual([]);
  });

  it("reaches the route each class calls, never the namesake's", async () => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const routed = (summary.apiRouteLinks ?? []).map((l) => `${l.source.split("/").pop()} ${l.routePath}`);
    expect(routed).toContain("ClubApi.ts /api/clubs");
    const garage = (summary.symbolLinks ?? []).filter((l) => l.targetFile.endsWith("GarageApi.ts") && l.sourceFile.endsWith("ClubsView.vue"));
    expect(garage).toEqual([]);
  });
});
