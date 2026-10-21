import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A Kubb-generated client, end to end: the generated modules are not on disk
 * (gitignored build output), so the call `await getClub(id)` states nothing
 * HTTP. The config names the spec, the spec names the operation, and the
 * operation's spec row yields to the Spring route implementing it.
 */
describe("Kubb-generated clients, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-kubb-"));
    const root = join(dir, "repo");
    const web = join(root, "web");
    const server = join(root, "server");
    await mkdir(join(web, "src", "store"), { recursive: true });
    await mkdir(join(web, "src", "views"), { recursive: true });
    await mkdir(join(server, "src", "main", "kotlin", "league"), { recursive: true });

    await writeFile(join(web, "package.json"), JSON.stringify({ name: "web", dependencies: { vue: "3.4.0", pinia: "2.1.0" }, devDependencies: { "@kubb/core": "3.0.0" } }));
    await writeFile(join(web, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await writeFile(join(web, "kubb.config.ts"), [
      "import { defineConfig } from '@kubb/core'",
      "import { pluginOas } from '@kubb/plugin-oas'",
      "import { pluginClient } from '@kubb/plugin-client'",
      "export default defineConfig({",
      "  root: '.',",
      "  input: { path: './api.json' },",
      "  output: { path: './src/api', clean: true },",
      "  plugins: [pluginOas(), pluginClient({ output: { path: 'clients' } })],",
      "})",
    ].join("\n"));
    // Keys sorted, as a generator dumps them: `components` first, `openapi` past the first 8 kB.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) schemas[`PlayerStats${i}`] = { type: "object", properties: { goals: { type: "integer" }, assists: { type: "integer" } } };
    const op = (operationId: string) => ({ operationId, tags: ["club-controller"], responses: { "200": { description: "OK" } } });
    await writeFile(join(web, "api.json"), JSON.stringify({
      components: { schemas },
      info: { title: "League", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/league/clubs": { get: op("getAllClubs") },
        "/league/clubs/{id}": { delete: op("deleteClub"), get: op("getClub") },
        "/league/archive/clubs/{id}": { get: op("getClub_1") },
      },
      servers: [{ url: "/" }],
    }, null, 2));
    await writeFile(join(web, "src", "store", "club-store.ts"), [
      "import { getAllClubs } from '@/api/clients/getAllClubs'",
      "import { deleteClub as removeClub } from '@/api/clients/deleteClub'",
      "export async function loadClubs() {",
      "  return await getAllClubs()",
      "}",
      "export async function dropClub(id: number) {",
      "  await removeClub(id)",
      "}",
    ].join("\n"));
    await writeFile(join(web, "src", "views", "ClubView.vue"), [
      "<template><button @click=\"load(1)\">Load</button></template>",
      "<script setup lang=\"ts\">",
      "import { getClub, getClub1 } from '../api/clients'",
      "async function load(id: number) {",
      "  const club = await getClub(id)",
      "  const archived = await getClub1(id)",
      "  return [club, archived]",
      "}",
      "</script>",
    ].join("\n"));

    await writeFile(join(server, "build.gradle.kts"), 'plugins { id("org.springframework.boot") version "3.2.0" }\n');
    await writeFile(join(server, "src", "main", "kotlin", "league", "ClubController.kt"), [
      "package league",
      "",
      "import org.springframework.web.bind.annotation.*",
      "",
      "@RestController",
      "@RequestMapping(\"league\")",
      "class ClubController {",
      "    @GetMapping(\"clubs\")",
      "    fun getAllClubs(): List<String> = listOf()",
      "",
      "    @GetMapping(\"clubs/{id}\")",
      "    fun getClub(@PathVariable id: Long): String = \"club\"",
      "",
      "    @DeleteMapping(\"clubs/{id}\")",
      "    fun deleteClub(@PathVariable id: Long) {}",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the sorted-key spec and the generator config", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    expect(s.routeMap.filter((r) => r.filePath === "web/api.json").map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual([
      "DELETE /league/clubs/{id} deleteClub",
      "GET /league/archive/clubs/{id} getClub_1",
      "GET /league/clubs getAllClubs",
      "GET /league/clubs/{id} getClub",
    ]);
  });

  it("each generated-client call is an api-call joined to the code route behind its operation", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const links = (s.apiRouteLinks ?? []).filter((l) => l.source.startsWith("web/src/"));
    expect(links.map((l) => `${l.source}:${l.sourceLine} ${l.method} ${l.url} → ${l.target}:${l.handler}`).sort()).toEqual([
      "web/src/store/club-store.ts:4 GET /league/clubs → server/src/main/kotlin/league/ClubController.kt:getAllClubs",
      "web/src/store/club-store.ts:7 DELETE /league/clubs/{id} → server/src/main/kotlin/league/ClubController.kt:deleteClub",
      "web/src/views/ClubView.vue:5 GET /league/clubs/{id} → server/src/main/kotlin/league/ClubController.kt:getClub",
      // No code route serves the archive operation: the spec row is what it reaches.
      "web/src/views/ClubView.vue:6 GET /league/archive/clubs/{id} → web/api.json:getClub_1",
    ]);
  });
});
